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
  for (const arg of backend.args ?? []) {
    const placeholders = arg.match(/\{[^}]+\}/g) ?? [];
    for (const placeholder of placeholders) {
      if (placeholder !== '{model}' && placeholder !== '{cwd}' && placeholder !== '{prompt_file}') {
        throw new Error(
          `Subagent backend "${name}" uses unsupported template placeholder ${placeholder}. Only {model}, {cwd}, and {prompt_file} are allowed.`,
        );
      }
    }
  }
}

export function materializeBackendArgs(
  route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
  cwd: string,
  promptFile = '',
): string[] {
  const model = route.modelAlias ?? '';
  return (route.backend.args ?? []).map((arg) =>
    arg
      .replaceAll('{model}', model)
      .replaceAll('{cwd}', cwd)
      .replaceAll('{prompt_file}', promptFile),
  );
}

export function wrapExternalSubagentPrompt(profileName: string, prompt: string): string {
  return `You are a subagent delegated by a parent Kimi Code agent. Your profile is "${profileName}". Complete the delegated task below and return your result to the parent agent, not directly to the end user.\n\n${prompt}`;
}

export interface ExternalSubagentCompletion {
  readonly result: string;
  readonly usage?: {
    readonly inputOther: number;
    readonly output: number;
    readonly inputCacheRead: number;
    readonly inputCacheCreation: number;
  };
}

export function parseExternalSubagentOutput(stdout: string): ExternalSubagentCompletion {
  const fallback = { result: stdout };
  const text = stdout.trim();
  if (text.length === 0) return fallback;

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (typeof payload !== 'object' || payload === null) return fallback;

  const record = payload as Record<string, unknown>;
  const result =
    typeof record['result'] === 'string'
      ? record['result']
      : typeof record['text'] === 'string'
        ? record['text']
        : undefined;
  if (result === undefined) return fallback;

  const usage = record['usage'];
  if (typeof usage !== 'object' || usage === null) return { result };
  const usageRecord = usage as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    typeof usageRecord[key] === 'number' && Number.isFinite(usageRecord[key])
      ? usageRecord[key]
      : undefined;
  const inputOther = number('input_tokens');
  const output = number('output_tokens');
  if (inputOther === undefined || output === undefined) return { result };
  return {
    result,
    usage: {
      inputOther,
      output,
      inputCacheRead: number('cache_read_input_tokens') ?? 0,
      inputCacheCreation: number('cache_creation_input_tokens') ?? 0,
    },
  };
}

export function isExternalSubagentId(agentId: string): boolean {
  return agentId.startsWith(EXTERNAL_SUBAGENT_ID_PREFIX);
}
