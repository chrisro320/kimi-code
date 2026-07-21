import { describe, expect, it, vi } from 'vitest';

import {
  buildReferenceAuditPlan,
  classifyReferenceAudit,
  type ReferenceAuditPlan,
  type ReferenceAuditRequest,
} from '../../src/reference-audit';
import {
  assembleReferenceAuditTrackResults,
  buildReferenceAuditTasks,
  REFERENCE_AUDIT_TRACK_TIMEOUT_MS,
  runReferenceAuditTracks,
} from '../../src/reference-audit/orchestration';
import { ReferenceAuditTool } from '../../src/tools/builtin/collaboration/reference-audit';

function reference(id: string, role: 'behavioral' | 'visual' | 'technical' | 'mixed' = 'mixed') {
  return { id, label: id, kind: 'product' as const, role };
}

function deepPlan(): ReferenceAuditPlan {
  const request: ReferenceAuditRequest = {
    references: [reference('minecraft'), reference('no-mans-sky')],
    crossProductMashup: true,
  };
  const decision = classifyReferenceAudit(request);
  if (!decision.triggered) throw new Error('expected triggered audit');
  return buildReferenceAuditPlan(request, decision);
}

function standardPlan(): ReferenceAuditPlan {
  const request: ReferenceAuditRequest = {
    references: [reference('a', 'behavioral'), reference('b', 'technical')],
  };
  const decision = classifyReferenceAudit(request);
  if (!decision.triggered) throw new Error('expected triggered audit');
  return buildReferenceAuditPlan(request, decision);
}

function rawReport(trackId: string, referenceId: string, claim = 'A directly supported fact.') {
  return JSON.stringify({
    track_id: trackId,
    claims: [
      {
        claim,
        kind: 'evidence',
        reference_id: referenceId,
        provenance: [{ source: 'https://example.test/source' }],
      },
    ],
    contradictions: [],
    unknowns: [],
    license_notes: [],
  });
}

describe('buildReferenceAuditTasks', () => {
  it('dispatches every track read-only, internal-only, discard-changes, and enforced', () => {
    const plan = standardPlan();
    const tasks = buildReferenceAuditTasks(plan, 'parent-1');

    expect(tasks).toHaveLength(plan.tracks.length);
    for (const task of tasks) {
      expect(task.kind).toBe('spawn');
      expect(task.profileName).toBe('explore');
      expect(task.timeout).toBe(REFERENCE_AUDIT_TRACK_TIMEOUT_MS);
      expect(task.enforceDispatch).toBe(true);
      expect(task.dispatch).toMatchObject({
        readOnly: true,
        discardChanges: true,
        internalOnly: true,
      });
      expect(task.dispatch?.allowedTools).toEqual(
        task.data.track.workflowRole === 'public-research'
          ? ['Read', 'Grep', 'Glob', 'ReadMediaFile', 'WebSearch', 'FetchURL']
          : ['Read', 'Grep', 'Glob', 'ReadMediaFile'],
      );
      expect(task.dispatch?.workCard?.forbiddenScope).toEqual(['**/*']);
    }
  });

  it('applies safe internal model overrides by workflow role', () => {
    const plan = standardPlan();
    const tasks = buildReferenceAuditTasks(plan, 'parent-1', {
      'source-explore': { backend: 'kimi', model: 'source-model' },
      'public-research': { backend: 'kimi', model: 'research-model' },
    });

    expect(tasks).not.toHaveLength(0);
    for (const task of tasks) {
      expect(task.modelAlias).toBe(
        task.data.track.workflowRole === 'public-research' ? 'research-model' : 'source-model',
      );
      expect(task.dispatch?.internalOnly).toBe(true);
    }
  });

  it('adds WebSearch and FetchURL only to the public-research track', () => {
    const plan = deepPlan();
    const tasks = buildReferenceAuditTasks(plan, 'parent-1');
    const byId = new Map(tasks.map((task) => [task.data.track.id, task]));

    expect(byId.get('visual-media-comparison')?.dispatch?.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ReadMediaFile',
      'WebSearch',
      'FetchURL',
    ]);
    expect(byId.get('product-minecraft')?.dispatch?.allowedTools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'ReadMediaFile',
    ]);
  });

  it('throws for a plan with no tracks', () => {
    const empty: ReferenceAuditPlan = {
      classification: { triggered: true, intensity: 'standard', reason: 'test' },
      references: [],
      tracks: [],
    };
    expect(() => buildReferenceAuditTasks(empty, 'parent-1')).toThrow('no tracks');
  });
});

