// Google Drive storage backend.
//
// How data is laid out in Drive:
//   My Drive/Pigeon Chat/                    <- created once per user
//     Chat: alice@gmail.com & bob@gmail.com/ <- one folder per conversation,
//                                              shared (writer) with the friend
//       msg-<time>.json                      <- one file per text message
//       photo-<time>-<name>.jpg              <- photos are stored as-is
//
// Every file carries appProperties so the app can find its own files:
//   folder:  chatApp=conv, memberA, memberB
//   message: chatApp=msg, kind=text|photo, from=<email>
// Text is stored both in the file body (JSON) and in the file description,
// so one list call is enough to render a whole chat.

const DriveBackend = (() => {
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  // Full Drive scope: needed so your friend can see the chat folder you share
  // with them. While the Google app is in "Testing" mode this is fine for up to
  // 100 test users without Google verification.
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const MSG_FIELDS = 'files(id,name,mimeType,description,createdTime,appProperties)';

  // Sign-in uses Google's full-page redirect (not a popup), because popups
  // do not work reliably inside an installed phone app.
  const TOKEN_KEY = 'pigeon.token';
  const STATE_KEY = 'pigeon.oauthState';
  const CLIENT_KEY = 'pigeon.clientId';

  let accessToken = null;
  let me = null;
  let rootId = null;
  const photoCache = new Map();

  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(k); } catch {} },
  };

  // The address Google sends the user back to. Must be listed under
  // "Authorized redirect URIs" in Google Cloud (see SETUP.md).
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

  function goToGoogle(clientId) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ls.set(STATE_KEY, state);
    ls.set(CLIENT_KEY, clientId);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + params);
    return new Promise(() => {}); // the page is navigating away
  }

  function storedToken() {
    try {
      const t = JSON.parse(ls.get(TOKEN_KEY) || 'null');
      if (t && t.exp > Date.now() + 60000) return t.token;
    } catch {}
    return null;
  }

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) {
      // Sign-in lasts about an hour. Go back to Google for a fresh one.
      ls.del(TOKEN_KEY);
      const clientId = ls.get(CLIENT_KEY);
      if (clientId) return goToGoogle(clientId);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error?.message || ''; } catch {}
      throw new Error(`Google Drive error ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return res;
  }

  const getJson = async (url, opts) => (await api(url, opts)).json();
  const q = (s) => encodeURIComponent(s);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function upload(metadata, blob) {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);
    return getJson(`${UPLOAD}&fields=id,name,mimeType,description,createdTime,appProperties`, {
      method: 'POST', body: form,
    });
  }

  async function ensureRoot() {
    if (rootId) return rootId;
    const query = `appProperties has { key='chatApp' and value='root' } and 'me' in owners and trashed=false`;
    const found = await getJson(`${API}/files?q=${q(query)}&fields=files(id)`);
    if (found.files.length) return (rootId = found.files[0].id);
    const created = await getJson(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Pigeon Chat',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { chatApp: 'root' },
      }),
    });
    return (rootId = created.id);
  }

  function toConv(f) {
    const a = f.appProperties?.memberA, b = f.appProperties?.memberB;
    const peer = a === me.email ? b : a;
    return { id: f.id, peerEmail: peer || f.name, updated: f.modifiedTime };
  }

  function toMsg(f) {
    const p = f.appProperties || {};
    return {
      id: f.id,
      kind: p.kind === 'photo' ? 'photo' : 'text',
      text: f.description || '',
      from: p.from || '',
      time: f.createdTime,
      name: f.name,
    };
  }

  return {
    name: 'drive',

    // Called on page load. Returns 'signed-in' if Google just sent us back
    // with a token (or one is still valid), an error message, or null.
    checkRedirect() {
      const hash = new URLSearchParams(location.hash.slice(1));
      if (hash.has('access_token') || hash.has('error')) {
        history.replaceState(null, '', location.pathname + location.search);
        const expected = ls.get(STATE_KEY);
        ls.del(STATE_KEY);
        if (hash.has('error')) return hash.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed: ' + hash.get('error');
        if (!expected || hash.get('state') !== expected) return 'Sign-in check failed. Please try again.';
        if (!(hash.get('scope') || '').includes(SCOPE)) return 'Please allow access to Google Drive (tick the box) so the app can save your chats.';
        ls.set(TOKEN_KEY, JSON.stringify({
          token: hash.get('access_token'),
          exp: Date.now() + Number(hash.get('expires_in') || 3600) * 1000,
        }));
      }
      return storedToken() ? 'signed-in' : null;
    },

    async signIn(clientId) {
      accessToken = storedToken();
      if (!accessToken) return goToGoogle(clientId);
      const about = await getJson(`${API}/about?fields=user(displayName,emailAddress,photoLink)`);
      me = { email: about.user.emailAddress.toLowerCase(), name: about.user.displayName, photo: about.user.photoLink };
      await ensureRoot();
      return me;
    },

    signOut() {
      if (accessToken) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(accessToken), { method: 'POST' }).catch(() => {});
      ls.del(TOKEN_KEY);
      accessToken = null; me = null; rootId = null;
    },

    async listConversations() {
      // Finds chats you started AND chats friends shared with you.
      const query = `appProperties has { key='chatApp' and value='conv' } and trashed=false`;
      const res = await getJson(`${API}/files?q=${q(query)}&orderBy=modifiedTime desc&pageSize=200&fields=files(id,name,modifiedTime,appProperties)`);
      return res.files.map(toConv);
    },

    async createConversation(peerEmail) {
      peerEmail = peerEmail.trim().toLowerCase();
      const existing = (await this.listConversations()).find((c) => c.peerEmail === peerEmail);
      if (existing) return existing;
      const parent = await ensureRoot();
      const folder = await getJson(`${API}/files?fields=id,name,modifiedTime,appProperties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Chat: ${me.email} & ${peerEmail}`,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parent],
          appProperties: { chatApp: 'conv', memberA: me.email, memberB: peerEmail },
        }),
      });
      await api(`${API}/files/${folder.id}/permissions?sendNotificationEmail=true&emailMessage=${q('I started a Pigeon Chat with you. Open the app and sign in to reply.')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: peerEmail }),
      });
      return toConv(folder);
    },

    // since = ISO time of the newest message already shown (or null for first load)
    async listMessages(convId, since) {
      let query = `'${esc(convId)}' in parents and trashed=false and appProperties has { key='chatApp' and value='msg' }`;
      if (since) {
        query += ` and createdTime >= '${since}'`;
        const res = await getJson(`${API}/files?q=${q(query)}&orderBy=createdTime&pageSize=200&fields=${MSG_FIELDS}`);
        return res.files.map(toMsg);
      }
      // First load: the latest 100 messages.
      const res = await getJson(`${API}/files?q=${q(query)}&orderBy=createdTime desc&pageSize=100&fields=${MSG_FIELDS}`);
      return res.files.map(toMsg).reverse();
    },

    async sendText(convId, text) {
      const time = new Date().toISOString();
      const body = new Blob([JSON.stringify({ from: me.email, text, time }, null, 2)], { type: 'application/json' });
      const f = await upload({
        name: `msg-${time.replace(/[:.]/g, '-')}.json`,
        mimeType: 'application/json',
        parents: [convId],
        description: text,
        appProperties: { chatApp: 'msg', kind: 'text', from: me.email },
      }, body);
      return toMsg(f);
    },

    async sendPhoto(convId, file) {
      const time = new Date().toISOString();
      const f = await upload({
        name: `photo-${time.replace(/[:.]/g, '-')}-${file.name}`,
        mimeType: file.type || 'image/jpeg',
        parents: [convId],
        appProperties: { chatApp: 'msg', kind: 'photo', from: me.email },
      }, file);
      return toMsg(f);
    },

    async photoUrl(fileId) {
      if (!photoCache.has(fileId)) {
        photoCache.set(fileId, api(`${API}/files/${fileId}?alt=media`)
          .then((r) => r.blob())
          .then((b) => URL.createObjectURL(b))
          .catch((e) => { photoCache.delete(fileId); throw e; }));
      }
      return photoCache.get(fileId);
    },
  };
})();
