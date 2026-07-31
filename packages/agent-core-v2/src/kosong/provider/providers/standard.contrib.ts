/**
 * `kosong/provider` domain (L2) — side-effect module for the four canonical
 * protocol-provider definitions and their endpoint environment fallbacks.
 *
 * `kosong/provider` domain — side-effect module: endpoint-only provider
 * definitions for the four canonical vendors.
 *
 * Only the Kimi vendor definition existed before, so endpoint resolution
 * answered for `kimi` alone and the legacy config-env-bag fallbacks
 * (`[providers.x.env] OPENAI_API_KEY=…` etc.) had no registry home. Endpoint
 * resolution now goes through the definition registry — hardcoded
 * per-protocol env tables are abolished — so the four canonical vendors each
 * need a definition that declares their env chain. These declarations change
 * nothing else: each vendor's `baseProtocol` equals its protocol id and
 * (Google GenAI aside, see below) the trait list is empty, so adapter
 * identity, hook composition, and capability resolution are exactly as they
 * were for an unregistered vendor.
 *
 * No `defaultBaseUrl` is declared: construction-time defaults stay where they
 * always were (inside the bases / their SDKs), matching the legacy env-only
 * fallback semantics precisely.
 *
 * Google GenAI is the one definition with non-empty traits: Vertex AI is a
 * `providerOptions` mode of the `google-genai` base rather than a vendor of
 * its own, and two one-line endpoint traits keep the legacy vertex chain
 * precedence — `VERTEXAI_API_KEY` / `GOOGLE_VERTEX_BASE_URL` first,
 * `GOOGLE_API_KEY` / `GOOGLE_GEMINI_BASE_URL` as fallback — while plain
 * Gemini users without the vertex envs see exactly the old behavior.
 *
 *
 * This fork's Anthropic definition also carries one narrow compatibility trait:
 * DeepSeek models served over the Anthropic wire require a flat object at the
 * root of every tool schema. The runtime provider identity is the configured
 * protocol type (`anthropic`), not the provider-table alias (`deepseek`), so
 * the trait gates on the wire model name and returns `undefined` for every
 * other Anthropic-compatible model.
 *
 * Like every contrib, this module is imported for effect only.
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
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' }) },
  ],
});
