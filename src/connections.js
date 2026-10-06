/**
 * Every endpoint the room can reach, as user-defined rows rather than a fixed
 * list of blessed providers.
 *
 * The presets below only prefill the form. Any endpoint can be added under any
 * name, so a provider that did not exist when this was written needs no code
 * change — which is the whole point, since the useful ones keep appearing.
 */

/** What a connection can be used for. */
export const KINDS = {
  chat: {
    label: 'Chat model',
    blurb: 'A model that takes a seat in the room and talks.',
    path: '/chat/completions',
  },
  transcribe: {
    label: 'Speech to text',
    blurb: 'Turns what you say into a message every agent can read.',
    path: '/audio/transcriptions',
  },
  speak: {
    label: 'Voice',
    blurb: 'Reads the room aloud in live chat, and makes the audio you generate.',
    path: '/audio/speech',
  },
  image: {
    label: 'Image generation',
    blurb: 'Makes images, for you or for an agent.',
    path: '/images/generations',
  },
  search: {
    label: 'Web search',
    blurb: 'Lets agents look things up, so claims can rest on something.',
    path: '/search',
  },
  video: {
    label: 'Video generation',
    blurb: 'Makes video. Shapes vary wildly, so expect to fill in the request template.',
    path: '/videos/generations',
  },
};

/**
 * Starting points, grouped by what they are for. Purely a convenience: pick one
 * and the URL and a model are filled in, then change anything you like.
 */
/**
 * My Claude Code, if it is running on this machine.
 *
 * It is a proxy in front of many providers that speaks the same OpenAI shape
 * this app speaks, on the same paths — chat, speech, transcription, images.
 * So it is not a special case in the code: it is one more endpoint, and the
 * only thing worth saying about it is where it listens and that the key for
 * whatever it reaches is its business, not this app's.
 */
const MCC = 'http://127.0.0.1:8082/v1';
const MCC_HINT = 'no key needed here — MCC holds the provider keys, in its own dashboard';

