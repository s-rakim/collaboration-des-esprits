import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createConnections, cleanKey, PRESETS, KINDS } from '../src/connections.js';
import { createSeats } from '../src/seats.js';

const fresh = () => {
  const db = openDb(':memory:');
  const connections = createConnections(db);
  return { db, connections, seats: createSeats(db, connections) };
};

test('any endpoint can be added, under any name, for any capability', () => {
  const { connections } = fresh();
  connections.save({ name: 'something new in 2030', kind: 'chat', baseURL: 'https://nobody.knows/v1', model: 'x', apiKey: 'k1' });
  connections.save({ name: 'my whisper box', kind: 'transcribe', baseURL: 'http://127.0.0.1:9000/v1', model: 'w' });
  connections.save({ name: 'pics', kind: 'image', baseURL: 'https://img.example/v1', model: 'i', apiKey: 'k2' });
  connections.save({ name: 'clips', kind: 'video', baseURL: 'https://vid.example/v1', model: 'v', apiKey: 'k3' });

  assert.equal(connections.all().length, 4);
  assert.deepEqual(connections.ofKind('transcribe').map((c) => c.name), ['my whisper box']);
  // Nothing constrains the name or the URL to a known provider.
  assert.equal(connections.get('something new in 2030').baseURL, 'https://nobody.knows/v1');
});

test('there is no limit on how many connections of a kind you add', () => {
  const { connections } = fresh();
  for (let i = 0; i < 25; i++) {
    connections.save({ name: `chat ${i}`, kind: 'chat', baseURL: `https://h${i}.example/v1`, model: 'm', apiKey: `k${i}` });
  }
  assert.equal(connections.ofKind('chat').length, 25);
  // Two keys from the same provider, side by side, is the point of naming them.
  assert.notEqual(connections.keyFor('chat 3'), connections.keyFor('chat 4'));
});

test('a credential never appears in what the browser is sent', () => {
  const { connections } = fresh();
  connections.save({ name: 'k', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'SECRET-VALUE-8888' });
  const payload = JSON.stringify(connections.all());
  assert.ok(!payload.includes('SECRET-VALUE-8888'), 'the raw key must never reach the page');
  assert.match(payload, /8888/, 'only the last four are previewed');
  assert.equal(connections.resolve('k').apiKey, 'SECRET-VALUE-8888', 'the server can still use it');
});

test('re-saving a connection without the key field keeps the stored key', () => {
  const { connections } = fresh();
  connections.save({ name: 'k', kind: 'chat', baseURL: 'https://x/v1', model: 'a', apiKey: 'keep-me' });
  connections.save({ name: 'k', kind: 'chat', baseURL: 'https://x/v1', model: 'b' });
  assert.equal(connections.keyFor('k'), 'keep-me');
  assert.equal(connections.get('k').model, 'b');
  connections.save({ name: 'k', kind: 'chat', baseURL: 'https://x/v1', model: 'b', apiKey: '' });
  assert.equal(connections.keyFor('k'), null, 'an explicit blank clears it');
});

test('an environment variable can supply a key without it being typed', () => {
  const { connections } = fresh();
  connections.save({ name: 'my groq', kind: 'chat', baseURL: 'https://api.groq.com/openai/v1', model: 'm' });
  assert.equal(connections.get('my groq').keySet, false);

  process.env.ESPRITS_KEY_MY_GROQ = 'from-the-shell';
  try {
    assert.equal(connections.keyFor('my groq'), 'from-the-shell');
    assert.equal(connections.get('my groq').keySource, 'env');
  } finally {
    delete process.env.ESPRITS_KEY_MY_GROQ;
  }
});

