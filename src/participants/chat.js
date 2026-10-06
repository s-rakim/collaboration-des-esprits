import OpenAI from 'openai';

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

export function chatAdapter({
  apiKey, model, maxTokens, effort, effortParam, baseURL, createClient,
  timeoutMs = TURN_TIMEOUT_MS, maxRetries = 1,
}) {
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
      const toolDefs = asTools(tools);
      // One controller for the whole turn, so "stop" reaches whichever request
      // is in flight rather than only the next one that has not started.
      const ctl = new AbortController();

      const request = async () => {
        let response;
        try {
          response = await client.chat.completions.create({
            model,
            max_completion_tokens: maxTokens,
            messages,
            tools: toolDefs,
            tool_choice: 'auto',
            // Omitted entirely unless the provider declared the field, since an
            // unknown parameter fails the request rather than being ignored.
            ...(effortParam && effort ? { [effortParam]: effort } : {}),
          }, { signal: ctl.signal });
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
              throw new Error(`could not reach ${baseURL || 'the provider'} — check the base URL, and that the service is running`);
            }
            if (err.status === 404) {
              throw new Error(`${baseURL} answered 404 — the base URL is probably missing or has an extra path segment (most end in /v1)`);
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
        get aborted() { return ctl.signal.aborted; },
      };
    },
  };
}
