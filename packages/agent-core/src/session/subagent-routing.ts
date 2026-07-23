import type {
  KimiConfig,
  SubagentBackend,
  SubagentLauncher,
  SubagentPoolRoute,
} from '#/config/schema';
import { dispatchCircuitFallbackKey } from '../agent/dispatch/controller';

export const INTERNAL_SUBAGENT_BACKEND = 'kimi';
export const EXTERNAL_SUBAGENT_ID_PREFIX = 'external-';

const READ_ONLY_ENFORCEMENT_MARKERS: readonly RegExp[] = [
  /^--read-only(?:=true)?$/i,
  /^--readonly(?:=true)?$/i,
  /^--sandbox=(?:read-only|ro)$/i,
  /^--permission-mode=plan$/i,
  /^--tools=$/i,
  /^CLAUDE_TOOLS_DISABLED(?:=1|=true)?$/i,
  /^GROK_SANDBOX_READ_ONLY(?:=1|=true)?$/i,
];

export type ResolvedSubagentRoute =
  | {
      readonly kind: 'internal';
      readonly modelAlias: string | undefined;
      readonly thinkingEffort: string | undefined;
    }
  | {
      readonly kind: 'external';
      readonly backendName: string;
      readonly backend: SubagentBackend;
      readonly modelAlias: string | undefined;
    };

/**
 * Opaque per-route identity string used as the R-A2 circuit-breaker key
 * component (see `DispatchController.isCircuitOpen`/`openCircuit`) — two
 * `ResolvedSubagentRoute`s that would launch the same backend+model
 * combination must produce the same identity regardless of `kind`.
 */
export function subagentRouteIdentity(route: ResolvedSubagentRoute): string {
  return route.kind === 'internal'
    ? dispatchCircuitFallbackKey(INTERNAL_SUBAGENT_BACKEND, route.modelAlias)
    : dispatchCircuitFallbackKey(route.backendName, route.modelAlias);
}

export function resolveSubagentRoute(
  config: KimiConfig,
  profileName: string,
  modelOverride?: string,
): ResolvedSubagentRoute {
  const routing = config.subagent?.routing?.[profileName];
  const modelAlias = modelOverride ?? routing?.model;
  return resolveRouteByNames(config, routing?.backend, modelAlias, routing?.thinkingEffort);
}

/**
 * Shared resolution core behind {@link resolveSubagentRoute}, the one-shot
 * work-card `routeOverride`, and pool-entry selection: given an explicit
 * backend name (`undefined`/`"kimi"` for the in-process subagent) and model
 * string, validate internal Kimi aliases against `config.models`, validate
 * external backend names, and produce a `ResolvedSubagentRoute`.
 */
export function resolveRouteByNames(
  config: KimiConfig,
  backendName: string | undefined,
  modelAlias: string | undefined,
  thinkingEffort?: string,
): ResolvedSubagentRoute {
  if (backendName === undefined || backendName === INTERNAL_SUBAGENT_BACKEND) {
    if (modelAlias !== undefined && config.models?.[modelAlias] === undefined) {
      throw new Error(`Subagent model alias "${modelAlias}" is not defined in config.models.`);
    }
    return { kind: 'internal', modelAlias, thinkingEffort };
  }
  const backend = config.subagent?.backends?.[backendName];
  if (backend === undefined) {
    throw new Error(`Subagent backend "${backendName}" is not defined in subagent.backends.`);
  }
  validateBackendTemplate(backendName, backend);
  return { kind: 'external', backendName, backend, modelAlias };
}

export function validateBackendTemplate(name: string, backend: SubagentBackend): void {
  for (const arg of [
    ...(backend.args ?? []),
    ...(backend.resumeArgs ?? []),
    ...(backend.readOnlyLauncher?.args ?? []),
    ...(backend.readOnlyLauncher?.resumeArgs ?? []),
  ]) {
    const placeholders = arg.match(/\{[^}]+\}/g) ?? [];
    for (const placeholder of placeholders) {
      if (
        placeholder !== '{model}' &&
        placeholder !== '{cwd}' &&
        placeholder !== '{prompt_file}' &&
        placeholder !== '{session_id}'
      ) {
        throw new Error(
          `Subagent backend "${name}" uses unsupported template placeholder ${placeholder}. Only {model}, {cwd}, {prompt_file}, and {session_id} are allowed.`,
        );
      }
    }
  }
}

