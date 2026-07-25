/**
 * `kosong/provider` domain (L2) — side-effect module for the four canonical
 * protocol-provider definitions and their endpoint environment fallbacks.
 *
 * The Anthropic definition also carries one narrow compatibility trait:
 * DeepSeek models served over the Anthropic wire require a flat object at the
 * root of every tool schema. The runtime provider identity is the configured
 * protocol type (`anthropic`), not the provider-table alias (`deepseek`), so
 * the trait gates on the wire model name and returns `undefined` for every
 * other Anthropic-compatible model.
 *
 * Google GenAI's endpoint traits preserve the Vertex-to-Gemini environment
 * fallback order. No definition declares a default base URL; construction
 * defaults remain owned by the protocol bases.
 */

import { convertDeepSeekTool } from './deepseek/deepseek-schema';
import { registerProviderDefinition } from '../providerDefinition';

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  traits: [
    {
      convertTool: (tool, context) =>
        /^deepseek(?:-|\/)/i.test(context.config.modelName)
          ? convertDeepSeekTool(tool)
          : undefined,
    },
  ],
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  traits: [
    // Two one-line endpoint traits so the aggregated apiKey fallback chain is
    // `VERTEXAI_API_KEY` → `GOOGLE_API_KEY` (legacy vertex precedence
    // preserved; plain Gemini users simply never set the vertex envs).
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }) },
  ],
});
