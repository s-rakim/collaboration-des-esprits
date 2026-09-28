import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { speak, transcribe } from '../src/media.js';
import { PRESETS } from '../src/connections.js';

/** A provider that records what it was asked and answers with audio. */
async function provider(reply = null) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      url: req.url,
      auth: req.headers.authorization ?? null,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (reply) return reply(req, res);
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(512)]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return { seen, base, close: () => server.close() };
}

const dir = () => mkdtempSync(join(tmpdir(), 'esprits-voice-'));

test('the voice is chosen per call, not fixed to the connection', async () => {
  const p = await provider();
  const conn = { name: 'v', baseURL: p.base, model: 'tts-1', apiKey: 'k', extra: { voice: 'alloy' } };
  await speak({ conn, text: 'one', dir: dir() });
  await speak({ conn, text: 'two', voice: 'nova', dir: dir() });
  p.close();
  assert.equal(JSON.parse(p.seen[0].body).voice, 'alloy');
  assert.equal(JSON.parse(p.seen[1].body).voice, 'nova');
});

test("ElevenLabs' shape is described, not coded for", async () => {
  const p = await provider();
  const preset = PRESETS.find((x) => x.preset === 'ElevenLabs');
  const conn = { name: 'e', baseURL: p.base, model: preset.model, apiKey: 'xi-key', extra: preset.extra };
  await speak({ conn, text: 'hello', dir: dir() });
  p.close();

  const [call] = p.seen;
  // Its own header, the voice in the path, `model_id` rather than `model`.
  assert.equal(call.headers['xi-api-key'], 'xi-key');
  assert.equal(call.auth, null, 'the key must not also go out as a bearer token');
  assert.match(call.url, /\/text-to-speech\/21m00Tcm4TlvDq8ikWAM$/);
  const body = JSON.parse(call.body);
  assert.equal(body.model_id, preset.model);
  assert.equal(body.text, 'hello');
  assert.equal('voice' in body, false);
  assert.equal('model' in body, false);
});

test("Deepgram's scheme and query-string model are described too", async () => {
  const p = await provider();
  const preset = PRESETS.find((x) => x.preset === 'Deepgram Aura');
  const conn = { name: 'd', baseURL: p.base, model: preset.model, apiKey: 'dg', extra: preset.extra };
  await speak({ conn, text: 'hello', dir: dir() });
  p.close();

  assert.equal(p.seen[0].auth, 'Token dg');
  assert.match(p.seen[0].url, /\/speak\?model=aura-2-thalia-en/);
  assert.deepEqual(JSON.parse(p.seen[0].body), { text: 'hello' });
});

test('the audio is written where the library can serve it', async () => {
  const p = await provider();
  const where = dir();
  const out = await speak({
    conn: { name: 'v', baseURL: p.base, model: 'tts-1', apiKey: 'k' },
    text: 'something', dir: where,
  });
  p.close();
  assert.match(out.url, /^\/media\/[\w-]+\.mp3$/);
  assert.equal(out.format, 'mp3');
  const [file] = readdirSync(where);
  assert.equal(readFileSync(join(where, file)).length, out.bytes);
});

test('audio wrapped in JSON is unwrapped rather than written as a broken file', async () => {
  const p = await provider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ audioContent: Buffer.from('not really mp3, but bytes').toString('base64') }));
  });
  const where = dir();
  const out = await speak({ conn: { name: 'g', baseURL: p.base, model: 'tts', apiKey: 'k' }, text: 'x', dir: where });
  p.close();
  assert.equal(readFileSync(join(where, readdirSync(where)[0])).toString(), 'not really mp3, but bytes');
});

test('a JSON error served as a 200 becomes a message, not a silent file', async () => {
  const p = await provider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
  });
  await assert.rejects(
    speak({ conn: { name: 'v', baseURL: p.base, model: 'tts', apiKey: 'k' }, text: 'x', dir: dir() }),
    /quota exceeded/,
  );
  p.close();
});

test('speaking nothing is refused before a request is made', async () => {
  const p = await provider();
  await assert.rejects(
    speak({ conn: { name: 'v', baseURL: p.base, model: 'tts', apiKey: 'k' }, text: '   ', dir: dir() }),
    /nothing to read out/,
  );
  p.close();
  assert.equal(p.seen.length, 0);
});

test('with no voice configured it says so rather than failing obscurely', async () => {
  await assert.rejects(speak({ conn: null, text: 'x', dir: dir() }), /no text-to-speech connection/);
});

test('transcription posts the clip as multipart, with the roster as a hint', async () => {
  const p = await provider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'ship it on Friday' }));
  });
  const text = await transcribe({
    conn: { name: 'ears', baseURL: p.base, model: 'whisper-1', apiKey: 'k' },
    audio: Buffer.from('fake audio'),
    prompt: 'kestrel, nova',
  });
  p.close();
  assert.equal(text, 'ship it on Friday');
  assert.match(p.seen[0].headers['content-type'], /multipart\/form-data/);
  assert.match(p.seen[0].body, /kestrel, nova/);
  assert.match(p.seen[0].body, /whisper-1/);
});

test('every voice preset names voices you can actually pick', () => {
  const speakable = PRESETS.filter((p) => p.kind === 'speak');
  assert.ok(speakable.length >= 4, 'more than one provider should be offered');
  for (const p of speakable) {
    assert.ok(p.baseURL.startsWith('http'), `${p.preset} needs a URL`);
    assert.ok(p.model, `${p.preset} needs a model`);
    // Either a list to choose from, or a shape that says the voice is elsewhere.
    const fixed = p.extra?.voiceKey === null && p.extra?.path?.includes('{voice}') === false;
    assert.ok(p.voices?.length || fixed, `${p.preset} offers no voices and does not explain why`);
  }
});
