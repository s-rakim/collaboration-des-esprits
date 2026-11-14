import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';

/**
 * Calls to endpoints that deal in audio, images and video.
 *
 * Everything here goes through a named connection, so which provider serves a
 * capability is the user's choice and adding another needs no code. The request
 * shapes below are the OpenAI-compatible ones, which most providers copy; where
 * one differs, a connection's `extra` overrides the pieces that matter rather
 * than requiring a new adapter.
 *
 * Generated files are written next to the database and served from /media.
 */

const TIMEOUT_MS = 180_000; // generation is slow; a minute is not enough

export function mediaDir(dbPath) {
  const base = dbPath && dbPath !== ':memory:' ? dirname(resolve(dbPath)) : resolve('./data');
  const dir = join(base, 'media');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const joinUrl = (base, path) => `${String(base).replace(/\/+$/, '')}${path}`;

/**
 * Headers for a connection, including any the user added in `extra`.
 *
 * Most providers take a bearer token. Enough of them do not — ElevenLabs wants
 * `xi-api-key`, Deepgram wants `Token` rather than `Bearer` — that the two
 * escape hatches are worth having: `extra.keyHeader` puts the credential in a
 * header of your choosing, `extra.keyScheme` changes the word in front of it.
 */
function headers(conn, extra = {}) {
  const h = { ...extra, ...(conn.extra?.headers ?? {}) };
  if (conn.apiKey) {
    const named = conn.extra?.keyHeader;
    if (named) {
      if (!Object.keys(h).some((k) => k.toLowerCase() === String(named).toLowerCase())) {
        h[named] = conn.apiKey;
      }
    } else if (!Object.keys(h).some((k) => k.toLowerCase() === 'authorization')) {
      h.Authorization = `${conn.extra?.keyScheme ?? 'Bearer'} ${conn.apiKey}`;
    }
  }
  return h;
}

async function call(conn, path, { body, json = true, method = 'POST', accept, exact = false } = {}) {
  // `exact` means the caller already worked the path out, placeholders and all,
  // so a connection-level override must not be applied a second time.
  const url = joinUrl(conn.baseURL, exact ? path : (conn.extra?.path ?? path));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: headers(conn, json ? { 'Content-Type': 'application/json' } : {}),
      body: json ? JSON.stringify(body) : body,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${conn.name} returned ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    if (accept === 'buffer') return Buffer.from(await res.arrayBuffer());
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${conn.name} timed out after ${TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Write bytes into the media directory and return the URL the page will use. */
function store(dir, bytes, ext) {
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, file), bytes);
  return `/media/${file}`;
}

// ------------------------------------------------------------- speech to text

/**
 * Transcribe an audio clip. Multipart, as every implementation of this endpoint
 * expects — including local whisper.cpp servers.
 */
export async function transcribe({ conn, audio, filename = 'clip.webm', mimeType = 'audio/webm', prompt }) {
  if (!conn) throw new Error('no speech-to-text connection is configured');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), filename);
  form.append('model', conn.model || 'whisper-1');
  form.append('response_format', 'json');
  // A prompt biases the transcriber toward names it would otherwise mangle —
  // the agent names in the room, for instance.
  if (prompt) form.append('prompt', prompt.slice(0, 900));

  const out = await call(conn, '/audio/transcriptions', { body: form, json: false });
  const text = (out.text ?? out.transcript ?? '').trim();
  if (!text) throw new Error(`${conn.name} returned no transcript`);
  return text;
}

// ------------------------------------------------------------- text to speech

/** File extension for the audio format asked for. */
const AUDIO_EXT = { mp3: 'mp3', opus: 'opus', aac: 'aac', flac: 'flac', wav: 'wav', pcm: 'wav', mp4: 'mp4', ogg: 'ogg' };

/** Some providers hand back JSON with the audio inside it rather than bytes. */
function audioFromJson(out) {
  const found = out?.audio ?? out?.audioContent ?? out?.b64_json ?? out?.data?.[0]?.b64_json
    ?? out?.data?.[0]?.audio ?? (typeof out?.data === 'string' ? out.data : undefined);
  return typeof found === 'string' ? Buffer.from(found, 'base64') : null;
}

/**
 * Read text aloud.
 *
 * The voice matters more than any other setting here — it is the one the room
 * speaks with in live chat, and the one that makes an audio generation worth
 * keeping — so it is overridable per call, not just per connection. Everything
 * about the request shape can be redescribed in `extra`, because the providers
 * worth using disagree about all of it: where the text goes, what the voice
 * field is called, whether the model id is `model` or `model_id`.
 */
