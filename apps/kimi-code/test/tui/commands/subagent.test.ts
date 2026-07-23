import { describe, expect, it, vi } from 'vitest';

import { handleSubagentCommand } from '#/tui/commands';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const RIGHT = '\u001B[C';
const CLEAR_LINE = '\u0015';
const DELETE = 'd';
const CONFIRM = 'y';
const ESCAPE = '\u001B';

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function makeConfig() {
  return {
    models: {
      fast: {
        provider: 'kimi', model: 'kimi-fast', maxContextSize: 128_000,
        capabilities: ['thinking'], supportEfforts: ['low', 'high'], defaultEffort: 'low',
      },
      strong: {
        provider: 'kimi', model: 'kimi-strong', maxContextSize: 256_000,
        capabilities: ['thinking'], supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
      }
    },
    providers: {},
    subagent: {
      backends: {
        claude: {
          command: 'claude', args: ['-p', '--dangerously-skip-permissions', '--model', '{model}', '--add-dir', '{cwd}'],
        },
        grok: {
          command: 'grok', args: ['-p', '--always-approve', '--cwd', '{cwd}'],
        },
      },
      routing: {
        coder: { backend: 'kimi', model: 'fast' },
      },
      pools: {
        coder: [{ backend: 'kimi', model: 'fast', weight: 1, maxConcurrency: 1 }],
      },
    },
  } as const;
}

function makeHost(config: ReturnType<typeof makeConfig> | Record<string, unknown> = makeConfig()) {
  const session = {
    reloadSession: vi.fn(async () => ({})),
  };
  const harness = {
    getConfig: vi.fn(async () => config),
    setConfig: vi.fn(async () => config),
  };
  const host = {
    state: {
      appState: { availableModels: {}, availableProviders: {} },
      theme: currentTheme,
    },
    session,
    harness,
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    refreshSlashCommandAutocomplete: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, config, session, harness };
}

