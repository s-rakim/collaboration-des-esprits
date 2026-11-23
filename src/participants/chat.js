import OpenAI from 'openai';
import { messagesAdapter } from './messages.js';

/**
 * The chat adapter, on the official OpenAI SDK.
 *
 * It serves every endpoint that speaks the Chat Completions shape, which is
 * nearly all of them — OpenAI, Gemini's compatible endpoint, OpenRouter, Groq,
 * Mistral, DeepSeek, xAI, a local Ollama or LM Studio, anything self-hosted.
 * The only thing that differs between them is the base URL, the key and the
 * model string, all of which come from a user-defined connection. So any model
 * on any such endpoint can take a seat without touching this file.
 */

/**
 * How long to wait, and how many times.
 *
 * The SDK's own defaults are ten minutes and two retries, which multiply to
 * half an hour before anything is reported. A seat mid-turn can afford to wait
 * a while; somebody sitting in front of a Test button cannot, and "calling…"
 * that never finishes is the least useful thing a button can do. So the caller
 * says which situation it is in, and neither gets the SDK's answer.
 */
const TURN_TIMEOUT_MS = 180_000;

/**
 * How long a streamed answer may go quiet.
 *
 * The SDK's own timeout stops counting the moment the first headers arrive.
 * A provider that sends them and then goes silent — which free tiers under
 * load do — was therefore waited on for ever: a call "in progress" for hours.
 * Between chunks the limit is short, because a live stream sends something
 * every second or two; before the first, it is long, because a model can think
 * a while before it writes.
 */
const STREAM_FIRST_MS = 150_000;
const STREAM_IDLE_MS = 60_000;
/**
 * Before the first headers the SDK's own timeout is the one that should fire —
 * it says "no reply within Ns", which is the right thing to say. The leash is
 * set just beyond it, so it only ever catches what the SDK lets through.
 */
const LEASH_SLACK_MS = 2_000;
/** And nothing runs longer than this, however steadily it trickles. */
const MAX_REQUEST_MS = 10 * 60_000;

/**
 * How many tokens an endpoint will take, read from its refusal.
 *
 * A seat asks for a generous reply length by default, and plenty of models
 * allow far less. They say so — "maximum context length is 32768 tokens,
 * however you requested 64200 (200 in the messages, 64000 in the completion)",
 * "max_tokens must be less than or equal to 4096" — and what they say is the
 * answer. Handing that sentence to a person, to go and type the number into a
 * settings page, is making them do arithmetic the error already did.
 *
 * Returns a number that fits, or null when the message is about something else.
 */
