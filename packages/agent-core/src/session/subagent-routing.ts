import type { KimiConfig, SubagentBackend } from '#/config/schema';

export const INTERNAL_SUBAGENT_BACKEND = 'kimi';
export const EXTERNAL_SUBAGENT_ID_PREFIX = 'external-';

export type ResolvedSubagentRoute =
  | {
      readonly kind: 'internal';
      readonly modelAlias: string | undefined;
    }
  | {
      readonly kind: 'external';
      readonly backendName: string;
      readonly backend: SubagentBackend;
      readonly modelAlias: string | undefined;
    };

export function resolveSubagentRoute(
  config: KimiConfig,
  profileName: string,
  modelOverride?: string,
): ResolvedSubagentRoute {
  const routing = config.subagent?.routing?.[profileName];
  const modelAlias = modelOverride ?? routing?.model;
  if (modelAlias !== undefined && config.models?.[modelAlias] === undefined) {
    throw new Error(`Subagent model alias "${modelAlias}" is not defined in config.models.`);
  }
  const backendName = routing?.backend;
  if (backendName === undefined || backendName === INTERNAL_SUBAGENT_BACKEND) {
    return { kind: 'internal', modelAlias };
  }
  const backend = config.subagent?.backends?.[backendName];
  if (backend === undefined) {
    throw new Error(`Subagent backend "${backendName}" is not defined in subagent.backends.`);
  }
  validateBackendTemplate(backendName, backend);
  return { kind: 'external', backendName, backend, modelAlias };
}

export function validateBackendTemplate(name: string, backend: SubagentBackend): void {
  for (const arg of [...(backend.args ?? []), ...(backend.resumeArgs ?? [])]) {
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
