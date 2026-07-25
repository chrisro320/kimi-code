import type { Tool } from '#/kosong/contract/tool';

/**
 * DeepSeek's Anthropic-compatible endpoint requires every tool input schema
 * to have an object root. Flatten only root unions of object branches; other
 * JSON Schema shapes pass through untouched.
 */
export function convertDeepSeekTool(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: flattenRootObjectUnion(tool.parameters) ?? tool.parameters,
  };
}

function flattenRootObjectUnion(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if ('type' in schema || ('anyOf' in schema && 'oneOf' in schema)) return undefined;

  const branches = schema['anyOf'] ?? schema['oneOf'];
  if (!Array.isArray(branches) || branches.length === 0) return undefined;

  const otherKeys = Object.keys(schema).filter(
    (key) => key !== 'anyOf' && key !== 'oneOf' && key !== 'description' && key !== '$schema',
  );
  if (otherKeys.length > 0 || !branches.every(isObjectBranch)) return undefined;

  const propertyBranches = new Map<string, unknown[]>();
  for (const branch of branches) {
    const properties = isRecord(branch['properties']) ? branch['properties'] : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      const candidates = propertyBranches.get(name) ?? [];
      if (!candidates.some((candidate) => jsonEqual(candidate, propertySchema))) {
        candidates.push(propertySchema);
      }
      propertyBranches.set(name, candidates);
    }
  }

  const properties: Record<string, unknown> = {};
  for (const [name, candidates] of propertyBranches) {
    properties[name] = candidates.length === 1 ? candidates[0] : { anyOf: candidates };
  }

  const requiredByBranch = branches.map(
    (branch) => new Set(Array.isArray(branch['required']) ? branch['required'] : []),
  );
  const required = [...propertyBranches.keys()].filter((name) =>
    requiredByBranch.every((names) => names.has(name)),
  );

  const flattened: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) flattened['required'] = required;
  if (branches.every((branch) => branch['additionalProperties'] === false)) {
    flattened['additionalProperties'] = false;
  }
  if (typeof schema['description'] === 'string') flattened['description'] = schema['description'];
  return flattened;
}

function isObjectBranch(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['type'] === 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
