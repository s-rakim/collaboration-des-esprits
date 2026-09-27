import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createRouter, chunk } from '../src/bridges/commands.js';

const CODE = 'letmein';

function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  const router = createRouter({ hub, pairCode: CODE, defaultHandle: 'rakim' });
  // A bare phone message is the common case, so the helper mirrors that shape.
  const say = (text, chatId = '555') => router.handle({ platform: 'telegram', chatId, text, from: { username: 'rakim' } }).reply;
  return { hub, router, say };
}

function paired() {
  const r = room();
  r.say(`/pair ${CODE}`);
  return r;
}

test('an unpaired chat can do nothing but pair', () => {
  const { say } = room();
  assert.match(say('/ideas'), /not paired/);
  assert.match(say('what are you all working on'), /not paired/);
  assert.match(say('/pair wrongcode'), /Wrong code/);
  assert.match(say(`/pair ${CODE}`), /Paired/);
});

test('pairing joins the room as a human, not an agent', () => {
  const { hub, say } = paired();
  const me = hub.roster().find((a) => a.name === 'rakim');
  assert.equal(me.kind, 'human', 'the human must not be mistaken for an agent');
  assert.equal(me.role, 'human');
  assert.match(say('/who'), /rakim/);
});

test('pairing does not replay the whole history to the phone', () => {
  const { hub, router, say } = room();
  hub.join({ name: 'archie', role: 'architect' });
  const idea = hub.dropIdea({ title: 'Old news', raw: '', by: 'archie' });
  hub.post({ idea: idea.slug, body: '@all lots of backlog here', by: 'archie' });

  say(`/pair ${CODE}`);
  assert.equal(router.pending().length, 0, 'the watermark starts at the current head');
});

test('a bare message posts to whatever idea the chat is on', () => {
  const { hub, say } = paired();
  assert.match(say('/idea Nightly digests\nemail me what the agents did'), /Dropped/);
  assert.match(say('make it weekly actually'), /Posted on "nightly-digests"/);

  assert.ok(
    hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('make it weekly actually'),
    'the bare text landed in the room, not just in the reply',
  );

  assert.match(say('/use lobby'), /lobby/);
  assert.match(say('general thought'), /Posted in the lobby/);
});

test('an idea can be dropped on one line with a bar, for thumb typing', () => {
  const { hub, say } = paired();
  say('/idea Push alerts | when CI breaks, ping my phone');
  const i = hub.listIdeas()[0];
  assert.equal(i.title, 'Push alerts');
  assert.equal(i.raw, 'when CI breaks, ping my phone', 'the detail after the bar becomes the dump');
});

test('the human answers blocking questions from the phone', () => {
  const { hub, say } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  const idea = hub.dropIdea({ title: 'Hosting', raw: '', by: 'rakim' });
  const q = hub.ask({ idea: idea.slug, body: 'Local box or a VPS?', by: 'archie', audience: 'human' });

  assert.match(say('/q'), /Local box or a VPS\?/);
  assert.match(say(`/a ${q.id} local box, reachable over telegram`), /Answered/);
  assert.equal(hub.questions({ open: true }).length, 0);
  assert.match(say('/q'), /Nothing is waiting on you/);
});

test('the phone gets pushed only what is addressed to the human', () => {
  const { hub, router, say } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  hub.join({ name: 'crit', role: 'critic' });
  const idea = hub.dropIdea({ title: 'Scope', raw: '', by: 'rakim' });

  // Agent-to-agent chatter must not reach the phone.
  hub.post({ idea: idea.slug, body: '@crit what do you think of the schema', by: 'archie' });
  assert.equal(router.pending().length, 0, 'agents talking to each other is not a notification');

  hub.ask({ idea: idea.slug, body: 'do you want auth on this?', by: 'archie', audience: 'human' });
  const out = router.pending();
  assert.equal(out.length, 1);
  assert.match(out[0].text, /do you want auth on this\?/);

  // Nothing is re-sent once delivered.
  router.markDelivered(out[0].chat, out[0].upTo);
  assert.equal(router.pending().length, 0);
});

test('the watermark only advances after a successful send', () => {
  const { hub, router } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  const idea = hub.dropIdea({ title: 'Retry', raw: '', by: 'rakim' });
  hub.post({ idea: idea.slug, body: '@rakim you around?', by: 'archie' });

  const first = router.pending();
  assert.equal(first.length, 1);
  // Simulate a failed delivery: markDelivered is simply never called.
  assert.equal(router.pending().length, 1, 'an undelivered nudge is offered again, not dropped');
});

test('converged proposals are pushed as viable options, once', () => {
  const { hub, router, say } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  hub.join({ name: 'crit', role: 'critic' });
  const idea = hub.dropIdea({ title: 'Queue design', raw: '', by: 'rakim' });

  const a = hub.propose({ idea: idea.slug, title: 'In-process timers', approach: 'setInterval', effort: 'S', by: 'archie' });
  const b = hub.propose({ idea: idea.slug, title: 'Redis queue', approach: 'bullmq', effort: 'M', by: 'crit' });

  // Still gathering scores — nothing should be pushed yet.
  assert.equal(router.optionsReady().length, 0, 'half-formed options are not worth interrupting for');

  hub.weighIn({ proposal: a.id, stance: 'endorse', feasibility: 4, reasoning: 'no new infra', by: 'crit' });
  hub.weighIn({ proposal: a.id, stance: 'endorse', feasibility: 4, by: 'rakim' });
  hub.weighIn({ proposal: b.id, stance: 'object', feasibility: 2, reasoning: 'another daemon to babysit', by: 'archie' });
  hub.weighIn({ proposal: b.id, stance: 'neutral', feasibility: 3, by: 'rakim' });

  const ready = router.optionsReady();
  assert.equal(ready.length, 1);
  assert.match(ready[0].text, /2 viable options/);
  assert.match(ready[0].text, /In-process timers/);
  assert.match(ready[0].text, /Redis queue/);
  assert.match(ready[0].text, /feasibility 4\/5/);
  assert.match(ready[0].text, /\/choose <id>/);

  router.markOptionsSent(ready[0].stateKey, ready[0].signature);
  assert.equal(router.optionsReady().length, 0, 'the same options are not pushed twice');

  // A changed score is new information, so it is worth one more push.
  hub.weighIn({ proposal: b.id, stance: 'endorse', feasibility: 5, reasoning: 'convinced', by: 'archie' });
  assert.equal(router.optionsReady().length, 1);
});

