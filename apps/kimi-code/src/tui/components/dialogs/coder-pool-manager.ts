import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export interface CoderPoolRoute {
  readonly backend: string;
  readonly model?: string;
  readonly maxConcurrency?: number;
  readonly weight?: number;
}

export interface CoderPoolManagerOptions {
  readonly routes: readonly CoderPoolRoute[];
  readonly onAdd: () => void;
  readonly onEdit: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly onClose: () => void;
}

export class CoderPoolManagerComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CoderPoolManagerOptions;
  private selectedIndex = 0;
  private confirmRemoveIndex: number | undefined;

  constructor(opts: CoderPoolManagerOptions) {
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
      this.selectedIndex = Math.min(this.opts.routes.length, this.selectedIndex + 1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.selectedIndex === this.opts.routes.length) this.opts.onAdd();
      else if (this.opts.routes[this.selectedIndex] !== undefined) this.opts.onEdit(this.selectedIndex);
      return;
    }
    if (printableChar(data)?.toLowerCase() === 'd' && this.selectedIndex < this.opts.routes.length) {
      if (this.opts.routes.length <= 1) return;
      this.confirmRemoveIndex = this.selectedIndex;
      this.invalidate();
    }
  }

  override render(width: number): string[] {
    const title = currentTheme.boldFg('primary', ' Manage coder pool');
    const hint = this.confirmRemoveIndex === undefined
      ? ' ↑↓ navigate · Enter edit/add · D remove · Esc back'
      : ` Remove ${formatRoute(this.opts.routes[this.confirmRemoveIndex] ?? { backend: 'route' })}? Y confirm · N/Esc cancel`;
    const rows = this.opts.routes.map((route, index) => {
      const selected = index === this.selectedIndex;
      const prefix = selected ? '› ' : '  ';
      const line = `${prefix}${formatRoute(route)}  weight=${String(route.weight ?? 1)} concurrency=${String(route.maxConcurrency ?? 1)}`;
      return currentTheme.fg(selected ? 'text' : 'textDim', line);
    });
    const addSelected = this.selectedIndex === this.opts.routes.length;
    rows.push(currentTheme.fg(addSelected ? 'primary' : 'textDim', `${addSelected ? '› ' : '  '}Add route`));
    const lines = [
      '─'.repeat(width),
      title,
      currentTheme.fg('textMuted', hint),
      '',
      ...rows,
      '',
      '─'.repeat(width),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }
}

function formatRoute(route: CoderPoolRoute): string {
  return route.model === undefined ? route.backend : `${route.backend}/${route.model}`;
}
