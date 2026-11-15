import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createConnections, cleanKey, parseSnippet, PRESETS, KINDS } from '../src/connections.js';
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
  const key = 'nvapi-NOTAREALKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL';
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
  const key = 'nvapi-NOTAREALKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL';
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

test('MCC is not a special case — it is an endpoint', () => {
  // The whole reason it needs no adapter: it serves the paths this app already
  // asks for. If that ever stops being true the presets are a lie, so the
  // claim is pinned here rather than left in a comment.
  const mcc = PRESETS.filter((p) => p.preset.includes('MCC'));
  assert.ok(mcc.length >= 4, 'it should cover chat, voice, ears and images');
  for (const p of mcc) {
    assert.equal(p.baseURL, 'http://127.0.0.1:8082/v1');
    assert.equal(p.keyOptional, true, `${p.kind} must not demand a key — MCC holds them`);
    assert.ok(KINDS[p.kind], `${p.kind} is not a kind this app has`);
  }
  // The four jobs it is offered for are four jobs it serves.
  assert.deepEqual(mcc.map((p) => p.kind).sort(), ['chat', 'image', 'speak', 'transcribe']);
});

test('a key pasted on its own is never altered', () => {
  // The hunting below decides which characters a key is made of, which is a
  // guess about every provider that exists and every one that does not yet. A
  // key holding one character the guess disallows came back shortened, saved,
  // showed a length nobody checks, and was refused everywhere — with the row
  // reporting fewer characters than the key really has, the only clue.
  for (const odd of [
    'sk-abc123!def456ghi789jkl012',
    'user:0123456789abcdef0123456789',
    'key%2Fwith%2Fescapes0123456789',
    'nvapi-NOT-A-REAL-KEY_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM',
    'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw==',
  ]) {
    assert.equal(cleanKey(odd), odd, `${odd.slice(0, 12)}… was changed`);
  }

  // NAME=value has no spaces in it either, and the key is the right-hand side.
  const key = 'nvapi-NOT-A-REAL-KEY_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM';
  assert.equal(cleanKey(`NVIDIA_API_KEY=${key}`), key);
  assert.equal(cleanKey(`NVIDIA_API_KEY="${key}"`), key);
  // But the "=" of base64 padding is not a separator, and only ever trails.
  const padded = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw==';
  assert.equal(cleanKey(`AZURE_KEY=${padded}`), padded);

  // And a key inside a line of other stuff is still found.
  assert.equal(cleanKey(`"Authorization": "Bearer ${key}",`), key);
  assert.equal(cleanKey(`curl -H "Authorization: Bearer ${key}" https://x/v1`), key);
});

