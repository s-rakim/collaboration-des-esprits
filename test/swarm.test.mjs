import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, Invalid } from '../src/core.js';
import { createConnections } from '../src/connections.js';
import { createSeats } from '../src/seats.js';
import { createSwarmRunner } from '../src/swarm.js';

/**
 * The runner is driven by a stub provider that records how many calls are in
 * flight at once — the point of a swarm being that the pieces genuinely run
 * together rather than one after another.
 */
function room() {
  const hub = new Hub({ dbPath: ':memory:' });
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  const connections = createConnections(hub.db);
  connections.save({ name: 'c', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' });
  const seats = createSeats(hub.db, connections);
  seats.save({ name: 'worker', connection: 'c', model: 'm', role: 'generalist' });
  return { hub, seats };
}

/** A stub that answers planner, worker and merger calls by their system prompt. */
function provider({ pieces = 3, workerDelay = 20, failOn = [] } = {}) {
  const stats = { inFlight: 0, peak: 0, calls: [] };
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          const system = params.messages.find((m) => m.role === 'system').content;
          const user = params.messages.find((m) => m.role === 'user').content;
          const say = (content) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });

          if (/break a goal into independent pieces/.test(system)) {
            stats.calls.push('plan');
            return say('```json\n' + JSON.stringify(
              Array.from({ length: pieces }, (_, i) => ({ title: `Piece ${i + 1}`, prompt: `do part ${i + 1}` })),
            ) + '\n```');
          }
          if (/merging the findings/.test(system)) {
            stats.calls.push('merge');
            return say(`MERGED: ${(user.match(/### /g) ?? []).length} findings`);
          }

          // A worker call: measure real concurrency.
          stats.inFlight += 1;
          stats.peak = Math.max(stats.peak, stats.inFlight);
          stats.calls.push('work');
          try {
            await new Promise((r) => setTimeout(r, workerDelay));
            const n = Number(user.match(/do part (\d+)/)?.[1] ?? 0);
            if (failOn.includes(n)) throw Object.assign(new Error('worker blew up'), { status: 500 });
            return say(`finding for part ${n}`);
          } finally {
            stats.inFlight -= 1;
          }
        },
      },
    },
  };
  return { client, stats };
}

const runnerFor = (ctx, p) =>
  createSwarmRunner({ hub: ctx.hub, seats: ctx.seats, createClient: () => p.client });

test('a swarm plans, fans out and merges into one answer', async () => {
  const ctx = room();
  const p = provider({ pieces: 4 });
  const run = ctx.hub.createSwarm({ goal: 'Review four competitors', seat: 'worker', workers: 4, by: 'rakim' });

  const done = await runnerFor(ctx, p).run({ id: run.id });
  assert.equal(done.status, 'done');
  assert.equal(done.total, 4);
  assert.equal(done.counts.done, 4);
  assert.match(done.synthesis, /MERGED: 4 findings/);
  assert.deepEqual(p.stats.calls.filter((c) => c === 'plan').length, 1);
  assert.deepEqual(p.stats.calls.filter((c) => c === 'merge').length, 1);
});

test('the pieces genuinely run at the same time, not one after another', async () => {
  const ctx = room();
  const p = provider({ pieces: 6, workerDelay: 60 });
  const run = ctx.hub.createSwarm({ goal: 'Six things', seat: 'worker', workers: 6, by: 'rakim' });

  const t0 = Date.now();
  await runnerFor(ctx, p).run({ id: run.id });
  const elapsed = Date.now() - t0;

  assert.ok(p.stats.peak >= 4, `expected several workers at once, peak was ${p.stats.peak}`);
  // Six 60ms pieces in series would be 360ms+; in parallel it is nearer one.
  assert.ok(elapsed < 300, `expected parallel timing, took ${elapsed}ms`);
});

test('the worker count is a ceiling on how many run at once', async () => {
  const ctx = room();
  const p = provider({ pieces: 8, workerDelay: 30 });
  // Eight pieces but only two workers allowed.
  const run = ctx.hub.createSwarm({ goal: 'Eight things', seat: 'worker', workers: 2, by: 'rakim' });
  await runnerFor(ctx, p).run({ id: run.id });

  assert.ok(p.stats.peak <= 2, `expected at most 2 in flight, peak was ${p.stats.peak}`);
  assert.equal(ctx.hub.getSwarm(run.id).counts.done, 2, 'the plan is capped to the worker count');
});

