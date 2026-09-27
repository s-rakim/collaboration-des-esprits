import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Invalid } from '../src/core.js';
import { createConfig } from '../src/settings.js';

function room() {
  const h = new Hub({ dbPath: ':memory:' });
  h.join({ name: 'rakim', role: 'human', kind: 'human' });
  h.join({ name: 'archie', role: 'architect' });
  h.join({ name: 'crit', role: 'critic' });
  h.join({ name: 'bob', role: 'backend' });
  return h;
}

test('agents speak freely until somebody asks for the floor', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Free for all', raw: '', by: 'rakim' });
  // Nobody queued: posting is unrestricted, so a room that ignores turn-taking
  // is informal rather than broken.
  assert.ok(h.post({ idea: idea.slug, body: 'thinking out loud', by: 'archie' }).id);
  assert.ok(h.post({ idea: idea.slug, body: 'me too', by: 'crit' }).id);
});

test('once one agent queues, everybody queues', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Discipline', raw: '', by: 'rakim' });
  h.requestFloor({ by: 'archie', urgency: 'comment', reason: 'a thought' });
  assert.throws(() => h.post({ idea: idea.slug, body: 'butting in', by: 'crit' }), /not your turn/);
  // The holder may speak.
  assert.ok(h.post({ idea: idea.slug, body: 'my thought', by: 'archie' }).id);
});

test('urgency decides who speaks, not arrival order', () => {
  const h = room();
  h.requestFloor({ by: 'bob', urgency: 'comment', reason: 'minor' });
  h.requestFloor({ by: 'crit', urgency: 'blocker', reason: 'the build is broken' });
  h.requestFloor({ by: 'archie', urgency: 'proposal', reason: 'an approach' });

  // bob asked first and got the vacant floor; the queue behind is by urgency.
  const f = h.floor();
  assert.equal(f.holder.agent, 'bob');
  assert.deepEqual(f.queue.map((q) => q.agent), ['crit', 'archie']);

  h.yieldFloor({ by: 'bob' });
  assert.equal(h.floor().holder.agent, 'crit', 'the blocker goes next');
  h.yieldFloor({ by: 'crit' });
  assert.equal(h.floor().holder.agent, 'archie');
});

test('posting releases the floor automatically', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Auto yield', raw: '', by: 'rakim' });
  h.requestFloor({ by: 'archie', urgency: 'comment' });
  h.requestFloor({ by: 'crit', urgency: 'comment' });
  assert.equal(h.floor().holder.agent, 'archie');

  h.post({ idea: idea.slug, body: 'said my bit', by: 'archie' });
  assert.equal(h.floor().holder.agent, 'crit', 'the next speaker is promoted without anybody yielding by hand');
});

test('the human never waits for the floor', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Boss', raw: '', by: 'rakim' });
  h.requestFloor({ by: 'archie', urgency: 'blocker', reason: 'mine' });
  // An agent holds the floor, and the human talks over it regardless.
  assert.ok(h.post({ idea: idea.slug, body: 'actually, change of plan', by: 'rakim' }).id);
  const f = h.requestFloor({ by: 'rakim' });
  assert.equal(f.yours, true);
  assert.equal(h.floor().holder.agent, 'archie', 'and does not displace the queue');
});

test('structured actions are never gated by the floor', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Actions', raw: '', by: 'rakim' });
  h.requestFloor({ by: 'archie', urgency: 'blocker', reason: 'holding' });

  // crit does not hold the floor, but proposing, scoring and deciding are
  // actions rather than speaking — gating them would deadlock the board.
  const p = h.propose({ idea: idea.slug, title: 'A route', approach: 'x', by: 'crit' });
  assert.ok(p.id);
  assert.ok(h.weighIn({ proposal: p.id, stance: 'endorse', feasibility: 4, by: 'bob' }));
  assert.ok(h.decide({ idea: idea.slug, choice: 'something', by: 'bob' }));
  assert.ok(h.plan({ idea: idea.slug, by: 'bob', tasks: [{ title: 't', role: 'backend' }] }));
});

