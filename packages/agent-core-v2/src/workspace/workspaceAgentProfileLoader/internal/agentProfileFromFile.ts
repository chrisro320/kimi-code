import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import { renderPromptTemplateResult } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition, AgentFileDiscoveryResult } from './types';

const LEAN_CTX_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Read: ['mcp__lean-ctx__ctx_read'],
  Grep: ['mcp__lean-ctx__ctx_search'],
  Glob: ['mcp__lean-ctx__ctx_glob', 'mcp__lean-ctx__ctx_tree'],
  Bash: ['mcp__lean-ctx__ctx_shell'],
};

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfile {
  const tools = normalizeFileAgentTools(definition.tools);
  const disallowedTools = normalizeFileAgentTools(definition.disallowedTools);
  const skillActive =
    (tools === undefined || tools.includes('Skill')) && !(disallowedTools ?? []).includes('Skill');
  return normalizeAgentProfile({
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    override: definition.override || definition.source === 'explicit',
    tools,
    disallowedTools,
    subagents: definition.subagents,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(definition.prompt, context, { skillActive }, basePrompt),
  });
}

function normalizeFileAgentTools(
  tools: readonly string[] | undefined,
): readonly string[] | undefined {
  if (tools === undefined) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const replacement of LEAN_CTX_TOOL_ALIASES[tool] ?? [tool]) {
      if (seen.has(replacement)) continue;
      seen.add(replacement);
      normalized.push(replacement);
    }
  }
  return normalized;
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfileContribution {
  return {
    profiles: result.agents.map((definition) => agentProfileFromFile(definition, basePrompt)),
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
  };
}
