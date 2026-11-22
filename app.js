// UI logic. Works with either NetBackend (real) or DemoBackend (try-out).

(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.CHAT_CONFIG || {};
  const POLL_MS = (cfg.pollSeconds || 1) * 1000;

  let backend = null;
  let me = null;
  let convs = [];
  let current = null;          // current conversation
  let shown = new Set();       // message ids already rendered
  let lastTime = null;         // time of newest rendered message
  let pollTimer = null, convTimer = null;

  // ---------- helpers ----------
  function toast(text, isError) {
    const t = $('toast');
    t.textContent = text;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 4000);
  }

  function avatar(el, name, seed) {
    let h = 0;
    for (const ch of seed || name || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
    el.textContent = (name || '?').trim().charAt(0).toUpperCase();
    el.style.background = `hsl(${h} 55% 48%)`;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return today ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
  }

  // Invite links look like  https://.../What/#join=ABCD-EFGH-JKLM-NPQR&name=Family
  function readInviteFromUrl() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.has('join')) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return { code: h.get('join'), name: h.get('name') || '' };
  }
  let pendingInvite = readInviteFromUrl();

  // ---------- start ----------
  function showLogin() {
    $('login').hidden = false;
    $('app').hidden = true;
    $('my-name').value = NetBackend.savedName();
    $('my-name').focus();
  }

  async function start(b, name) {
    $('login-error').hidden = true;
    $('btn-signin').disabled = true;
    try {
      backend = b;
      me = await backend.signIn(name);
      $('login').hidden = true;
      $('app').hidden = false;
      $('me-name').textContent = me.name;
      avatar($('me-avatar'), me.name, me.id);
      await refreshConvs();
      convTimer = setInterval(refreshConvs, 5000);
      if (b === DemoBackend) toast('Demo mode: nothing is sent or saved, and Mai replies automatically.');
      if (pendingInvite && b !== DemoBackend) {
        const inv = pendingInvite; pendingInvite = null;
        await join(inv.code, inv.name);
      }
    } catch (e) {
      $('login-error').textContent = e.message;
      $('login-error').hidden = false;
      $('login').hidden = false;
      $('app').hidden = true;
    } finally {
      $('btn-signin').disabled = false;
    }
  }

  $('login-form').onsubmit = (e) => {
    e.preventDefault();
    const name = $('my-name').value.trim();
    if (name) start(NetBackend, name);
  };
  $('btn-demo').onclick = () => start(DemoBackend, $('my-name').value.trim() || 'You');

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
      avatar(av, c.name, c.id);
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = '<div class="name"></div><div class="muted small"></div>';
      info.firstChild.textContent = c.name;
      info.lastChild.textContent = c.updated ? 'Last message ' + fmtTime(c.updated) : 'No messages yet';
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
    $('peer-name').textContent = c.name;
    avatar($('peer-avatar'), c.name, c.id);
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
      if (conv !== current) return; // switched chats meanwhile
      list.forEach(addMessage);
    } catch (e) { toast(e.message, true); }
  }

  function addMessage(m) {
    if (!m || shown.has(m.id)) return;
    shown.add(m.id);
    if (!lastTime || m.time > lastTime) lastTime = m.time;

    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const mine = m.from === me.id;

    const row = document.createElement('div');
    row.className = 'msg ' + (mine ? 'mine' : 'theirs');
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (!mine) {
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = m.fromName;
      let h = 0; for (const ch of m.from) h = (h * 31 + ch.charCodeAt(0)) % 360;
      who.style.color = `hsl(${h} 55% 42%)`;
      bubble.append(who);
    }
    if (m.kind === 'photo') {
      const img = document.createElement('img');
      img.alt = 'Photo';
      img.className = 'loading';
      backend.photoUrl(m.id).then((url) => { img.src = url; img.className = ''; })
        .catch(() => { img.alt = 'Photo could not be loaded'; });
      img.onload = () => { if (nearBottom || mine) box.scrollTop = box.scrollHeight; };
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

    // keep order by time (messages can arrive out of order)
    row.dataset.time = m.time;
    const after = [...box.children].find((el) => el.dataset.time > m.time);
    box.insertBefore(row, after || null);
    if (nearBottom || mine) box.scrollTop = box.scrollHeight;
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
    toast('Sending photo…');
    try {
      addMessage(await backend.sendPhoto(current.id, file));
      $('toast').hidden = true;
    } catch (err) { toast('Photo not sent: ' + err.message, true); }
  };

  // ---------- new / join chat ----------
  let tab = 'start';
  function setTab(t) {
    tab = t;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
    $('new-ok').textContent = t === 'start' ? 'Start chat' : 'Join chat';
  }
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  $('btn-new').onclick = () => {
    $('new-name').value = ''; $('join-code').value = ''; $('join-name').value = '';
    setTab('start');
    $('new-dialog').showModal();
  };

  async function join(code, name) {
    try {
      toast('Joining chat…');
      const c = await backend.joinConversation(code, name);
      $('toast').hidden = true;
      await refreshConvs();
      openChat(convs.find((x) => x.id === c.id) || c);
    } catch (err) { toast(err.message, true); }
  }

  $('new-dialog').onclose = async () => {
    if ($('new-dialog').returnValue !== 'ok') return;
    if (tab === 'join') return join($('join-code').value, $('join-name').value.trim());
    try {
      const c = await backend.createConversation($('new-name').value.trim() || 'Family');
      await refreshConvs();
      await openChat(convs.find((x) => x.id === c.id) || c);
      showInvite();
    } catch (err) { toast('Could not start chat: ' + err.message, true); }
  };

  // ---------- invite ----------
  function inviteText() {
    const appUrl = cfg.appUrl || (location.origin + location.pathname);
    const link = `${appUrl}#join=${encodeURIComponent(current.code)}&name=${encodeURIComponent(current.name)}`;
    return `Join my Pigeon Chat "${current.name}".\n\n` +
      `1. Get the app: ${cfg.apkUrl || appUrl}\n` +
      `2. Open it, tap ＋, choose "Join with code" and type:\n${current.code}\n\n` +
      `Or open this link: ${link}`;
  }

  function showInvite() {
    if (!current) return;
    $('invite-code').textContent = current.code;
    $('invite-dialog').showModal();
  }
  $('btn-invite').onclick = showInvite;

  $('btn-share').onclick = async () => {
    const text = inviteText();
    if (navigator.share) {
      try { await navigator.share({ title: 'Pigeon Chat invite', text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text); toast('Invite copied. Paste it in a message to your family.'); }
    catch { toast('Could not share. Copy the code instead.', true); }
  };
  $('btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(current.code); toast('Code copied.'); }
    catch { toast('Could not copy. Please write the code down.', true); }
  };
  $('btn-leave').onclick = async () => {
    if (!current) return;
    const id = current.id;
    $('invite-dialog').close();
    await backend.leaveConversation(id);
    closeChat();
    await refreshConvs();
    toast('You left the chat. You can join again with the code.');
  };

  // ---------- on load ----------
  if (new URLSearchParams(location.search).has('demo')) start(DemoBackend, 'You');
  else if (NetBackend.savedName()) start(NetBackend, NetBackend.savedName());
  else showLogin();
})();
