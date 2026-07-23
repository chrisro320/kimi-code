import { describe, expect, it } from 'vitest';

import { normalizeKimiToolSchema } from '#/kosong/provider/providers/kimi/kimi-schema';

// The v2 copy of the Kimi schema dialect must flatten a root anyOf/oneOf of
// object schemas the same way packages/kosong does — Moonshot rejects a union
// at the parameters root, so a z.union of object tools would otherwise fail
// the whole request on v2 paths (kimi web / kap-server).
describe('normalizeKimiToolSchema root union flattening', () => {
  it('flattens a root anyOf of object schemas into one object schema', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      anyOf: [
        {
          type: 'object',
          properties: { task_id: { type: 'string' }, mode: { type: 'string', enum: ['inspect'] } },
          required: ['task_id', 'mode'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            candidate_hash: { type: 'string' },
            requested_scope: { type: 'array', items: { type: 'string' } },
          },
          required: ['task_id', 'candidate_hash'],
          additionalProperties: false,
        },
      ],
    };

    expect(normalizeKimiToolSchema(schema)).toEqual({
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        mode: { type: 'string', enum: ['inspect'] },
        candidate_hash: { type: 'string' },
        requested_scope: { type: 'array', items: { type: 'string' } },
      },
      required: ['task_id'],
      additionalProperties: false,
    });
  });

  it('keeps a mixed-type root union untouched', () => {
    const schema = {
      anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'string' }],
    };
    const result = normalizeKimiToolSchema(schema);
    expect(result['anyOf']).toBeDefined();
    expect(result['type']).toBeUndefined();
  });

  it('does not flatten a nested anyOf inside properties', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const result = normalizeKimiToolSchema(schema);
    const value = (result['properties'] as Record<string, unknown>)['value'] as Record<string, unknown>;
    expect(value['anyOf']).toBeDefined();
  });

  it('merges divergent same-name properties into a per-property anyOf', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      ],
    };
    const result = normalizeKimiToolSchema(schema);
    expect(result['type']).toBe('object');
    const id = (result['properties'] as Record<string, unknown>)['id'] as Record<string, unknown>;
    expect(id['anyOf']).toEqual([{ type: 'string' }, { type: 'number' }]);
    expect(result['required']).toEqual(['id']);
  });
});
