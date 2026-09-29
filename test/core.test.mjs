import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Invalid, NotFound } from '../src/core.js';

const hub = () => new Hub({ dbPath: ':memory:' });

/** The room as it normally exists: a human plus the preset builders. */
function staffed() {
  const h = hub();
  h.join({ name: 'rakim', role: 'human', kind: 'human' });
  h.join({ name: 'archie', role: 'architect' });
  h.join({ name: 'crit', role: 'critic' });
  h.join({ name: 'bob', role: 'backend' });
  h.join({ name: 'fay', role: 'frontend' });
  h.join({ name: 'rev', role: 'reviewer' });
  return h;
}

test('join is idempotent and keeps identity across reconnects', () => {
  const h = hub();
  const first = h.join({ name: 'archie', role: 'architect' });
  assert.equal(first.rejoined, false);
  const again = h.join({ name: 'archie', role: 'architect' });
  assert.equal(again.rejoined, true);
  assert.equal(h.roster().length, 1);
  assert.ok(again.role.charter.length > 0, 'a rejoining agent is re-told its charter');
  assert.ok(again.role.houseRules.length > 0);
});

test('agent names cannot contain spaces, because they are @mention handles', () => {
  const h = hub();
  assert.throws(() => h.join({ name: 'the architect' }), Invalid);
});

test('mentions are parsed and @all reaches everyone', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Test idea', raw: 'x', by: 'rakim' });
  h.post({ idea: idea.slug, body: 'thoughts @archie? cc @all', by: 'rakim' });
  const got = h.read({ by: 'bob', idea: idea.slug });
  const mine = got.messages.at(-1);
  assert.deepEqual(mine.mentions.sort(), ['all', 'archie']);
  const forMe = h.read({ by: 'crit', idea: idea.slug, since: 0, mentioningMe: true });
  assert.equal(forMe.messages.length, 1, '@all counts as addressed to every agent');
});

test('read advances a per-agent cursor so each agent sees only what is new to it', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Cursors', raw: '', by: 'rakim' });
  h.post({ idea: idea.slug, body: 'one', by: 'rakim' });
  const a = h.read({ by: 'bob', idea: idea.slug });
  assert.ok(a.messages.length >= 1);
  assert.equal(h.read({ by: 'bob', idea: idea.slug }).messages.length, 0, 'nothing new the second time');
  h.post({ idea: idea.slug, body: 'two', by: 'rakim' });
  assert.equal(h.read({ by: 'bob', idea: idea.slug }).messages.length, 1);
  // fay has read nothing yet, so her cursor is independent of bob's
  assert.ok(h.read({ by: 'fay', idea: idea.slug }).messages.length >= 3);
});

test('an agent cannot answer a question addressed to the human', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Auth model', raw: '', by: 'rakim' });
  const q = h.ask({ idea: idea.slug, body: 'Self-hosted or cloud?', by: 'archie', audience: 'human' });
  assert.throws(() => h.answer({ id: q.id, answer: 'cloud', by: 'bob' }), Invalid);
  const ok = h.answer({ id: q.id, answer: 'self-hosted', by: 'rakim' });
  assert.equal(ok.answeredBy, 'rakim');
  assert.equal(h.questions({ idea: idea.slug, open: true }).length, 0);
});

test('an idea cannot reach building over an empty spec or a blocking question', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Guarded', raw: '', by: 'rakim' });
  assert.throws(() => h.advance({ ref: idea.slug, stage: 'building', by: 'archie' }), /spec is still empty/);
  h.refine({ ref: idea.slug, spec: 'do the thing', by: 'archie' });
  h.ask({ idea: idea.slug, body: 'which database?', by: 'bob', audience: 'human', blocking: true });
  assert.throws(() => h.advance({ ref: idea.slug, stage: 'building', by: 'archie' }), /blocking question/);
  // force is the escape hatch, and it is explicit
  assert.equal(h.advance({ ref: idea.slug, stage: 'building', by: 'rakim', force: true }).stage, 'building');
});