describe('runReferenceAuditTracks', () => {
  it('resolves every track without a repair when all responses are well-formed', async () => {
    const plan = standardPlan();
    const runQueued = vi.fn(async (tasks: readonly { data: { track: { id: string; referenceIds: readonly string[] } } }[]) =>
      tasks.map((task) => ({
        task,
        agentId: `agent-${task.data.track.id}`,
        status: 'completed' as const,
        result: rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      })),
    );

    const results = await runReferenceAuditTracks({ runQueued } as never, plan, 'parent-1');

    expect(runQueued).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(plan.tracks.length);
    for (const entry of results) {
      expect(entry.repairCount).toBe(0);
      expect(entry.normalization.status).toBe('completed');
    }
  });

  it('requests exactly one private repair for a malformed track and accepts the fix', async () => {
    const plan = standardPlan();
    const [first, second] = plan.tracks;
    let call = 0;
    const runQueued = vi.fn(async (tasks: readonly { data: { track: { id: string; referenceIds: readonly string[] } }; prompt: string }[]) => {
      call += 1;
      return tasks.map((task) => ({
        task,
        agentId: `agent-${task.data.track.id}-${String(call)}`,
        status: 'completed' as const,
        result:
          call === 1 && task.data.track.id === first!.id
            ? '{"track_id":"wrong"}'
            : rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      }));
    });

    const results = await runReferenceAuditTracks({ runQueued } as never, plan, 'parent-1');

    expect(runQueued).toHaveBeenCalledTimes(2);
    const repairCall = runQueued.mock.calls[1]![0];
    expect(repairCall.map((task) => task.data.track.id)).toEqual([first!.id]);
    expect(repairCall[0]!.prompt).toContain('one allowed private');

    const firstResult = results.find((entry) => entry.trackId === first!.id)!;
    expect(firstResult).toMatchObject({
      repairCount: 1,
      initialRawResponse: '{"track_id":"wrong"}',
      normalization: { status: 'completed' },
    });
    const secondResult = results.find((entry) => entry.trackId === second!.id)!;
    expect(secondResult.repairCount).toBe(0);
  });

  it('marks a track unavailable, never fabricating evidence, when its repair remains malformed', async () => {
    const plan = standardPlan();
    const [first] = plan.tracks;
    const runQueued = vi.fn(async (tasks: readonly { data: { track: { id: string; referenceIds: readonly string[] } } }[]) =>
      tasks.map((task) => ({
        task,
        agentId: `agent-${task.data.track.id}`,
        status: 'completed' as const,
        result:
          task.data.track.id === first!.id
            ? '{"track_id":"still-wrong"}'
            : rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      })),
    );

    const results = await runReferenceAuditTracks({ runQueued } as never, plan, 'parent-1');

    expect(runQueued).toHaveBeenCalledTimes(2);
    const firstResult = results.find((entry) => entry.trackId === first!.id)!;
    expect(firstResult).toMatchObject({
      repairCount: 1,
      normalization: {
        status: 'unavailable',
        reason: 'track report remained malformed after one contract repair',
      },
    });
  });

  it('marks a timed-out or failed track unavailable without attempting a repair', async () => {
    const plan = standardPlan();
    const [first, second] = plan.tracks;
    const runQueued = vi.fn(async (tasks: readonly { data: { track: { id: string; referenceIds: readonly string[] } } }[]) =>
      tasks.map((task) => ({
        task,
        status: task.data.track.id === first!.id ? ('failed' as const) : ('completed' as const),
        error: task.data.track.id === first!.id ? 'Subagent timed out.' : undefined,
        result:
          task.data.track.id === first!.id
            ? undefined
            : rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      })),
    );

    const results = await runReferenceAuditTracks({ runQueued } as never, plan, 'parent-1');

    expect(runQueued).toHaveBeenCalledTimes(1);
    const firstResult = results.find((entry) => entry.trackId === first!.id)!;
    expect(firstResult).toMatchObject({
      repairCount: 0,
      normalization: { status: 'unavailable', reason: 'Subagent timed out.' },
    });
    const secondResult = results.find((entry) => entry.trackId === second!.id)!;
    expect(secondResult.normalization.status).toBe('completed');
  });
});

describe('assembleReferenceAuditTrackResults', () => {
  it('records an unavailable track as an explicit unknown, never as fabricated evidence', async () => {
    const plan = standardPlan();
    const [first, second] = plan.tracks;
    const runQueued = vi.fn(async (tasks: readonly { data: { track: { id: string; referenceIds: readonly string[] } } }[]) =>
      tasks.map((task) => ({
        task,
        status: task.data.track.id === first!.id ? ('failed' as const) : ('completed' as const),
        error: task.data.track.id === first!.id ? 'boom' : undefined,
        result:
          task.data.track.id === first!.id
            ? undefined
            : rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      })),
    );

    const trackResults = await runReferenceAuditTracks({ runQueued } as never, plan, 'parent-1');
    const result = assembleReferenceAuditTrackResults(plan, trackResults);

    expect(result.claims).toHaveLength(1);
    const unavailableUnknown = result.unknowns.find((entry) => entry.question.includes(first!.label));
    expect(unavailableUnknown).toMatchObject({ reason: 'inaccessible' });
    expect(unavailableUnknown?.question).toContain('boom');
    expect(second).toBeDefined();
  });
});

