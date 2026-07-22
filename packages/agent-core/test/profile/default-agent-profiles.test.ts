import { describe, expect, it, vi } from 'vitest';

import type { SkillRegistry } from '../../src/agent/skill';
import { DEFAULT_AGENT_PROFILES, loadAgentProfilesFromSources } from '../../src/profile';

const promptContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: 'LISTING_SNAPSHOT',
  agentsMd: 'AGENTS_MD_BODY',
  skills: '- test-skill: does things\n  Path: /skills/test/SKILL.md',
} as const;

describe('default agent profiles', () => {
  it('loads the bundled default system prompt from embedded sources', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext);

    expect(prompt).toContain('You are Kimi Code CLI');
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('/workspace');
  });

  it('keeps static instructions before dynamic prompt context', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';

    expect(prompt.indexOf('Use this as your basic understanding of the project structure.')).toBeLessThan(
      prompt.indexOf('LISTING_SNAPSHOT'),
    );
    expect(prompt.indexOf('User instructions given directly in the conversation')).toBeLessThan(
      prompt.indexOf('AGENTS_MD_BODY'),
    );
    expect(prompt.indexOf('Only read skill details when needed')).toBeLessThan(
      prompt.indexOf('- test-skill: does things'),
    );
  });

  it('passes compact listing mode only when requested by runtime context', () => {
    const getModelSkillListing = vi.fn((options?: { readonly compact?: boolean }) =>
      options?.compact === true ? '- compact-skill' : '- full-skill',
    );
    const skills = { getModelSkillListing } as unknown as SkillRegistry;

    const compactPrompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({
      ...promptContext,
      skills,
      compactSkillListing: true,
    });
    const fullPrompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt({ ...promptContext, skills });

    expect(compactPrompt).toContain('- compact-skill');
    expect(compactPrompt).not.toContain('- full-skill');
    expect(fullPrompt).toContain('- full-skill');
    expect(getModelSkillListing).toHaveBeenNthCalledWith(1, { compact: true });
    expect(getModelSkillListing).toHaveBeenNthCalledWith(2, { compact: false });
  });

  it('lists main-only goal and collaboration tools on the agent profile but not on subagent profiles', () => {
    const agentTools = DEFAULT_AGENT_PROFILES['agent']?.tools ?? [];
    expect(agentTools).toEqual(
      expect.arrayContaining([
        'CreateGoal',
        'GetGoal',
        'SetGoalBudget',
        'UpdateGoal',
        'Agora',
        'ReferenceAudit',
        'AssetPipeline',
      ]),
    );
    expect(DEFAULT_AGENT_PROFILES['agent']?.subagents?.['agora-peer']).toBeDefined();
    for (const name of ['coder', 'coder-ex', 'debugger', 'explore', 'reviewer', 'agora-peer', 'frontend-artist']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('CreateGoal');
      expect(tools).not.toContain('GetGoal');
      expect(tools).not.toContain('SetGoalBudget');
      expect(tools).not.toContain('UpdateGoal');
      expect(tools).not.toContain('Agora');
      expect(tools).not.toContain('ReferenceAudit');
      expect(tools).not.toContain('AssetPipeline');
    }
  });

  it('fails loudly when an embedded system prompt source is missing', () => {
    expect(() =>
      loadAgentProfilesFromSources(['profile/default/agent.yaml'], {
        'profile/default/agent.yaml': 'name: agent\nsystemPromptPath: ./missing.md\n',
      }),
    ).toThrow(/Embedded agent profile source missing: profile\/default\/missing\.md/);
  });

  it('omits the Skills section only for profiles that lack the Skill tool', () => {
    // The root agent, implementation workers, and frontend-artist have the Skill tool,
    // so the Skills section and listing render in their prompts.
    for (const name of ['agent', 'coder', 'coder-ex', 'frontend-artist']) {
      expect(DEFAULT_AGENT_PROFILES[name]?.tools).toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).toContain('# Skills');
      expect(prompt).toContain('- test-skill: does things');
    }

    // explore/debugger/reviewer lack the Skill tool, so neither the section heading
    // nor the skill listing should appear in their prompts.
    for (const name of ['explore', 'debugger', 'reviewer']) {
      const tools = DEFAULT_AGENT_PROFILES[name]?.tools ?? [];
      expect(tools).not.toContain('Skill');
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('# Skills');
      expect(prompt).not.toContain('- test-skill: does things');
    }
  });

  it('keeps optional-tool guidance out of the shared system prompt entirely', () => {
    // Tool-coupled guidance now lives in each tool's own description, which the schema
    // layer ships ONLY when the tool is registered — that is the availability gate, for
    // free. So the shared system.md must not name optional tools at all (no per-tool
    // {% if %} reconstruction of availability). This holds for the root `agent` too, not
    // just subagents. The cross-tool secret-file guard — built on the always-present
    // Read/Grep/Glob — stays shared.
    for (const name of ['agent', 'coder', 'coder-ex', 'explore', 'debugger', 'reviewer', 'frontend-artist']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      expect(prompt).not.toContain('Launch multiple explore agents concurrently'); // Agent → agent.md + explore whenToUse
      expect(prompt).not.toContain('long-running shell commands as background tasks'); // background → bash.md
      expect(prompt).not.toContain('maintain a `TodoList`'); // TodoList → todo-list.md
      expect(prompt).not.toContain('prefer entering plan mode first'); // EnterPlanMode → enter-plan-mode.md
      expect(prompt).not.toContain('call `TaskList` to re-enumerate'); // compaction recovery → task-list.md
      // The dedicated-tool routing must name only universally-present tools (Read/Glob/Grep).
      // Write/Edit are absent from read-only profiles (explore/debugger/reviewer have
      // Bash but no Write/Edit), so naming them in the shared routing sentence would dangle —
      // that routing lives in bash.md (echo>file→Write, sed→Edit, etc.), which ships with Bash.
      expect(prompt).not.toContain('`Write` / `Edit` to change files');
      expect(prompt).not.toContain('Keep `Bash` for genuine shell work');
      expect(prompt).toContain('`Glob` to find files by name'); // universal routing stays
      expect(prompt).toContain('refuse a fixed set of well-known secret files'); // shared guard stays
    }
  });

  it('renders blast-radius and concrete-example guidance for root and subagents alike', () => {
    // These additions live in shared, ungated sections, so the root agent AND every
    // subagent that renders the coding guidelines must carry them verbatim.
    for (const name of ['agent', 'coder', 'coder-ex', 'explore', 'debugger', 'reviewer', 'frontend-artist']) {
      const prompt = DEFAULT_AGENT_PROFILES[name]?.systemPrompt(promptContext) ?? '';
      // Reversibility / blast-radius principle generalized beyond the git rule.
      expect(prompt).toContain('reversibility and blast radius');
      expect(prompt).toContain('A one-time approval covers that one action');
      // The "do local work freely" clause is role-scoped: read-only subagents (explore/debugger)
      // render this same paragraph, so it must not tell them editing files is free.
      expect(prompt).toContain('Local, reversible work your role permits');
      // Concrete one-line examples anchoring high-frequency abstract rules.
      expect(prompt).toContain('locate the method in the code'); // ambiguous instruction -> edit code, not echo text
      expect(prompt).toContain('update the related tests'); // preamble phrasing example
      expect(prompt).toContain('premature abstraction'); // MINIMAL-changes counterexample
    }
  });
});