test('the spec is versioned and the raw dump is never overwritten', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Versioned', raw: 'ORIGINAL INTENT', by: 'rakim' });
  h.refine({ ref: idea.slug, spec: 'v1', summary: 'first', by: 'archie' });
  h.refine({ ref: idea.slug, spec: 'v2', summary: 'second', by: 'archie' });
  const cur = h.getIdea(idea.slug);
  assert.equal(cur.spec, 'v2');
  assert.equal(cur.specRev, 2);
  assert.equal(cur.raw, 'ORIGINAL INTENT', 'refinement never rewrites what was dropped');
  assert.equal(h.specHistory(idea.slug).length, 2);
});

// ------------------------------------------------------------ collaboration

test('competing proposals are ranked, and a blocking objection holds a route', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Storage layer', raw: 'need shared state', by: 'rakim' });

  const pg = h.propose({ idea: idea.slug, title: 'Postgres', approach: 'run a server', effort: 'M', by: 'archie' });
  const lite = h.propose({ idea: idea.slug, title: 'SQLite WAL', approach: 'one file, no daemon', effort: 'S', by: 'bob' });
  assert.equal(h.getIdea(idea.slug).stage, 'proposing', 'proposing moves the idea out of raw');

  h.weighIn({ proposal: pg.id, stance: 'object', feasibility: 2, reasoning: 'needs a daemon running for two local agents to talk', blocking: true, by: 'crit' });
  h.weighIn({ proposal: lite.id, stance: 'endorse', feasibility: 5, reasoning: 'no moving parts', by: 'crit' });
  h.weighIn({ proposal: lite.id, stance: 'endorse', feasibility: 4, reasoning: 'good enough concurrency in WAL', by: 'archie' });

  assert.equal(h.getProposal(pg.id).choosable, false, 'live blocking objection holds the route');
  assert.throws(() => h.choose({ proposal: pg.id, by: 'archie' }), /blocking objection/);

  const st = h.standing({ idea: idea.slug }).contests[0];
  assert.equal(st.leader.id, lite.id, 'the better-supported route leads');
  assert.equal(h.getProposal(lite.id).feasibility, 4.5);
});

test('an objection must carry an argument, and only an objection may block', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Arguments', raw: '', by: 'rakim' });
  const p = h.propose({ idea: idea.slug, title: 'A', approach: 'a', by: 'archie' });
  assert.throws(() => h.weighIn({ proposal: p.id, stance: 'object', by: 'crit' }), /reasoning is required/);
  assert.throws(() => h.weighIn({ proposal: p.id, stance: 'endorse', blocking: true, by: 'crit' }), /only an objection/);
  assert.throws(() => h.weighIn({ proposal: p.id, stance: 'endorse', feasibility: 9, by: 'crit' }), /1-5/);
});

test('resolving an objection frees the route; re-scoring overwrites a stance', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Convergence', raw: '', by: 'rakim' });
  const p = h.propose({ idea: idea.slug, title: 'A', approach: 'a', by: 'archie' });
  h.weighIn({ proposal: p.id, stance: 'object', feasibility: 2, reasoning: 'races on write', blocking: true, by: 'crit' });
  assert.equal(h.getProposal(p.id).choosable, false);

  h.resolveObjection({ proposal: p.id, agent: 'crit', how: 'WAL plus busy_timeout covers it', by: 'archie' });
  assert.equal(h.getProposal(p.id).choosable, true);

  // crit is persuaded and updates its own score rather than leaving a stale one
  h.weighIn({ proposal: p.id, stance: 'endorse', feasibility: 4, reasoning: 'fair enough', by: 'crit' });
  const after = h.getProposal(p.id);
  assert.equal(after.assessments.length, 1, 're-scoring replaces, never duplicates');
  assert.equal(after.endorsements, 1);
  assert.equal(after.objections, 0);
});

