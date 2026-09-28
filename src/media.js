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
 * Generate an image. Providers return either base64 or a URL; both are handled,
 * and either way the bytes are stored locally so the room keeps working when a
 * provider's temporary link expires.
 */
export async function generateImage({ conn, prompt, size, dir }) {
  if (!conn) throw new Error('no image connection is configured');
  const out = await call(conn, '/images/generations', {
    body: {
      model: conn.model || 'gpt-image-1',
      prompt: String(prompt),
      n: 1,
      ...(size ? { size } : {}),
      ...(conn.extra?.body ?? {}),
    },
  });

  const first = out.data?.[0] ?? out;
  if (first.b64_json) return store(dir, Buffer.from(first.b64_json, 'base64'), 'png');
  if (first.url) {
    const res = await fetch(first.url);
    if (!res.ok) throw new Error(`could not fetch the generated image (${res.status})`);
    return store(dir, Buffer.from(await res.arrayBuffer()), 'png');
  }
  throw new Error(`${conn.name} returned no image`);
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
