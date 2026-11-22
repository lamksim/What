// In-memory stand-in for the chat servers, so the app can be tried without
// sending anything anywhere. Nothing is saved; pretend family members reply.

const DemoBackend = (() => {
  let me = null;
  const convs = [];
  const msgs = {}; // convId -> [msg]
  let n = 0;
  const id = () => `demo-${++n}`;
  const now = () => new Date(Date.now() + n).toISOString(); // unique, increasing
  const MAI = 'demo-mai', TOM = 'demo-tom';

  const replies = ['Nice! 😄', 'Got it.', 'Haha, love that.', 'Sounds good to me.', 'Where are you now?', 'Let me check and get back to you.'];

  function add(convId, msg) {
    const m = { id: id(), time: now(), text: '', ...msg };
    msgs[convId].push(m);
    return m;
  }

  function friendReplies(convId, toPhoto) {
    setTimeout(() => add(convId, {
      kind: 'text', from: MAI, fromName: 'Mai',
      text: toPhoto ? 'Cool photo!' : replies[Math.floor(Math.random() * replies.length)],
    }), 1500);
  }

  function newConv(name) {
    const c = { id: id(), name, code: 'DEMO-' + String(n).padStart(4, '0') + '-ABCD-EFGH' };
    convs.push(c); msgs[c.id] = [];
    return c;
  }

  function seed() {
    const fam = newConv('Family');
    add(fam.id, { kind: 'text', from: MAI, fromName: 'Mai', text: 'Hey! Is this the new chat app?' });
    add(fam.id, { kind: 'text', from: me.id, fromName: me.name, text: 'Yes! No accounts needed, just the invite code.' });
    add(fam.id, { kind: 'text', from: TOM, fromName: 'Tom', text: 'Works on my phone too 👍' });
    const t = newConv('Tom');
    add(t.id, { kind: 'text', from: TOM, fromName: 'Tom', text: 'Lunch tomorrow?' });
  }

  return {
    name: 'demo',
    newCode: () => 'DEMO-CODE-0000-0000',
    normCode: (c) => c,
    savedName: () => '',
    async signIn(name) { me = { id: 'demo-me', name: name || 'You' }; if (!convs.length) seed(); return me; },
    signOut() {},
    async listConversations() {
      return convs.map((c) => ({ ...c, updated: (msgs[c.id].at(-1) || {}).time || '' }))
        .sort((a, b) => b.updated.localeCompare(a.updated));
    },
    async createConversation(name) { return newConv(name || 'New chat'); },
    async joinConversation(code, name) { return newConv(name || 'Joined chat'); },
    async leaveConversation(cid) { const i = convs.findIndex((c) => c.id === cid); if (i >= 0) convs.splice(i, 1); },
    async listMessages(convId, since) { return (msgs[convId] || []).filter((m) => !since || m.time >= since); },
    async sendText(convId, text) {
      const m = add(convId, { kind: 'text', from: me.id, fromName: me.name, text });
      friendReplies(convId, false);
      return m;
    },
    async sendPhoto(convId, file) {
      const m = add(convId, { kind: 'photo', from: me.id, fromName: me.name, url: URL.createObjectURL(file) });
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
