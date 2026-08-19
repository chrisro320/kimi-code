import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarnessV2 } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

// These SDK-level tests run no turns, so no refs are ever minted; state-bearing
// reset/isolation semantics live at the engine layer (test/features/acp/ in agent-core-v2).
describe('Session ACP lifecycle (v2)', () => {
  it('holds the activation for the session and drops it on a harness restart', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-resume-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-resume-work-');
    const first = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await first.createSession({ id: 'ses_acp_resume', workDir });
      await session.acpEnable();
      expect((await session.acpStatus()).enabled).toBe(true);

      await session.acpReset();
      expect((await session.acpStatus()).health).toBe('healthy');
      // Reset clears state but must NOT disable the manager (the disable leg below covers that).
      expect((await session.acpStatus()).enabled).toBe(true);

      await session.acpDisable();
      expect((await session.acpStatus()).enabled).toBe(false);
    } finally {
      await first.close();
    }

    // The activation is an agent-scoped override, never a config write, so a
    // fresh process resumes the session at the default instead of inheriting
    // whatever the last `acpEnable()` on this box happened to be.
    const second = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const resumed = await second.resumeSession({ id: 'ses_acp_resume' });
      expect((await resumed.acpStatus()).enabled).toBe(false);

      await resumed.acpEnable();
      expect((await resumed.acpStatus()).enabled).toBe(true);
    } finally {
      await second.close();
    }

    const third = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const resumed = await third.resumeSession({ id: 'ses_acp_resume' });
      expect((await resumed.acpStatus()).enabled).toBe(false);
    } finally {
      await third.close();
    }
  });

  it('keeps one live session\'s ACP toggle out of another live session', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-isolation-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-isolation-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const a = await harness.createSession({ id: 'ses_acp_iso_a', workDir });
      const b = await harness.createSession({ id: 'ses_acp_iso_b', workDir });

      await b.acpEnable();
      expect((await b.acpStatus()).enabled).toBe(true);
      // Session A never asked for ACP. A machine-wide `contextManager` write
      // would switch it on here, because A holds no override of its own and
      // the requester re-reads that section on every request.
      expect((await a.acpStatus()).enabled).toBe(false);

      await a.acpEnable();
      await a.acpDisable();
      // The reverse leg: A opting out must not drag B out with it.
      expect((await b.acpStatus()).enabled).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('gives a forked session its own ACP activation', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-fork-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-fork-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const source = await harness.createSession({ id: 'ses_acp_fork_src', workDir });
      await source.acpEnable();

      const fork = await harness.forkSession({
        id: source.id,
        forkId: 'ses_acp_fork_child',
      });
      expect((await fork.acpStatus()).refs).toBe(0);
      // The fork gets its own agent, and activation lives on the agent, so it
      // inherits neither the manager choice nor the refs.
      expect((await fork.acpStatus()).enabled).toBe(false);

      await fork.acpReset();
      expect((await source.acpStatus()).enabled).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('exports a session with ACP enabled', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-export-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-export-work-');
    const outputPath = join(await makeTempDir(tempDirs, 'kimi-sdk-acp-export-out-'), 'out.zip');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ id: 'ses_acp_export', workDir });
      await session.acpEnable();

      const result = await harness.exportSession({
        id: session.id,
        outputPath,
        version: '1.0.0-test',
      });

      expect(result.zipPath).toBe(outputPath);
      expect((await session.acpStatus()).health).toBe('healthy');
    } finally {
      await harness.close();
    }
  });
});
