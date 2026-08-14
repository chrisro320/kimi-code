import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import type { SlashCommandHost } from './dispatch';

const ACP_USAGE = 'Usage: /acp [status|enable|disable|reset]';

export async function handleAcpCommand(host: SlashCommandHost, args: string): Promise<void> {
  const session = host.session;
  if (session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  const subcommand = args.trim().split(/\s+/)[0] ?? '';
  switch (subcommand) {
    case '':
    case 'status': {
      const status = await session.acpStatus();
      host.setAppState({ acp: status.enabled ? status.health : undefined });
      const lines = [
        `Manager: ${status.managerId} v${status.managerVersion} (${status.enabled ? 'enabled' : 'disabled'})`,
        `Health: ${status.health}${status.reason === undefined ? '' : ` — ${status.reason}`}`,
        `Refs: ${status.refs} · Blocks: ${status.blocks} (${status.activeBlocks} active)`,
      ];
      if (status.contextUsage !== undefined) {
        lines.push(`Context usage: ${Math.round(status.contextUsage * 100)}%`);
      }
      host.showNotice('ACP status', lines.join('\n'));
      return;
    }
    case 'enable': {
      await session.acpEnable();
      const status = await session.acpStatus();
      host.setAppState({ acp: status.enabled ? status.health : undefined });
      host.showNotice('ACP context manager enabled', 'Takes effect on the next request.');
      return;
    }
    case 'disable': {
      await session.acpDisable();
      host.setAppState({ acp: undefined });
      host.showNotice('ACP context manager disabled', 'Compressed state is kept; /acp reset deletes it.');
      return;
    }
    case 'reset': {
      const confirmed = await confirmAcpReset(host);
      if (!confirmed) return;
      await session.acpReset();
      host.showNotice('ACP state reset', 'Refs and compressed blocks for this agent were deleted.');
      return;
    }
    default:
      host.showError(`Unknown /acp subcommand: ${subcommand}. ${ACP_USAGE}`);
      return;
  }
}

function confirmAcpReset(host: SlashCommandHost): Promise<boolean> {
  return new Promise((resolveConfirmed) => {
    host.mountEditorReplacement(
      new ChoicePickerComponent({
        title: 'Reset ACP context manager state?',
        hint: '↑↓ navigate · Enter/Space select · ←/Esc cancel',
        options: [
          {
            value: 'cancel',
            label: 'Cancel',
            description: 'Keep the compressed state.',
          },
          {
            value: 'reset',
            label: 'Reset ACP state',
            tone: 'danger',
            description:
              "Delete this agent's refs and compressed blocks. The conversation history is untouched.",
          },
        ],
        onSelect: (value) => {
          host.restoreEditor();
          resolveConfirmed(value === 'reset');
        },
        onCancel: () => {
          host.restoreEditor();
          resolveConfirmed(false);
        },
      }),
    );
  });
}
