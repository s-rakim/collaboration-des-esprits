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
    blurb: 'Turns what you say into text in the chat.',
    path: '/audio/transcriptions',
  },
  speak: {
    label: 'Text to speech',
    blurb: 'Reads replies back to you.',
    path: '/audio/speech',
  },
  image: {
    label: 'Image generation',
    blurb: 'Makes images, for you or for an agent.',
    path: '/images/generations',
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
  { preset: 'OpenAI speech', kind: 'speak', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts',
    keyHint: 'platform.openai.com', extra: { voice: 'alloy' } },

  // ---- images ----
  { preset: 'OpenAI images', kind: 'image', baseURL: 'https://api.openai.com/v1', model: 'gpt-image-1',
    keyHint: 'platform.openai.com' },
  { preset: 'Google Imagen', kind: 'image', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'imagen-4',
    keyHint: 'aistudio.google.com' },

  // ---- video ----
  { preset: 'OpenAI video', kind: 'video', baseURL: 'https://api.openai.com/v1', model: 'sora-2',
    keyHint: 'platform.openai.com' },
];

const mask = (v) => (!v ? null : v.length <= 8 ? '•'.repeat(v.length) : `${'•'.repeat(8)}${v.slice(-4)}`);

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
      const key = apiKey === undefined ? (existing?.api_key ?? null) : String(apiKey).trim() || null;
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
