import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILES } from '../../../src/profile';

const promptContext = {
  osEnv: {
    osKind: 'linux',
    osArch: 'x64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-07-19T00:00:00.000Z',
  cwdListing: 'src',
  agentsMd: '',
  skills: '',
} as const;

type DispatchFixture = {
  readonly scenario: string;
  readonly action: string;
  readonly profile: string;
  readonly rationaleCategory: string;
};

const dispatchFixtures: readonly DispatchFixture[] = [
  {
    scenario: 'trivial-known-change',
    action: 'direct',
    profile: 'none',
    rationaleCategory: 'trivial',
  },
  {
    scenario: 'missing-code-context',
    action: 'delegate',
    profile: 'explore',
    rationaleCategory: 'missing-context',
  },
  {
    scenario: 'unclear-failure',
    action: 'delegate',
    profile: 'debugger',
    rationaleCategory: 'failure-diagnosis',
  },
  {
    scenario: 'independent-same-profile',
    action: 'delegate',
    profile: 'AgentSwarm(coder)',
    rationaleCategory: 'parallel-independent',
  },
  {
    scenario: 'mixed-frontend-backend',
    action: 'delegate',
    profile: 'Agent(coder)+Agent(frontend-artist)',
    rationaleCategory: 'specialist-split',
  },
  {
    scenario: 'tightly-coupled-shared-files',
    action: 'serialize',
    profile: 'none',
    rationaleCategory: 'shared-context',
  },
];

describe('deterministic proactive dispatch policy fixtures', () => {
  it.each(dispatchFixtures)('$scenario has a stable action/profile/rationale contract', (fixture) => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain(
      `- \`${fixture.scenario}\` -> \`${fixture.action}\` / profile \`${fixture.profile}\` / rationale category \`${fixture.rationaleCategory}\``,
    );
  });

  it('repairs a fixable coder delivery by resuming the same agent before escalation', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(promptContext) ?? '';
    expect(prompt).toContain('Agent(resume=<agent id>)');
    expect(prompt).toContain('Do not spawn another coder for that scope while the original agent remains resumable.');
    expect(prompt).toContain('Escalate to `coder-ex` only when the original session is demonstrably non-resumable');
  });
});
