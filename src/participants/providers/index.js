import { openaiAdapter } from './openai.js';

/**
 * Providers a seat can run on.
 *
 * All of them speak the OpenAI Chat Completions shape, which is what almost
 * every provider and local runner exposes, so a single adapter with a different
 * base URL reaches them all. Adding another is a row in this table, not code.
 *
 * `keyEnv` is the conventional environment variable for that provider, used as a
 * fallback when a seat has no key of its own.
 */
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    adapter: openaiAdapter,
    keyEnv: 'OPENAI_API_KEY',
    keyHint: 'platform.openai.com',
    // Reasoning models take a reasoning_effort parameter. Declared per provider
    // rather than sent everywhere, because a provider that does not know the
    // field will reject the whole request.
    effortParam: 'reasoning_effort',
    models: [
      { id: 'gpt-5.2', label: 'GPT-5.2', note: '' },
      { id: 'gpt-5.1', label: 'GPT-5.1', note: '' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', note: 'Cheaper.' },
      { id: 'o4', label: 'o4', note: 'Reasoning model.' },
    ],
  },
  google: {
    label: 'Google Gemini',
    adapter: openaiAdapter,
    // Gemini exposes an OpenAI-compatible endpoint, so the same adapter works.
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyEnv: 'GOOGLE_API_KEY',
    keyHint: 'aistudio.google.com',
    models: [
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', note: '' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', note: 'Cheaper.' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    adapter: openaiAdapter,
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyHint: 'openrouter.ai — one key, many models',
    models: [
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2', note: '' },
      { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', note: '' },
      { id: 'qwen/qwen3-max', label: 'Qwen3 Max', note: '' },
      { id: 'x-ai/grok-4', label: 'Grok 4', note: '' },
    ],
  },
  ollama: {
    label: 'Ollama (local)',
    adapter: openaiAdapter,
    baseURL: 'http://127.0.0.1:11434/v1',
    keyEnv: 'OLLAMA_API_KEY',
    keyHint: 'no key needed for a local Ollama',
    keyOptional: true,
    models: [
      { id: 'llama4', label: 'Llama 4', note: '' },
      { id: 'qwen3', label: 'Qwen 3', note: '' },
      { id: 'deepseek-r1', label: 'DeepSeek R1', note: '' },
    ],
  },
  custom: {
    label: 'Other OpenAI-compatible',
    adapter: openaiAdapter,
    keyEnv: 'ESPRITS_CUSTOM_API_KEY',
    keyHint: 'anything exposing /v1/chat/completions — set the base URL too',
    needsBaseURL: true,
    models: [],
  },
};

/** Falls back to the first declared provider so an unknown name cannot crash a caller. */
/** Used when a seat names a provider that no longer exists. */
export const DEFAULT_PROVIDER = 'openai';

export function providerFor(name) {
  return PROVIDERS[name] ?? PROVIDERS[DEFAULT_PROVIDER];
}

/** What the setup page needs to render the picker. Never includes a key. */
export function describeProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    keyEnv: p.keyEnv,
    keyHint: p.keyHint,
    keyOptional: Boolean(p.keyOptional),
    needsBaseURL: Boolean(p.needsBaseURL),
    supportsEffort: Boolean(p.effortParam),
    defaultBaseURL: p.baseURL ?? '',
    models: p.models,
  }));
}
