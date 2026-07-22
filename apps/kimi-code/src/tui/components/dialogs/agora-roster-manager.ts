import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export interface AgoraPeerEntry {
  readonly id: string;
  readonly backend: string;
  readonly model?: string;
  readonly displayName?: string;
}

export interface AgoraRosterManagerOptions {
  readonly peers: readonly AgoraPeerEntry[];
  /** `false` renders the built-in fallback roster; rows are read-only until a peer is added. */
  readonly configured: boolean;
  readonly onAdd: () => void;
  readonly onEdit: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly onClose: () => void;
}

export class AgoraRosterManagerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: AgoraRosterManagerOptions;
  private selectedIndex = 0;
  private confirmRemoveIndex: number | undefined;

  constructor(opts: AgoraRosterManagerOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    if (this.confirmRemoveIndex !== undefined) {
      const printable = printableChar(data)?.toLowerCase();
      if (printable === 'y') {
        const index = this.confirmRemoveIndex;
        this.confirmRemoveIndex = undefined;
        this.opts.onRemove(index);
      } else if (printable === 'n' || matchesKey(data, Key.escape)) {
        this.confirmRemoveIndex = undefined;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.opts.peers.length, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selectedIndex === this.opts.peers.length) this.opts.onAdd();
      else if (this.opts.peers[this.selectedIndex] !== undefined) this.opts.onEdit(this.selectedIndex);
      return;
    }
    if (printableChar(data)?.toLowerCase() === 'd' && this.selectedIndex < this.opts.peers.length) {
      if (!this.opts.configured) return;
      this.confirmRemoveIndex = this.selectedIndex;
      this.invalidate();
    }
  }

  override render(width: number): string[] {
    const title = currentTheme.boldFg('primary', ' Manage Agora peer roster');
    const hint = this.confirmRemoveIndex === undefined
      ? ' ↑↓ navigate · Enter edit/add · D remove · Esc back'
      : ` Remove peer ${this.opts.peers[this.confirmRemoveIndex]?.id ?? ''}? Y confirm · N/Esc cancel`;
    const rows = this.opts.peers.map((peer, index) => {
      const selected = index === this.selectedIndex;
      const prefix = selected ? '› ' : '  ';
      const route = [peer.backend, peer.model].filter((part): part is string => part !== undefined).join('/');
      const label = peer.displayName !== undefined && peer.displayName !== peer.id
        ? `${peer.displayName} (${peer.id})`
        : peer.id;
      const line = `${prefix}${label}  ${route}`;
      return currentTheme.fg(selected ? 'text' : 'textDim', line);
    });
    const addSelected = this.selectedIndex === this.opts.peers.length;
    rows.push(currentTheme.fg(addSelected ? 'primary' : 'textDim', `${addSelected ? '› ' : '  '}Add peer`));
    const lines = [
      '─'.repeat(width),
      title,
      currentTheme.fg('textMuted', hint),
      '',
      ...rows,
    ];
    if (!this.opts.configured) {
      lines.push('', currentTheme.fg('textMuted', ' Built-in fallback roster — add a peer to start configuring.'));
    }
    lines.push('', '─'.repeat(width));
    return lines.map((line) => truncateToWidth(line, width));
  }
}
