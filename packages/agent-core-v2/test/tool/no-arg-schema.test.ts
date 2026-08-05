/**
 * `tool` contract — guard for the `_unused` empty-schema workaround.
 *
 * Some OpenAI-compatible relays hang on a function schema whose `properties`
 * is empty, so parameter-less builtins carry a throwaway `_unused` field.
 * The guard is easy to lose silently: an upstream merge has relocated these
 * schemas into fresh modules before, and the new file — being conflict-free —
 * landed as a plain `z.object({})`, which neither a conflict marker nor a
 * type error would have caught. Ported from v1 (`b734433c6`): the named pins
 * cover the schemas a loop-tools sweep misses (none of them is active in the
 * default profile), and the registry sweep covers whatever is registered.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { CronListInputSchema } from '#/agent/tools/cron/cron-list/cron-list';
import { GetGoalToolInputSchema } from '#/agent/tools/goal/get-goal/get-goal';
import { EnterPlanModeInputSchema } from '#/agent/tools/plan/enter-plan-mode/enter-plan-mode';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { toInputJsonSchema } from '#/tool/input-schema';

import { createTestAgent, type TestAgentContext } from '../harness';

describe('no-argument builtin schemas', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('keeps a non-empty parameter object on every no-argument builtin schema', () => {
    const noArgSchemas = {
      CronList: CronListInputSchema,
      GetGoal: GetGoalToolInputSchema,
      EnterPlanMode: EnterPlanModeInputSchema,
    };

    for (const [name, schema] of Object.entries(noArgSchemas)) {
      const parameters = toInputJsonSchema(schema) as { properties?: object };
      expect(
        Object.keys(parameters.properties ?? {}),
        `${name} must advertise at least one property`,
      ).not.toEqual([]);
    }
  });

  it('never advertises a registered tool with an empty parameter object', () => {
    ctx = createTestAgent();

    const offenders = ctx
      .get(IAgentToolRegistryService)
      .list()
      .filter((tool) => {
        const parameters = tool.parameters as
          | { type?: string; properties?: object }
          | undefined;
        if (parameters?.type !== 'object') return false;
        return Object.keys(parameters.properties ?? {}).length === 0;
      })
      .map((tool) => tool.name);

    expect(offenders).toEqual([]);
  });
});