test('one piece failing is recorded as a gap, and the rest still merge', async () => {
  const ctx = room();
  const p = provider({ pieces: 4, failOn: [2] });
  const run = ctx.hub.createSwarm({ goal: 'Four things', seat: 'worker', workers: 4, by: 'rakim' });

  const done = await runnerFor(ctx, p).run({ id: run.id });
  assert.equal(done.status, 'done', 'a single failure does not fail the run');
  assert.equal(done.counts.done, 3);
  assert.equal(done.counts.failed, 1);
  assert.match(done.synthesis, /MERGED: 3 findings/);

  const failed = done.tasks.find((t) => t.status === 'failed');
  assert.match(failed.error, /worker blew up/, 'and the reason is kept');
});

test('a failed piece can be retried on its own', async () => {
  const ctx = room();
  const run = ctx.hub.createSwarm({
    goal: 'g', seat: 'worker', workers: 2, by: 'rakim',
    tasks: [{ title: 'A', prompt: 'a' }, { title: 'B', prompt: 'b' }],
  });
  const t = ctx.hub.claimSwarmTask({ runId: run.id });
  ctx.hub.finishSwarmTask({ taskId: t.id, error: 'network' });
  assert.equal(ctx.hub.getSwarm(run.id).counts.failed, 1);

  ctx.hub.retrySwarmTask({ taskId: t.id });
  assert.equal(ctx.hub.getSwarm(run.id).counts.queued, 2);
  assert.throws(() => ctx.hub.retrySwarmTask({ taskId: t.id }), /only a failed piece/);
});

test('every piece failing fails the run rather than merging nothing', async () => {
  const ctx = room();
  const p = provider({ pieces: 3, failOn: [1, 2, 3] });
  const run = ctx.hub.createSwarm({ goal: 'doomed', seat: 'worker', workers: 3, by: 'rakim' });

  const done = await runnerFor(ctx, p).run({ id: run.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /every piece failed/);
  assert.ok(!p.stats.calls.includes('merge'), 'and it does not waste a merge call');
});

test('the answer is kept as an artifact, not just a chat message', async () => {
  const ctx = room();
  const p = provider({ pieces: 2 });
  const idea = ctx.hub.dropIdea({ title: 'Research', raw: '', by: 'rakim' });
  const run = ctx.hub.createSwarm({ goal: 'Look into two things', seat: 'worker', workers: 2, idea: idea.slug, by: 'rakim' });

  const done = await runnerFor(ctx, p).run({ id: run.id });
  assert.ok(done.artifact, 'the write-up is an artifact');
  assert.match(ctx.hub.getArtifact(done.artifact).content, /MERGED/);
  // And the room is told, so the swarm is not invisible.
  assert.ok(ctx.hub.db.prepare("SELECT 1 FROM messages WHERE body LIKE '%Swarm%'").get());
});

test('two workers can never take the same piece', () => {
  const ctx = room();
  const run = ctx.hub.createSwarm({
    goal: 'g', seat: 'worker', workers: 4, by: 'rakim',
    tasks: Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, prompt: `p${i}` })),
  });
  const taken = [];
  for (let i = 0; i < 12; i++) {
    const t = ctx.hub.claimSwarmTask({ runId: run.id });
    if (t) taken.push(t.seq);
  }
  assert.deepEqual(taken, [0, 1, 2, 3, 4]);
  assert.equal(new Set(taken).size, taken.length, 'no piece handed out twice');
});

test('a planner that returns nonsense fails the run with a readable reason', async () => {
  const ctx = room();
  const p = provider();
  p.client.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'I would rather not.' } }] });
  const run = ctx.hub.createSwarm({ goal: 'g', seat: 'worker', workers: 3, by: 'rakim' });

  const done = await runnerFor(ctx, p).run({ id: run.id });
  assert.equal(done.status, 'failed');
  assert.match(done.error, /did not return a list/);
});

test('a swarm on a seat with no connection says so instead of hanging', async () => {
  const ctx = room();
  const run = ctx.hub.createSwarm({ goal: 'g', seat: 'nobody', workers: 2, by: 'rakim' });
  const runner = createSwarmRunner({ hub: ctx.hub, seats: ctx.seats });
  await assert.rejects(() => runner.run({ id: run.id }), /no usable connection/);
});

test('cancelling stops the queue and marks what was left', () => {
  const ctx = room();
  const run = ctx.hub.createSwarm({
    goal: 'g', seat: 'worker', workers: 2, by: 'rakim',
    tasks: [{ title: 'A', prompt: 'a' }, { title: 'B', prompt: 'b' }],
  });
  const cancelled = ctx.hub.cancelSwarm({ id: run.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.counts.failed, 2);
  assert.equal(ctx.hub.claimSwarmTask({ runId: run.id }), null, 'nothing left to claim');
});

test('a swarm needs a goal', () => {
  const ctx = room();
  assert.throws(() => ctx.hub.createSwarm({ goal: '  ', by: 'rakim' }), Invalid);
});
