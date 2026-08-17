import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, createKimiHarnessV2 } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kosong')>();
  return {
    ...actual,
    createProvider: () => ({
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      async generate() {
        throw new Error('no LLM in acp tests');
      },
      withThinking() {
        return this;
      },
    }),
  };
});

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session ACP bridge (v2)', () => {
  it('reports a disabled healthy manager by default', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ workDir });

      const status = await session.acpStatus();

      expect(status).toMatchObject({
        enabled: false,
        managerId: 'acp-kernel',
        health: 'healthy',
      });
    } finally {
      await harness.close();
    }
  });

  it('switches the active manager on enable and back off on disable', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ workDir });

      await session.acpEnable();
      expect((await session.acpStatus()).enabled).toBe(true);

      await session.acpDisable();
      expect((await session.acpStatus()).enabled).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('resets the agent-scoped ACP state', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-work-');
    const harness = createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ workDir });

      await session.acpReset();

      expect((await session.acpStatus()).health).toBe('healthy');
    } finally {
      await harness.close();
    }
  });
});

describe('Session ACP bridge (v1)', () => {
  it('rejects with NOT_IMPLEMENTED', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-v1-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-acp-v1-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ workDir });

      await expect(session.acpStatus()).rejects.toMatchObject({ code: 'not_implemented' });
      await expect(session.acpEnable()).rejects.toMatchObject({ code: 'not_implemented' });
      await expect(session.acpDisable()).rejects.toMatchObject({ code: 'not_implemented' });
      await expect(session.acpReset()).rejects.toMatchObject({ code: 'not_implemented' });
    } finally {
      await harness.close();
    }
  });
});