describe('ReferenceAuditTool', () => {
  it('classifies, dispatches, assembles, and records a completed run', async () => {
    const runQueued = vi.fn(async (tasks: readonly { modelAlias?: string; data: { track: { id: string; referenceIds: readonly string[] } } }[]) =>
      tasks.map((task) => ({
        task,
        agentId: `agent-${task.data.track.id}`,
        status: 'completed' as const,
        result: rawReport(task.data.track.id, task.data.track.referenceIds[0]!),
      })),
    );
    const records = { logRecord: vi.fn() };
    const tool = new ReferenceAuditTool({ runQueued } as never, records as never);

    const execution = tool.resolveExecution({
      references: [
        { id: 'a', label: 'A', kind: 'product', role: 'behavioral' },
        { id: 'b', label: 'B', kind: 'product', role: 'technical' },
      ],
      role_routes: {
        source_explore: { backend: 'kimi', model: 'source-model' },
        public_research: { backend: 'kimi', model: 'research-model' },
      },
    });
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output.triggered).toBe(true);
    expect(output.result.claims).toHaveLength(2);
    const dispatched = runQueued.mock.calls[0]![0];
    expect(dispatched.every((task) => task.modelAlias === 'research-model')).toBe(true);
    expect(records.logRecord).toHaveBeenCalledTimes(2);
    expect(records.logRecord.mock.calls[0]![0]).toMatchObject({
      type: 'reference_audit.state',
      material: true,
      referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(records.logRecord.mock.calls[1]![0]).toMatchObject({
      type: 'reference_audit.run',
      triggered: true,
      referenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      terminalState: 'completed',
      claimCount: 2,
      rawResponses: [
        { trackId: 'reference-a', initial: expect.any(String), summary: expect.any(String), redactionCount: expect.any(Number), originalSha256: expect.stringMatching(/^[a-f0-9]{64}$/), redactedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { trackId: 'reference-b', initial: expect.any(String), summary: expect.any(String), redactionCount: expect.any(Number), originalSha256: expect.stringMatching(/^[a-f0-9]{64}$/), redactedSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ],
      result: { claims: expect.any(Array), reports: expect.any(Array) },
    });
  });

  it('records and returns a skip without dispatching when the audit is not material', async () => {
    const runQueued = vi.fn();
    const records = { logRecord: vi.fn() };
    const tool = new ReferenceAuditTool({ runQueued } as never, records as never);

    const execution = tool.resolveExecution({
      references: [{ id: 'mood', label: 'Mood board', kind: 'media', role: 'visual' }],
    });
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      signal: new AbortController().signal,
    });

    expect(runQueued).not.toHaveBeenCalled();
    const output = JSON.parse(result.output as string);
    expect(output.triggered).toBe(false);
    expect(records.logRecord.mock.calls[0]![0]).toMatchObject({
      type: 'reference_audit.run',
      triggered: false,
      terminalState: 'skipped',
    });
  });

  it('returns an explicit main-model fallback packet when audit dispatch fails', async () => {
    const runQueued = vi.fn(async () => {
      throw new Error('dispatch exploded');
    });
    const records = { logRecord: vi.fn() };
    const tool = new ReferenceAuditTool({ runQueued } as never, records as never);

    const execution = tool.resolveExecution({
      references: [
        { id: 'a', label: 'A', kind: 'product', role: 'behavioral' },
        { id: 'b', label: 'B', kind: 'product', role: 'technical' },
      ],
    });
    if ('isError' in execution && execution.isError === true) throw new Error(execution.message);
    const result = await execution.execute({
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      signal: new AbortController().signal,
    });

    expect(result.isError).not.toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output).toMatchObject({
      triggered: true,
      fallbackRequired: true,
      fallbackTracks: [{
        trackId: 'audit-runtime',
        reason: 'dispatch exploded',
      }],
    });
    expect(output.fallbackPolicy).toContain('main model');
    expect(output.fallbackPolicy).toContain('independent consensus');
    expect(records.logRecord.mock.calls[0]![0]).toMatchObject({
      type: 'reference_audit.state',
      material: true,
    });
    expect(records.logRecord.mock.calls[1]![0]).toMatchObject({
      type: 'reference_audit.run',
      terminalState: 'fallback_required',
      error: expect.stringContaining('dispatch exploded'),
    });
  });
});
