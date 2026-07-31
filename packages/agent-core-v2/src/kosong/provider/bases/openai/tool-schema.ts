/**
 * Root-union flattening for chat-completions tool schemas — protocol-level,
 * not vendor-level.
 *
 * A tool built from `z.union([...])` of object schemas normalizes to a bare
 * `{ anyOf: [...] }` at `function.parameters`, and strict chat-completions
 * upstreams reject that root shape outright: Moonshot answers "type is
 * required and must be object" (and also rejects `type: 'object'` sitting
 * alongside the root `anyOf` — it wants a flat object, not a union), and
 * opencode zen's "Console Go" route answers `400 Upstream request failed`.
 * Flattening into one `type: 'object'` schema is the single rewrite both
 * flavors accept, so the OpenAI chat base applies it to every tool and the
 * Kimi flavor builds on top of it.
 *
 * Schemas without a root union are returned as the SAME object reference, so
 * the wire shape — and therefore the provider-side prompt cache — stays
 * byte-identical in the overwhelmingly common case.
 */

export function flattenRootToolSchemaUnion(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return mergeRootUnion(schema) ?? schema;
}

/**
 * Flattens a root `{ anyOf: [...] }`/`{ oneOf: [...] }` of object schemas
 * into a single `type: 'object'` schema Moonshot's function-calling flavor
 * accepts. Returns `undefined` (no flattening) when there's no top-level
 * union, a branch isn't itself `type: 'object'`, or the union sits
 * alongside sibling keywords other than `description` (an actual mixed-type
 * union is a real schema shape this function has no safe rewrite for).
 */
function mergeRootUnion(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (hasOwn(schema, 'type')) return undefined;
  const branches = schema['anyOf'] ?? schema['oneOf'];
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const otherKeys = Object.keys(schema).filter(
    (key) => key !== 'anyOf' && key !== 'oneOf' && key !== 'description' && key !== '$schema',
  );
  if (otherKeys.length > 0) return undefined;
  if (!branches.every((branch) => isRecord(branch) && branch['type'] === 'object')) return undefined;
  const objectBranches = branches as Record<string, unknown>[];

  const propertyBranches = new Map<string, unknown[]>();
  for (const branch of objectBranches) {
    const branchProperties = isRecord(branch['properties'])
      ? (branch['properties'] as Record<string, unknown>)
      : {};
    for (const [key, propertySchema] of Object.entries(branchProperties)) {
      const existing = propertyBranches.get(key);
      if (existing === undefined) {
        propertyBranches.set(key, [propertySchema]);
      } else if (!existing.some((seen) => deepEqualJson(seen, propertySchema))) {
        existing.push(propertySchema);
      }
    }
  }
  const properties: Record<string, unknown> = {};
  for (const [key, propertySchemas] of propertyBranches) {
    properties[key] = propertySchemas.length === 1 ? propertySchemas[0] : { anyOf: propertySchemas };
  }

  const requiredPerBranch = objectBranches.map(
    (branch) => new Set(Array.isArray(branch['required']) ? (branch['required'] as string[]) : []),
  );
  const required = [...propertyBranches.keys()].filter((key) =>
    requiredPerBranch.every((set) => set.has(key)),
  );

  const merged: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) merged['required'] = required;
  if (objectBranches.every((branch) => branch['additionalProperties'] === false)) {
    merged['additionalProperties'] = false;
  }
  if (typeof schema['description'] === 'string') merged['description'] = schema['description'];
  return merged;
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
