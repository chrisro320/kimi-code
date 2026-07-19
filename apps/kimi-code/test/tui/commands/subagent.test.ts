import { describe, expect, it, vi } from 'vitest';

import { handleSubagentCommand } from '#/tui/commands';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const DOWN = '\u001B[B';
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
      },
      strong: {
        provider: 'kimi', model: 'kimi-strong', maxContextSize: 256_000,
      },
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
    },
  } as const;
}

function makeHost() {
  const config = makeConfig();
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
    expect(picker(host).render(100).join('\n')).toContain('Select subagent type');
    picker(host).handleInput(ENTER);
    expect(picker(host, 1).render(100).join('\n')).toContain('Configure subagent: coder');
    picker(host, 1).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(harness.setConfig).toHaveBeenCalledWith({
        subagent: { routing: { coder: { backend: 'kimi', model: 'fast' } } },
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

  it('does not write configuration when cancelled', async () => {
    const { host, harness } = makeHost();
    await handleSubagentCommand(host, 'plan');
    picker(host).handleInput(ESCAPE);
    expect(harness.setConfig).not.toHaveBeenCalled();
  });
});
