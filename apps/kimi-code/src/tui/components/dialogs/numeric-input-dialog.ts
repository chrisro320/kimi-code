import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export type NumericInputResult =
  | { readonly kind: 'ok'; readonly value: number }
  | { readonly kind: 'cancel' };

export interface NumericInputDialogOptions {
  readonly title: string;
  readonly description: string;
  readonly initialValue: number;
  readonly integer?: boolean;
  readonly onDone: (result: NumericInputResult) => void;
}

export class NumericInputDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly opts: NumericInputDialogOptions;
  private error: string | undefined;
  private done = false;

  constructor(opts: NumericInputDialogOptions) {
    super();
    this.opts = opts;
    this.input.setValue(String(opts.initialValue));
    this.input.handleInput('\u0005');
    this.input.onSubmit = (value) => this.submit(value);
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.done = true;
      this.opts.onDone({ kind: 'cancel' });
      return;
    }
    this.error = undefined;
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const border = (text: string): string => currentTheme.fg('primary', text);
    const title = currentTheme.boldFg('textStrong', this.opts.title);
    const description = currentTheme.fg('textDim', this.opts.description);
    const error = this.error === undefined ? undefined : currentTheme.fg('error', this.error);
    const inputLine = this.input.render(innerWidth)[0] ?? '> ';
    const content = [
      title,
      '',
      truncateToWidth(description, innerWidth, '…'),
      ...(error === undefined ? [] : [error]),
      '',
      inputLine,
      '',
      currentTheme.fg('textDim', 'Enter submit · Esc cancel'),
    ];
    const lines = [
      border('╭' + '─'.repeat(Math.max(0, safeWidth - 2)) + '╮'),
      ...content.map((line) => {
        const trimmed = truncateToWidth(line, innerWidth, '…');
        return border('│') + '  ' + trimmed + ' '.repeat(Math.max(0, innerWidth - visibleWidth(trimmed))) + border('│');
      }),
      border('╰' + '─'.repeat(Math.max(0, safeWidth - 2)) + '╯'),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private submit(raw: string): void {
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0 || (this.opts.integer === true && !Number.isInteger(value))) {
      this.error = this.opts.integer === true
        ? 'Enter a positive whole number.'
        : 'Enter a positive number.';
      this.invalidate();
      return;
    }
    this.done = true;
    this.opts.onDone({ kind: 'ok', value });
  }
}
