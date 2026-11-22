// Checks that the public relays in config.js accept and return Pigeon Chat
// messages (a big photo-sized message and a small text one).
// Run: node tools/relay-check.mjs   (Node 22+, after `npm i nostr-tools@2.10.4`)
import { readFileSync } from 'node:fs';
import { Relay, finalizeEvent, generateSecretKey } from 'nostr-tools';
import { randomBytes } from 'node:crypto';

const window = {};
new Function('window', readFileSync(new URL('../config.js', import.meta.url), 'utf8'))(window);
const relays = window.CHAT_CONFIG.relays;
const sk = generateSecretKey();
const tag = randomBytes(32).toString('hex');
const sizes = { photo: 55000, text: 140 };

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);

let good = 0;
for (const url of relays) {
  const row = [url];
  try {
    const relay = await withTimeout(Relay.connect(url), 10000, 'connect');
    const ids = [];
    for (const [kind, size] of Object.entries(sizes)) {
      const content = randomBytes(12).toString('base64') + '.' + randomBytes(Math.floor(size * 0.75)).toString('base64');
      const ev = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', tag]], content }, sk);
      try { await withTimeout(relay.publish(ev), 10000, 'publish'); row.push(`${kind}: accepted`); ids.push(ev.id); }
      catch (e) { row.push(`${kind}: REJECTED (${e.message})`); }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const got = new Set();
    await withTimeout(new Promise((resolve) => {
      const sub = relay.subscribe([{ kinds: [4], '#p': [tag], limit: 10 }], {
        onevent: (e) => got.add(e.id),
        oneose: () => { sub.close(); resolve(); },
      });
    }), 10000, 'read back').catch(() => {});
    row.push(`read back ${ids.filter((i) => got.has(i)).length}/${ids.length}`);
    if (ids.length === 2 && ids.every((i) => got.has(i))) good++;
    relay.close();
  } catch (e) { row.push('FAILED: ' + (e?.message || String(e))); }
  console.log(row.join(' | '));
}
console.log(`\n${good}/${relays.length} relays fully working`);
if (good < 2) process.exit(1);
