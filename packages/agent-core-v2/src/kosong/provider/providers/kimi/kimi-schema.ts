/**
 * `kosong/provider` domain (L2) — Kimi tool-schema dialect normalization.
 *
 * Pure functions: dereference local `$ref` pointers by inlining definitions,
 * then complete missing `type` fields from enum/const values or structural
 * keys — the schema dialect the Kimi tool endpoint accepts.
 *
 * Circular references are detected and left as `$ref` to avoid infinite
 * recursion; in that case the referenced definition bucket is preserved so the
 * remaining local `$ref` pointers stay resolvable to a JSON Schema validator.
 */

export function derefJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visited = new Set<string>();
  const result = resolveNode(schema, schema, visited) as Record<string, unknown>;

  if (!hasUnresolvedDefinitionRef(result, '$defs')) {
    delete result['$defs'];
  }
  if (!hasUnresolvedDefinitionRef(result, 'definitions')) {
    delete result['definitions'];
  }
  return result;
}

type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
type SchemaSlotKind = 'single' | 'array' | 'map' | 'schema-or-array';
type StructuralJsonSchemaType = Extract<JsonSchemaType, 'string' | 'object' | 'array'>;

interface ChildSchemaSlot {
  key: string;
  kind: SchemaSlotKind;
  parentType?: StructuralJsonSchemaType;
}

const TYPE_COMPLETION_SKIP_KEYS = new Set([
  '$ref',
  'allOf',
  'anyOf',
  'else',
  'if',
  'not',
  'oneOf',
  'then',
]);

const CHILD_SCHEMA_SLOTS = [
  { key: '$defs', kind: 'map' },
  { key: 'definitions', kind: 'map' },
  { key: 'dependencies', kind: 'map', parentType: 'object' },
  { key: 'dependentSchemas', kind: 'map', parentType: 'object' },
  { key: 'patternProperties', kind: 'map', parentType: 'object' },
  { key: 'properties', kind: 'map', parentType: 'object' },
  { key: 'additionalItems', kind: 'single', parentType: 'array' },
  { key: 'additionalProperties', kind: 'single', parentType: 'object' },
  { key: 'contains', kind: 'single', parentType: 'array' },
  { key: 'contentSchema', kind: 'single', parentType: 'string' },
  { key: 'else', kind: 'single' },
  { key: 'if', kind: 'single' },
  { key: 'not', kind: 'single' },
  { key: 'propertyNames', kind: 'single', parentType: 'object' },
  { key: 'then', kind: 'single' },
  { key: 'unevaluatedItems', kind: 'single', parentType: 'array' },
  { key: 'unevaluatedProperties', kind: 'single', parentType: 'object' },
  { key: 'allOf', kind: 'array' },
  { key: 'anyOf', kind: 'array' },
  { key: 'oneOf', kind: 'array' },
  { key: 'prefixItems', kind: 'array', parentType: 'array' },
  { key: 'items', kind: 'schema-or-array', parentType: 'array' },
] as const satisfies readonly ChildSchemaSlot[];

const OBJECT_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('object'),
  'dependentRequired',
  'maxProperties',
  'minProperties',
  'required',
]);

const ARRAY_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('array'),
  'maxContains',
  'maxItems',
  'minContains',
  'minItems',
  'uniqueItems',
]);

const STRING_STRUCTURE_KEYS = new Set([
  ...childSchemaKeysForParentType('string'),
  'contentEncoding',
  'contentMediaType',
  'format',
  'maxLength',
  'minLength',
  'pattern',
]);

const NUMERIC_STRUCTURE_KEYS = new Set([
  'exclusiveMaximum',
  'exclusiveMinimum',
  'maximum',
  'minimum',
  'multipleOf',
]);

export function normalizeKimiToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return ensureKimiPropertyTypes(derefJsonSchema(schema));
}

function ensureKimiPropertyTypes(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = cloneJsonValue(schema);
  if (!isRecord(normalized)) {
    throw new Error('JSON Schema root must normalize to an object.');
  }
  // Moonshot's function-calling flavor rejects a union sitting directly at
  // the parameters root ("type is required and must be object", and adding
  // `type: 'object'` alongside a root anyOf is rejected too — it wants a
  // flat object there). Flatten a root anyOf/oneOf of object schemas into
  // one; nested anyOf stays untouched. Keep in sync with
  // packages/kosong/src/providers/kimi-schema.ts.
  const flattened = mergeRootUnion(normalized) ?? normalized;
  recurseSchema(flattened);
  return flattened;
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

function hasUnresolvedDefinitionRef(node: unknown, bucketKey: string): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => hasUnresolvedDefinitionRef(child, bucketKey));
  }
  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;
    const ref = obj['$ref'];
    if (typeof ref === 'string' && ref.startsWith(`#/${bucketKey}/`)) {
      return true;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === bucketKey) continue;
      if (hasUnresolvedDefinitionRef(value, bucketKey)) return true;
    }
    return false;
  }
  return false;
}

function resolveNode(node: unknown, root: Record<string, unknown>, visited: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveNode(item, root, visited));
  }

  if (typeof node === 'object' && node !== null) {
    const obj = node as Record<string, unknown>;

    if (typeof obj['$ref'] === 'string') {
      const ref = obj['$ref'];
      if (isLocalJsonPointerRef(ref)) {
        if (visited.has(ref)) {
          return obj;
        }
        const resolvedRef = resolveLocalJsonPointer(root, ref);
        if (resolvedRef.found) {
          visited.add(ref);
          const resolved = resolveNode(resolvedRef.value, root, visited);
          visited.delete(ref);
          if (typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)) {
            const merged: Record<string, unknown> = { ...(resolved as Record<string, unknown>) };
            for (const [key, value] of Object.entries(obj)) {
              if (key === '$ref') continue;
              merged[key] = resolveNode(value, root, visited);
            }
            return merged;
          }
          return resolved;
        }
      }
      return obj;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveNode(value, root, visited);
    }
    return resolved;
  }

  return node;
}