export function resolveExternalSubagentLauncher(
  route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
  readOnly: boolean,
): SubagentLauncher {
  if (!readOnly) return route.backend;
  const launcher = route.backend.readOnlyLauncher;
  if (launcher === undefined) {
    throw new Error(
      `Read-only external dispatch refused: backend "${route.backendName}" does not define ` +
        'subagent.backends.<name>.read_only_launcher with an enforced read-only command and arguments.',
    );
  }
  if (launcher.sandbox?.filesystem !== 'read_only') {
    throw new Error(
      `Read-only external dispatch refused: backend "${route.backendName}" read_only_launcher ` +
        'must declare sandbox.filesystem = "read_only".',
    );
  }
  if (!hasReadOnlyEnforcementMarker([launcher.command, ...(launcher.args ?? [])])) {
    throw new Error(
      `Read-only external dispatch refused: backend "${route.backendName}" read_only_launcher ` +
        'must include a verifiable read-only enforcement marker in command or args.',
    );
  }
  if (
    launcher.resumeArgs !== undefined &&
    !hasReadOnlyEnforcementMarker([launcher.command, ...launcher.resumeArgs])
  ) {
    throw new Error(
      `Read-only external dispatch refused: backend "${route.backendName}" read_only_launcher.resume_args ` +
        'must include a verifiable read-only enforcement marker.',
    );
  }
  return launcher;
}

function hasReadOnlyEnforcementMarker(tokens: readonly string[]): boolean {
  return tokens.some((token) => READ_ONLY_ENFORCEMENT_MARKERS.some((pattern) => pattern.test(token)));
}

export function materializeBackendArgs(
  route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
  cwd: string,
  promptFile = '',
  args: readonly string[] = route.backend.args ?? [],
  sessionId = '',
): string[] {
  const model = route.modelAlias ?? '';
  return args.map((arg) =>
    arg
      .replaceAll('{model}', model)
      .replaceAll('{cwd}', cwd)
      .replaceAll('{prompt_file}', promptFile)
      .replaceAll('{session_id}', sessionId),
  );
}

export function wrapExternalSubagentPrompt(profileName: string, prompt: string): string {
  return `You are a subagent delegated by a parent Kimi Code agent. Your profile is "${profileName}". Complete the delegated task below and return your result to the parent agent, not directly to the end user.\n\n${prompt}`;
}

export interface ExternalSubagentCompletion {
  readonly result: string;
  readonly usage?: ExternalSubagentUsage;
}

export interface ExternalSubagentUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface ExternalSubagentStreamUpdate {
  readonly result?: string;
  readonly resultDelta?: string;
  readonly usage?: ExternalSubagentUsage;
  readonly usageKey?: string;
  readonly finalUsage?: boolean;
}

export function parseExternalSubagentStreamLine(line: string): ExternalSubagentStreamUpdate | undefined {
  const text = line.trim();
  if (text.length === 0) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;

  const record = payload as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : undefined;
  if (type === 'text' && typeof record['data'] === 'string') {
    return { resultDelta: record['data'] };
  }

  if (type === 'assistant') {
    const message = asRecord(record['message']);
    const usage = parseExternalUsage(message?.['usage']);
    if (usage === undefined) return undefined;
    return {
      usage,
      usageKey: typeof message?.['id'] === 'string' ? message['id'] : undefined,
    };
  }

  const result =
    typeof record['result'] === 'string'
      ? record['result']
      : type === undefined && typeof record['text'] === 'string'
        ? record['text']
        : undefined;
  const usage = parseExternalUsage(record['usage']);
  if (result === undefined && usage === undefined) return undefined;
  return {
    result,
    usage,
    finalUsage: type === 'result' || type === 'end',
  };
}

export function parseExternalSubagentOutput(stdout: string): ExternalSubagentCompletion {
  const text = stdout.trim();
  if (text.length === 0) return { result: stdout };

  const usageByKey = new Map<string, ExternalSubagentUsage>();
  let anonymousUsage: ExternalSubagentUsage | undefined;
  let finalUsage: ExternalSubagentUsage | undefined;
  let result: string | undefined;
  let resultFromDeltas = '';
  let parsedLine = false;

  for (const line of text.split(/\r?\n/)) {
    const update = parseExternalSubagentStreamLine(line);
    if (update === undefined) continue;
    parsedLine = true;
    if (update.result !== undefined) result = update.result;
    if (update.resultDelta !== undefined) resultFromDeltas += update.resultDelta;
    if (update.usage !== undefined) {
      if (update.finalUsage === true) {
        finalUsage = update.usage;
      } else if (update.usageKey !== undefined) {
        usageByKey.set(update.usageKey, update.usage);
      } else {
        anonymousUsage = update.usage;
      }
    }
  }

  if (!parsedLine) return { result: stdout };
  const usage = finalUsage ?? sumExternalUsage([...usageByKey.values(), ...(anonymousUsage === undefined ? [] : [anonymousUsage])]);
  return {
    result: result ?? resultFromDeltas,
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseExternalUsage(value: unknown): ExternalSubagentUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const number = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key])
      ? record[key]
      : undefined;
  const inputOther = number('input_tokens');
  const output = number('output_tokens');
  if (inputOther === undefined || output === undefined) return undefined;
  return {
    inputOther,
    output,
    inputCacheRead: number('cache_read_input_tokens') ?? 0,
    inputCacheCreation: number('cache_creation_input_tokens') ?? 0,
  };
}

