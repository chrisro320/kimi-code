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
      if (placeholder !== '{model}' && placeholder !== '{cwd}') {
        throw new Error(
          `Subagent backend "${name}" uses unsupported template placeholder ${placeholder}. Only {model} and {cwd} are allowed.`,
        );
      }
    }
  }
}

export function materializeBackendArgs(
  route: Extract<ResolvedSubagentRoute, { kind: 'external' }>,
  cwd: string,
): string[] {
  const model = route.modelAlias ?? '';
  return (route.backend.args ?? []).map((arg) =>
    arg.replaceAll('{model}', model).replaceAll('{cwd}', cwd),
  );
}

export function isExternalSubagentId(agentId: string): boolean {
  return agentId.startsWith(EXTERNAL_SUBAGENT_ID_PREFIX);
}
