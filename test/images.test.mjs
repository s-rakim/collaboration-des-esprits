import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateImage, imageFrom, nvidiaImageTargets } from '../src/media.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 7)]);

test('an image is found wherever a provider put it', () => {
  const b64 = JPEG.toString('base64');
  for (const [where, out] of Object.entries({
    'data[0].b64_json': { data: [{ b64_json: b64 }] },
    'artifacts[0].base64': { artifacts: [{ base64: b64, finishReason: 'SUCCESS', seed: 1 }] },
    'a top-level image': { image: b64, finish_reason: 'SUCCESS', seed: 1 },
    'images[0] as a string': { images: [b64] },
    'a data: address': { data: [{ b64_json: `data:image/jpeg;base64,${b64}` }] },
  })) {
    assert.deepEqual(imageFrom(out).bytes, JPEG, where);
  }
  assert.deepEqual(imageFrom({ data: [{ url: 'https://cdn.example/x.png' }] }), { url: 'https://cdn.example/x.png' });
  // Filtered: a 200 with a reason and no picture is not "returned no image", it is why.
  assert.deepEqual(imageFrom({ artifacts: [{ base64: '', finishReason: 'CONTENT_FILTERED' }] }), { why: 'content filtered' });
  assert.deepEqual(imageFrom({}), { why: null });
});

test('an NVIDIA image connection is sent to the model\'s own address, whichever host was typed', () => {
  const at = (baseURL, model) => nvidiaImageTargets({ baseURL, model })?.urls;
  // The chat host is the one a key page shows first, and it serves no images.
  assert.deepEqual(at('https://integrate.api.nvidia.com/v1', 'black-forest-labs/flux.1-dev'),
    ['https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev']);
  // A bare model name gets its publisher.
  assert.deepEqual(at('https://ai.api.nvidia.com/v1', 'flux.1-schnell'),
    ['https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell']);
  assert.deepEqual(at('https://ai.api.nvidia.com/v1', 'stable-diffusion-3-medium'),
    ['https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-3-medium']);
  // Listed with a dash, served with a dot: both are tried, as typed first.
  assert.deepEqual(at('https://integrate.api.nvidia.com/v1', 'flux-3-image-klein'), [
    'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein',
    'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.3-image-klein',
  ]);
  // The whole address pasted from a model's page is used as it is.
  assert.deepEqual(at('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b', ''),
    ['https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b']);
  // Anybody else's endpoint is not NVIDIA's business.
  assert.equal(nvidiaImageTargets({ baseURL: 'https://api.openai.com/v1', model: 'gpt-image-1' }), null);
  assert.equal(nvidiaImageTargets({ baseURL: 'https://nvidia.com.evil.example/v1', model: 'flux' }), null);
});

/** A stand-in for both kinds of image endpoint, on one port. */
async function provider() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seen.push({ path: req.url, body, auth: req.headers.authorization });
    const json = (status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/v1/images/generations') return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
    if (req.url === '/v1/genai/black-forest-labs/flux.3-image-klein') {
      if (/forbidden/.test(body.prompt)) return json(200, { artifacts: [{ base64: '', finishReason: 'CONTENT_FILTERED', seed: 0 }] });
      return json(200, { artifacts: [{ base64: JPEG.toString('base64'), finishReason: 'SUCCESS', seed: 7 }] });
    }
    json(404, { detail: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}/v1` };
}

test('the usual shape still works, and the file is named for what it is', async () => {
  const p = await provider();
  const dir = mkdtempSync(join(tmpdir(), 'esprits-img-'));
  const url = await generateImage({ conn: { name: 'img', baseURL: p.base, model: 'gpt-image-1', apiKey: 'k' }, prompt: 'a square', dir });
  assert.match(url, /^\/media\/.+\.png$/);
  assert.deepEqual(p.seen[0].body, { model: 'gpt-image-1', prompt: 'a square', n: 1 });
  p.server.close();
});

test('an NVIDIA model is asked the way it expects, and its JPEG is kept as one', async (t) => {
  const p = await provider();
  const dir = mkdtempSync(join(tmpdir(), 'esprits-img-'));
  // The real host cannot be called from a test, so the one address it would
  // use is pointed at the stand-in.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) =>
    realFetch(String(url).replace('https://ai.api.nvidia.com/v1', p.base), init));

  const conn = { name: 'st-malo', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'flux-3-image-klein', apiKey: 'nv-key' };
  const url = await generateImage({ conn, prompt: 'a lighthouse at dusk', dir });
  assert.match(url, /^\/media\/.+\.jpg$/);
  assert.deepEqual(readFileSync(join(dir, readdirSync(dir)[0])), JPEG);
  // Tried as typed, found under the dotted name.
  assert.deepEqual(p.seen.map((s) => s.path), [
    '/v1/genai/black-forest-labs/flux-3-image-klein',
    '/v1/genai/black-forest-labs/flux.3-image-klein',
  ]);
  assert.deepEqual(p.seen[1].body, { prompt: 'a lighthouse at dusk' }, 'the prompt directly — no model field, no n');
  assert.equal(p.seen[1].auth, 'Bearer nv-key');

  await assert.rejects(() => generateImage({ conn, prompt: 'something forbidden', dir }), /content filtered.*reword the prompt/);
  await assert.rejects(
    () => generateImage({ conn: { ...conn, model: 'no-such-model' }, prompt: 'x', dir }),
    /NVIDIA has no image model at no-such-model — use the name from the model's page/,
  );
  await assert.rejects(() => generateImage({ conn: { ...conn, model: '' }, prompt: 'x', dir }), /needs a model/);
  p.server.close();
});