export function smallerLimit(message, asked) {
  const text = String(message ?? '');
  if (!/token/i.test(text)) return null;

  const window = text.match(/maximum context length is (\d+)/i) ?? text.match(/context (?:window|length) of (\d+)/i);
  if (window) {
    const used = text.match(/(\d+) in the messages/i) ?? text.match(/(\d+) (?:prompt|input) tokens/i);
    const room = Number(window[1]) - (used ? Number(used[1]) : Math.ceil(Number(window[1]) / 2)) - 64;
    if (room >= 256 && room < asked) return room;
  }
  const cap = text.match(/(?:at most|less than or equal to|<=|no (?:more|greater) than|maximum (?:value )?(?:is|of)|up to|limit (?:is|of)|>)\s*`?(\d{3,7})\b/i);
  if (cap && Number(cap[1]) < asked) return Number(cap[1]);
  // It objected to the size without saying what would fit.
  if (/too large|too many|exceed|greater than|out of range|must be (?:less|at most|<=)/i.test(text) && asked > 4096) return 4096;
  return null;
}

/**
 * What has been learned about an endpoint, kept for as long as the room runs.
 *
 * An adapter lives for one turn. Without this, everything a turn found out —
 * the reply length this model allows, the name it wants for the limit, that it
 * will not stream — was forgotten when the turn ended, and the next one paid
 * for a refused request to find it out again. On every turn, for every agent.
 */
const learned = new Map();
const known = (baseURL, model) => {
  const key = `${baseURL ?? ''}|${model ?? ''}`;
  if (!learned.has(key)) learned.set(key, {});
  return learned.get(key);
};

/**
 * The value of one string field in JSON that is still being written.
 *
 * A reply arrives as the arguments of a tool call — {"body":"…"} — a few
 * characters at a time. This reads what there is of the body so far, so it can
 * be shown while it is written rather than after.
 */
export function partialString(json, key) {
  const text = String(json ?? '');
  const at = text.search(new RegExp(`"${key}"\\s*:\\s*"`));
  if (at === -1) return '';
  let i = text.indexOf('"', text.indexOf(':', at) + 1) + 1;
  let out = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') break;
    if (c !== '\\') { out += c; continue; }
    const n = text[++i];
    if (n === undefined) break;                       // the escape is not all here yet
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '';
    else if (n === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += n;
  }
  return out;
}

export function chatAdapter({
  apiKey, model, maxTokens, effort, effortParam, baseURL, createClient,
  timeoutMs = TURN_TIMEOUT_MS, maxRetries = 1, tokenParam, shape,
  // Overridable so a test need not wait a minute to see a hung stream cut off.
  firstChunkMs = STREAM_FIRST_MS, idleChunkMs = STREAM_IDLE_MS,
  // Called as the answer is written: ({ thinking, text, tool, args }). Asking
  // for it is asking for the reply to be streamed.
  onDelta = null,
}) {
  // A router that serves no /chat/completions needs the other language
  // entirely, not a different parameter. Which one it is gets discovered once
  // and stored on the connection; this only honours the answer.
  if (shape === 'messages') {
    return messagesAdapter({ apiKey, model, maxTokens, effort, baseURL, timeoutMs });
  }

  /**
   * What this endpoint calls the length limit.
   *
   * OpenAI renamed it to max_completion_tokens for the reasoning models and
   * requires that spelling there. Nearly everything else — and OpenAI itself
   * for everything else — wants max_tokens. The two are not interchangeable
   * and the failure is not symmetric: a server that does not know
   * max_completion_tokens generally IGNORES it rather than refusing, so the
   * cap silently does not apply and a reasoning model writes until it hits its
   * own default. From the outside that looks exactly like the endpoint hanging.
   *
   * So the default is the spelling almost everyone takes, and the other one is
   * learned from the only thing that can actually settle it: the server saying
   * so.
   */
  const memory = known(baseURL, model);
  let lengthKey = memory.lengthKey || tokenParam || 'max_tokens';
  /** The reply length asked for. Starts as configured; comes down if the endpoint says it must. */
  let cap = memory.cap ? Math.min(memory.cap, maxTokens) : maxTokens;
  const client = createClient
    ? createClient(apiKey, baseURL)
    // Some compatible servers (a local Ollama) need no credential, but the SDK
    // insists on a non-empty string.
    : new OpenAI({
        apiKey: apiKey || 'not-needed',
        baseURL: baseURL || undefined,
        timeout: timeoutMs,
        maxRetries,
      });

  const asTools = (tools) =>
    tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

  return {
    model,

    startTurn({ system, tools }) {
      const messages = [{ role: 'system', content: system }];
      let toolDefs = asTools(tools);
      // One controller for the whole turn, so "stop" reaches whichever request
      // is in flight rather than only the next one that has not started.
      const ctl = new AbortController();

      const body = () => ({
        model,
        [lengthKey]: cap,
        messages,
        // An empty tools array alongside tool_choice:'auto' asks some servers
        // to choose from nothing, which they are entitled to find confusing.
        // A turn with no tools should simply not mention them.
        ...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        // Omitted entirely unless the provider declared the field, since an
        // unknown parameter fails the request rather than being ignored.
        ...(effortParam && effort ? { [effortParam]: effort } : {}),
      });

      /**
       * One request, streamed when somebody is watching.
       *
       * A model that takes forty seconds to answer has usually been writing for
       * thirty-five of them. Streamed, the first words are on the screen in the
       * first second or two, and the wait stops looking like nothing happening.
       */
      /**
       * A request's own leash. Stopping the turn still stops it, but it can
       * also be cut off for going quiet — and told apart from a stop, which is
       * what `why` is for.
       */
      const guard = () => {
        const req = new AbortController();
        let why = null;
        let idle = null;
        const onStop = () => req.abort();
        if (ctl.signal.aborted) req.abort(); else ctl.signal.addEventListener('abort', onStop, { once: true });
        const stop = (reason) => { why ??= reason; req.abort(); };
        const total = setTimeout(() => stop(`was still going after ${MAX_REQUEST_MS / 60_000} minutes`), MAX_REQUEST_MS);
        return {
          signal: req.signal,
          get why() { return why; },
          poke(ms) {
            clearTimeout(idle);
            idle = setTimeout(() => stop(`sent nothing for ${Math.round(ms / 1000)}s`), ms);
          },
          done() { clearTimeout(total); clearTimeout(idle); ctl.signal.removeEventListener('abort', onStop); },
        };
      };

      const once = async () => {
        const g = guard();
        try {
          return await attempt(g);
        } catch (err) {
          if (g.why && !ctl.signal.aborted) {
            const stalled = new Error(
              `${baseURL || 'the provider'} ${g.why}, part-way through its answer. That is the provider hanging `
              + '— not your key, and not this app waiting politely. Send it again, or pick another model for this seat',
            );
            stalled.stalled = true;
            throw stalled;
          }
          throw err;
        } finally {
          g.done();
        }
      };

      const attempt = async (g) => {
        // The whole request, for one that is not streamed; a streamed one takes over below.
        g.poke(timeoutMs + LEASH_SLACK_MS);
        if (!onDelta || memory.noStream) return client.chat.completions.create(body(), { signal: g.signal });
        let stream;
        try {
          stream = await client.chat.completions.create({ ...body(), stream: true }, { signal: g.signal });
        } catch (err) {
          // An endpoint that will not stream says so; ask it the plain way, and remember.
          if ((err?.status === 400 || err?.status === 422) && /stream/i.test(err.message ?? '')) {
            memory.noStream = true;
            g.poke(timeoutMs + LEASH_SLACK_MS);
            return client.chat.completions.create(body(), { signal: g.signal });
          }
          throw err;
        }
        // It answered all at once anyway (or is a stand-in that always does).
        if (typeof stream?.[Symbol.asyncIterator] !== 'function') return stream;

        let content = '';
        let finish = null;
        let chunks = 0;
        const calls = [];
        g.poke(firstChunkMs);
        for await (const chunk of stream) {
          g.poke(idleChunkMs);
          const choice = chunk?.choices?.[0];
          if (!choice) continue;
          chunks += 1;
          const d = choice.delta ?? {};
          if (typeof d.content === 'string') content += d.content;
          for (const part of d.tool_calls ?? []) {
            const i = part.index ?? 0;
            calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (part.id) calls[i].id = part.id;
            if (part.function?.name && !calls[i].function.name) calls[i].function.name = part.function.name;
            if (typeof part.function?.arguments === 'string') calls[i].function.arguments += part.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
          const first = calls.find(Boolean);
          try {
            onDelta({
              // Reasoning that is not the answer: worth knowing it is happening, not worth showing.
              thinking: !content && !first && Boolean(d.reasoning_content ?? d.reasoning),
              text: content,
              tool: first?.function.name || null,
              args: first?.function.arguments ?? '',
            });
          } catch { /* a watcher must not be able to break the turn */ }
        }
        if (!chunks) {
          // Asked to stream and sent nothing that reads as one: it does not
          // stream. Ask again the plain way rather than report an empty answer.
          memory.noStream = true;
          g.poke(timeoutMs + LEASH_SLACK_MS);
          return client.chat.completions.create(body(), { signal: g.signal });
        }
        const made = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
        return {
          choices: [{
            finish_reason: finish ?? (made.length ? 'tool_calls' : 'stop'),
            message: { role: 'assistant', content: content || null, ...(made.length ? { tool_calls: made } : {}) },
          }],
        };
      };

      const request = async () => {
        let response;
        try {
          try {
            response = await once();
          } catch (first) {
            // The one case worth retrying automatically: the server naming the
            // length parameter it wanted. It has told us the answer, so asking
            // a person to go and find it would be a strange thing to do.
            // And the other: the connection dropped before anything came back.
            // That is the network hiccuping far more often than it is the
            // address being wrong, so it is tried again, twice, a moment apart,
            // before anybody is told about it.
            const dropped = (e) => e?.stalled === true || (e instanceof OpenAI.APIError && (e.status === undefined || e.status === null)
              && !(e instanceof OpenAI.APIConnectionTimeoutError) && e.name !== 'APIConnectionTimeoutError' && e.name !== 'APIUserAbortError');
            if (dropped(first) && !ctl.signal.aborted) {
              let last = first;
              // A hung request already cost its whole wait; it gets one more go, not two.
              for (const wait of first?.stalled ? [700] : [700, 2000]) {
                await new Promise((r) => setTimeout(r, wait));
                if (ctl.signal.aborted) break;
                try { response = await once(); last = null; break; } catch (again) { last = again; if (!dropped(again)) break; }
              }
              if (last) throw last;
            } else {
            if (first?.status !== 400 && first?.status !== 422) throw first;
            // Asked for more than the model allows: it has said how much it
            // does allow, so ask for that. Checked before the spelling,
            // because a complaint about size names the parameter too.
            const fits = smallerLimit(first.message, cap);
            if (fits) { cap = fits; memory.cap = fits; }
            else if (/max_completion_tokens|max_tokens/i.test(first.message ?? '')) {
              lengthKey = lengthKey === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
              memory.lengthKey = lengthKey;
            } else throw first;
            response = await once();
            }
          }
        } catch (err) {
          // The SDK's typed errors carry a status; map the ones worth naming.
          // What a person needs here is the next thing to do, so a connection
          // error names the address rather than reporting "error undefined".
          // A cut-off request is not a failure to report; it is what was asked
          // for, and it needs to be told apart from the provider going wrong.
          if (ctl.signal.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') {
            const stop = new Error('stopped');
            stop.interrupted = true;
            throw stop;
          }
          // A timeout is not the provider saying no; it is the provider saying
          // nothing. Those need different answers, and lumping them together
          // sends somebody to check a key that was never looked at.
          if (err instanceof OpenAI.APIConnectionTimeoutError
              || err.name === 'APIConnectionTimeoutError') {
            throw new Error(
              `${baseURL || 'the provider'} accepted the connection but sent no reply within `
              + `${Math.round(timeoutMs / 1000)}s. The address is reachable, so this is the model `
              + 'taking too long or the endpoint hanging — try a smaller model, or check the '
              + "provider's status page.",
            );
          }
          if (err instanceof OpenAI.AuthenticationError) {
            // Flagged, not just worded. Whoever wants to react to "the key was
            // refused" should not have to pattern-match this sentence, because
            // the sentence is allowed to change and the matcher silently stops
            // firing when it does — which is exactly what happened.
            const refused = new Error('the provider rejected the API key');
            refused.unauthorized = true;
            throw refused;
          }
          if (err instanceof OpenAI.RateLimitError) throw new Error('rate limited by the provider — backing off');
          if (err instanceof OpenAI.APIError) {
            if (err.status === undefined || err.status === null) {
              const why = err.cause?.code || err.cause?.cause?.code || '';
              const local = /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\])/.test(baseURL || '');
              throw new Error(local
                ? `could not reach ${baseURL} — check the base URL, and that the service is running${why ? ` (${why})` : ''}`
                : `the connection to ${baseURL || 'the provider'} dropped, three times running${why ? ` (${why})` : ''}. `
                  + 'That is this computer\'s internet or the provider being briefly unreachable, not the key — send it again in a moment');
            }
            if (err.status === 404) {
              // Two different things answer 404: an address with no API at it,
              // and a real API that has no model by that name. Saying "check
              // the URL" for the second sends somebody to fix what is not broken.
              const said = String(err.message ?? '');
              const aboutModel = /model|not found for account|does not exist|no such/i.test(said) || /\/v\d+\/?$/.test(String(baseURL ?? ''));
              throw new Error(aboutModel
                ? `${baseURL} has no model called "${model}" for this key (404) — press "find" on its row in setup to see the models it offers`
                : `${baseURL} answered 404 — the base URL is probably missing or has an extra path segment (most end in /v1)`);
            }
            throw new Error(`provider API error ${err.status}: ${err.message}`);
          }
          throw err;
        }

        const choice = response.choices?.[0];
        if (!choice) throw new Error('the provider returned no choices');
        const message = choice.message ?? {};

        // Echoed back so the tool results that follow attach to the right calls.
        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
        });

        if (choice.finish_reason === 'length') return { stopReason: 'max_tokens', text: '', toolCalls: [] };
        if (choice.finish_reason === 'content_filter') return { stopReason: 'refusal', text: '', toolCalls: [] };

        const toolCalls = (message.tool_calls ?? [])
          .filter((c) => c.type === 'function' || c.function)
          .map((c) => {
            let input = {};
            try {
              // Arguments arrive as a JSON string and can be malformed or
              // truncated; a parse failure must not take the turn down.
              input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
            } catch {
              input = { __malformed: c.function?.arguments ?? '' };
            }
            return { id: c.id, name: c.function?.name, input };
          });

        return {
          stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
          text: (message.content ?? '').trim(),
          toolCalls,
        };
      };

      return {
        async send(text) {
          messages.push({ role: 'user', content: text });
          return request();
        },
        async toolResults(results) {
          // One message per tool result, keyed by the call id it answers.
          for (const r of results) {
            messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
          }
          return request();
        },
        sent: () => messages,
        /** Cut the turn off wherever it is. */
        abort: () => ctl.abort(),
        /** Change which tools the rest of this turn is offered. */
        setTools(next) { toolDefs = asTools(next); },
        get aborted() { return ctl.signal.aborted; },
      };
    },
  };
}
