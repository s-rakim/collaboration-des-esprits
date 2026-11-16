/**
 * Free model APIs: providers with a free tier, ready to add as a connection.
 *
 * Taken from the community list at github.com/mnfst/awesome-free-llm-apis, as
 * it stood on the date below. It is a starting point, not a promise: free
 * tiers change, models are retired, limits move — the list's own notes say so
 * for several entries. Each entry carries the address to send requests to,
 * the page where a key is made, what the free tier allows, and the models the
 * list names. Where the list gives a display name rather than a model id, the
 * model is left for the provider's own catalogue to supply.
 *
 * Nothing here is called until a person adds one and puts their own key in.
 */

export const FREE_SOURCE = {
  name: 'awesome-free-llm-apis',
  url: 'https://github.com/mnfst/awesome-free-llm-apis',
  asOf: '2026-11-16',
};

/**
 * `baseURL` is the OpenAI-compatible one where the list gives two.
 * `keyOptional` means the list says it answers with no key at all.
 * `needs` is what stands between a person and the free tier, said plainly.
 */
export const FREE_PROVIDERS = [
  {
    name: 'Groq', group: 'Inference', baseURL: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys',
    limits: '30 requests/min, 1,000/day, 8,000 tokens/min, 200,000 tokens/day per model (varies by model)',
    needs: 'No credit card.', notes: 'Very fast. A good first choice for chat seats.',
    models: [
      { id: 'openai/gpt-oss-120b', context: '131K' },
      { id: 'openai/gpt-oss-20b', context: '131K' },
      { id: 'qwen/qwen3.8-27b', context: '131K', kind: 'text + image' },
    ],
  },
  {
    name: 'OpenRouter', group: 'Inference', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys',
    limits: '20 requests/min and 50/day across all free models; 1,000/day once the account has bought 10 credits',
    needs: 'No credit card for the free models.', notes: 'Free models end in :free. Free providers may log prompts for training.',
    models: [
      { id: 'openrouter/free', context: 'varies', note: 'routes to whichever free model is available' },
      { id: 'nvidia/nemotron-3.5-lightning:free', context: '1M' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', context: '1M' },
      { id: 'google/gemma-4-31b-it:free', context: '262K', kind: 'text + image + video' },
      { id: 'google/gemma-4-26b-a4b-it:free', context: '262K', kind: 'text + image + video' },
      { id: 'cohere/north-mini-code:free', context: '256K', kind: 'code' },
      { id: 'recursive/flint-v1.0:free', context: '262K' },
      { id: 'dots-studio/dots-3-note-preview:free', context: '512K', kind: 'text + image' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', context: '1M', kind: 'text + image + video' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', context: '256K', kind: 'reasoning, multimodal' },
    ],
  },
  {
    name: 'Google Gemini', group: 'Provider', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/app/apikey',
    limits: 'Not published per model — see your quotas in AI Studio',
    needs: 'No credit card.', notes: 'Free-tier prompts may be used to improve Google products (not in the EEA, Switzerland or the UK).',
    discoverModels: true,
    families: ['Gemini 3.8 Flash', 'Gemini 3.6 Flash', 'Gemini 3.5 Flash-Lite', 'Gemini 2.5 Flash', 'Gemma 4 31B'],
    models: [],
  },
  {
    name: 'NVIDIA NIM', group: 'Inference', baseURL: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/explore/discover',
    limits: 'Not published — varies per model and with how many people are using it',
    needs: 'Free NVIDIA Developer Program membership.', notes: 'For prototyping and testing. A model here can be fast one hour and hang the next; if a seat times out, try another model.',
    models: [
      { id: 'openai/gpt-oss-20b', context: '131K' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', context: '1M' },
    ],
  },
  {
    name: 'Cohere', group: 'Provider', baseURL: 'https://api.cohere.ai/compatibility/v1', keyUrl: 'https://dashboard.cohere.com/api-keys',
    limits: '1,000 calls/month, 20 requests/min, on a Trial key',
    needs: 'No credit card.', notes: 'Trial keys are for non-commercial use only.',
    discoverModels: true,
    families: ['Command A+', 'Command A', 'Command R+', 'Command R', 'Command R7B', 'Command A Reasoning', 'Aya Expanse 32B'],
    models: [],
  },
  {
    name: 'Cloudflare Workers AI', group: 'Inference', baseURL: 'https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    limits: '10,000 Neurons/day, shared across everything; resets at 00:00 UTC. Over the limit the request fails — it does not bill',
    needs: 'No credit card. Put your account id in the address in place of YOUR_ACCOUNT_ID.', notes: '60+ models on the free tier.',
    models: [
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', context: '24K' },
      { id: '@cf/openai/gpt-oss-120b', context: '128K' },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', context: '131K', kind: 'multimodal' },
      { id: '@cf/google/gemma-4-26b-a4b-it', context: '256K', kind: 'text + vision' },
      { id: '@cf/zai-org/glm-4.7-flash', context: '131K' },
      { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', context: '128K', kind: 'text + vision' },
      { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', context: '80K', kind: 'reasoning' },
    ],
  },
  {
    name: 'Kilo Code', group: 'Inference', baseURL: 'https://api.kilo.ai/api/gateway', keyUrl: 'https://app.kilo.ai/profile',
    limits: '200 requests/hour per IP', keyOptional: true,
    needs: 'No key and no credit card for the free models.', notes: 'The free pool changes often. The auto-router may send requests to providers that log prompts.',
    models: [
      { id: 'kilo-auto/free', context: '256K', note: 'routes to whichever free model is available' },
      { id: 'nvidia/nemotron-3.5-lightning:free', context: '1M' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', context: '1M' },
      { id: 'cohere/north-mini-code:free', context: '256K', kind: 'code' },
      { id: 'dots-studio/dots-3-note-preview:free', context: '512K', kind: 'text + vision' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', context: '1M', kind: 'multimodal' },
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', context: '256K', kind: 'reasoning, multimodal' },
      { id: 'stealth/glyph-cluster', context: '256K', kind: 'code' },
    ],
  },
  {
    name: 'LLM7.io', group: 'Inference', baseURL: 'https://api.llm7.io/v1', keyUrl: 'https://token.llm7.io',
    limits: '60 requests/min, 250/hour, 100,000 tokens/day with a free token', keyOptional: true,
    needs: 'Works with no key; a free token raises the limits.', notes: 'The free quota may be reduced without notice.',
    models: [
      { id: 'gpt-oss:20b', context: '128K' },
      { id: 'mistral-Nemo-Instruct-2407', context: '128K' },
      { id: 'codestral-latest', context: '32K', kind: 'code' },
    ],
  },
  {
    name: 'OVHcloud AI Endpoints', group: 'Inference', baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', keyUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/',
    limits: '2 requests/min per IP per model with no key', keyOptional: true,
    needs: 'No key and no signup for the anonymous tier.', notes: 'Hosted in the EU. Two requests a minute is one slow turn — fine for trying a model, thin for a busy room.',
    models: [
      { id: 'gpt-oss-120b', context: '131K' },
      { id: 'gpt-oss-20b', context: '131K' },
      { id: 'Meta-Llama-3_3-70B-Instruct', context: '131K' },
      { id: 'Qwen3.5-397B-A17B', context: '262K', kind: 'text + vision' },
      { id: 'Qwen3.8-27B', context: '262K', kind: 'text + vision' },
      { id: 'Qwen3.5-9B', context: '262K', kind: 'text + vision' },
    ],
  },
  {
    name: 'Z AI (Zhipu)', group: 'Provider', baseURL: 'https://api.z.ai/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    limits: '1 request at a time',
    needs: 'No credit card. Registration takes overseas phone numbers.', notes: 'One request at a time means seats on this key answer strictly one after another.',
    models: [
      { id: 'GLM-4.7-Flash', context: '200K', kind: 'reasoning' },
      { id: 'GLM-4.6V-Flash', context: '128K', kind: 'multimodal' },
    ],
  },
  {
    name: 'Aion Labs', group: 'Provider', baseURL: 'https://api.aionlabs.ai/v1', keyUrl: 'https://www.aionlabs.ai/app/api-keys/',
    limits: '15 requests/min, 20,000 tokens/day',
    needs: 'No credit card.', notes: 'Built for roleplay and storytelling. 20,000 tokens a day is a few turns.',
    models: [
      { id: 'aion-labs/aion-3.0', context: '128K', kind: 'reasoning' },
      { id: 'aion-labs/aion-3.0-mini', context: '128K', kind: 'reasoning' },
      { id: 'aion-labs/aion-2.0', context: '128K', kind: 'reasoning' },
      { id: 'aion-labs/aion-rp-llama-3.1-8b', context: '32K' },
    ],
  },
  {
    name: 'Gonka Broker', group: 'Inference', baseURL: 'https://proxy.gonkabroker.com/v1', keyUrl: 'https://app.gonkabroker.com/signup',
    limits: 'About 1M tokens/month, shared; resets monthly',
    needs: 'No credit card. SMS verification with a real, non-VoIP number.', notes: 'The model list rotates.',
    discoverModels: true,
    models: [
      { id: 'zai-org/GLM-5.3-Flash', context: '400K', kind: 'reasoning' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', context: '400K', kind: 'reasoning' },
      { id: 'MiniMaxAI/MiniMax-M2.7', context: '200K', kind: 'reasoning' },
    ],
  },
  {
    name: 'ModelScope', group: 'Inference', baseURL: 'https://api-inference.modelscope.cn/v1', keyUrl: 'https://modelscope.cn/my/myaccesstoken',
    limits: '2,000 requests/day in total, at most 500/day per model',
    needs: 'An Alibaba Cloud account with real-name verification.', notes: 'The list could not test this from outside mainland China.',
    models: [
      { id: 'Qwen/Qwen3.5-35B-A3B', context: '256K' },
      { id: 'Qwen/Qwen3.5-27B', context: '256K' },
    ],
  },
  {
    name: 'SiliconFlow', group: 'Inference', baseURL: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    limits: 'Not published',
    needs: 'Real-name identity verification (mainland-Chinese documents; others contact support).', notes: 'Most of its catalogue is paid. The list could not test this from outside mainland China.',
    models: [
      { id: 'tencent/Hunyuan-MT-7B', kind: 'translation' },
      { id: 'XingChenAGI/Xing4.0-29B' },
    ],
  },
];
