/**
 * The Anthropic-shape adapter, for endpoints that serve /v1/messages.
 *
 * Free Claude Code is the reason this exists: it stands in front of dozens of
 * providers and holds their keys, but it speaks only Anthropic's shape — there
 * is no /chat/completions on it at all, so the OpenAI adapter 404s every turn.
 *
 * It has the same face as chatAdapter, so nothing above it knows which shape a
 * seat is on. The transcript is kept internally in the OpenAI shape, which is
 * what the rest of the room (and the Python runtime) reads, and translated on
 * the way out. Three differences do the work: the system prompt is a field
 * rather than the first message, a tool is described by input_schema rather
 * than nested under function, and tool results are content blocks on one user
 * message, because Anthropic alternates roles strictly and a run of user
 * messages is refused.
 *
 * Plain fetch rather than an SDK, because the request is one POST and the
 * whole of the protocol that matters here fits on this page.
 */

const TURN_TIMEOUT_MS = 180_000;
const ANTHROPIC_VERSION = '2023-06-01';

/** Headers for an Anthropic-shaped endpoint, credential in both spellings. */
export function messagesHeaders(apiKey, extra = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(extra.headers ?? {}),
  };
  if (apiKey) {
    // Which one a server reads depends on which client it is imitating: the
    // Anthropic API reads x-api-key, Free Claude Code's model listing reads
    // only Bearer. Sending the pair costs nothing.
    headers['x-api-key'] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** The internal (OpenAI-shaped) transcript, as an Anthropic request body. */
export function toMessages(transcript) {
  let system = '';
  const turns = [];
  const pushUser = (block) => {
    const last = turns[turns.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
    else turns.push({ role: 'user', content: [block] });
  };

  for (const m of transcript) {
    if (m.role === 'system') {
      system = m.content ?? '';
    } else if (m.role === 'tool') {
      pushUser({ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = {}; }
        content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
      }
      turns.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else {
      pushUser({ type: 'text', text: String(m.content ?? '') });
    }
  }
  return { system, messages: turns };
}

export function messagesAdapter({
  apiKey, model, maxTokens, baseURL, extra = {},
  timeoutMs = TURN_TIMEOUT_MS, maxRetries = 1, fetchImpl = fetch,
}) {
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  const url = `${base}/messages`;

  return {
    model,

    startTurn({ system, tools }) {
      // Kept in the OpenAI shape, so one transcript serves both adapters.
      const transcript = [{ role: 'system', content: system }];
      const toolDefs = tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      }));
      const ctl = new AbortController();

      const body = () => {
        const { system: sys, messages } = toMessages(transcript);
        return {
          model,
          max_tokens: maxTokens,
          messages,
          ...(sys ? { system: sys } : {}),
          ...(toolDefs.length ? { tools: toolDefs } : {}),
        };
      };

      const once = async () => {
        const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
        try {
          return await fetchImpl(url, {
            method: 'POST',
            headers: messagesHeaders(apiKey, extra),
            body: JSON.stringify(body()),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      };

      let stopped = false;

      const request = async () => {
        let res;
        for (let attempt = 0; ; attempt++) {
          try {
            res = await once();
          } catch (err) {
            if (stopped) {
              const stop = new Error('stopped');
              stop.interrupted = true;
              throw stop;
            }
            if (ctl.signal.aborted) {
              throw new Error(
                `${base || 'the provider'} accepted the connection but sent no reply within `
                + `${Math.round(timeoutMs / 1000)}s — try a smaller model, or check that the `
                + 'router has a working provider behind it.',
              );
            }
            if (attempt < maxRetries) continue;
            throw new Error(
              `could not reach ${base || 'the provider'} — check the base URL, and that the`
              + ` service is running (for Free Claude Code: fcc-server) (${err.message})`,
            );
          }
          // Worth one more go: the router busy or a provider behind it falling over.
          if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) continue;
          break;
        }

        const text = await res.text();
        if (!res.ok) {
          let message = text.slice(0, 300);
          try {
            const parsed = JSON.parse(text);
            message = parsed.error?.message ?? parsed.detail ?? parsed.message ?? message;
            if (typeof message !== 'string') message = JSON.stringify(message);
          } catch { /* not JSON, keep the text */ }
          // Free Claude Code explains a failure as a traceback of causes, one
          // per line. The first few say what happened; the rest is for its log.
          message = message.split('\n').map((l) => l.trim())
            .filter((l) => l && !l.endsWith(':')).slice(0, 3).join(' — ');
          if (res.status === 401 || res.status === 403) {
            const refused = new Error('the provider rejected the API key');
            refused.unauthorized = true;
            throw refused;
          }
          if (res.status === 429) throw new Error('rate limited by the provider — backing off');
          if (res.status === 404) {
            throw new Error(`${base} answered 404 for /messages — the base URL should end in /v1 (${message})`);
          }
          throw new Error(`provider API error ${res.status}: ${message}`);
        }

        let response;
        try { response = JSON.parse(text); } catch { throw new Error('the provider answered, but not with JSON'); }

        const blocks = Array.isArray(response.content) ? response.content : [];
        const said = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
        const uses = blocks.filter((b) => b.type === 'tool_use');

        transcript.push({
          role: 'assistant',
          content: said || null,
          ...(uses.length ? {
            tool_calls: uses.map((u) => ({
              id: u.id,
              type: 'function',
              function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
            })),
          } : {}),
        });

        if (response.stop_reason === 'max_tokens' && !uses.length) {
          return { stopReason: 'max_tokens', text: '', toolCalls: [] };
        }
        if (response.stop_reason === 'refusal') return { stopReason: 'refusal', text: '', toolCalls: [] };

        const toolCalls = uses.map((u) => ({ id: u.id, name: u.name, input: u.input ?? {} }));
        return { stopReason: toolCalls.length ? 'tool_use' : 'end_turn', text: said, toolCalls };
      };

      return {
        async send(text) {
          transcript.push({ role: 'user', content: text });
          return request();
        },
        async toolResults(results) {
          for (const r of results) transcript.push({ role: 'tool', tool_call_id: r.id, content: r.output });
          return request();
        },
        sent: () => transcript,
        abort: () => { stopped = true; ctl.abort(); },
        get aborted() { return ctl.signal.aborted; },
      };
    },
  };
}