test('choosing a route records a binding decision and closes the alternatives', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Pick one', raw: '', by: 'rakim' });
  const a = h.propose({ idea: idea.slug, title: 'A', approach: 'route a', by: 'archie' });
  const b = h.propose({ idea: idea.slug, title: 'B', approach: 'route b', by: 'bob' });
  h.weighIn({ proposal: a.id, stance: 'endorse', feasibility: 5, by: 'crit' });

  const { decision } = h.choose({ proposal: a.id, rationale: 'simplest that works', by: 'archie' });
  assert.match(decision.choice, /approach: A/);
  assert.equal(h.getProposal(b.id).status, 'rejected', 'the losing route is closed, not left dangling');
  assert.ok(h.decisions({ idea: idea.slug }).some((d) => d.alternatives.includes('B')), 'the rejected route is recorded');
});

test('the human can overrule the room and choose a held route', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Override', raw: '', by: 'rakim' });
  const p = h.propose({ idea: idea.slug, title: 'A', approach: 'a', by: 'archie' });
  h.weighIn({ proposal: p.id, stance: 'object', reasoning: 'I dislike it', blocking: true, by: 'crit' });
  assert.throws(() => h.choose({ proposal: p.id, by: 'archie' }), Invalid);
  assert.equal(h.choose({ proposal: p.id, by: 'rakim' }).proposal.status, 'chosen');
});

test('standing names what is missing rather than just ranking', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Verdicts', raw: '', by: 'rakim' });
  assert.match(h.standing({ idea: idea.slug }).contests.length ? '' : 'none', /none|^$/);
  const p = h.propose({ idea: idea.slug, title: 'A', approach: 'a', by: 'archie' });
  assert.match(h.standing({ idea: idea.slug }).contests[0].verdict, /gathering scores/);
  for (const who of ['crit', 'bob', 'fay', 'rev']) {
    h.weighIn({ proposal: p.id, stance: 'endorse', feasibility: 4, by: who });
  }
  assert.match(h.standing({ idea: idea.slug }).contests[0].verdict, /ready: choose/);
});

// ------------------------------------------------------------------- board

test('claim_next respects the blocker graph and matches on role', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Ordered build', raw: '', by: 'rakim' });
  const [schema, api, ui] = h.plan({
    idea: idea.slug,
    by: 'archie',
    tasks: [
      { title: 'schema', role: 'backend' },
      { title: 'api', role: 'backend', dependsOn: [0] },
      { title: 'screen', role: 'frontend', dependsOn: [1] },
    ],
  });

  const first = h.claimNext({ by: 'bob' });
  assert.equal(first.task.id, schema.id, 'the only unblocked backend task comes first');
  assert.ok(first.brief.digest.includes('Ordered build'), 'claiming hands over the full context pack');

  // fay's work is two hops away, so there is nothing for her yet — and she is told why
  const none = h.claimNext({ by: 'fay' });
  assert.equal(none.task, null);
  assert.match(none.why, /waiting on unfinished dependencies|other roles/);

  const { unblocked } = h.updateTask({ id: schema.id, status: 'done', result: 'tables created', by: 'bob' });
  assert.deepEqual(unblocked.map((t) => t.id), [api.id], 'finishing work announces what it frees');
  assert.equal(h.claimNext({ by: 'bob' }).task.id, api.id);
  h.updateTask({ id: api.id, status: 'done', by: 'bob' });
  assert.equal(h.claimNext({ by: 'fay' }).task.id, ui.id);
});

test('two builders racing for one task cannot both win it', () => {
  const h = staffed();
  h.join({ name: 'bob2', role: 'backend' });
  const idea = h.dropIdea({ title: 'Race', raw: '', by: 'rakim' });
  h.plan({ idea: idea.slug, by: 'archie', tasks: [{ title: 'only one', role: 'backend' }] });
  assert.ok(h.claimNext({ by: 'bob' }).task);
  assert.equal(h.claimNext({ by: 'bob2' }).task, null, 'the second builder gets nothing, not a duplicate claim');
});

