// UI logic. Works with either DriveBackend (real) or DemoBackend (try-out).

(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.CHAT_CONFIG || {};
  const POLL_MS = (cfg.pollSeconds || 4) * 1000;

  let backend = null;
  let me = null;
  let convs = [];
  let current = null;          // current conversation
  let shown = new Set();       // message ids already rendered
  let lastTime = null;         // createdTime of newest rendered message
  let pollTimer = null, convTimer = null;

  // ---------- helpers ----------
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 4000);
  }

  const displayName = (email) => (email || '?').split('@')[0];

  function avatar(el, email) {
    let h = 0;
    for (const ch of email || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
    el.textContent = displayName(email).charAt(0).toUpperCase();
    el.style.background = `hsl(${h} 55% 48%)`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---------- sign in ----------
  function showLogin() {
    $('login').hidden = false;
    $('app').hidden = true;
    const savedId = cfg.clientId || store.get('pigeon.clientId') || '';
    $('client-setup').hidden = !!cfg.clientId;
    $('client-id').value = savedId;
  }

  async function start(b, clientId) {
    $('login-error').hidden = true;
    $('btn-signin').disabled = true;
    try {
      backend = b;
      me = await backend.signIn(clientId);
      $('login').hidden = true;
      $('app').hidden = false;
      $('me-name').textContent = me.name || displayName(me.email);
      $('me-email').textContent = me.email;
      avatar($('me-avatar'), me.email);
      await refreshConvs();
      convTimer = setInterval(refreshConvs, POLL_MS * 4);
      if (b === DemoBackend) toast('Demo mode: nothing is saved, and your friend replies automatically.');
    } catch (e) {
      $('login-error').textContent = e.message;
      $('login-error').hidden = false;
    } finally {
      $('btn-signin').disabled = false;
    }
  }

  $('btn-signin').onclick = () => {
    const clientId = (cfg.clientId || $('client-id').value).trim();
    if (!clientId) {
      $('client-setup').hidden = false;
      $('login-error').textContent = 'Paste your Google OAuth Client ID first (see SETUP.md).';
      $('login-error').hidden = false;
      return;
    }
    store.set('pigeon.clientId', clientId);
    start(DriveBackend, clientId);
  };
  $('btn-demo').onclick = () => start(DemoBackend);

  $('btn-signout').onclick = () => {
    backend.signOut();
    clearInterval(pollTimer); clearInterval(convTimer);
    current = null; convs = [];
    $('conv-list').innerHTML = '';
    closeChat();
    showLogin();
  };

  // ---------- conversation list ----------
  async function refreshConvs() {
    try {
      convs = await backend.listConversations();
      renderConvs();
    } catch (e) { toast(e.message, true); }
  }

  function renderConvs() {
    const ul = $('conv-list');
    ul.innerHTML = '';
    $('conv-empty').hidden = convs.length > 0;
    for (const c of convs) {
      const li = document.createElement('li');
      li.className = current?.id === c.id ? 'active' : '';
      const av = document.createElement('div');
      av.className = 'avatar';
      avatar(av, c.peerEmail);
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="name"></div><div class="muted small"></div>';
      info.firstChild.textContent = displayName(c.peerEmail);
      info.lastChild.textContent = c.peerEmail;
      li.append(av, info);
      li.onclick = () => openChat(c);
      ul.append(li);
    }
  }

  // ---------- chat ----------
  async function openChat(c) {
    current = c;
    shown = new Set();
    lastTime = null;
    $('messages').innerHTML = '';
    $('chat-empty').hidden = true;
    $('chat-view').hidden = false;
    $('peer-name').textContent = displayName(c.peerEmail);
    avatar($('peer-avatar'), c.peerEmail);
    document.body.classList.add('in-chat');
    renderConvs();
    clearInterval(pollTimer);
    await loadMessages();
    pollTimer = setInterval(loadMessages, POLL_MS);
    $('text-input').focus();
  }

  function closeChat() {
    current = null;
    clearInterval(pollTimer);
    $('chat-view').hidden = true;
    $('chat-empty').hidden = false;
    document.body.classList.remove('in-chat');
  }
  $('btn-back').onclick = () => { closeChat(); renderConvs(); };

  async function loadMessages() {
    const conv = current;
    if (!conv) return;
    try {
      const list = await backend.listMessages(conv.id, lastTime);
      if (conv !== current) return; // user switched chats meanwhile
      list.forEach(addMessage);
    } catch (e) { toast(e.message, true); }
  }

  function addMessage(m) {
    if (shown.has(m.id)) return;
    shown.add(m.id);
    if (!lastTime || m.time > lastTime) lastTime = m.time;

    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

    const row = document.createElement('div');
    row.className = 'msg ' + (m.from === me.email ? 'mine' : 'theirs');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.kind === 'photo') {
      const img = document.createElement('img');
      img.alt = 'Photo';
      img.className = 'loading';
      backend.photoUrl(m.id).then((url) => { img.src = url; img.className = ''; })
        .catch(() => { img.alt = 'Photo could not be loaded'; });
      img.onload = () => { if (nearBottom) box.scrollTop = box.scrollHeight; };
      img.onclick = () => img.src && window.open(img.src, '_blank');
      bubble.append(img);
    } else {
      const p = document.createElement('div');
      p.className = 'text';
      p.textContent = m.text;
      bubble.append(p);
    }
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = fmtTime(m.time);
    bubble.append(t);
    row.append(bubble);

    // keep order by time (in case of slight clock differences between users)
    const after = [...box.children].find((el) => el.dataset.time > m.time);
    row.dataset.time = m.time;
    box.insertBefore(row, after || null);
    if (nearBottom || m.from === me.email) box.scrollTop = box.scrollHeight;
  }

  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('text-input');
    const text = input.value.trim();
    if (!text || !current) return;
    input.value = '';
    try {
      addMessage(await backend.sendText(current.id, text));
    } catch (err) {
      input.value = text;
      toast('Message not sent: ' + err.message, true);
    }
  };

  $('photo-input').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !current) return;
    if (file.size > 20 * 1024 * 1024) return toast('Photo is too big (20 MB max).', true);
    toast('Uploading photo…');
    try {
      addMessage(await backend.sendPhoto(current.id, file));
      $('toast').hidden = true;
    } catch (err) { toast('Photo not sent: ' + err.message, true); }
  };

  // ---------- new chat ----------
  $('btn-new').onclick = () => { $('new-email').value = ''; $('new-dialog').showModal(); };
  $('new-dialog').onclose = async () => {
    if ($('new-dialog').returnValue !== 'ok') return;
    const email = $('new-email').value.trim();
    if (!email) return;
    if (email.toLowerCase() === me.email) return toast("That's your own address.", true);
    try {
      toast('Creating chat folder in Google Drive…');
      const c = await backend.createConversation(email);
      await refreshConvs();
      openChat(convs.find((x) => x.id === c.id) || c);
    } catch (err) { toast('Could not start chat: ' + err.message, true); }
  };

  // On load: demo link (index.html?demo), coming back from Google sign-in,
  // or an earlier sign-in that is still valid.
  if (new URLSearchParams(location.search).has('demo')) {
    start(DemoBackend);
  } else {
    const result = DriveBackend.checkRedirect();
    const clientId = cfg.clientId || store.get('pigeon.clientId');
    showLogin();
    if (result === 'signed-in' && clientId) start(DriveBackend, clientId);
    else if (result && result !== 'signed-in') {
      $('login-error').textContent = result;
      $('login-error').hidden = false;
    }
  }
})();
