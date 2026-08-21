import { describe, expect, it } from 'vitest';

import { getAgentProfileContributions } from '#/app/agentProfileCatalog/contribution';

import type { AgentProfile, AgentProfileContext } from '#/app/agentProfileCatalog/agentProfileCatalog';

import '#/session/agentLifecycle/profile/profiles';

const promptContext: AgentProfileContext = {
  osKind: 'macOS',
  shellName: 'bash',
  shellPath: '/bin/bash',
  cwd: '/workspace',
  now: '2026-08-11T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
};

const GOAL_TOOLS = ['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] as const;

const ACP_TOOLS = ['compress', 'decompress', 'search_context', 'acp_status'] as const;

const SUBAGENT_PROFILES = [
  'coder',
  'coder-ex',
  'debugger',
  'explore',
  'reviewer',
  'frontend-artist',
] as const;

// Each role's opening sentence in `packages/agent-core/src/profile/default/<name>.yaml`,
// so a rewrite of the ported prompt text fails here instead of silently drifting from v1.
const ROLE_FINGERPRINTS: Record<string, string> = {
  'coder-ex':
    'You are the escalation tier for backend, core logic, CLI, infrastructure, build, and other non-visual engineering.',
  debugger: 'You are a read-only failure-diagnosis specialist.',
  reviewer: 'You are a read-only senior code reviewer.',
  'frontend-artist': 'You are a senior frontend engineer and digital artist.',
};

function profileByName(name: string): AgentProfile {
  const profile = getAgentProfileContributions().find((candidate) => candidate.name === name);
  expect(profile, `profile "${name}" is not registered`).toBeDefined();
  return profile as AgentProfile;
}

describe('builtin agent profiles', () => {
  it('registers the default agent plus every task-agent profile', () => {
    const names = getAgentProfileContributions().map((profile) => profile.name);
    expect(new Set(names)).toEqual(new Set(['agent', ...SUBAGENT_PROFILES]));
  });

  it('lists main-only goal tools on the agent profile but not on subagent profiles', () => {
    expect(profileByName('agent').tools).toEqual(expect.arrayContaining([...GOAL_TOOLS]));
    for (const name of SUBAGENT_PROFILES) {
      const tools = profileByName(name).tools ?? [];
      for (const goalTool of GOAL_TOOLS) {
        expect(tools, `${name} must not expose ${goalTool}`).not.toContain(goalTool);
      }
    }
  });

  it('lists ACP tools on the agent profile but not on subagent profiles', () => {
    expect(profileByName('agent').tools).toEqual(expect.arrayContaining([...ACP_TOOLS]));
    for (const name of SUBAGENT_PROFILES) {
      const tools = profileByName(name).tools ?? [];
      for (const acpTool of ACP_TOOLS) {
        expect(tools, `${name} must not expose ${acpTool}`).not.toContain(acpTool);
      }
    }
  });

  it('gives the ported profiles the same tool sets as their v1 counterparts', () => {
    const explore = new Set(profileByName('explore').tools ?? []);
    const coder = new Set(profileByName('coder').tools ?? []);

    for (const name of ['debugger', 'reviewer']) {
      expect(new Set(profileByName(name).tools ?? [])).toEqual(explore);
    }
    for (const name of ['coder-ex', 'frontend-artist']) {
      expect(new Set(profileByName(name).tools ?? [])).toEqual(coder);
    }
  });

  it('renders the Skills section only for profiles that keep the Skill tool', () => {
    for (const name of ['agent', 'coder', 'coder-ex', 'frontend-artist']) {
      const profile = profileByName(name);
      expect(profile.tools).toContain('Skill');
      const prompt = profile.systemPrompt(promptContext);
      expect(prompt).toContain('# Skills');
      expect(prompt).toContain('- test-skill: does things');
    }

    for (const name of ['explore', 'debugger', 'reviewer']) {
      const profile = profileByName(name);
      expect(profile.tools).not.toContain('Skill');
      const prompt = profile.systemPrompt(promptContext);
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('keeps the ported role text verbatim from the v1 profile sources', () => {
    for (const [name, fingerprint] of Object.entries(ROLE_FINGERPRINTS)) {
      expect(profileByName(name).systemPrompt(promptContext)).toContain(fingerprint);
    }
  });

  it('describes every task-agent profile for the Agent tool listing', () => {
    for (const name of SUBAGENT_PROFILES) {
      const profile = profileByName(name);
      expect(profile.description?.length ?? 0).toBeGreaterThan(0);
      expect(profile.whenToUse?.length ?? 0).toBeGreaterThan(0);
      expect(profile.summaryPolicy?.minChars).toBe(200);
    }
  });
  it('wires TowerInit into the default profile', () => {
    const agent = profileByName('agent');
    expect(agent.tools).toContain('TowerInit');
  });

  it('caps the default profile delegation at non-spawning profiles', () => {
    const agent = profileByName('agent');
    expect(agent.subagents).toEqual(['coder', 'explore', 'plan']);
  });
});