test('a reviewer pulls work awaiting review and never its own', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Gate', raw: '', by: 'rakim' });
  const [t] = h.plan({ idea: idea.slug, by: 'archie', tasks: [{ title: 'build it', role: 'backend' }] });
  h.claimNext({ by: 'bob' });
  h.updateTask({ id: t.id, status: 'review', by: 'bob' });
  assert.equal(h.claimNext({ by: 'rev' }).task.id, t.id);

  // a reviewer's own task is not offered back to it
  const own = h.createTask({ idea: idea.slug, title: 'mine', role: 'backend', owner: 'rev', by: 'archie' });
  h.updateTask({ id: own.id, status: 'review', by: 'rev' });
  const next = h.claimNext({ by: 'rev' });
  assert.notEqual(next.task?.id, own.id);
});

test('a handoff returns the task to the board and carries context forward', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Baton', raw: '', by: 'rakim' });
  const [t] = h.plan({ idea: idea.slug, by: 'archie', tasks: [{ title: 'long job', role: 'backend' }] });
  h.claimNext({ by: 'bob' });

  const ho = h.handoff({
    idea: idea.slug, task: t.id, by: 'bob', toRole: 'backend',
    summary: 'migration written, resolver half done',
    nextSteps: 'finish the resolver then wire the route',
    watchOut: 'the enum is not migrated yet',
    artifacts: ['src/schema.sql'],
  });

  assert.equal(h.getTask(t.id).status, 'todo', 'handed-off work goes back on the board');
  assert.equal(h.getTask(t.id).owner, undefined);

  h.join({ name: 'bob3', role: 'backend' });
  const taken = h.takeHandoff({ id: ho.id, by: 'bob3' });
  assert.equal(taken.handoff.claimedBy, 'bob3');
  assert.match(taken.brief.digest, /migration written/);
  assert.throws(() => h.takeHandoff({ id: ho.id, by: 'bob' }), /already picked up/);
});

// ---------------------------------------------------------------- memory

test('brief hands a cold agent everything the room already settled', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Connector', raw: 'agents should share memory', by: 'rakim' });
  h.remember({ key: 'runtime', value: 'Node 22 ESM', source: 'package.json', by: 'archie' });
  h.remember({ idea: idea.slug, key: 'transport', value: 'MCP stdio + HTTP', by: 'bob' });
  h.decide({ idea: idea.slug, choice: 'SQLite over Postgres', rationale: 'no daemon for the local case', by: 'archie' });
  h.refine({ ref: idea.slug, spec: 'One sqlite file, MCP surface on top.', by: 'archie' });
  h.ask({ idea: idea.slug, body: 'Do you want a hosted mode?', by: 'crit', audience: 'human' });

  const cold = h.join({ name: 'newcomer', role: 'backend' });
  assert.ok(cold.waiting.nudges.length, 'a fresh agent is told what is waiting on it');

  const d = h.brief({ idea: idea.slug, by: 'newcomer' }).digest;
  assert.match(d, /agents should share memory/, 'carries the original intent');
  assert.match(d, /One sqlite file/, 'carries the current spec');
  assert.match(d, /do not re-open/i, 'tells the newcomer not to re-litigate');
  assert.match(d, /SQLite over Postgres/, 'carries the decision');
  assert.match(d, /no daemon for the local case/, 'carries the reasoning, not just the verdict');
  assert.match(d, /Node 22 ESM/, 'global facts reach every idea');
  assert.match(d, /MCP stdio \+ HTTP/);
  assert.match(d, /hosted mode/, 'carries the open question');
});

test('a superseded decision is retired but its history survives', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Reversal', raw: '', by: 'rakim' });
  const first = h.decide({ idea: idea.slug, choice: 'use Postgres', by: 'archie' });
  h.decide({ idea: idea.slug, choice: 'use SQLite', rationale: 'no daemon', supersedes: first.id, by: 'archie' });
  const live = h.decisions({ idea: idea.slug });
  assert.equal(live.length, 1);
  assert.equal(live[0].choice, 'use SQLite');
  assert.equal(h.decisions({ idea: idea.slug, includeRetired: true }).length, 2, 'the reversal stays auditable');
});

