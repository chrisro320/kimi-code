import { describe, expect, it } from 'vitest';

import { buildHookSpawnOptions, runHook } from '#/features/externalHooks/internal/runHook';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

const hostProcess = new HostProcessService();

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, ' '))}`;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("ok\\n");'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ message: "hook says hi" }));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const emptyObject = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("{}");'),
      {},
      { timeout: 5 },
    );
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: {} }));'),
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("blocked\\n"); process.exit(2);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.exit(1);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('setTimeout(() => {}, 10000);'),
      { tool_name: 'Bash' },
      { timeout: 0.05 },
    );

    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "use rg" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('passes hookSpecificOutput.updatedInput through on allow results', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: "ls" } } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.updatedInput).toEqual({ command: 'ls' });
  });

  it('carries updatedInput alongside a permissionDecision=deny block', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope", updatedInput: { command: "ls" } } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('nope');
    expect(result.updatedInput).toEqual({ command: 'ls' });
  });

  it('ignores a top-level updatedInput field outside hookSpecificOutput', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ updatedInput: { command: "ls" } }));'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.updatedInput).toBeUndefined();
  });

  it('drops a non-object updatedInput without failing the hook', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { message: "hi", updatedInput: "not-an-object" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('hi');
    expect(result.updatedInput).toBeUndefined();
  });

  it('passes hookSpecificOutput.additionalContext through on allow results', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<workflow-state>ok</workflow-state>" } }));',
      ),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.additionalContext).toBe('<workflow-state>ok</workflow-state>');
  });

  it('carries additionalContext alongside a permissionDecision=deny block', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope", additionalContext: "extra" } }));',
      ),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('nope');
    expect(result.additionalContext).toBe('extra');
  });

  it('ignores a top-level additionalContext field outside hookSpecificOutput', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ additionalContext: "top-level" }));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.additionalContext).toBeUndefined();
  });

  it('stringifies a scalar additionalContext and drops an object one', async () => {
    const scalar = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 42 } }));',
      ),
      {},
      { timeout: 5 },
    );
    expect(scalar.action).toBe('allow');
    expect(scalar.additionalContext).toBe('42');

    const object = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { message: "hi", additionalContext: { a: 1 } } }));',
      ),
      {},
      { timeout: 5 },
    );
    expect(object.action).toBe('allow');
    expect(object.message).toBe('hi');
    expect(object.additionalContext).toBeUndefined();
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand([
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(parsed.tool_name);',
        '});',
      ].join('\n')),
      { tool_name: 'Write' },
      { timeout: 5 },
    );

    expect(result.stdout?.trim()).toBe('Write');
  });
});

describe('buildHookSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true so hooks do not flash a console on Windows', () => {
    expect(buildHookSpawnOptions({}).windowsHide).toBe(true);
  });

  it('runs through the shell with stdio piped', () => {
    const options = buildHookSpawnOptions({});
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe('pipe');
  });

  it('merges hook env onto process.env and forwards cwd', () => {
    const options = buildHookSpawnOptions({ cwd: '/repo', env: { FOO: 'bar' } });
    expect(options.cwd).toBe('/repo');
    expect(options.env).toMatchObject({ FOO: 'bar' });
  });
});
