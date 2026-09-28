import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createConnections } from '../src/connections.js';
import { createSeats, STARTER_SEATS } from '../src/seats.js';

const fresh = () => {
  const hub = new Hub({ dbPath: ':memory:' });
  const connections = createConnections(hub.db);
  return { hub, connections, seats: createSeats(hub.db, connections) };
};

const withChat = (ctx, name = 'c') => {
  ctx.connections.save({ name, kind: 'chat', baseURL: 'https://x/v1', model: 'default', apiKey: 'k' });
  return name;
};

test('a seat round-trips with its connection, model, role and effort', () => {
  const ctx = fresh();
  withChat(ctx);
  ctx.seats.save({ name: 'gpt', connection: 'c', model: 'anything-at-all', role: 'architect', effort: 'max' });
  const s = ctx.seats.get('gpt');
  assert.equal(s.connection, 'c');
  assert.equal(s.model, 'anything-at-all');
  assert.equal(s.role, 'architect');
  assert.equal(s.effort, 'max');
  assert.equal(s.enabled, true);
});

test('saving the same name updates rather than duplicating the seat', () => {
  const ctx = fresh();
  withChat(ctx);
  ctx.seats.save({ name: 'gpt', connection: 'c', model: 'a', role: 'architect' });
  ctx.seats.save({ name: 'gpt', connection: 'c', model: 'b', role: 'critic' });
  assert.equal(ctx.seats.all().length, 1);
  assert.equal(ctx.seats.get('gpt').model, 'b');
});

test('a name with spaces is refused, because it is an @mention handle', () => {
  const ctx = fresh();
  withChat(ctx);
  assert.throws(() => ctx.seats.save({ name: 'my model', connection: 'c' }), /cannot contain spaces/);
  assert.throws(() => ctx.seats.save({ name: '', connection: 'c' }), /needs a name/);
});

test('an invalid effort is clamped to a usable one', () => {
  const ctx = fresh();
  withChat(ctx);
  ctx.seats.save({ name: 'x', connection: 'c', model: 'm', effort: 'ludicrous' });
  assert.equal(ctx.seats.get('x').effort, 'high');
});

test('only seats that are both enabled and ready are started', () => {
  const ctx = fresh();
  withChat(ctx, 'ready');
  ctx.connections.save({ name: 'keyless', kind: 'chat', baseURL: 'https://y/v1', model: 'm' });
  ctx.seats.save({ name: 'on', connection: 'ready', model: 'm' });
  ctx.seats.save({ name: 'nokey', connection: 'keyless', model: 'm' });
  ctx.seats.save({ name: 'off', connection: 'ready', model: 'm', enabled: false });
  assert.deepEqual(ctx.seats.enabled().map((s) => s.name), ['on']);
});

test('removing a seat keeps everything that model already contributed', () => {
  const ctx = fresh();
  withChat(ctx);
  ctx.hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  ctx.seats.save({ name: 'gpt', connection: 'c', model: 'm', role: 'architect' });
  ctx.hub.join({ name: 'gpt', role: 'architect', model: 'm' });

  const idea = ctx.hub.dropIdea({ title: 'Legacy', raw: '', by: 'rakim' });
  ctx.hub.post({ idea: idea.slug, body: 'my reasoning', by: 'gpt' });
  const d = ctx.hub.decide({ idea: idea.slug, choice: 'do it this way', rationale: 'because', by: 'gpt' });

  assert.equal(ctx.seats.remove('gpt'), true);
  assert.equal(ctx.seats.get('gpt'), null);
  // The decision still stands — deleting the reasoning behind a live decision
  // because the model left would be worse than keeping it.
  assert.ok(ctx.hub.decisions({ idea: idea.slug }).some((x) => x.id === d.id));
  assert.ok(ctx.hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('my reasoning'));
  assert.equal(ctx.seats.remove('gpt'), false, 'removing twice is not an error');
});

test('a fresh install is seeded with a room that can disagree with itself', () => {
  const ctx = fresh();
  const made = ctx.seats.seedIfEmpty();
  assert.equal(made.length, STARTER_SEATS.length);
  const roles = ctx.seats.all().map((s) => s.role);
  assert.ok(roles.includes('architect') && roles.includes('critic'), 'a critic ships by default');
  // Off until connections exist, so nothing tries to call an endpoint it lacks.
  assert.deepEqual(ctx.seats.enabled(), []);
  assert.deepEqual(ctx.seats.seedIfEmpty(), [], 'and seeding is idempotent');
});
