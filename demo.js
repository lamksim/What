// In-memory stand-in for Google Drive, so the app can be tried without any
// Google setup. Nothing is saved; a pretend friend replies to you.

const DemoBackend = (() => {
  const me = { email: 'you@example.com', name: 'You (demo)' };
  const convs = [];
  const msgs = {}; // convId -> [msg]
  let n = 0;
  const id = () => `demo-${++n}`;
  const now = () => new Date(Date.now() + n).toISOString(); // unique, increasing

  const replies = [
    'Nice! 😄', 'Got it.', 'Haha, love that.', 'Sounds good to me.',
    'Where are you now?', 'Let me check and get back to you.', 'Cool photo!',
  ];

  function add(convId, msg) {
    const m = { id: id(), time: now(), text: '', ...msg };
    msgs[convId].push(m);
    const c = convs.find((x) => x.id === convId);
    c.updated = m.time;
    return m;
  }

  function friendReplies(convId, toPhoto) {
    const c = convs.find((x) => x.id === convId);
    setTimeout(() => add(convId, {
      kind: 'text', from: c.peerEmail,
      text: toPhoto ? 'Cool photo!' : replies[Math.floor(Math.random() * (replies.length - 1))],
    }), 1500);
  }

  function seed() {
    const c = { id: id(), peerEmail: 'mai@example.com', updated: now() };
    convs.push(c); msgs[c.id] = [];
    add(c.id, { kind: 'text', from: c.peerEmail, text: 'Hey! Is this the new chat app?' });
    add(c.id, { kind: 'text', from: me.email, text: 'Yes, and every message goes into Google Drive.' });
    add(c.id, { kind: 'text', from: c.peerEmail, text: 'So I can see them in my Drive too? Neat 👍' });
    const d = { id: id(), peerEmail: 'tom@example.com', updated: now() };
    convs.push(d); msgs[d.id] = [];
    add(d.id, { kind: 'text', from: d.peerEmail, text: 'Lunch tomorrow?' });
  }

  return {
    name: 'demo',
    async signIn() { if (!convs.length) seed(); return me; },
    signOut() {},
    async listConversations() { return [...convs].sort((a, b) => b.updated.localeCompare(a.updated)); },
    async createConversation(peerEmail) {
      peerEmail = peerEmail.trim().toLowerCase();
      let c = convs.find((x) => x.peerEmail === peerEmail);
      if (!c) { c = { id: id(), peerEmail, updated: now() }; convs.push(c); msgs[c.id] = []; }
      return c;
    },
    async listMessages(convId, since) {
      return msgs[convId].filter((m) => !since || m.time >= since);
    },
    async sendText(convId, text) {
      const m = add(convId, { kind: 'text', from: me.email, text });
      friendReplies(convId, false);
      return m;
    },
    async sendPhoto(convId, file) {
      const m = add(convId, { kind: 'photo', from: me.email, url: URL.createObjectURL(file) });
      friendReplies(convId, true);
      return m;
    },
    async photoUrl(fileId) {
      for (const list of Object.values(msgs)) {
        const m = list.find((x) => x.id === fileId);
        if (m) return m.url;
      }
      throw new Error('Photo not found');
    },
  };
})();