function isLocalJsonPointerRef(ref: string): boolean {
  return ref === '#' || ref.startsWith('#/');
}

function resolveLocalJsonPointer(
  root: Record<string, unknown>,
  ref: string,
): { found: true; value: unknown } | { found: false } {
  if (ref === '#') {
    return { found: true, value: root };
  }
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = unescapeJsonPointerPart(rawPart);
    if (isRecord(current)) {
      if (!hasOwn(current, part)) {
        return { found: false };
      }
      current = current[part];
    } else if (Array.isArray(current)) {
      const index = parseJsonPointerArrayIndex(part);
      if (index === null || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function unescapeJsonPointerPart(part: string): string {
  return part.replaceAll('~1', '/').replaceAll('~0', '~');
}

function parseJsonPointerArrayIndex(part: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(part)) {
    return null;
  }
  return Number(part);
}

function recurseSchema(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  visitChildSchemas(node, normalizeProperty);
}

function visitChildSchemas(node: Record<string, unknown>, visit: (schema: unknown) => void): void {
  for (const { key, kind } of CHILD_SCHEMA_SLOTS) {
    const value = node[key];
    if (kind === 'single') {
      if (isRecord(value)) {
        visit(value);
      }
    } else if (kind === 'array') {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    } else if (kind === 'map') {
      if (isRecord(value)) {
        for (const item of Object.values(value)) {
          visit(item);
        }
      }
    } else if (kind === 'schema-or-array') {
      if (isRecord(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      }
    }
  }
}

function childSchemaKeysForParentType(parentType: StructuralJsonSchemaType): string[] {
  return CHILD_SCHEMA_SLOTS.flatMap((slot) => {
    if (!('parentType' in slot) || slot.parentType !== parentType) {
      return [];
    }
    return [slot.key];
  });
}

function normalizeProperty(node: unknown): void {
  if (!isRecord(node)) {
    return;
  }

  if (!hasOwn(node, 'type') && !hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS)) {
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      node['type'] = inferTypeFromValues(enumValues);
    } else if (hasOwn(node, 'const')) {
      node['type'] = inferTypeFromValues([node['const']]);
    } else {
      node['type'] = inferTypeFromStructure(node);
    }
  } else if (!hasAnyKey(node, TYPE_COMPLETION_SKIP_KEYS) && typeof node['type'] === 'string') {
    const enumValues = node['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      try {
        const inferred = inferTypeFromValues(enumValues);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {}
    } else if (hasOwn(node, 'const')) {
      try {
        const inferred = inferTypeFromValues([node['const']]);
        if (node['type'] !== inferred) {
          node['type'] = inferred;
          removeIrrelevantStructureKeys(node, inferred);
        }
      } catch {}
    }
  }

  recurseSchema(node);
}

function removeIrrelevantStructureKeys(
  node: Record<string, unknown>,
  newType: JsonSchemaType,
): void {
  if (newType !== 'object') {
    for (const key of OBJECT_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
  if (newType !== 'array') {
    for (const key of ARRAY_STRUCTURE_KEYS) {
      delete node[key];
    }
  }
}

function inferTypeFromStructure(schema: Record<string, unknown>): JsonSchemaType {
  if (hasAnyKey(schema, OBJECT_STRUCTURE_KEYS)) {
    return 'object';
  }
  if (hasAnyKey(schema, ARRAY_STRUCTURE_KEYS)) {
    return 'array';
  }
  if (hasAnyKey(schema, STRING_STRUCTURE_KEYS)) {
    return 'string';
  }
  if (hasAnyKey(schema, NUMERIC_STRUCTURE_KEYS)) {
    return 'number';
  }
  return 'string';
}

function inferTypeFromValues(values: unknown[]): JsonSchemaType {
  const inferred = new Set<JsonSchemaType>();
  for (const value of values) {
    const valueType = inferValueType(value);
    if (valueType === undefined) {
      throw new Error('Cannot infer JSON Schema type from non-JSON enum or const value.');
    }
    inferred.add(valueType);
  }
  const types = normalizeInferredTypes(inferred);
  if (types.length === 1) {
    const onlyType = types[0];
    if (onlyType === undefined) {
      throw new Error('Cannot infer JSON Schema type from an empty enum.');
    }
    return onlyType;
  }
  throw new Error('Mixed JSON Schema enum or const types are not supported by Kimi tool schemas.');
}

function inferValueType(value: unknown): JsonSchemaType | undefined {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      return undefined;
  }
  return undefined;
}

function normalizeInferredTypes(types: Set<JsonSchemaType>): JsonSchemaType[] {
  const normalized = new Set(types);
  if (normalized.has('number')) {
    normalized.delete('integer');
  }
  const order: JsonSchemaType[] = [
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
    'null',
  ];
  return order.filter((type) => normalized.has(type));
}

function hasAnyKey(obj: Record<string, unknown>, keys: Set<string>): boolean {
  for (const key of keys) {
    if (hasOwn(obj, key)) {
      return true;
    }
  }
  return false;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(child);
    }
    return cloned;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