test('a stale hold is reclaimed so a crashed agent cannot wedge the room', () => {
  const h = room();
  h.requestFloor({ by: 'archie', urgency: 'comment' });
  h.requestFloor({ by: 'crit', urgency: 'comment' });
  assert.equal(h.floor().holder.agent, 'archie');

  // Backdate the grant past the hold limit, as if archie died mid-turn.
  h.db.prepare("UPDATE floor_queue SET granted_at = ? WHERE agent_name = 'archie'")
    .run(new Date(Date.now() - 10 * 60_000).toISOString());
  assert.equal(h.floor().holder.agent, 'crit', 'the floor moves on');
  assert.ok(!h.floor().queue.some((q) => q.agent === 'archie'), 'and the dead holder is dropped');
});

test('re-requesting updates urgency instead of queueing twice', () => {
  const h = room();
  h.requestFloor({ by: 'archie', urgency: 'comment' });
  h.requestFloor({ by: 'crit', urgency: 'comment', reason: 'first thought' });
  h.requestFloor({ by: 'crit', urgency: 'blocker', reason: 'actually this is serious' });
  const f = h.floor();
  assert.equal(f.queue.length, 1);
  assert.equal(f.queue[0].urgency, 'blocker');
  assert.equal(f.queue[0].reason, 'actually this is serious');
});

test('wait_for_turn refuses when you never asked for the floor', async () => {
  const h = room();
  await assert.rejects(() => h.waitForTurn({ by: 'crit', timeoutMs: 10 }), /not in the queue/);
});

test('wait_for_turn returns as soon as the floor is yours', async () => {
  const h = room();
  h.requestFloor({ by: 'archie', urgency: 'comment' });
  const r = await h.waitForTurn({ by: 'archie', timeoutMs: 1000 });
  assert.equal(r.yours, true);
  assert.equal(r.timedOut, false);
});

test('wait_for_turn times out while somebody else is holding', async () => {
  const h = room();
  h.requestFloor({ by: 'archie', urgency: 'comment' });
  h.requestFloor({ by: 'crit', urgency: 'comment' });
  const r = await h.waitForTurn({ by: 'crit', timeoutMs: 400, pollMs: 100 });
  assert.equal(r.yours, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.position, 1);
});

test('an invalid urgency is rejected', () => {
  const h = room();
  assert.throws(() => h.requestFloor({ by: 'archie', urgency: 'extremely' }), Invalid);
});

// ------------------------------------------------- tagging an agent directly

test('a question tagged at one agent can only be answered by that agent', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Direct', raw: '', by: 'rakim' });
  const q = h.ask({ idea: idea.slug, body: 'why did you pick that library?', by: 'rakim', audience: 'archie' });

  assert.throws(() => h.answer({ id: q.id, answer: 'I think because…', by: 'crit' }), /addressed to @archie/);
  assert.ok(h.answer({ id: q.id, answer: 'smaller dependency tree', by: 'archie' }));
});

test('the human can always answer, whoever was tagged', () => {
  const h = room();
  const q = h.ask({ body: 'which of these do you want?', by: 'archie', audience: 'bob' });
  assert.ok(h.answer({ id: q.id, answer: 'the first one', by: 'rakim' }));
});

test('a tagged question threads under the message it is about', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Threading', raw: '', by: 'rakim' });
  const said = h.post({ idea: idea.slug, body: 'I would use a queue here', by: 'archie' });
  const q = h.ask({
    idea: idea.slug, body: 'what does that cost to run?', by: 'rakim',
    audience: 'archie', replyTo: said.id, blocking: false,
  });

  const thread = h.thread(said.id);
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].kind, 'question');
  assert.match(thread.replies[0].body, /what does that cost/);
  assert.deepEqual(thread.replies[0].mentions, ['archie'], 'the tag is a real mention, so it reaches them');

  // And the tagged agent sees it as theirs to answer.
  const forThem = h.catchUp({ name: 'archie' }).questionsForMe;
  assert.ok(forThem.some((x) => x.id === q.id));
  assert.ok(!h.catchUp({ name: 'crit' }).questionsForMe.some((x) => x.id === q.id));
});

