import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic adapter, on the official SDK.
 *
 * It keeps the conversation in the API's own content-block form rather than a
 * neutral one, because thinking blocks have to be echoed back unchanged to stay
 * valid on the same model — flattening them into a portable shape would throw
 * that away, and with it the reasoning continuity across tool calls.
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function anthropicAdapter({ apiKey, model, maxTokens, effort, createClient }) {
  const client = createClient ? createClient(apiKey) : new Anthropic({ apiKey });
  const level = EFFORTS.includes(effort) ? effort : 'high';

  /** Translate our neutral tool definitions into Anthropic's shape. */
  const asTools = (tools) =>
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

  return {
    provider: 'anthropic',
    model,

    startTurn({ system, tools }) {
      const messages = [];
      const toolDefs = asTools(tools);

      const request = async () => {
        let response;
        try {
          // Streaming because a turn carries a whole brief and may return a long
          // spec; a non-streaming call at this max_tokens risks an HTTP timeout.
          const stream = client.beta.messages.stream({
            model,
            max_tokens: maxTokens,
            system,
            thinking: { type: 'adaptive' },
            output_config: { effort: level },
            tools: toolDefs,
            messages,
            // The model can decline outright; the server reruns the request on a
            // fallback model inside the same call rather than returning nothing.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
          });
          response = await stream.finalMessage();
        } catch (err) {
          if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key');
          if (err instanceof Anthropic.RateLimitError) throw new Error('rate limited by Anthropic — backing off');
          if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
          throw err;
        }

        // Refusal must be checked before content is read: the whole fallback
        // chain declined, and content will not hold an answer.
        if (response.stop_reason === 'refusal') return { stopReason: 'refusal', text: '', toolCalls: [] };
        if (response.stop_reason === 'max_tokens') return { stopReason: 'max_tokens', text: '', toolCalls: [] };

        // Kept whole, thinking blocks included, for the next request.
        messages.push({ role: 'assistant', content: response.content });

        return {
          stopReason: response.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          text: response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
          toolCalls: response.content
            .filter((b) => b.type === 'tool_use')
            .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
        };
      };

      return {
        async send(text) {
          messages.push({ role: 'user', content: text });
          return request();
        },
        async toolResults(results) {
          // All results for one assistant turn go back in a single user message;
          // splitting them teaches the model to stop calling tools in parallel.
          messages.push({
            role: 'user',
            content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })),
          });
          return request();
        },
        sent: () => messages,
      };
    },
  };
}
