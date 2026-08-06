import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { type DispatchMode, IAgentDispatchModeService } from '#/agent/dispatch/dispatch';
import { DispatchModeModel } from '#/agent/dispatch/dispatchOps';
import { AgentDispatchModeService } from '#/agent/dispatch/dispatchService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'dispatch-mode-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentDispatchModeService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentDispatchModeService, new SyncDescriptor(AgentDispatchModeService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  svc = ix.get(IAgentDispatchModeService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await ix.get(IWireService).flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('AgentDispatchModeService (wire-backed)', () => {
  it('defaults to auto and fires onDidChangeMode only on actual change', () => {
    const changes: { mode: DispatchMode; previousMode: DispatchMode }[] = [];
    disposables.add(
      svc.onDidChangeMode((ctx) => {
        changes.push({ mode: ctx.mode, previousMode: ctx.previousMode });
      }),
    );

    expect(svc.mode).toBe('auto');

    svc.setMode('ask');
    expect(svc.mode).toBe('ask');
    expect(changes).toEqual([{ mode: 'ask', previousMode: 'auto' }]);

    svc.setMode('ask');
    expect(changes).toEqual([{ mode: 'ask', previousMode: 'auto' }]);

    svc.setMode('off');
    expect(changes).toEqual([
      { mode: 'ask', previousMode: 'auto' },
      { mode: 'off', previousMode: 'ask' },
    ]);
  });

  it('dispatch persists a flat { type, mode } record (v1 record-type parity)', async () => {
    svc.setMode('ask');

    const records = await readRecords();
    expect(records).toEqual([{ type: 'dispatch_mode.set', mode: 'ask', time: expect.any(Number) }]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('persists an explicitly configured auto mode when it matches the initial value', async () => {
    svc.setMode('auto');

    expect(await readRecords()).toEqual([
      { type: 'dispatch_mode.set', mode: 'auto', time: expect.any(Number) },
    ]);
  });

  it('replay rebuilds mode from a persisted record on a fresh WireService (v1 restoreSet parity)', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    const fresh = registerTestAgentWire(ix2, testWireScope(SCOPE, 'dispatch-mode-replay'), {
      log: log2,
    });

    await restoreTestAgentWire(fresh, log2, testWireScope(SCOPE, 'dispatch-mode-replay'), [
      { type: 'dispatch_mode.set', mode: 'off' },
    ]);

    expect(fresh.getModel(DispatchModeModel)).toBe('off');
  });
});