// ------------------------------------------------------------ configuration

test('a secret is readable by the server and never by describe()', () => {
  const h = room();
  const c = createConfig(h.db);
  c.setSecret('telegram_token', '123456:AAsupersecret7777');
  assert.equal(c.secret('telegram_token'), '123456:AAsupersecret7777');

  const shown = JSON.stringify(c.describe());
  assert.ok(!shown.includes('supersecret'), 'the raw secret must never reach the page');
  assert.match(shown, /7777/, 'only the last four are previewed');
  assert.equal(c.describe().secrets.telegram_token.set, true);
});

test('the environment overrides a stored value and is marked read-only', () => {
  const h = room();
  const c = createConfig(h.db);
  c.set('human_handle', 'stored-handle');
  c.setSecret('telegram_token', 'stored-token');

  process.env.ESPRITS_HUMAN = 'env-handle';
  process.env.ESPRITS_TELEGRAM_TOKEN = 'env-token';
  try {
    assert.equal(c.get('human_handle'), 'env-handle');
    assert.equal(c.secret('telegram_token'), 'env-token');
    assert.equal(c.describe().settings.human_handle.locked, true);
    assert.equal(c.describe().secrets.telegram_token.locked, true);
  } finally {
    delete process.env.ESPRITS_HUMAN;
    delete process.env.ESPRITS_TELEGRAM_TOKEN;
  }
  // With the env cleared, the stored value is in force again.
  assert.equal(c.get('human_handle'), 'stored-handle');
  assert.equal(c.describe().settings.human_handle.locked, false);
});

test('stored() distinguishes a real setting from a default', () => {
  const c = createConfig(room().db);
  assert.equal(c.stored('human_handle'), null, 'nothing configured yet');
  assert.equal(c.get('human_handle'), '', 'but get() still answers with the default');
  c.set('human_handle', 'rakim');
  assert.equal(c.stored('human_handle'), 'rakim');
});

test('booleans parse the usual spellings', () => {
  const c = createConfig(room().db);
  assert.equal(c.bool('telegram_enabled'), false);
  for (const yes of ['true', 'TRUE', '1', 'yes', 'on']) {
    c.set('telegram_enabled', yes);
    assert.equal(c.bool('telegram_enabled'), true, `${yes} should be truthy`);
  }
  c.set('telegram_enabled', 'false');
  assert.equal(c.bool('telegram_enabled'), false);
});

test('unknown keys are refused rather than silently stored', () => {
  const c = createConfig(room().db);
  assert.throws(() => c.set('not_a_setting', 'x'), /unknown setting/);
  assert.throws(() => c.setSecret('not_a_secret', 'x'), /unknown secret/);
  assert.throws(() => c.get('nope'), /unknown setting/);
});

test('an answer threads under the question, so the chain is visible', () => {
  const h = room();
  const idea = h.dropIdea({ title: 'Chain', raw: '', by: 'rakim' });
  const said = h.post({ idea: idea.slug, body: 'I would cache that', by: 'archie' });
  const q = h.ask({
    idea: idea.slug, body: 'cache where exactly?', by: 'rakim',
    audience: 'archie', replyTo: said.id, blocking: false,
  });
  h.answer({ id: q.id, answer: 'in the edge layer', by: 'archie' });

  // original message → tagged question → the answer to it
  const asked = h.thread(said.id).replies[0];
  assert.equal(asked.kind, 'question');
  const answered = h.thread(asked.id).replies[0];
  assert.equal(answered.kind, 'answer');
  assert.equal(answered.author, 'archie');
  assert.match(answered.body, /in the edge layer/);
});