export async function speak({ conn, text, voice, speed, format, dir }) {
  if (!conn) throw new Error('no text-to-speech connection is configured');
  const body = String(text ?? '').trim();
  if (!body) throw new Error('there is nothing to read out');

  const ex = conn.extra ?? {};
  const chosen = voice || ex.voice || 'alloy';
  const fmt = String(format || ex.format || 'mp3').toLowerCase();
  const rate = Number(speed ?? ex.speed ?? 0);

  // A key set to null means "this provider does not take that field" — Deepgram
  // puts the model in the query string, ElevenLabs puts the voice in the path.
  const payload = {
    ...(ex.modelKey === null ? {} : { [ex.modelKey ?? 'model']: conn.model || 'gpt-4o-mini-tts' }),
    [ex.textKey ?? 'input']: body.slice(0, 4000),
    // voiceKey: null is how a provider says "the voice is in the URL, not the body".
    ...(ex.voiceKey === null ? {} : { [ex.voiceKey ?? 'voice']: chosen }),
    ...(rate ? { [ex.speedKey ?? 'speed']: rate } : {}),
    ...(ex.formatKey === null ? {} : { [ex.formatKey ?? 'response_format']: fmt }),
    ...(ex.body ?? {}),
  };

  const path = String(ex.path ?? '/audio/speech').replace('{voice}', encodeURIComponent(chosen));
  const bytes = await call(conn, path, { body: payload, accept: 'buffer', exact: true });

  // Audio starts with ID3, 0xFF, RIFF or OggS — never with a brace. A brace
  // means JSON: either the audio wrapped in base64, or an error dressed as a
  // 200, and both are better handled than written to disk as a silent file.
  if (/^\s*[{[]/.test(bytes.subarray(0, 8).toString('utf8'))) {
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
    const decoded = parsed && audioFromJson(parsed);
    if (!decoded) throw new Error(`${conn.name} returned no audio: ${bytes.toString('utf8').slice(0, 200)}`);
    return { url: store(dir, decoded, AUDIO_EXT[fmt] ?? 'mp3'), voice: chosen, format: fmt, bytes: decoded.length };
  }

  return {
    url: store(dir, bytes, AUDIO_EXT[fmt] ?? 'mp3'),
    voice: chosen,
    format: fmt,
    bytes: bytes.length,
  };
}

// -------------------------------------------------------------------- images

/**
 * Where an image is, in whatever a provider sent back.
 *
 * There is no one shape. OpenAI and those who copy it use data[0].b64_json or
 * data[0].url; NVIDIA's catalogue uses artifacts[0].base64 for most models and
 * a bare top-level "image" for some; others use images[0] or output[0]. All of
 * them are a base64 string or a link, so they are looked for by what they are.
 */
export function imageFrom(out) {
  const first = out?.data?.[0] ?? out?.artifacts?.[0] ?? out?.images?.[0] ?? out?.output?.[0] ?? out;
  const pick = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
  const found = typeof first === 'string' ? first
    : pick(first?.b64_json) ?? pick(first?.base64) ?? pick(first?.image) ?? pick(first?.url) ?? pick(first?.image_url)
      ?? pick(out?.image) ?? pick(out?.url);
  // A provider that filtered the prompt answers 200 with a reason and no picture.
  const why = first?.finishReason ?? first?.finish_reason ?? out?.finish_reason ?? out?.finishReason;
  if (!found || (why && !/^(success|stop)$/i.test(String(why)) && String(found).length < 200)) {
    return { why: why ? String(why).toLowerCase().replace(/_/g, ' ') : null };
  }
  if (/^https?:\/\//i.test(found)) return { url: found };
  return { bytes: Buffer.from(found.replace(/^data:image\/\w+;base64,/, ''), 'base64') };
}

/** JPEG, WebP or PNG — told from the bytes, because the providers do not agree and do not always say. */
const imageExt = (bytes) => (bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpg'
  : bytes.subarray(0, 4).toString('latin1') === 'RIFF' ? 'webp' : 'png');

/**
 * NVIDIA's image models.
 *
 * They are not behind /images/generations. Each model has an address of its
 * own — https://ai.api.nvidia.com/v1/genai/<publisher>/<model> — and takes the
 * prompt directly. Their chat models live on a different host
 * (integrate.api.nvidia.com), which is the one a key page shows first, so an
 * image connection pointed there is sent to the right place rather than
 * failing with a 404 that explains nothing.
 */
const NVIDIA_HOST = /(^|\.)api\.nvidia\.com$/i;
const NVIDIA_PUBLISHER = [
  [/^flux/i, 'black-forest-labs'],
  [/^(stable-|sd)/i, 'stabilityai'],
];

export function nvidiaImageTargets(conn) {
  let url;
  try { url = new URL(conn.baseURL); } catch { return null; }
  if (!NVIDIA_HOST.test(url.hostname)) return null;

  // The whole address pasted from a model's own page: use it as it is.
  const pasted = url.pathname.match(/\/genai\/([^/]+\/[^/]+)\/?$/);
  let model = String(conn.model ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (pasted) return { urls: [`https://ai.api.nvidia.com/v1/genai/${pasted[1]}`], model: pasted[1] };
  if (!model) return { urls: [], model: '' };
  if (!model.includes('/')) {
    const publisher = NVIDIA_PUBLISHER.find(([re]) => re.test(model))?.[1];
    if (publisher) model = `${publisher}/${model}`;
  }
  // The catalogue lists some models with a dash where the address has a dot
  // ("flux-3-image-klein" is served at flux.3-image-klein), so both are tried.
  const dotted = model.replace(/(flux)[-_](\d)(?=[-_.]|$)/i, '$1.$2');
  const names = [...new Set([model, dotted])];
  return { urls: names.map((m) => `https://ai.api.nvidia.com/v1/genai/${m}`), model };
}

async function nvidiaImage({ conn, prompt, size, targets }) {
  if (!targets.urls.length) throw new Error(`${conn.name} needs a model — for NVIDIA that is the name on the model's page, such as flux.1-schnell`);
  const [width, height] = String(size ?? '').split('x').map(Number);
  const sdxl = /stable-diffusion-xl/i.test(targets.model);
  const body = {
    // Stable Diffusion XL is the one that still takes its prompt as a list.
    ...(sdxl ? { text_prompts: [{ text: String(prompt) }] } : { prompt: String(prompt) }),
    // Only when asked for: the default is 1024 everywhere, and not every model takes a size.
    ...(width && height && !/stable-diffusion-3/i.test(targets.model) ? { width, height } : {}),
    ...(conn.extra?.body ?? {}),
  };
  let last;
  for (const url of targets.urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers(conn, { 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (res.ok) return res.json();
      const text = await res.text().catch(() => '');
      last = new Error(res.status === 404
        ? `${conn.name}: NVIDIA has no image model at ${url.split('/genai/')[1]} — use the name from the model's page on build.nvidia.com`
        : res.status === 401 || res.status === 403
          ? `${conn.name}: NVIDIA refused the key for ${targets.model} (${res.status}) — the key may not have access to this model`
          : `${conn.name} returned ${res.status}: ${text.slice(0, 300) || res.statusText}`);
      if (res.status !== 404) throw last;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`${conn.name} timed out after ${TIMEOUT_MS / 1000}s`);
      if (err !== last) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/**
 * Generate an image. Providers return either base64 or a URL; both are handled,
 * and either way the bytes are stored locally so the room keeps working when a
 * provider's temporary link expires.
 */
export async function generateImage({ conn, prompt, size, dir }) {
  if (!conn) throw new Error('no image connection is configured');
  const nvidia = conn.extra?.path ? null : nvidiaImageTargets(conn);
  const out = nvidia
    ? await nvidiaImage({ conn, prompt, size, targets: nvidia })
    : await call(conn, '/images/generations', {
        body: {
          model: conn.model || 'gpt-image-1',
          prompt: String(prompt),
          n: 1,
          ...(size ? { size } : {}),
          ...(conn.extra?.body ?? {}),
        },
      });

  const image = imageFrom(out);
  if (image.bytes?.length) return store(dir, image.bytes, imageExt(image.bytes));
  if (image.url) {
    const res = await fetch(image.url);
    if (!res.ok) throw new Error(`could not fetch the generated image (${res.status})`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return store(dir, bytes, imageExt(bytes));
  }
  throw new Error(image.why
    ? `${conn.name} made no image: the provider answered "${image.why}"${/filter/.test(image.why) ? ' — reword the prompt' : ''}`
    : `${conn.name} returned no image`);
}

// --------------------------------------------------------------------- video

/**
 * Generate a video.
 *
 * This is the least standardised of the lot. Most providers start a job and
 * make you poll, and the field names differ, so the polling path and the
 * response fields are configurable per connection through `extra`:
 *
 *   { "statusPath": "/videos/{id}", "idField": "id", "urlField": "url" }
 *
 * Immediate responses are handled too, for providers that just return a link.
 */
export async function generateVideo({ conn, prompt, dir, onProgress = () => {} }) {
  if (!conn) throw new Error('no video connection is configured');
  const started = await call(conn, '/videos/generations', {
    body: {
      model: conn.model || 'sora-2',
      prompt: String(prompt),
      ...(conn.extra?.body ?? {}),
    },
  });

  const urlField = conn.extra?.urlField ?? 'url';
  const idField = conn.extra?.idField ?? 'id';
  const direct = started.data?.[0]?.[urlField] ?? started[urlField];
  if (direct) return fetchVideo(direct, dir);

  const id = started[idField] ?? started.data?.[0]?.[idField];
  if (!id) throw new Error(`${conn.name} returned neither a video nor a job id`);

  // Poll. Bounded, because a job that never finishes must not pin a request
  // open forever.
  const statusPath = (conn.extra?.statusPath ?? '/videos/{id}').replace('{id}', id);
  const deadline = Date.now() + TIMEOUT_MS;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(5000, 1000 + attempt * 500)));
    const status = await call(conn, statusPath, { method: 'GET', json: false, body: undefined });
    onProgress(status.status ?? 'working');
    const done = status.data?.[0]?.[urlField] ?? status[urlField];
    if (done) return fetchVideo(done, dir);
    if (/fail|error|cancel/i.test(status.status ?? '')) {
      throw new Error(`${conn.name} reported the job ${status.status}`);
    }
  }
  throw new Error(`${conn.name} did not finish within ${TIMEOUT_MS / 1000}s`);
}

async function fetchVideo(url, dir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch the generated video (${res.status})`);
  return store(dir, Buffer.from(await res.arrayBuffer()), 'mp4');
}
