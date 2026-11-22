// Chat backend on free public "Nostr" relay servers. No accounts, no keys to
// set up: each phone makes its own random identity the first time it runs.
//
// How a chat works:
//   - Each chat has a secret invite code, e.g. K7QM-3XPA-9TRW-HC2D.
//   - From the code the app derives (1) an encryption key and (2) a chat tag.
//   - Every message/photo is encrypted (AES-256-GCM) with that key and sent to
//     several public relays, labelled with the chat tag.
//   - Anyone with the code can read and write; the relays only see gibberish.
//   - Messages are also kept on the phone (IndexedDB) so history survives even
//     if a relay forgets old messages.

const NetBackend = (() => {
  const { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } = window.NostrTools;
  const cfg = window.CHAT_CONFIG || {};
  const RELAYS = cfg.relays || [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://relay.snort.social',
  ];
  const KIND = 4; // "encrypted direct message" kind: widely accepted and kept by relays
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const MAX_PHOTO_BYTES = 40 * 1024; // many relays reject events over 64 KB

  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  let pool = null, me = null, secretKey = null;
  const rooms = new Map();   // id -> { id, name, code, key, msgs: Map, sub }
  const photos = new Map();  // msg id -> object URL

  // ---------- local cache (IndexedDB) ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve) => {
      try {
        const r = indexedDB.open('pigeon-chat', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('events', { keyPath: 'id' }).createIndex('room', 'room');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return dbp;
  }
  async function cachePut(room, ev) {
    const d = await db(); if (!d) return;
    try { d.transaction('events', 'readwrite').objectStore('events').put({ ...ev, room }); } catch {}
  }
  async function cacheGet(room) {
    const d = await db(); if (!d) return [];
    return new Promise((resolve) => {
      try {
        const r = d.transaction('events').objectStore('events').index('room').getAll(room);
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  }

  // ---------- codes & crypto ----------
  function newCode() {
    const r = crypto.getRandomValues(new Uint8Array(16));
    const s = [...r].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    return s.match(/.{4}/g).join('-');
  }
  const normCode = (c) => (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function deriveRoom(code) {
    const base = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('pigeon-chat/v1'), iterations: 150000 }, base, 512));
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const id = hex(await crypto.subtle.digest('SHA-256', bits.slice(32)));
    return { id, key };
  }

  // Payload layout before encryption: [4-byte header length][header JSON][photo bytes]
  async function seal(key, header, bytes = new Uint8Array(0)) {
    const h = enc.encode(JSON.stringify(header));
    const plain = new Uint8Array(4 + h.length + bytes.length);
    new DataView(plain.buffer).setUint32(0, h.length);
    plain.set(h, 4); plain.set(bytes, 4 + h.length);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    return b64(iv) + '.' + b64(ct);
  }
  async function open(key, content) {
    const [iv, ct] = content.split('.');
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
    const len = new DataView(plain.buffer).getUint32(0);
    return { header: JSON.parse(dec.decode(plain.subarray(4, 4 + len))), bytes: plain.subarray(4 + len) };
  }

  // ---------- receiving ----------
  async function handleEvent(room, ev, fromCache) {
    if (room.msgs.has(ev.id) || room.seen.has(ev.id)) return;
    room.seen.add(ev.id);
    try {
      const { header, bytes } = await open(room.key, ev.content);
      const m = {
        id: ev.id,
        kind: header.type === 'photo' ? 'photo' : 'text',
        text: header.text || '',
        from: ev.pubkey,
        fromName: header.name || 'Someone',
        time: new Date(header.t || ev.created_at * 1000).toISOString(),
      };
      if (m.kind === 'photo') photos.set(m.id, URL.createObjectURL(new Blob([bytes], { type: header.mime || 'image/jpeg' })));
      room.msgs.set(m.id, m);
      if (!fromCache) cachePut(room.id, ev);
    } catch { /* not for us or corrupted: ignore */ }
  }

  async function addRoom(info) {
    if (rooms.has(info.id)) return rooms.get(info.id);
    const { key } = await deriveRoom(info.code);
    const room = { ...info, key, msgs: new Map(), seen: new Set() };
    rooms.set(room.id, room);
    for (const ev of await cacheGet(room.id)) await handleEvent(room, ev, true);
    room.sub = pool.subscribeMany(RELAYS, [{ kinds: [KIND], '#p': [room.id], limit: 500 }], {
      onevent: (ev) => handleEvent(room, ev, false),
    });
    return room;
  }

  function saveRooms() {
    ls.set('pigeon.rooms', JSON.stringify([...rooms.values()].map(({ id, name, code, joined }) => ({ id, name, code, joined }))));
  }

  async function publish(room, content) {
    const ev = finalizeEvent({
      kind: KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', room.id]],
      content,
    }, secretKey);
    const results = await Promise.allSettled(pool.publish(RELAYS, ev));
    if (!results.some((r) => r.status === 'fulfilled')) {
      throw new Error('No chat server accepted the message. Check your internet connection.');
    }
    await handleEvent(room, ev, false);
    return room.msgs.get(ev.id);
  }

  // Shrink a photo until it fits in one message.
  async function compressPhoto(file) {
    const img = await createImageBitmap(file);
    let scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    for (let round = 0; round < 8; round++) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      for (const q of [0.82, 0.7, 0.58, 0.46]) {
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= MAX_PHOTO_BYTES) return new Uint8Array(await blob.arrayBuffer());
      }
      scale *= 0.75;
    }
    throw new Error('Could not shrink this photo enough to send.');
  }

  return {
    name: 'net',
    newCode,
    normCode,

    savedName: () => ls.get('pigeon.name') || '',

    async signIn(name) {
      ls.set('pigeon.name', name);
      let sk = ls.get('pigeon.secretKey');
      if (!sk) { sk = hex(generateSecretKey()); ls.set('pigeon.secretKey', sk); }
      secretKey = unhex(sk);
      me = { id: getPublicKey(secretKey), name };
      pool = new SimplePool();
      let saved = [];
      try { saved = JSON.parse(ls.get('pigeon.rooms') || '[]'); } catch {}
      for (const r of saved) await addRoom(r);
      return me;
    },

    signOut() {
      for (const r of rooms.values()) r.sub?.close();
      rooms.clear();
      pool?.close(RELAYS);
    },

    async listConversations() {
      return [...rooms.values()]
        .map((r) => {
          let last = r.joined || '';
          for (const m of r.msgs.values()) if (m.time > last) last = m.time;
          return { id: r.id, name: r.name, code: r.code, updated: last };
        })
        .sort((a, b) => b.updated.localeCompare(a.updated));
    },

    // Start a brand-new chat with a fresh secret code.
    async createConversation(name) {
      return this.joinConversation(newCode(), name);
    },

    // Join a chat someone shared with you.
    async joinConversation(code, name) {
      const clean = normCode(code);
      if (clean.length !== 16) throw new Error('That invite code does not look right. It has 16 letters and numbers.');
      const pretty = clean.match(/.{4}/g).join('-');
      const { id } = await deriveRoom(pretty);
      const room = await addRoom({ id, code: pretty, name: name || `Chat ${pretty.slice(0, 4)}`, joined: new Date().toISOString() });
      saveRooms();
      return { id: room.id, name: room.name, code: room.code };
    },

    async leaveConversation(id) {
      rooms.get(id)?.sub?.close();
      rooms.delete(id);
      saveRooms();
    },

    async listMessages(roomId, since) {
      const room = rooms.get(roomId);
      if (!room) return [];
      return [...room.msgs.values()]
        .filter((m) => !since || m.time >= since)
        .sort((a, b) => a.time.localeCompare(b.time));
    },

    async sendText(roomId, text) {
      const room = rooms.get(roomId);
      return publish(room, await seal(room.key, { type: 'text', text, name: me.name, t: Date.now() }));
    },

    async sendPhoto(roomId, file) {
      const room = rooms.get(roomId);
      const bytes = await compressPhoto(file);
      return publish(room, await seal(room.key, { type: 'photo', mime: 'image/jpeg', name: me.name, t: Date.now() }, bytes));
    },

    async photoUrl(id) {
      if (photos.has(id)) return photos.get(id);
      throw new Error('Photo not found');
    },
  };
})();