test('facts upsert by key per scope', () => {
  const h = staffed();
  const idea = h.dropIdea({ title: 'Scoped', raw: '', by: 'rakim' });
  h.remember({ key: 'stack', value: 'node', by: 'archie' });
  h.remember({ key: 'stack', value: 'node 22', by: 'bob' });
  h.remember({ idea: idea.slug, key: 'stack', value: 'expo', by: 'fay' });
  assert.equal(h.recall({ key: 'stack' }).length, 2, 'one global and one idea-scoped, not three');
  assert.equal(h.recall({ idea: idea.slug, key: 'stack' }).length, 2);
  h.forget({ key: 'stack', by: 'archie' });
  assert.throws(() => h.forget({ key: 'stack', by: 'archie' }), NotFound);
});

test('overview says what is stuck and why, per idea', () => {
  const h = staffed();
  const quiet = h.dropIdea({ title: 'Untouched', raw: '', by: 'rakim' });
  const asked = h.dropIdea({ title: 'Waiting on me', raw: '', by: 'rakim' });
  h.ask({ idea: asked.slug, body: 'budget?', by: 'archie', audience: 'human', blocking: true });

  const ov = h.overview();
  const a = ov.needsAttention.find((x) => x.idea === asked.slug);
  assert.ok(a.reasons.some((r) => /waiting on you/.test(r)));
  const q = ov.needsAttention.find((x) => x.idea === quiet.slug);
  assert.ok(q.reasons.some((r) => /no approach has been proposed/.test(r)));
  assert.equal(ov.totals.ideas, 2);
});

test('search finds a message by its words and can be scoped to one idea', () => {
  const h = staffed();
  const a = h.dropIdea({ title: 'First', raw: '', by: 'rakim' });
  const b = h.dropIdea({ title: 'Second', raw: '', by: 'rakim' });
  h.post({ idea: a.slug, body: 'we should use websockets for the live feed', by: 'bob' });
  h.post({ idea: b.slug, body: 'websockets are overkill here', by: 'fay' });
  assert.equal(h.search({ query: 'websockets' }).length, 2);
  assert.equal(h.search({ query: 'websockets', idea: a.slug }).length, 1);
  // punctuation must not be able to become FTS syntax
  assert.doesNotThrow(() => h.search({ query: 'feed "OR mismatched' }));
});

test('unknown references fail loudly rather than silently doing nothing', () => {
  const h = staffed();
  assert.throws(() => h.post({ idea: 'nope', body: 'x', by: 'bob' }), NotFound);
  assert.throws(() => h.post({ body: 'x', by: 'ghost' }), /no agent named/);
  assert.throws(() => h.getTask(9999), NotFound);
  assert.throws(() => h.weighIn({ proposal: 9999, stance: 'endorse', by: 'bob' }), NotFound);
});

test('a handle typed with its @ is stored without it', () => {
  const hub = new Hub({ dbPath: ':memory:' });
  // Writing your own handle as "@name" is the natural thing to do, and storing
  // it that way makes every mention of you read "@@name" and match nobody.
  const joined = hub.join({ name: '@holysukuna', role: 'human', kind: 'human' });
  assert.equal(joined.agent.name, 'holysukuna');
  // And it is the same person as the one who types it without.
  assert.equal(hub.join({ name: 'holysukuna', role: 'human', kind: 'human' }).rejoined, true);
  assert.equal(hub.roster().filter((a) => a.name === 'holysukuna').length, 1);
});

test('a name nobody could @mention is refused', () => {
  const hub = new Hub({ dbPath: ':memory:' });
  // The feed links mentions with /@([a-zA-Z0-9][\w.-]*)/, so a name outside
  // that can be joined but never addressed — which in this room is useless.
  for (const bad of ['holy sukuna', '!nope', '-lead', '.dot', '@@', '   ']) {
    assert.throws(() => hub.join({ name: bad }), /name/, `${JSON.stringify(bad)} should be refused`);
  }
  for (const good of ['rakim', 'holy.sukuna', 'agent-7', 'k3_swarm', '9lives']) {
    assert.equal(hub.join({ name: good }).agent.name, good);
  }
});