test('choosing from the phone settles the contest and records a decision', () => {
  const { hub, say } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  const idea = hub.dropIdea({ title: 'Pick', raw: '', by: 'rakim' });
  const a = hub.propose({ idea: idea.slug, title: 'Route A', approach: 'a', by: 'archie' });
  const b = hub.propose({ idea: idea.slug, title: 'Route B', approach: 'b', by: 'archie' });
  hub.weighIn({ proposal: a.id, stance: 'endorse', feasibility: 4, by: 'archie' });

  say(`/use ${idea.slug}`);
  assert.match(say('/props'), /Route A/);
  assert.match(say(`/choose ${a.id} this one, ship it`), /Chose P1/);
  assert.equal(hub.getProposal(b.id).status, 'rejected');
  assert.ok(hub.decisions({ idea: idea.slug }).some((d) => /Route A/.test(d.choice)));
});

test('the human can overrule a held route from the phone', () => {
  const { hub, say } = paired();
  hub.join({ name: 'crit', role: 'critic' });
  const idea = hub.dropIdea({ title: 'Deadlock', raw: '', by: 'rakim' });
  const p = hub.propose({ idea: idea.slug, title: 'Only route', approach: 'x', by: 'crit' });
  hub.weighIn({ proposal: p.id, stance: 'object', reasoning: 'I just do not like it', blocking: true, by: 'crit' });
  assert.match(say(`/choose ${p.id}`), /Chose P/, 'the human breaks a deadlock the agents cannot');
});

test('brief, status, tasks and search all answer from the phone', () => {
  const { hub, say } = paired();
  hub.join({ name: 'archie', role: 'architect' });
  const idea = hub.dropIdea({ title: 'Everything', raw: 'the original dump', by: 'rakim' });
  hub.decide({ idea: idea.slug, choice: 'sqlite', rationale: 'no daemon', by: 'archie' });
  hub.refine({ ref: idea.slug, spec: 'one file', by: 'archie' });
  hub.plan({ idea: idea.slug, by: 'archie', tasks: [{ title: 'build it', role: 'backend' }] });
  hub.post({ idea: idea.slug, body: 'needle in the haystack', by: 'archie' });

  say(`/use ${idea.slug}`);
  const b = say('/brief');
  assert.match(b, /the original dump/);
  assert.match(b, /no daemon/);
  assert.match(say('/status'), /building|Needs attention|open tasks/);
  assert.match(say('/tasks'), /#1 \[backend\] build it/);
  assert.match(say('/search needle'), /needle in the haystack/);
  assert.match(say('/remember stack=node 22'), /Remembered stack/);
  assert.match(say('/decide ship on friday'), /Recorded decision/);
});

test('bad input is answered, never swallowed', () => {
  const { say } = paired();
  assert.match(say('/use no-such-idea'), /✖.*no idea/);
  assert.match(say('/a 999 hello'), /✖/);
  assert.match(say('/choose 999'), /✖/);
  assert.match(say('/wat'), /Unknown command/);
  assert.match(say('/a'), /Use: \/a/);
  assert.match(say('/remember nokey'), /Use: \/remember/);
});

test('two phones are independent chats with their own idea context', () => {
  const { hub, router } = room();
  router.handle({ platform: 'telegram', chatId: 'A', text: `/pair ${CODE} rakim` });
  router.handle({ platform: 'telegram', chatId: 'B', text: `/pair ${CODE} partner` });
  const i1 = hub.dropIdea({ title: 'One', raw: '', by: 'rakim' });
  const i2 = hub.dropIdea({ title: 'Two', raw: '', by: 'rakim' });

  router.handle({ platform: 'telegram', chatId: 'A', text: `/use ${i1.slug}` });
  router.handle({ platform: 'telegram', chatId: 'B', text: `/use ${i2.slug}` });
  assert.match(router.handle({ platform: 'telegram', chatId: 'A', text: 'hello' }).reply, /"one"/);
  assert.match(router.handle({ platform: 'telegram', chatId: 'B', text: 'hello' }).reply, /"two"/);
});

test('unpairing revokes access', () => {
  const { say } = paired();
  assert.match(say('/stop'), /Unpaired/);
  assert.match(say('/ideas'), /not paired/);
});

test('long replies are chunked on line boundaries, never truncated', () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const parts = chunk(body);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 4000, `chunk too long: ${p.length}`);
  assert.equal(parts.join('\n'), body, 'chunking loses nothing');

  // A single unbroken line longer than the limit still has to go out.
  const huge = chunk('y'.repeat(9000));
  assert.ok(huge.length >= 3);
  assert.equal(huge.join(''), 'y'.repeat(9000));
});
