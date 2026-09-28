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

/** Headers for a connection, including any the user added in `extra`. */
function headers(conn, extra = {}) {
  const h = { ...extra, ...(conn.extra?.headers ?? {}) };
  if (conn.apiKey) {
    // Most providers take a bearer token; a few want their own header, which
    // `extra.headers` can supply instead.
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'authorization')) {
      h.Authorization = `Bearer ${conn.apiKey}`;
    }
  }
  return h;
}

async function call(conn, path, { body, json = true, method = 'POST', accept } = {}) {
  const url = joinUrl(conn.baseURL, conn.extra?.path ?? path);
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

export async function speak({ conn, text, dir }) {
  if (!conn) throw new Error('no text-to-speech connection is configured');
  const bytes = await call(conn, '/audio/speech', {
    body: {
      model: conn.model || 'gpt-4o-mini-tts',
      voice: conn.extra?.voice ?? 'alloy',
      input: String(text).slice(0, 4000),
      response_format: 'mp3',
    },
    accept: 'buffer',
  });
  return store(dir, bytes, 'mp3');
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
