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

  // ---- speech to text ----
  { preset: 'OpenAI Whisper', kind: 'transcribe', baseURL: 'https://api.openai.com/v1', model: 'whisper-1',
    keyHint: 'platform.openai.com' },
  { preset: 'Groq Whisper', kind: 'transcribe', baseURL: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3',
    keyHint: 'console.groq.com — fastest option' },
  { preset: 'Deepgram', kind: 'transcribe', baseURL: 'https://api.deepgram.com/v1/openai', model: 'nova-3',
    keyHint: 'console.deepgram.com' },
  { preset: 'whisper.cpp (local)', kind: 'transcribe', baseURL: 'http://127.0.0.1:8080/v1', model: 'whisper-1',
    keyHint: 'no key needed', keyOptional: true },

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

  // ---- images ----
  { preset: 'OpenAI images', kind: 'image', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-1',
    keyHint: 'platform.openai.com' },
  { preset: 'Google Imagen', kind: 'image', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'imagen-4',
    keyHint: 'aistudio.google.com' },

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

  // Whatever it was wrapped in, the key is in there as one unbroken run.
  const tokens = text.match(/[A-Za-z0-9_\-.~+/]{8,}/g) ?? [];
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
