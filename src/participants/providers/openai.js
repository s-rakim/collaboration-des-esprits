import OpenAI from 'openai';

/**
 * OpenAI adapter, on the official SDK, also used for every provider that speaks
 * the Chat Completions shape — Gemini's compatible endpoint, OpenRouter, Ollama,
 * and anything self-hosted. The only difference between them is the base URL.
 *
 * Deliberately not used for Anthropic: Claude has its own SDK and its own
 * request shape, and going through a compatibility layer would cost thinking
 * blocks and prompt caching.
 */

export function openaiAdapter({ apiKey, model, maxTokens, baseURL, createClient }) {
  const client = createClient
    ? createClient(apiKey, baseURL)
    // Some compatible servers (a local Ollama) need no credential, but the SDK
    // insists on a non-empty string.
    : new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseURL || undefined });

  const asTools = (tools) =>
    tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

  return {
    provider: 'openai-compatible',
    model,

    startTurn({ system, tools }) {
      const messages = [{ role: 'system', content: system }];
      const toolDefs = asTools(tools);

      const request = async () => {
        let response;
        try {
          response = await client.chat.completions.create({
            model,
            max_completion_tokens: maxTokens,
            messages,
            tools: toolDefs,
            tool_choice: 'auto',
          });
        } catch (err) {
          // The SDK's typed errors carry a status; map the ones worth naming.
          if (err instanceof OpenAI.AuthenticationError) throw new Error('the provider rejected the API key');
          if (err instanceof OpenAI.RateLimitError) throw new Error('rate limited by the provider — backing off');
          if (err instanceof OpenAI.APIError) throw new Error(`provider API error ${err.status}: ${err.message}`);
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
          // This shape wants one message per tool result, keyed by call id —
          // unlike Anthropic, which wants them all in a single user message.
          for (const r of results) {
            messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
          }
          return request();
        },
        sent: () => messages,
      };
    },
  };
}