export const PRESETS = [
  // ---- chat ----
  { preset: 'OpenAI', kind: 'chat', baseURL: 'https://api.openai.com/v1', model: 'gpt-5.2',
    keyHint: 'platform.openai.com', extra: { effortParam: 'reasoning_effort' } },
  { preset: 'Google Gemini', kind: 'chat', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3-pro',
    keyHint: 'aistudio.google.com' },
  { preset: 'OpenRouter', kind: 'chat', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v3.2',
    keyHint: 'openrouter.ai — one key, many models' },
  { preset: 'Groq', kind: 'chat', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-4-maverick',
    keyHint: 'console.groq.com — very fast' },
  { preset: 'Mistral', kind: 'chat', baseURL: 'https://api.mistral.ai/v1', model: 'mistral-large-latest',
    keyHint: 'console.mistral.ai' },
  { preset: 'DeepSeek', kind: 'chat', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    keyHint: 'platform.deepseek.com' },
  { preset: 'xAI Grok', kind: 'chat', baseURL: 'https://api.x.ai/v1', model: 'grok-4',
    keyHint: 'console.x.ai' },
  { preset: 'NVIDIA NIM', kind: 'chat', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'moonshotai/kimi-k3',
    keyHint: 'build.nvidia.com — a free tier, and the model ids carry the vendor: moonshotai/…, meta/…' },
  { preset: 'Ollama (local)', kind: 'chat', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3',
    keyHint: 'no key needed', keyOptional: true },
  { preset: 'LM Studio (local)', kind: 'chat', baseURL: 'http://127.0.0.1:1234/v1', model: 'local-model',
    keyHint: 'no key needed', keyOptional: true },
  // My Claude Code: a proxy in front of many providers, speaking the same shape
  // this app already speaks. One row here reaches everything it is configured
  // with, and its keys stay in its own dashboard rather than being pasted twice.
  { preset: 'My Claude Code (local proxy)', kind: 'chat', baseURL: MCC, model: '',
    keyHint: MCC_HINT, keyOptional: true, discoverModels: true },

  // ---- speech to text ----
  { preset: 'OpenAI Whisper', kind: 'transcribe', baseURL: 'https://api.openai.com/v1', model: 'whisper-1',
    keyHint: 'platform.openai.com' },
  { preset: 'Groq Whisper', kind: 'transcribe', baseURL: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3',
    keyHint: 'console.groq.com — fastest option' },
  { preset: 'Deepgram', kind: 'transcribe', baseURL: 'https://api.deepgram.com/v1/openai', model: 'nova-3',
    keyHint: 'console.deepgram.com' },
  { preset: 'whisper.cpp (local)', kind: 'transcribe', baseURL: 'http://127.0.0.1:8080/v1', model: 'whisper-1',
    keyHint: 'no key needed', keyOptional: true },
  { preset: 'My Claude Code (local proxy)', kind: 'transcribe', baseURL: MCC, model: '',
    keyHint: MCC_HINT, keyOptional: true, discoverModels: true },

  // ---- text to speech ----
  // The voice is the room's speaking voice: it reads replies aloud in live chat
  // and it is what an audio generation is made with. So each preset names the
  // voices that provider actually has, and the setup page offers them.
  { preset: 'OpenAI speech', kind: 'speak', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts',
    keyHint: 'platform.openai.com', extra: { voice: 'alloy' },
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'] },
  { preset: 'ElevenLabs', kind: 'speak', baseURL: 'https://api.elevenlabs.io/v1', model: 'eleven_turbo_v2_5',
    keyHint: 'elevenlabs.io — the most natural of the lot',
    // Its own header, the voice in the path, and `model_id` rather than `model`.
    extra: { keyHeader: 'xi-api-key', path: '/text-to-speech/{voice}', textKey: 'text', modelKey: 'model_id',
             voiceKey: null, formatKey: null, voice: '21m00Tcm4TlvDq8ikWAM' },
    voices: ['21m00Tcm4TlvDq8ikWAM', 'AZnzlk1XvdvUeBnXmlld', 'EXAVITQu4vr4xnSDxMaL', 'ErXwobaYiN019PkySvjV', 'MF3mGyEYCl7XYWbV9V6O'] },
  { preset: 'Deepgram Aura', kind: 'speak', baseURL: 'https://api.deepgram.com/v1', model: 'aura-2-thalia-en',
    keyHint: 'console.deepgram.com — fast and cheap',
    extra: { keyScheme: 'Token', path: '/speak?model=aura-2-thalia-en', textKey: 'text',
             modelKey: null, voiceKey: null, formatKey: null } },
  { preset: 'Groq speech', kind: 'speak', baseURL: 'https://api.groq.com/openai/v1', model: 'playai-tts',
    keyHint: 'console.groq.com', extra: { voice: 'Fritz-PlayAI' },
    voices: ['Fritz-PlayAI', 'Arista-PlayAI', 'Atlas-PlayAI', 'Basil-PlayAI', 'Briggs-PlayAI', 'Celeste-PlayAI', 'Quinn-PlayAI'] },
  { preset: 'Kokoro (local)', kind: 'speak', baseURL: 'http://127.0.0.1:8880/v1', model: 'kokoro',
    keyHint: 'no key needed — runs on your machine', keyOptional: true, extra: { voice: 'af_bella' },
    voices: ['af_bella', 'af_sarah', 'af_nicole', 'am_adam', 'am_michael', 'bf_emma', 'bm_george'] },
  { preset: 'My Claude Code (local proxy)', kind: 'speak', baseURL: MCC, model: '',
    keyHint: MCC_HINT, keyOptional: true, discoverModels: true },

  // ---- images ----
  { preset: 'OpenAI images', kind: 'image', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-1',
    keyHint: 'platform.openai.com' },
  { preset: 'Google Imagen', kind: 'image', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'imagen-4',
    keyHint: 'aistudio.google.com' },
  { preset: 'My Claude Code (local proxy)', kind: 'image', baseURL: MCC, model: '',
    keyHint: MCC_HINT, keyOptional: true, discoverModels: true },

  // ---- web search ----
  { preset: 'Brave Search', kind: 'search', baseURL: 'https://api.search.brave.com/res/v1/web', model: 'search',
    keyHint: 'brave.com/search/api', extra: { headerName: 'X-Subscription-Token', query: 'q', resultsPath: 'web.results' } },
  { preset: 'Tavily', kind: 'search', baseURL: 'https://api.tavily.com', model: 'search',
    keyHint: 'tavily.com', extra: { method: 'POST', path: '/search', bodyKey: 'query', resultsPath: 'results' } },
  { preset: 'SearXNG (local)', kind: 'search', baseURL: 'http://127.0.0.1:8888', model: 'search',
    keyHint: 'no key needed', keyOptional: true, extra: { path: '/search', query: 'q', format: 'json', resultsPath: 'results' } },

  // ---- video ----
  { preset: 'OpenAI video', kind: 'video', baseURL: 'https://api.openai.com/v1', model: 'sora-2',
    keyHint: 'platform.openai.com' },
];

/**
 * Read a provider's own example and fill the row in from it.
 *
 * Every provider hands you a snippet on the page where you make the key — four
 * lines of Python or JavaScript or curl holding the base URL, the key, a model
 * that actually exists on that account, and the parameter names that endpoint
 * takes. That is every box on this row, already correct, already together.
 *
 * Typing them in one at a time is a transcription exercise with four chances to
 * get something subtly wrong, and the wrongness does not announce itself: a
 * truncated key, a model id from a different vendor's page, a base URL missing
 * its /v1. So take the snippet.
 *
 * It reads whatever shape it is given rather than knowing providers, because
 * the snippets vary far less than the providers do: a quoted URL, a quoted
 * key-shaped string, a quoted model.
 */
export function parseSnippet(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return { ok: false, error: 'there is nothing pasted' };

  // A quoted value for any of the names a thing goes by, in any of the
  // languages' punctuation: name = "v", name: 'v', "name": `v`.
  const valueFor = (...names) => {
    for (const name of names) {
      const re = new RegExp(
        `["'\`]?\\b${name}\\b["'\`]?\\s*[:=]\\s*["'\`]([^"'\`]+)["'\`]`,
        'i',
      );
      const hit = text.match(re);
      if (hit) return hit[1].trim();
    }
    return '';
  };

  // The key, from a named field or from the header a curl example puts it in.
  const apiKey =
    valueFor('api_key', 'apiKey', 'apikey', 'key', 'token')
    || (text.match(/Authorization\s*:\s*["'`]?\s*Bearer\s+([^\s"'`\\]+)/i) ?? [])[1]
    || (text.match(/[-\w]*api[-_]?key\s*:\s*["'`]?\s*([A-Za-z0-9_\-.~+/]{16,}={0,2})/i) ?? [])[1]
    || '';

  let baseURL = valueFor('base_url', 'baseURL', 'baseurl', 'endpoint', 'host');

  // curl gives no named field: the URL is simply there, and it is the full
  // path rather than the base, so the known endpoint tails come off.
  if (!baseURL) {
    const urls = text.match(/https?:\/\/[^\s"'`\\)]+/g) ?? [];
    const api = urls.find((u) => /\/v\d|\/api|\/openai/i.test(u)) ?? urls[0];
    if (api) baseURL = api;
  }
  baseURL = baseURL
    .replace(/\/(chat\/completions|completions|responses|embeddings|models)\/?$/i, '')
    .replace(/\/(audio\/(speech|transcriptions|translations)|images\/(generations|edits)|videos)\/?$/i, '')
    .replace(/\/+$/, '');

  const model = valueFor('model', 'model_id', 'modelId', 'deployment');

  // What this endpoint calls the length limit is in the snippet, which settles
  // the one question that cannot be settled by looking at the URL — and which,
  // got wrong, makes a capped request into an uncapped one.
  const tokenParam = /max_completion_tokens/i.test(text)
    ? 'max_completion_tokens'
    : (/max_tokens/i.test(text) ? 'max_tokens' : '');

  // The job is in the path the example calls, so an audio example does not
  // arrive filed as a chat model.
  const kind = /audio\/speech|text-to-speech|\.speech\./i.test(text) ? 'speak'
    : /audio\/transcriptions|\.transcriptions\./i.test(text) ? 'transcribe'
    : /images\/(generations|edits)|\.images\./i.test(text) ? 'image'
    : /\/videos|\.videos\./i.test(text) ? 'video'
    : 'chat';

  const extra = {};
  if (tokenParam) extra.tokenParam = tokenParam;
  // Only the ones that change what comes back, and only when stated.
  const effort = valueFor('reasoning_effort', 'effort');
  if (effort) { extra.effortParam = 'reasoning_effort'; extra.effort = effort; }
  const voice = valueFor('voice');
  if (voice) extra.voice = voice;

  if (!baseURL && !apiKey) {
    return {
      ok: false,
      error: 'nothing in that looked like a base URL or a key — paste the whole example,'
        + " including the lines that set them",
    };
  }

  return { ok: true, baseURL, apiKey, model, kind, extra };
}

const mask = (v) => (!v ? null : v.length <= 8 ? '•'.repeat(v.length) : `${'•'.repeat(8)}${v.slice(-4)}`);

/**
 * Pull the key out of whatever was pasted.
 *
 * Nobody copies a bare key. They copy the line it was sitting in — out of a
 * curl example, a JSON body, a Python snippet — and it arrives wrapped in a
 * header name, a scheme word, quotes and a trailing comma:
 *
 *     "Authorization": "Bearer nvapi-xxxx",
 *
 * Every one of those wrappers makes the provider reject the credential, with a
 * message that sends somebody off to regenerate a key that was fine all along.
 *
 * Rather than peeling the wrappers off — they nest, and peeling leaves whatever
 * was underneath — this looks for the credential itself: the longest run of
 * key-shaped characters that is not one of the words such lines are made of.
 */
const NOISE = new Set([
  'authorization', 'bearer', 'token', 'basic', 'apikey', 'api', 'key', 'x-api-key',
  'headers', 'header', 'auth', 'secret', 'value', 'string', 'const', 'let', 'var',
  'export', 'set', 'setx', 'env', 'true', 'false', 'null', 'none',
]);

export function cleanKey(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';

  // One word, pasted on its own, is the key. Return it untouched.
  //
  // Everything below hunts for a credential inside a line of other stuff, and
  // hunting means deciding which characters a key is made of — which is a guess
  // about every provider that exists and every one that does not exist yet. A
  // key containing one character the guess did not allow comes back shortened,
  // saves, shows a length nobody checks, and is refused everywhere. There is no
  // reason to run any of that against something with no line around it.
  if (!/\s/.test(text) && !/^["'`]|["'`,]$/.test(text)) {
    // NAME=value has no spaces in it either, and the key is the right-hand
    // side. The "=" has to be a separator rather than base64 padding, which
    // only ever sits at the very end.
    const assigned = text.match(/^[A-Za-z0-9_.-]+=(?!=*$)(.+)$/);
    return (assigned ? assigned[1] : text).replace(/^(bearer|token|basic)\s+/i, '');
  }

  // Whatever it was wrapped in, the key is in there as one unbroken run.
  // "=" only at the end, where base64 padding lives. Allowing it anywhere
  // would swallow the "=" of KEY=value and hand back the whole line.
  const tokens = text.match(/[A-Za-z0-9_\-.~+/]{8,}={0,2}/g) ?? [];
  const candidates = tokens.filter((t) => !NOISE.has(t.toLowerCase().replace(/[_-]/g, '')));
  if (candidates.length) {
    // A credential has digits in it; the words around one — OPENAI_API_KEY,
    // production, Authorization — do not. That single test separates the key
    // from the name of the variable it was assigned to.
    const digity = candidates.filter((t) => /\d/.test(t));
    const pool = digity.length ? digity : candidates;
    // Then the longest, and on a tie the later one, since a value follows the
    // name of the thing it is the value of.
    // A dot or comma at the end of the run is the punctuation of the sentence
    // it was pasted in, not part of the credential. Only trailing ones: a
    // JWT-shaped key has dots in the middle and needs them.
    return pool.reduce((best, t) => (t.length >= best.length ? t : best)).replace(/[.,;:]+$/, '');
  }

  // Nothing key-shaped: a short or unusual credential, so take it as typed with
  // only the obvious wrapping removed rather than throwing it away.
  return text
    .replace(/^["'`]+|["'`]+,?$/g, '')
    .replace(/^(bearer|token|basic)\s+/i, '')
    .trim()
    .split(/\s/)[0];
}


/** A name has to survive being put in a URL and referenced by a seat. */
function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new Error('a connection needs a name');
  if (name.length > 64) throw new Error('that name is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    throw new Error('use letters, numbers, spaces, dots, dashes or underscores');
  }
  return name;
}

export function createConnections(db) {
  const view = (r) => {
    let extra = {};
    try {
      extra = JSON.parse(r.extra || '{}');
    } catch {
      // A hand-edited row must not break the whole settings page.
      extra = {};
    }
    // Env fallback, so a key set in the shell works without being retyped:
    // ESPRITS_KEY_<NAME>, upper-cased with non-alphanumerics as underscores.
    const envName = `ESPRITS_KEY_${r.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const fromEnv = process.env[envName];
    const effective = r.api_key || fromEnv || null;
    return {
      name: r.name,
      kind: r.kind,
      baseURL: r.base_url,
      model: r.model,
      extra,
      // The credential itself never appears here; this is the shape the HTTP
      // layer returns, so a key cannot leak by somebody forgetting to strip it.
      keySet: Boolean(effective),
      // The length, not the key. A key that was cut off when it was copied
      // looks exactly like a working one behind eight dots, and this is the
      // cheapest way to see that it is short.
      keyLength: effective ? effective.length : 0,
      keyPreview: mask(r.api_key) ?? (fromEnv ? `from ${envName}` : null),
      keySource: r.api_key ? 'stored' : fromEnv ? 'env' : 'unset',
      keyEnv: envName,
      createdAt: r.created_at,
    };
  };

  return {
    all() {
      return db.prepare('SELECT * FROM connections ORDER BY kind, created_at, name').all().map(view);
    },

    ofKind(kind) {
      return db.prepare('SELECT * FROM connections WHERE kind = ? ORDER BY created_at').all(kind).map(view);
    },

    get(name) {
      const r = db.prepare('SELECT * FROM connections WHERE name = ?').get(String(name));
      return r ? view(r) : null;
    },

    /** The real credential. Server-side callers only. */
    keyFor(name) {
      const r = db.prepare('SELECT name, api_key FROM connections WHERE name = ?').get(String(name));
      if (!r) return null;
      const envName = `ESPRITS_KEY_${r.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      return r.api_key || process.env[envName] || null;
    },

    /**
     * Everything the server needs to call this endpoint, credential included.
     * Kept separate from get() so the leaky path has to be asked for by name.
     */
    resolve(name) {
      const c = this.get(name);
      if (!c) return null;
      return { ...c, apiKey: this.keyFor(name) };
    },

    save({ name, kind = 'chat', baseURL = '', model = '', apiKey = undefined, extra = undefined, rename = undefined }) {
      const handle = checkName(name);
      if (!KINDS[kind]) throw new Error(`unknown kind "${kind}"`);

      const existing = db.prepare('SELECT * FROM connections WHERE name = ?').get(handle);
      // undefined means "leave it alone" — the page sends a key only when it was
      // edited, so re-saving a row cannot wipe the key already stored for it.
      const key = apiKey === undefined ? (existing?.api_key ?? null) : cleanKey(apiKey) || null;
      const ex = extra === undefined ? (existing?.extra ?? '{}') : JSON.stringify(extra ?? {});

      db.prepare(
        `INSERT INTO connections (name, kind, base_url, api_key, model, extra, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           kind = excluded.kind, base_url = excluded.base_url, api_key = excluded.api_key,
           model = excluded.model, extra = excluded.extra`,
      ).run(handle, kind, String(baseURL).trim(), key, String(model).trim(), ex, new Date().toISOString());

      if (rename && rename !== handle) {
        const to = checkName(rename);
        db.prepare('UPDATE connections SET name = ? WHERE name = ?').run(to, handle);
        // Seats point at connections by name, so they have to follow the rename.
        db.prepare('UPDATE participants SET connection = ? WHERE connection = ?').run(to, handle);
        return this.get(to);
      }
      return this.get(handle);
    },

    remove(name) {
      const handle = String(name);
      const users = db.prepare('SELECT name FROM participants WHERE connection = ?').all(handle);
      if (users.length) {
        throw new Error(
          `${handle} is in use by ${users.map((u) => u.name).join(', ')} — point those elsewhere first`,
        );
      }
      return db.prepare('DELETE FROM connections WHERE name = ?').run(handle).changes > 0;
    },
  };
}
