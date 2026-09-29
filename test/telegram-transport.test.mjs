import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { createRouter } from '../src/bridges/commands.js';
import { createTelegram } from '../src/bridges/telegram.js';

/**
 * The transport, as opposed to the language.
 *
 * commands.js is covered thoroughly elsewhere; what was never exercised is the
 * part that actually talks to Telegram — the long poll, the offset that must
 * advance past a bad update, the send that chunks. Those only run against an
 * HTTP surface, so here is one.
 */
async function telegram({ replies = [] } = {}) {
  const calls = [];
  let queued = [...replies];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const method = req.url.split('/').pop();
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    calls.push({ method, body });

    const answer = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };

    if (method === 'getMe') return answer({ username: 'esprits_test_bot' });
    if (method === 'sendMessage') return answer({ message_id: calls.length });
    if (method === 'getUpdates') {
      const next = queued.shift();
      // An empty long poll, rather than answering instantly forever.
      if (!next) return setTimeout(() => answer([]), 60);
      return answer(next);
    }
    answer(true);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const hub = new Hub({ dbPath: ':memory:' });
  const router = createRouter({ hub, pairCode: 'letmein', defaultHandle: 'rakim' });
  const bridge = createTelegram({
    hub,
    router,
    token: 'test-token',
    apiBase: `http://127.0.0.1:${server.address().port}`,
    log: () => {},
  });

  return {
    hub,
    calls,
    bridge,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text),
    close: () => { bridge.stop(); server.close(); },
  };
}

const message = (id, text, chatId = 555) => ({
  update_id: id,
  message: { chat: { id: chatId }, text, from: { username: 'rakim' } },
});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('it connects, takes an update, and answers it', async () => {
  const t = await telegram({ replies: [[message(1, '/pair letmein')]] });
  t.bridge.run().catch(() => {});
  await settle();
  t.close();

  assert.equal(t.calls[0].method, 'getMe', 'it says hello before polling');
  assert.match(t.sent().join('\n'), /paired/i);
  // Pairing joins the room, which is the point of the round trip.
  assert.ok(t.hub.roster().some((a) => a.kind === 'human'));
});

test('a message from a paired chat reaches the room', async () => {
  const t = await telegram({ replies: [[message(1, '/pair letmein')], [message(2, 'ship the importer on Friday')]] });
  t.bridge.run().catch(() => {});
  await settle(700);
  t.close();

  // Read the messages table directly: read() is cursor-based and the bridge has
  // already advanced that cursor, which is the behaviour, not the thing under
  // test here.
  const bodies = t.hub.db.prepare('SELECT body FROM messages ORDER BY id').all().map((r) => r.body).join('\n');
  assert.match(bodies, /ship the importer on Friday/);
});

test('the offset advances past an update that failed', async () => {
  // One bad update used to wedge the loop forever, re-fetching the same thing.
  const t = await telegram({
    replies: [[{ update_id: 7, message: { chat: { id: 555 } } }], [message(8, '/pair letmein')]],
  });
  t.bridge.run().catch(() => {});
  await settle(700);
  t.close();

  const offsets = t.calls.filter((c) => c.method === 'getUpdates').map((c) => c.body.offset);
  assert.ok(offsets.includes(8), `it should have moved past 7: ${offsets.join(', ')}`);
  assert.ok(offsets.some((o) => o >= 9), `and past 8: ${offsets.join(', ')}`);
});

test('a chat that never paired is told to pair and nothing else', async () => {
  const t = await telegram({ replies: [[message(1, 'brief')]] });
  t.bridge.run().catch(() => {});
  await settle();
  t.close();

  assert.match(t.sent().join('\n'), /pair/i);
  assert.equal(t.hub.roster().length, 0, 'an unpaired chat must not join anybody to the room');
});

test('media gets an honest answer rather than silence', async () => {
  const t = await telegram({
    replies: [[message(1, '/pair letmein')], [{ update_id: 2, message: { chat: { id: 555 }, photo: [{ file_id: 'x' }] } }]],
  });
  t.bridge.run().catch(() => {});
  await settle(700);
  t.close();
  assert.match(t.sent().join('\n'), /only read text/i);
});

test('stopping ends the loop', async () => {
  const t = await telegram();
  const running = t.bridge.run();
  await settle(200);
  t.bridge.stop();
  await Promise.race([running, settle(2000)]);
  const before = t.calls.length;
  await settle(300);
  t.close();
  assert.ok(t.calls.length - before <= 1, 'it should not keep polling after being stopped');
});