function picker(host: SlashCommandHost, index = 0): TestPicker {
  return (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock.calls[index]?.[0] as TestPicker;
}

describe('handleSubagentCommand', () => {
  it('opens profile then internal model pickers and persists the route', async () => {
    const { host, harness, session } = makeHost();

    await handleSubagentCommand(host, '');
    const profilePicker = picker(host);
    const profilePickerText = profilePicker.render(100).join('\n');
    expect(profilePickerText).toContain('Select subagent type');
    expect(profilePickerText).toContain('coder-ex');
    expect(profilePickerText).toContain('frontend-artist');
    expect(profilePickerText).toContain('reviewer');
    profilePicker.handleInput(ENTER);
    expect(picker(host, 1).render(100).join('\n')).toContain('Configure subagent: coder');
    picker(host, 1).handleInput(ENTER);
    expect(picker(host, 2).render(100).join('\n')).toContain('Thinking');
    picker(host, 2).handleInput(RIGHT);
    picker(host, 2).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: { routing: { coder: { backend: 'kimi', model: 'fast', thinkingEffort: 'low' } } },
      });
    });
    await vi.waitFor(() => {
      expect(session.reloadSession).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(host.reloadCurrentSessionView).toHaveBeenCalledOnce();
    });
  });

  it('persists an external backend without adding permission flags', async () => {
    const { host, harness } = makeHost();

    await handleSubagentCommand(host, 'coder');
    const routePicker = picker(host);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: { routing: { coder: { backend: 'grok' } } },
      });
    });
  });

  it('selects a model for external backends that use {model}', async () => {
    const { host, harness } = makeHost();

    await handleSubagentCommand(host, 'coder');
    const routePicker = picker(host);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(DOWN);
    routePicker.handleInput(ENTER);
    expect(picker(host, 1).render(100).join('\n')).toContain('Select model for CLI: claude');
    picker(host, 1).handleInput(DOWN);
    picker(host, 1).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: { routing: { coder: { backend: 'claude', model: 'strong' } } },
      });
    });
  });

  it('manages coder pool members without changing the single-route picker', async () => {
    const { host, harness, session } = makeHost();
    await handleSubagentCommand(host, 'coder');
    expect(picker(host).render(100).join('\n')).toContain('Manage coder pool');
    picker(host).handleInput(UP);
    picker(host).handleInput(ENTER);
    expect(picker(host, 1).render(100).join('\n')).toContain('Add route');
    picker(host, 1).handleInput(DOWN);
    picker(host, 1).handleInput(ENTER);

    const addPicker = picker(host, 2);
    addPicker.handleInput(DOWN);
    addPicker.handleInput(ENTER);
    expect(picker(host, 3).render(100).join('\n')).toContain('Thinking');
    picker(host, 3).handleInput(RIGHT);
    picker(host, 3).handleInput(ENTER);
    expect(picker(host, 4).render(100).join('\n')).toContain('Coder pool weight');
    picker(host, 4).handleInput(CLEAR_LINE);
    picker(host, 4).handleInput('2');
    picker(host, 4).handleInput(ENTER);
    expect(picker(host, 5).render(100).join('\n')).toContain('Coder pool max concurrency');
    picker(host, 5).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: {
          pools: {
            coder: [
              { backend: 'kimi', model: 'fast', weight: 1, maxConcurrency: 1 },
              { backend: 'kimi', model: 'strong', thinkingEffort: 'low', weight: 2, maxConcurrency: 4 },
            ],
          },
        },
      });
    });
    expect(session.reloadSession).toHaveBeenCalled();
  });

  it('adds a backend-only CLI route without a model picker', async () => {
    const { host, harness } = makeHost();
    await handleSubagentCommand(host, 'coder');
    picker(host).handleInput(UP);
    picker(host).handleInput(ENTER);
    picker(host, 1).handleInput(DOWN);
    picker(host, 1).handleInput(ENTER);
    const addPicker = picker(host, 2);
    addPicker.handleInput(DOWN);
    addPicker.handleInput(DOWN);
    addPicker.handleInput(DOWN);
    addPicker.handleInput(ENTER);
    expect(picker(host, 3).render(100).join('\n')).toContain('Coder pool weight');
    picker(host, 3).handleInput(ENTER);
    picker(host, 4).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: {
          pools: {
            coder: [
              { backend: 'kimi', model: 'fast', weight: 1, maxConcurrency: 1 },
              { backend: 'grok', weight: 1, maxConcurrency: 4 },
            ],
          },
        },
      });
    });
  });

  it('rejects a duplicate coder pool route', async () => {
    const { host, harness } = makeHost();
    await handleSubagentCommand(host, 'coder');
    picker(host).handleInput(UP);
    picker(host).handleInput(ENTER);
    picker(host, 1).handleInput(DOWN);
    picker(host, 1).handleInput(ENTER);
    picker(host, 2).handleInput(ENTER);
    picker(host, 3).handleInput(ENTER);
    picker(host, 4).handleInput(ENTER);
    picker(host, 5).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith('Coder pool already contains route kimi/fast.');
    });
    expect(harness.setConfig).not.toHaveBeenCalled();
  });

  it('rejects final coder pool route removal', async () => {
    const { host, harness } = makeHost();
    await handleSubagentCommand(host, 'coder');
    picker(host).handleInput(UP);
    picker(host).handleInput(ENTER);
    expect(picker(host, 1).render(100).join('\n')).toContain('Add route');
    picker(host, 1).handleInput(ENTER);
    picker(host, 2).handleInput(DOWN);
    picker(host, 2).handleInput(ENTER);
    expect(host.showError).toHaveBeenCalledWith('Cannot remove the final coder pool route. Add another route first.');
    expect(harness.setConfig).not.toHaveBeenCalled();
  });

  it('edits and removes an existing coder pool route', async () => {
    const config = {
      ...makeConfig(),
      subagent: {
        ...makeConfig().subagent,
        pools: {
          coder: [
            { backend: 'kimi', model: 'fast', weight: 1, maxConcurrency: 1 },
            { backend: 'grok', weight: 1, maxConcurrency: 1 },
          ],
        },
      },
    };
    const edit = makeHost(config);
    await handleSubagentCommand(edit.host, 'coder');
    picker(edit.host).handleInput(UP);
    picker(edit.host).handleInput(ENTER);
    picker(edit.host, 1).handleInput(ENTER);
    picker(edit.host, 2).handleInput(ENTER);
    expect(picker(edit.host, 3).render(100).join('\n')).toContain('Thinking');
    picker(edit.host, 3).handleInput(RIGHT);
    picker(edit.host, 3).handleInput(ENTER);
    picker(edit.host, 4).handleInput(CLEAR_LINE);
    picker(edit.host, 4).handleInput('3');
    picker(edit.host, 4).handleInput(ENTER);
    picker(edit.host, 5).handleInput(ENTER);
    await vi.waitFor(() => {
      expect(edit.harness.setConfig).toHaveBeenCalledWith({
        subagent: {
          pools: {
            coder: [
              { backend: 'kimi', model: 'fast', thinkingEffort: 'low', weight: 3, maxConcurrency: 1 },
              { backend: 'grok', weight: 1, maxConcurrency: 1 },
            ],
          },
        },
      });
    });

    const remove = makeHost(config);
    await handleSubagentCommand(remove.host, 'coder');
    picker(remove.host).handleInput(UP);
    picker(remove.host).handleInput(ENTER);
    picker(remove.host, 1).handleInput(DELETE);
    expect(picker(remove.host, 1).render(100).join('\n')).toContain('Y confirm');
    picker(remove.host, 1).handleInput(CONFIRM);
    await vi.waitFor(() => {
      expect(remove.harness.setConfig).toHaveBeenCalledWith({
        subagent: {
          pools: {
            coder: [{ backend: 'grok', weight: 1, maxConcurrency: 1 }],
          },
        },
      });
    });
  });

  it('does not write configuration when cancelled', async () => {
    const { host, harness } = makeHost();
    await handleSubagentCommand(host, 'debugger');
    picker(host).handleInput(ESCAPE);
    expect(harness.setConfig).not.toHaveBeenCalled();
  });
});
