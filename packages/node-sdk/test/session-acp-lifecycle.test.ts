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
  it('keeps the manager enabled across a harness restart and resets after resume', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-resume-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-resume-work-');
    const first = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await first.createSession({ id: 'ses_acp_resume', workDir });
      await session.acpEnable();
      expect((await session.acpStatus()).enabled).toBe(true);
    } finally {
      await first.close();
    }

    const second = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const resumed = await second.resumeSession({ id: 'ses_acp_resume' });
      const status = await resumed.acpStatus();
      expect(status.enabled).toBe(true);
      expect(status.health).toBe('healthy');

      await resumed.acpReset();
      expect((await resumed.acpStatus()).health).toBe('healthy');
      // Reset clears state but must NOT disable the manager (the disable leg below covers that).
      expect((await resumed.acpStatus()).enabled).toBe(true);

      await resumed.acpDisable();
      expect((await resumed.acpStatus()).enabled).toBe(false);
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
      // A fork inherits activation (config-level) but not refs (session-scoped sidecar).
      expect((await fork.acpStatus()).enabled).toBe(true);

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