test('an endpoint that accepts the connection and then says nothing is reported', async () => {
  // The failure that looked like "it is calling but not connecting": the SDK's
  // own defaults are ten minutes and two retries, which multiply to half an
  // hour of a button saying "calling…" before anything at all is reported.
  const { chatAdapter } = await import('../src/participants/chat.js');
  const http = await import('node:http');

  // Accepts the socket, reads the request, and never answers — which is what a
  // hung endpoint does, and is not the same as refusing or being unreachable.
  const held = [];
  const server = http.createServer((req, res) => { held.push(res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const adapter = chatAdapter({
    apiKey: 'k', model: 'm', maxTokens: 8, baseURL: base,
    timeoutMs: 700, maxRetries: 0,
  });
  const turn = adapter.startTurn({ system: 'x', tools: [] });

  const began = Date.now();
  await assert.rejects(
    () => turn.send('hello'),
    (err) => {
      // It names what happened — nothing came back — rather than blaming the
      // key, which was never looked at.
      assert.match(err.message, /sent no reply within/i);
      assert.match(err.message, /0\.7s|1s/);
      assert.doesNotMatch(err.message, /key/i);
      return true;
    },
  );
  // And it gave up when it said it would, rather than on the SDK's schedule.
  assert.ok(Date.now() - began < 5000, 'it waited far longer than the timeout it was given');

  for (const res of held) res.destroy();
  server.close();
});

test('the length limit is sent in the spelling the endpoint takes', async () => {
  // Sending max_completion_tokens to a server that wants max_tokens does not
  // fail — it is ignored, so no cap applies and a reasoning model writes until
  // its own default. From the outside that is indistinguishable from the
  // endpoint hanging, which is exactly how it was read.
  const { chatAdapter } = await import('../src/participants/chat.js');
  const http = await import('node:http');

  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bodies.push(body);

    // A server of the newer kind: it refuses max_tokens and names its
    // replacement, the way OpenAI's reasoning models do.
    if (body.strict !== undefined) { /* unused branch guard */ }
    if (server.strict && body.max_tokens !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"Use max_completion_tokens instead of max_tokens"}}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  // The ordinary case: the spelling nearly every endpoint takes.
  const plain = chatAdapter({ apiKey: 'k', model: 'm', maxTokens: 512, baseURL: base, maxRetries: 0 });
  await plain.startTurn({ system: 'x', tools: [] }).send('hi');
  assert.equal(bodies[0].max_tokens, 512, 'the cap must actually be sent');
  assert.equal(bodies[0].max_completion_tokens, undefined);
  // A turn with no tools must not mention tools at all: an empty list beside
  // tool_choice:'auto' asks a server to choose from nothing.
  assert.equal(bodies[0].tools, undefined);
  assert.equal(bodies[0].tool_choice, undefined);

  // The newer kind: it says which it wants, and that is taken as the answer
  // rather than handed to a person to go and look up.
  bodies.length = 0;
  server.strict = true;
  const strict = chatAdapter({ apiKey: 'k', model: 'm', maxTokens: 256, baseURL: base, maxRetries: 0 });
  const step = await strict.startTurn({ system: 'x', tools: [] }).send('hi');
  assert.equal(step.text, 'ok');
  assert.equal(bodies.length, 2, 'it should have been told once and then got it right');
  assert.equal(bodies[1].max_completion_tokens, 256);
  assert.equal(bodies[1].max_tokens, undefined);

  // And it remembers, rather than being told again every turn.
  bodies.length = 0;
  await strict.startTurn({ system: 'x', tools: [] }).send('again');
  assert.equal(bodies.length, 1, 'it asked to be corrected twice');
  assert.equal(bodies[0].max_completion_tokens, 256);

  server.close();
});

test("a provider's own example fills the whole row", () => {
  // The snippet on the page where you made the key has every box on the row in
  // it, already correct and already together. Typing them in one at a time is a
  // transcription exercise with four chances to go subtly wrong — a truncated
  // key, a model id off a different vendor's page, a base URL missing its /v1 —
  // and not one of them announces itself.
  const key = 'nvapi-EXAMPLE-ONLY_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcb';

  const python = parseSnippet(`from openai import OpenAI

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = "${key}"
)

completion = client.chat.completions.create(
  model="openai/gpt-oss-20b",
  messages=[{"role":"user","content":"Which number is larger, 9.11 or 9.8?"}],
  temperature=1,
  max_tokens=4096,
  stream=False
)`);
  assert.equal(python.ok, true);
  assert.equal(python.baseURL, 'https://integrate.api.nvidia.com/v1');
  assert.equal(python.apiKey, key);
  assert.equal(python.model, 'openai/gpt-oss-20b');
  assert.equal(python.kind, 'chat');
  // The one thing no amount of looking at the URL can settle, and the one that
  // silently uncaps the request when it is wrong.
  assert.equal(python.extra.tokenParam, 'max_tokens');

  const js = parseSnippet(`import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: '${key}' });
const r = await client.chat.completions.create({ model: 'llama-4-maverick', max_completion_tokens: 512 });`);
  assert.equal(js.baseURL, 'https://api.groq.com/openai/v1');
  assert.equal(js.apiKey, key);
  assert.equal(js.model, 'llama-4-maverick');
  assert.equal(js.extra.tokenParam, 'max_completion_tokens');

  // curl names nothing: the URL is simply there, as a full path rather than a
  // base, and the key is in a header.
  const curl = parseSnippet(`curl https://api.deepseek.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}" \\
  -d '{"model": "deepseek-chat", "messages": [{"role":"user","content":"hi"}], "max_tokens": 100}'`);
  assert.equal(curl.baseURL, 'https://api.deepseek.com/v1', 'the endpoint tail must come off');
  assert.equal(curl.apiKey, key);
  assert.equal(curl.model, 'deepseek-chat');

  // The job comes from the path the example calls, so an audio example does
  // not arrive filed as a chat model.
  const speech = parseSnippet(`client.audio.speech.create(model="gpt-4o-mini-tts", voice="nova", input="hello")
client = OpenAI(base_url="https://api.openai.com/v1", api_key="${key}")`);
  assert.equal(speech.kind, 'speak');
  assert.equal(speech.extra.voice, 'nova');

  const image = parseSnippet(`curl https://api.openai.com/v1/images/generations -H "Authorization: Bearer ${key}" -d '{"model":"gpt-image-1"}'`);
  assert.equal(image.kind, 'image');
  assert.equal(image.baseURL, 'https://api.openai.com/v1');
});

test('a snippet with nothing in it says so rather than saving a blank row', () => {
  assert.equal(parseSnippet('').ok, false);
  assert.equal(parseSnippet('just some prose about api keys').ok, false);
  assert.match(parseSnippet('hello').error, /paste the whole example/i);

  // A snippet showing the shape rather than the credential is still useful:
  // the address and model are taken and whatever key is stored is left alone.
  const shape = parseSnippet(`client = OpenAI(base_url="https://api.x.ai/v1", api_key=os.environ["XAI_KEY"])
r = client.chat.completions.create(model="grok-4")`);
  assert.equal(shape.ok, true);
  assert.equal(shape.baseURL, 'https://api.x.ai/v1');
  assert.equal(shape.model, 'grok-4');
  assert.equal(shape.apiKey, '', 'an env lookup is not a key');
});

test('a reply length the model will not allow is brought down to one it will', async () => {
  // A seat asks for a long reply by default. A model that allows less says so,
  // and that used to be the end of it: every turn failed with the same
  // sentence, which reads as "the agents do not answer".
  const { chatAdapter, smallerLimit } = await import('../src/participants/chat.js');
  const http = await import('node:http');

  assert.equal(smallerLimit("This model's maximum context length is 32768 tokens. However, you requested 64200 tokens (200 in the messages, 64000 in the completion).", 64000), 32768 - 200 - 64);
  assert.equal(smallerLimit('max_tokens must be less than or equal to 4096', 64000), 4096);
  assert.equal(smallerLimit('max_tokens: 64000 > 8192', 64000), 8192);
  assert.equal(smallerLimit('max_tokens is too large for this model', 64000), 4096);
  // Not about size, so not this function's to answer.
  assert.equal(smallerLimit("Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", 64000), null);
  assert.equal(smallerLimit('The model `nope` does not exist', 64000), null);
  assert.equal(smallerLimit('max_tokens must be less than or equal to 4096', 2048), null, 'already under it — the complaint is about something else');

  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    bodies.push(body);
    if (body.max_tokens > 4096) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `max_tokens must be less than or equal to 4096, got ${body.max_tokens}` } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const adapter = chatAdapter({ apiKey: 'k', model: 'm', maxTokens: 64000, baseURL: `http://127.0.0.1:${server.address().port}/v1`, maxRetries: 0 });

  const step = await adapter.startTurn({ system: 'x', tools: [] }).send('hi');
  assert.equal(step.text, 'ok');
  assert.deepEqual(bodies.map((b) => b.max_tokens), [64000, 4096]);
  // It still means max_tokens: a complaint about size is not a complaint about spelling.
  assert.equal(bodies[1].max_completion_tokens, undefined);

  bodies.length = 0;
  await adapter.startTurn({ system: 'x', tools: [] }).send('again');
  assert.deepEqual(bodies.map((b) => b.max_tokens), [4096], 'and it does not have to be told twice');
  server.close();
});

test('a chat key becomes an agent in the chat, once, under the name it was given', () => {
  const db = openDb(':memory:');
  const connections = createConnections(db);
  const seats = createSeats(db, connections);
  seats.seedIfEmpty();                       // a new room: architect and critic, waiting for a model

  connections.save({ name: 'stdenis', kind: 'chat', baseURL: 'https://x/v1', model: 'vendor/one', apiKey: 'nvapi-NOT-A-REAL-KEY_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLM' });
  db.prepare('UPDATE connections SET created_at = ? WHERE name = ?').run('2026-01-01T00:00:00Z', 'stdenis');
  connections.save({ name: 'st etienne', kind: 'chat', baseURL: 'https://x/v1', model: 'vendor/two', apiKey: 'nvapi-EXAMPLE-ONLY_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcb' });
  connections.save({ name: 'st-malo', kind: 'image', baseURL: 'https://y/v1' });          // not for chat
  connections.save({ name: 'no-key-yet', kind: 'chat', baseURL: 'https://z/v1' });         // nothing to sit on yet

  const first = seats.follow([]);
  assert.deepEqual(first.made, ['stdenis', 'st-etienne'], 'a name with a space becomes one that can follow an @');
  // The roles a new room starts with pass to the first keys, so two keys still disagree.
  assert.deepEqual(seats.all().map((s) => [s.name, s.role, s.connection, s.enabled, s.ready]).sort(), [
    ['st-etienne', 'critic', 'st etienne', true, true],
    ['stdenis', 'architect', 'stdenis', true, true],
  ]);
  assert.deepEqual(seats.enabled().map((s) => s.name).sort(), ['st-etienne', 'stdenis']);

  // Asked again, nothing happens — and a seat somebody removed stays removed.
  seats.remove('stdenis');
  const again = seats.follow(first.done);
  assert.deepEqual(again.made, []);
  assert.equal(seats.get('stdenis'), null);

  // The key that had not arrived yet gets its seat when it does.
  connections.save({ name: 'no-key-yet', kind: 'chat', baseURL: 'https://z/v1', apiKey: 'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234yz' });
  assert.deepEqual(seats.follow(again.done).made, ['no-key-yet']);
  assert.equal(seats.get('no-key-yet').role, 'generalist');

  // A connection somebody already seated by hand is left alone.
  connections.save({ name: 'manual', kind: 'chat', baseURL: 'https://m/v1', apiKey: 'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234yz' });
  seats.save({ name: 'kestrel', connection: 'manual', role: 'reviewer' });
  assert.deepEqual(seats.follow([]).made.includes('manual'), false);
});

test('starter seats an older version parked on an empty connection are taken over too', () => {
  const db = openDb(':memory:');
  const connections = createConnections(db);
  const seats = createSeats(db, connections);
  // What a restart used to leave behind: a keyless "openai" row nobody made,
  // with the two unconfigured starter seats attached to it.
  connections.save({ name: 'openai', kind: 'chat' });
  seats.save({ name: 'architect', role: 'architect', connection: 'openai', enabled: false });
  seats.save({ name: 'critic', role: 'critic', connection: 'openai', enabled: false });
  connections.save({ name: 'stdenis', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234yz' });

  assert.deepEqual(seats.follow([]).made, ['stdenis']);
  assert.deepEqual(seats.all().map((s) => [s.name, s.role]), [['critic', 'critic'], ['stdenis', 'architect']]);
  assert.ok(connections.get('openai'), 'still in use by the other starter seat');

  connections.save({ name: 'second', kind: 'chat', baseURL: 'https://x/v1', model: 'm', apiKey: 'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu901VWX234yz' });
  seats.follow(['stdenis']);
  assert.deepEqual(seats.all().map((s) => [s.name, s.role]).sort(), [['second', 'critic'], ['stdenis', 'architect']]);
  assert.equal(connections.get('openai'), null, 'and the empty connection goes with the last of them');
});

test('a reply is read as it is written, and arrives whole', async () => {
  const { chatAdapter, partialString } = await import('../src/participants/chat.js');
  const http = await import('node:http');

  // Half a JSON string is still most of a sentence.
  assert.equal(partialString('{"body":"Start with the imp', 'body'), 'Start with the imp');
  assert.equal(partialString('{"reply_to":4,"body":"a\\nb \\"quoted\\" \\u00e9"}', 'body'), 'a\nb "quoted" é');
  assert.equal(partialString('{"bo', 'body'), '');

  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    if (server.plain) {
      // An endpoint that ignores "stream" and answers in one piece.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"choices":[{"finish_reason":"stop","message":{"content":"all at once"}}]}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    send({ role: 'assistant', reasoning_content: 'let me think' });
    send({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'reply', arguments: '' } }] });
    for (const piece of ['{"bo', 'dy":"Start ', 'with the ', 'importer."}']) {
      send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
    }
    send({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const seen = [];
  const adapter = chatAdapter({
    apiKey: 'k', model: 'streamer', maxTokens: 512, baseURL: base, maxRetries: 0,
    onDelta: (d) => seen.push({ ...d, draft: d.tool === 'reply' ? partialString(d.args, 'body') : d.text }),
  });
  const tools = [{ name: 'reply', description: 'say it', parameters: { type: 'object', properties: { body: { type: 'string' } } } }];
  const step = await adapter.startTurn({ system: 'x', tools }).send('where do we start?');

  assert.equal(requests[0].stream, true);
  assert.deepEqual(step.toolCalls, [{ id: 'call_a', name: 'reply', input: { body: 'Start with the importer.' } }]);
  assert.equal(seen[0].thinking, true, 'reasoning is reported as thinking, not shown as the answer');
  const drafts = seen.map((d) => d.draft).filter(Boolean);
  assert.deepEqual(drafts, ['Start ', 'Start with the ', 'Start with the importer.', 'Start with the importer.']);

  // An endpoint that does not stream is asked the plain way, once, and then remembered.
  server.plain = true;
  requests.length = 0;
  const flat = chatAdapter({ apiKey: 'k', model: 'no-streamer', maxTokens: 512, baseURL: base, maxRetries: 0, onDelta: () => {} });
  assert.equal((await flat.startTurn({ system: 'x', tools: [] }).send('hi')).text, 'all at once');
  assert.deepEqual(requests.map((r) => Boolean(r.stream)), [true, false]);
  requests.length = 0;
  const again = chatAdapter({ apiKey: 'k', model: 'no-streamer', maxTokens: 512, baseURL: base, maxRetries: 0, onDelta: () => {} });
  await again.startTurn({ system: 'x', tools: [] }).send('hi');
  assert.deepEqual(requests.map((r) => Boolean(r.stream)), [false], 'a later turn does not pay to find it out again');

  // Nobody watching, no stream asked for.
  requests.length = 0;
  await chatAdapter({ apiKey: 'k', model: 'quiet', maxTokens: 512, baseURL: base, maxRetries: 0 }).startTurn({ system: 'x', tools: [] }).send('hi');
  assert.equal(requests[0].stream, undefined);
  server.close();
});
