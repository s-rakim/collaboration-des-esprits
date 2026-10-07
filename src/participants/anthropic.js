/**
 * The Anthropic Messages shape.
 *
 * Free Claude Code serves /v1/messages and /v1/responses and has no
 * /chat/completions at all, so without this the room pointed at it would 404
 * every turn. 9Router and My Claude Code serve both, and for those the OpenAI
 * adapter is still the one used — this exists for the router that only speaks
 * the other language.
 *
 * Three differences do the work:
 *
 *   - the system prompt is a top-level field, not the first message;
 *   - a tool is described by `input_schema` rather than nested under `function`;
 *   - tool results are content blocks on a user message rather than messages of
 *     their own, because roles alternate strictly here and a run of user
 *     messages is refused outright.
 *
 * The transcript is kept in the OpenAI shape internally and translated on the
 * way out, so one conversation survives being moved between routers.
 */

const TURN_TIMEOUT_MS = 180_000;

/** The same surface chatAdapter has, so nothing above here knows the difference. */
export function anthropicAdapter({
  apiKey, model, maxTokens, effort, baseURL,
  timeoutMs = TURN_TIMEOUT_MS, fetchImpl = fetch,
}) {
  const url = `${String(baseURL || '').replace(/\/+$/, '')}/messages`;

  const headers = () => {
    const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    // Which of the two a router reads depends on which shape it is imitating,
    // and sending the pair costs nothing. This is the router's own token, not
    // a provider key — the router holds those.
    if (apiKey) {
      h['x-api-key'] = apiKey;
      h.authorization = `Bearer ${apiKey}`;
    }
    return h;
  };

  return {
    model,

    startTurn({ system, tools }) {
      const messages = [{ role: 'system', content: system }];
      const ctl = new AbortController();

      /** The transcript, translated. */
      const body = () => {
        let systemText = '';
        const turns = [];
        for (const m of messages) {
          if (m.role === 'system') {
            systemText = m.content ?? '';
          } else if (m.role === 'tool') {
            const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' };
            const last = turns[turns.length - 1];
            // Consecutive results belong to one user message. Two tools
            // answered in one round is the ordinary case for a parallel call,
            // and sending those as two user messages in a row is refused.
            if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
            else turns.push({ role: 'user', content: [block] });
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
            turns.push({ role: 'user', content: m.content ?? '' });
          }
        }

        return {
          model,
          messages: turns,
          max_tokens: maxTokens,
          ...(systemText ? { system: systemText } : {}),
          ...(tools?.length
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters ?? { type: 'object' },
                })),
              }
            : {}),
          ...(effort ? { thinking: { type: 'enabled', budget_tokens: Math.min(maxTokens - 1, 8192) } } : {}),
        };
      };

      const request = async () => {
        let res;
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body()),
            signal: ctl.signal,
          });
        } catch (err) {
          if (ctl.signal.aborted || err.name === 'AbortError') {
            const stop = new Error('stopped');
            stop.interrupted = true;
            throw stop;
          }
          throw new Error(
            `could not reach ${baseURL} — check the address, and that the router is running`,
          );
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          const text = (await res.text()).slice(0, 400);
          let message = text;
          try {
            const parsed = JSON.parse(text);
            message = parsed.error?.message ?? parsed.message ?? parsed.detail ?? text;
          } catch { /* not JSON; the text is the message */ }
          if (res.status === 401 || res.status === 403) {
            const refused = new Error('the provider rejected the API key');
            refused.unauthorized = true;
            throw refused;
          }
          throw new Error(`router error ${res.status}: ${message}`);
        }

        const answer = await res.json();
        const blocks = answer.content ?? [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
        const uses = blocks.filter((b) => b.type === 'tool_use');

        // Echoed back in the OpenAI shape, so the transcript stays one thing.
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(uses.length
            ? {
                tool_calls: uses.map((u) => ({
                  id: u.id,
                  type: 'function',
                  function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
                })),
              }
            : {}),
        });

        if (answer.stop_reason === 'max_tokens') return { stopReason: 'max_tokens', text: '', toolCalls: [] };
        if (answer.stop_reason === 'refusal') return { stopReason: 'refusal', text: '', toolCalls: [] };

        const toolCalls = uses.map((u) => ({ id: u.id, name: u.name, input: u.input ?? {} }));
        return { stopReason: toolCalls.length ? 'tool_use' : 'end_turn', text, toolCalls };
      };

      return {
        async send(text) {
          messages.push({ role: 'user', content: text });
          return request();
        },
        async toolResults(results) {
          for (const r of results) {
            messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
          }
          return request();
        },
        sent: () => messages,
        abort: () => ctl.abort(),
        get aborted() { return ctl.signal.aborted; },
      };
    },
  };
}

/**
 * Which shape a router speaks, asked rather than assumed.
 *
 * Asked with GET, which is the one question whose answer cannot mean anything
 * else: a path that exists but takes POST answers 405, a path that does not
 * exist answers 404. A POST would have been ambiguous, because a 404 could
 * equally be the router saying it has no such model.
 */
export async function detectShape(baseURL, { fetchImpl = fetch, timeoutMs = 8000, apiKey } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${String(baseURL).replace(/\/+$/, '')}/chat/completions`, {
      method: 'GET',
      signal: ctl.signal,
      headers: apiKey ? { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey } : {},
    });
    // Only the status is wanted, but an unread body holds its socket open and
    // the connection is never released — which is a leak in a long-running
    // server and a process that will not exit in a test.
    await res.body?.cancel().catch(() => {});
    return res.status === 404 ? 'messages' : 'chat';
  } catch {
    // Unreachable is not an answer about shape. Say the usual one and let the
    // real call report the real problem.
    return 'chat';
  } finally {
    clearTimeout(timer);
  }
}