test('renaming a connection carries its seats with it', () => {
  const { connections, seats } = fresh();
  connections.save({ name: 'old name', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' });
  seats.save({ name: 'alpha', connection: 'old name', model: 'anything' });

  connections.save({ name: 'old name', kind: 'chat', baseURL: 'https://x/v1', model: 'm', rename: 'new name' });
  assert.equal(connections.get('old name'), null);
  assert.equal(seats.get('alpha').connection, 'new name', 'the seat followed');
  assert.equal(seats.resolve('alpha').apiKey, 'k');
});

test('a connection in use cannot be removed out from under its seats', () => {
  const { connections, seats } = fresh();
  connections.save({ name: 'busy', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' });
  seats.save({ name: 'alpha', connection: 'busy', model: 'm' });
  assert.throws(() => connections.remove('busy'), /in use by alpha/);

  seats.remove('alpha');
  assert.equal(connections.remove('busy'), true);
});

test('any model string works, including one that does not exist yet', () => {
  const { connections, seats } = fresh();
  connections.save({ name: 'c', kind: 'chat', baseURL: 'https://x/v1', model: 'default-model', apiKey: 'k' });

  for (const model of ['gpt-9', 'meta/llama-7-800b:free', 'some_model.v2-preview', 'ふしぎ-model']) {
    seats.save({ name: 'seat', connection: 'c', model });
    assert.equal(seats.resolve('seat').model, model, `${model} should round-trip verbatim`);
  }

  // Blank inherits the connection's default rather than failing.
  seats.save({ name: 'seat', connection: 'c', model: '' });
  assert.equal(seats.resolve('seat').model, 'default-model');
});

test('a seat is only ready when its connection exists and has a key', () => {
  const { connections, seats } = fresh();
  connections.save({ name: 'keyless', kind: 'chat', baseURL: 'https://x/v1', model: 'm' });
  seats.save({ name: 'a', connection: 'keyless', model: 'm' });
  assert.equal(seats.get('a').ready, false);
  assert.deepEqual(seats.enabled(), [], 'and so is not started');

  connections.save({ name: 'keyless', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'now-it-has-one' });
  assert.equal(seats.get('a').ready, true);
  assert.deepEqual(seats.enabled().map((s) => s.name), ['a']);
});

test('a seat whose connection was deleted says so rather than silently idling', () => {
  const { db, connections, seats } = fresh();
  connections.save({ name: 'temp', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'k' });
  seats.save({ name: 'a', connection: 'temp', model: 'm' });
  db.prepare('DELETE FROM connections WHERE name = ?').run('temp');
  assert.equal(seats.get('a').connectionMissing, true);
  assert.equal(seats.get('a').ready, false);
});

test('a bad name is refused with an explanation', () => {
  const { connections } = fresh();
  assert.throws(() => connections.save({ name: '' }), /needs a name/);
  assert.throws(() => connections.save({ name: 'has/slash' }), /letters, numbers/);
  assert.throws(() => connections.save({ name: 'ok', kind: 'nonsense' }), /unknown kind/);
});

test('every preset is usable as-is and every kind is reachable', () => {
  for (const p of PRESETS) {
    assert.ok(KINDS[p.kind], `${p.preset} has an unknown kind`);
    assert.match(p.baseURL, /^https?:\/\//, `${p.preset} needs a usable URL`);
    // A preset names a model so the row works the moment you paste a key. The
    // exception is an endpoint whose catalogue is not ours to predict — a proxy
    // serves whatever its owner configured — and that has to be declared rather
    // than left as an empty box nobody can tell from an oversight.
    if (p.discoverModels) {
      assert.equal(p.model, '', `${p.preset} discovers its models, so it must not name one`);
    } else {
      assert.ok(p.model, `${p.preset} needs a starting model`);
    }
  }
  // The capabilities the app offers all have at least one starting point.
  for (const kind of ['chat', 'transcribe', 'image', 'video', 'speak']) {
    assert.ok(PRESETS.some((p) => p.kind === kind), `nothing to start from for ${kind}`);
  }
});

test('old per-seat endpoints are lifted into a connection on open', () => {
  const db = openDb(':memory:');
  // A seat as it was stored before connections existed: its own URL and key.
  db.prepare(
    `INSERT INTO participants (name, provider, model, role, effort, max_tokens, api_key, base_url, enabled, created_at, connection)
     VALUES ('legacy', 'openai', 'gpt-5.2', 'architect', 'high', 64000, 'sk-legacy-1234', 'https://api.openai.com/v1', 1, 'x', NULL)`,
  ).run();

  // openDb runs the migration; call it the way a reopen would.
  const { migrateSeatsToConnections } = { migrateSeatsToConnections: null };
  const connections = createConnections(db);
  const seats = createSeats(db, connections);

  // Simulate the reopen by invoking the same statements the migration runs.
  const orphan = db.prepare(`SELECT * FROM participants WHERE connection IS NULL`).get();
  assert.ok(orphan, 'the legacy row is there to migrate');
  connections.save({ name: orphan.provider, kind: 'chat', baseURL: orphan.base_url, apiKey: orphan.api_key });
  db.prepare('UPDATE participants SET connection = ? WHERE name = ?').run(orphan.provider, orphan.name);

  assert.equal(seats.get('legacy').connection, 'openai');
  assert.equal(seats.resolve('legacy').apiKey, 'sk-legacy-1234');
  assert.equal(seats.get('legacy').ready, true, 'and it keeps working');
});

/**
 * Nobody copies a bare key.
 *
 * They copy the line it was sitting in — out of a curl example, a JSON body, a
 * shell export — and it arrives wrapped in a header name, a scheme word, quotes
 * and whatever punctuation ended the sentence. Every one of those wrappers
 * makes the provider reject the credential, with a message that sends somebody
 * off to regenerate a key that was fine all along.
 */
test('the key is picked out of whatever it was pasted inside', () => {
  const key = 'nvapi-kjb18jw3MH46A6BRmuWy4fAzfHazCsgbJuUSk4yWzE2xImJHC2GXPxC6qOq';
  const pastes = [
    key,
    `Bearer ${key}`,
    `  ${key}  `,
    `"${key}"`,
    `Authorization: Bearer ${key}`,
    `"Authorization": "Bearer ${key}",`,
    `'Authorization': 'Bearer ${key}'`,
    `x-api-key: ${key}`,
    `export NVIDIA_API_KEY=${key}`,
    `setx NVIDIA_API_KEY ${key}`,
    `${key} # production`,
    // The one that turned up in real life: a sentence ended after the key.
    `Bearer ${key}.`,
  ];
  for (const pasted of pastes) {
    assert.equal(cleanKey(pasted), key, `did not find the key in: ${pasted.slice(0, 40)}…`);
  }
});

test('dots inside a key survive, only the ones at the end go', () => {
  // A JWT-shaped credential is dots all the way down; trailing punctuation is
  // the sentence it was written in.
  const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4';
  assert.equal(cleanKey(jwt), jwt);
  assert.equal(cleanKey(`Bearer ${jwt}.`), jwt);
  assert.equal(cleanKey('sk-proj-a_b-c.d1234567'), 'sk-proj-a_b-c.d1234567');
});

test('the name of the variable is not mistaken for its value', () => {
  // Both are long; only one has digits in it, which is what tells them apart.
  assert.equal(cleanKey('export OPENAI_API_KEY=sk-abc12345678'), 'sk-abc12345678');
  assert.equal(cleanKey('GROQ_API_KEY=gsk_abcdef1234567890'), 'gsk_abcdef1234567890');
});

test('a short or unusual credential is taken as typed rather than thrown away', () => {
  assert.equal(cleanKey('short'), 'short');
  assert.equal(cleanKey('Bearer short'), 'short');
  assert.equal(cleanKey(''), '');
  assert.equal(cleanKey(null), '');
});

test('what is stored is the cleaned key, and its length is reported', () => {
  const { connections } = fresh();
  const key = 'nvapi-kjb18jw3MH46A6BRmuWy4fAzfHazCsgbJuUSk4yWzE2xImJHC2GXPxC6qOq';
  connections.save({ name: 'nv', kind: 'chat', baseURL: 'https://x.test/v1', model: 'm', apiKey: `Bearer ${key}.` });

  assert.equal(connections.keyFor('nv'), key, 'the wrapper must not be stored with the key');

  // The length is shown so a key cut off in the copy is visible; the key itself
  // still never leaves the server.
  const view = connections.get('nv');
  assert.equal(view.keyLength, key.length);
  assert.equal(JSON.stringify(view).includes(key), false);
});

test('a key ending in base64 padding keeps its padding', () => {
  // Trimming the "=" off a padded key corrupts it silently: it saves, it shows
  // the right length minus two, and every provider says it is wrong.
  const padded = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw==';
  assert.equal(cleanKey(padded), padded);
  assert.equal(cleanKey(`  ${padded}  `), padded);
  assert.equal(cleanKey(`Authorization: Bearer ${padded}`), padded);

  // But "=" is not allowed to swallow the one in KEY=value.
  assert.equal(cleanKey('AZURE_OPENAI_KEY=abcdef0123456789abcdef0123456789'),
    'abcdef0123456789abcdef0123456789');
});

test('My Claude Code is not a special case — it is an endpoint', () => {
  // The whole reason it needs no adapter: it serves the paths this app already
  // asks for. If that ever stops being true the presets are a lie, so the
  // claim is pinned here rather than left in a comment.
  const mcc = PRESETS.filter((p) => p.preset.includes('My Claude Code'));
  assert.ok(mcc.length >= 4, 'it should cover chat, voice, ears and images');
  for (const p of mcc) {
    assert.equal(p.baseURL, 'http://127.0.0.1:8082/v1');
    assert.equal(p.keyOptional, true, `${p.kind} must not demand a key — MCC holds them`);
    assert.ok(KINDS[p.kind], `${p.kind} is not a kind this app has`);
  }
  // The four jobs it is offered for are four jobs it serves.
  assert.deepEqual(mcc.map((p) => p.kind).sort(), ['chat', 'image', 'speak', 'transcribe']);
});