function sumExternalUsage(usages: readonly ExternalSubagentUsage[]): ExternalSubagentUsage | undefined {
  if (usages.length === 0) return undefined;
  return usages.reduce<ExternalSubagentUsage>(
    (total, usage) => ({
      inputOther: total.inputOther + usage.inputOther,
      output: total.output + usage.output,
      inputCacheRead: total.inputCacheRead + usage.inputCacheRead,
      inputCacheCreation: total.inputCacheCreation + usage.inputCacheCreation,
    }),
    { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

export function isExternalSubagentId(agentId: string): boolean {
  return agentId.startsWith(EXTERNAL_SUBAGENT_ID_PREFIX);
}

export interface AcquiredSubagentRoute {
  readonly route: SubagentPoolRoute;
  /** Releases this route's concurrency slot. Idempotent; call exactly once per acquire. */
  readonly release: () => void;
}

/**
 * Deterministic weighted round-robin over a profile's `subagent.pools`
 * entries. `SessionSubagentHost` holds one instance per pooled profile for
 * the life of the host, so rotation state (`currentWeight`) and per-route
 * concurrency (`active`) persist across every spawn in the session.
 *
 * Uses the smooth weighted round-robin algorithm (as used by nginx
 * upstreams): each `acquire()` adds every currently-available route's
 * weight to its running total, picks the highest, then subtracts the sum of
 * available weights from it. This keeps selection frequency proportional to
 * `weight` even as routes drop in and out of availability because of
 * `maxConcurrency`.
 */
export class SubagentRoutePool {
  private readonly entries: Array<{
    readonly route: SubagentPoolRoute;
    currentWeight: number;
    active: number;
  }>;
  private readonly waiters: Array<{
    readonly resolve: (acquired: AcquiredSubagentRoute) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
  }> = [];

  constructor(routes: readonly SubagentPoolRoute[]) {
    if (routes.length === 0) {
      throw new Error('Subagent route pool requires at least one route entry.');
    }
    this.entries = routes.map((route) => ({ route, currentWeight: 0, active: 0 }));
  }

  /**
   * Picks the next route among entries under their `maxConcurrency` cap.
   * Throws when every route is saturated. The caller must invoke the
   * returned `release()` exactly once, after the spawn settles (completion,
   * failure, or abort) — never on every attempt, only the terminal one.
   */
  acquire(): AcquiredSubagentRoute {
    const acquired = this.tryAcquire();
    if (acquired === null) {
      throw new Error('Subagent route pool is exhausted: every route is at its max_concurrency limit.');
    }
    return acquired;
  }

  /**
   * Queuing variant of `acquire` for spawn paths: waits FIFO until a route
   * frees up instead of throwing, so concurrent spawns behind a saturated
   * pool line up rather than fail. Rejects with the abort reason when
   * `signal` fires while queued.
   */
  acquireQueued(signal?: AbortSignal): Promise<AcquiredSubagentRoute> {
    const immediate = this.tryAcquire();
    if (immediate !== null) return Promise.resolve(immediate);
    if (signal?.aborted === true) return Promise.reject(signal.reason as unknown);
    return new Promise<AcquiredSubagentRoute>((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => {},
      };
      if (signal !== undefined) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          rejectPromise(signal.reason as unknown);
        };
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private tryAcquire(): AcquiredSubagentRoute | null {
    const available = this.entries.filter(
      (entry) => entry.route.maxConcurrency === undefined || entry.active < entry.route.maxConcurrency,
    );
    if (available.length === 0) return null;

    const totalWeight = available.reduce((sum, entry) => sum + (entry.route.weight ?? 1), 0);
    let picked = available[0]!;
    for (const entry of available) {
      entry.currentWeight += entry.route.weight ?? 1;
      if (entry.currentWeight > picked.currentWeight) picked = entry;
    }
    picked.currentWeight -= totalWeight;
    picked.active += 1;

    let released = false;
    return {
      route: picked.route,
      release: () => {
        if (released) return;
        released = true;
        picked.active -= 1;
        this.drainWaiters();
      },
    };
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const acquired = this.tryAcquire();
      if (acquired === null) return;
      const waiter = this.waiters.shift()!;
      waiter.cleanup();
      waiter.resolve(acquired);
    }
  }
}
