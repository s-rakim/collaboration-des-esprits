/**
 * Working out what an endpoint actually wants.
 *
 * Adding a provider was a guessing game with two guesses in it, and getting
 * either wrong produced an error from somebody else's server about somebody
 * else's field names. Does this base URL end in /v1, or /openai/v1, or nothing?
 * Is the model called "Gemini 3.1 Pro" or "gemini-3-pro" or something else
 * entirely? The documentation knows; the endpoint knows; the person pasting a
 * key into a box does not, and should not have to.
 *
 * So ask the endpoint. Nearly everything speaking the OpenAI shape answers
 * GET /models with the ids it will accept, which settles both questions at
 * once: the URL that answered is the right URL, and the list is the list.
 */

const TIMEOUT_MS = 12_000;

/**
 * The base URLs worth trying, given what somebody typed.
 *
 * People paste the page they were reading: the bare host, the full
 * /chat/completions path, a URL with a trailing slash. Each of those has one
 * obvious repair, and trying four URLs is faster than a round trip through a
 * human reading an error message.
 */
export function candidates(raw) {
  // Trimmed, not stripped. Removing every space turns "not a url at all" into
  // a hostname, and then four variants of gibberish get requested before
  // anybody is told the obvious thing.
  const typed = String(raw ?? '').trim();
  if (!typed || /\s/.test(typed)) return [];

  let url;
  try {
    // A scheme that was not typed has to be guessed, and the guess is decided
    // by where it points: a model running on this machine is served over http,
    // and assuming https there fails in a way that looks like the app's fault.
    const local = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(typed);
    url = new URL(/^https?:\/\//i.test(typed) ? typed : `${local ? 'http' : 'https'}://${typed}`);
  } catch {
    return [];
  }

  // A host is a name with a dot in it, a machine on this one, or an address.
  const host = url.hostname;
  const plausible = host.includes('.') || host === 'localhost' || host.endsWith('.localhost')
    || /^\[?[0-9a-f:]+\]?$/i.test(host);
  if (!plausible) return [];

  const origin = url.origin;
  let path = url.pathname.replace(/\/+$/, '');

  // A pasted endpoint rather than a base: the base is its parent.
  for (const tail of ['/chat/completions', '/completions', '/models', '/responses']) {
    if (path.toLowerCase().endsWith(tail)) path = path.slice(0, -tail.length);
  }

  const out = [];
  const add = (p) => {
    const candidate = `${origin}${p}`.replace(/\/+$/, '');
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };

  add(path);
  // Google's compatibility layer hangs off a versioned path rather than /v1,
  // and it goes early: the generic guesses below all 404 there.
  if (/googleapis\.com$/i.test(url.hostname)) add('/v1beta/openai');
  if (!/\/v\d+(beta|alpha)?$/i.test(path) && !path.endsWith('/openai')) {
    add(`${path}/v1`);
    add(`${path}/openai/v1`);
    add(`${path}/api/v1`);
  }
  // And the bare origin, for anything that serves the API at the root.
  add('');

  return out.slice(0, 6);
}

/** Ask one base URL what models it has. */
async function askModels(base, apiKey, extra = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { accept: 'application/json', ...(extra.headers ?? {}) };
    if (apiKey) {
      const named = extra.keyHeader;
      if (named) headers[named] = apiKey;
      else headers.authorization = `${extra.keyScheme ?? 'Bearer'} ${apiKey}`;
    }

    const res = await fetch(`${base}/models`, { headers, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      const why = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
      return { ok: false, status: res.status, error: why ? `${res.status}: ${why}` : `HTTP ${res.status}` };
    }

    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, error: 'that answered, but not with JSON' }; }

    // The OpenAI shape is {data:[{id}]}; a few return a bare array, and
    // Google's own listing uses {models:[{name}]}.
    const rows = Array.isArray(body) ? body : body.data ?? body.models ?? [];
    const models = rows
      .map((m) => (typeof m === 'string' ? m : m.id ?? m.name ?? m.model ?? ''))
      .map((id) => String(id).replace(/^models\//, ''))
      .filter(Boolean);

    if (!models.length) return { ok: false, error: 'that answered, but listed no models' };
    return { ok: true, models: [...new Set(models)].sort() };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: `no answer within ${TIMEOUT_MS / 1000}s` };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Say what a refusal actually means, in a sentence.
 *
 * Providers answer failures with their own JSON, and pasting that JSON into
 * the page verbatim hands somebody a function UUID and an account hash to read
 * past before they reach the one word that matters. The useful part is nearly
 * always a "message" or a "detail" field, so dig it out and show that.
 */
export function explain(status, raw) {
  const text = String(raw ?? '').trim();
  let message = '';
  try {
    const body = JSON.parse(text);
    const found = body.error?.message ?? body.message ?? body.detail ?? body.error ?? body.title;
    if (typeof found === 'string') message = found;
  } catch {
    message = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  message = message.slice(0, 200);
  return message ? `${status}: ${message}` : `HTTP ${status}`;
}

/**
 * Is this a refusal of the model rather than of the key?
 *
 * The distinction decides what somebody is told to do next: a key that was
 * refused has to be replaced, while a model the account cannot reach just means
 * picking another from the list — and a catalogue listing every model a
 * provider hosts is not a list of the ones your particular account may call.
 */
function aboutTheModel(status, text) {
  if (status === 404) return true;
  return /model[_ ]?not[_ ]?found|not found for account|does not exist|no access to|not authorized to (use|access) (the )?model/i.test(text);
}

/**
 * Make the smallest real call there is, to find out whether the key works.
 *
 * Listing models often needs no credential at all — which is why finding an
 * endpoint and being able to use it are different questions, and answering only
 * the first sends somebody away thinking they are set up when they are not.
 *
 * Takes a list rather than one name, because the answer to "does this key work"
 * must not depend on which model happened to sort first. A provider's catalogue
 * is what it hosts, not what your account may call, so a few of the listed
 * models refusing is ordinary — the key is proven by the first one that does
 * not, and that one is worth handing back as the model to start with.
 */
export async function tryKey({ baseURL, apiKey, model, models, extra = {} }) {
  const list = (models ?? (model ? [model] : [])).filter(Boolean);
  if (!list.length) return { ok: null, error: 'no model to try' };

  // Enough to get past a run of models the account cannot reach, few enough
  // that a key which is simply wrong is reported in seconds. A model that was
  // asked for explicitly is the only one tried, because "that one failed, so
  // here is a different one" is not an answer to a question about that one.
  const attempts = models ? list.slice(0, 6) : list;
  let last = null;

  for (const candidate of attempts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const headers = { 'content-type': 'application/json', ...(extra.headers ?? {}) };
      if (apiKey) {
        const named = extra.keyHeader;
        if (named) headers[named] = apiKey;
        else headers.authorization = `${extra.keyScheme ?? 'Bearer'} ${apiKey}`;
      }

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        signal: ctl.signal,
        // As small as a request can be: one token in, one token out.
        body: JSON.stringify({
          model: candidate,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (res.ok) return { ok: true, model: candidate, tried: attempts.indexOf(candidate) + 1 };

      const text = await res.text();
      last = {
        ok: false,
        status: res.status,
        model: candidate,
        unauthorized: res.status === 401 || res.status === 403,
        modelUnavailable: aboutTheModel(res.status, text),
        error: explain(res.status, text),
      };
      // A refused key refuses every model, so walking the list proves nothing
      // and only makes somebody wait for six copies of the same answer.
      if (!last.modelUnavailable) return last;
    } catch (err) {
      last = err.name === 'AbortError'
        ? { ok: false, model: candidate, error: `no answer within ${TIMEOUT_MS / 1000}s` }
        : { ok: false, model: candidate, error: err.message };
      return last;
    } finally {
      clearTimeout(timer);
    }
  }

  // Every one tried was refused for being that model. The key was never the
  // problem, and saying so is the difference between picking from a list and
  // hunting for a new key.
  return { ...last, exhausted: attempts.length };
}

/**
 * Find the base URL that works and the models behind it.
 *
 * Tries the obvious repairs in order and stops at the first that answers, so a
 * URL that was already right costs one request. Returns what it tried either
 * way: "none of these worked" with the four things attempted is a far better
 * place to start than one 404.
 */
export async function probe({ baseURL, apiKey, extra = {} }) {
  const tried = [];
  for (const base of candidates(baseURL)) {
    const result = await askModels(base, apiKey, extra);
    tried.push({ baseURL: base, ok: result.ok, error: result.error });
    if (result.ok) {
      return {
        ok: true,
        baseURL: base,
        changed: base !== String(baseURL ?? '').trim().replace(/\/+$/, ''),
        models: result.models,
        tried,
      };
    }
    // A refused key is the endpoint saying "right address, wrong credential".
    // Trying variations of the address after that only wastes time.
    if (result.status === 401 || result.status === 403) {
      return { ok: false, unauthorized: true, baseURL: base, error: result.error, tried };
    }
  }
  return { ok: false, error: tried.length ? 'none of these answered' : 'that is not a URL', tried };
}
