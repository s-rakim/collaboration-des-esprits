import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createConfig } from '../src/settings.js';
import { createSeats, STARTER_SEATS } from '../src/seats.js';
import { PROVIDERS, describeProviders } from '../src/participants/providers/index.js';

const fresh = () => {
  const hub = new Hub({ dbPath: ':memory:' });
  return { hub, seats: createSeats(hub.db), config: createConfig(hub.db) };
};

test('a seat round-trips with its model, role and effort', () => {
  const { seats } = fresh();
  seats.save({ name: 'opus', model: 'claude-opus-5', role: 'architect', effort: 'max' });
  const s = seats.get('opus');
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.role, 'architect');
  assert.equal(s.effort, 'max');
  assert.equal(s.enabled, true);
});

test('saving the same name updates rather than duplicating the seat', () => {
  const { seats } = fresh();
  seats.save({ name: 'opus', model: 'claude-opus-5', role: 'architect' });
  seats.save({ name: 'opus', model: 'claude-sonnet-5', role: 'critic' });
  assert.equal(seats.all().length, 1);
  assert.equal(seats.get('opus').model, 'claude-sonnet-5');
});

test('a name with spaces is refused, because it is an @mention handle', () => {
  const { seats } = fresh();
  assert.throws(() => seats.save({ name: 'my model', model: 'claude-opus-5' }), /cannot contain spaces/);
  assert.throws(() => seats.save({ name: '', model: 'claude-opus-5' }), /needs a name/);
  assert.throws(() => seats.save({ name: 'x', model: '' }), /needs a model/);
});

test('an invalid effort is clamped to a usable one', () => {
  const { seats } = fresh();
  seats.save({ name: 'x', model: 'claude-opus-5', effort: 'ludicrous' });
  assert.equal(seats.get('x').effort, 'high');
});

test('only enabled seats are started', () => {
  const { seats } = fresh();
  seats.save({ name: 'on1', model: 'claude-opus-5' });
  seats.save({ name: 'on2', model: 'claude-sonnet-5' });
  seats.save({ name: 'off', model: 'claude-haiku-4-5', enabled: false });
  assert.deepEqual(seats.enabled().map((s) => s.name).sort(), ['on1', 'on2']);
});

test('removing a seat keeps everything that model already contributed', () => {
  const { hub, seats } = fresh();
  hub.join({ name: 'rakim', role: 'human', kind: 'human' });
  seats.save({ name: 'opus', model: 'claude-opus-5', role: 'architect' });
  hub.join({ name: 'opus', role: 'architect', model: 'claude-opus-5' });

  const idea = hub.dropIdea({ title: 'Legacy', raw: '', by: 'rakim' });
  hub.post({ idea: idea.slug, body: 'my reasoning', by: 'opus' });
  const d = hub.decide({ idea: idea.slug, choice: 'do it this way', rationale: 'because', by: 'opus' });

  assert.equal(seats.remove('opus'), true);
  assert.equal(seats.get('opus'), null);
  // The decision still stands — deleting the reasoning behind a live decision
  // because the model left would be worse than keeping it.
  assert.ok(hub.decisions({ idea: idea.slug }).some((x) => x.id === d.id));
  assert.ok(hub.db.prepare('SELECT 1 FROM messages WHERE body = ?').get('my reasoning'));
  assert.equal(seats.remove('opus'), false, 'removing twice is not an error');
});

test('a fresh install is seeded with a room that can disagree with itself', () => {
  const { seats, config } = fresh();
  const made = seats.seedIfEmpty();
  assert.equal(made.length, STARTER_SEATS.length);
  const roles = seats.all().map((s) => s.role);
  assert.ok(roles.includes('architect') && roles.includes('critic'), 'a critic ships by default');
  // Off until a key is added, so nothing tries to run without credentials.
  assert.deepEqual(seats.enabled(), []);
  // And seeding is idempotent.
  assert.deepEqual(seats.seedIfEmpty(), []);
  assert.equal(seats.all().length, STARTER_SEATS.length);
});

test('every provider advertises an adapter, a key variable and models', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.equal(typeof p.adapter, 'function', `${id} needs an adapter`);
    assert.ok(p.label && p.keyEnv, `${id} needs a label and a key env var`);
    assert.ok(Array.isArray(p.models), `${id} needs a model list`);
  }
  // Only Anthropic gets its own SDK path; the rest share the compatible one.
  assert.notEqual(PROVIDERS.anthropic.adapter, PROVIDERS.openai.adapter);
  assert.equal(PROVIDERS.google.adapter, PROVIDERS.openai.adapter);
});

test('the provider description sent to the browser carries no credentials', () => {
  const shown = JSON.stringify(describeProviders());
  assert.ok(!/apiKey|api_key/.test(shown));
  assert.match(shown, /anthropic/);
  assert.match(shown, /openrouter/);
});

test('seats on different providers each keep their own key', () => {
  const { seats } = fresh();
  seats.save({ name: 'opus', provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-1111' });
  seats.save({ name: 'gpt', provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-oai-2222' });
  assert.equal(seats.keyFor('opus'), 'sk-ant-1111');
  assert.equal(seats.keyFor('gpt'), 'sk-oai-2222');

  // And no view of a seat ever carries the raw value.
  const shown = JSON.stringify(seats.all());
  assert.ok(!shown.includes('sk-ant-1111') && !shown.includes('sk-oai-2222'));
  assert.match(shown, /1111/, 'only the last four are previewed');
});

test('re-saving a seat without the key field keeps the stored key', () => {
  const { seats } = fresh();
  seats.save({ name: 'gpt', provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-keep-me' });
  seats.save({ name: 'gpt', provider: 'openai', model: 'gpt-5-mini', role: 'critic' });
  assert.equal(seats.keyFor('gpt'), 'sk-keep-me');
  assert.equal(seats.get('gpt').model, 'gpt-5-mini');

  // An explicit empty string is a deliberate clear.
  seats.save({ name: 'gpt', provider: 'openai', model: 'gpt-5-mini', apiKey: '' });
  assert.equal(seats.keyFor('gpt'), null);
});

test("a provider's conventional env var is the fallback when a seat has no key", () => {
  const { seats } = fresh();
  seats.save({ name: 'gem', provider: 'google', model: 'gemini-3-pro' });
  assert.equal(seats.get('gem').keySet, false);

  process.env.GOOGLE_API_KEY = 'AIza-from-env';
  try {
    assert.equal(seats.keyFor('gem'), 'AIza-from-env');
    assert.equal(seats.get('gem').keySet, true);
    assert.equal(seats.get('gem').keySource, 'env');
  } finally {
    delete process.env.GOOGLE_API_KEY;
  }
});

test('a local provider that needs no key is still usable', () => {
  const { seats } = fresh();
  seats.save({ name: 'local', provider: 'ollama', model: 'qwen3' });
  assert.equal(seats.get('local').keySet, true, 'a local runner needs no credential');
});

test('an unknown provider is refused', () => {
  const { seats } = fresh();
  assert.throws(() => seats.save({ name: 'x', provider: 'skynet', model: 'm' }), /unknown provider/);
});
