import type { Component } from '@moonshot-ai/pi-tui';
import { Container, Text, truncateToWidth } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { ResultRenderer } from './tool-renderers/types';
import { PREVIEW_LINES } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

// `  $ ` — two cells of block indent plus the two-cell prompt. The command
// body renders at this indent so wrapped rows line up under the first one.
const COMMAND_INDENT = 4;

/**
 * Wrap-aware command preview.
 *
 * The cap counts *rendered* rows rather than `\n`s: a one-line `a && b && c`
 * chain wraps to many rows and would otherwise escape the cap entirely, which
 * is how long deploy one-liners kept filling the transcript. The first row's
 * indent is swapped for the `$ ` prompt after wrapping, so the prompt stays
 * column-aligned with the continuation rows.
 */
class CommandPreviewComponent implements Component {
  private readonly textComponent: Text;
  private readonly maxLines: number | undefined;

  constructor(command: string, maxLines: number | undefined) {
    // Distinguish the command (input) from the result (output): the `$` prompt
    // uses the dedicated shell-mode hue, the command body uses `textDim`, and
    // the result below is one step dimmer in `textMuted` so the two stay
    // separable without a connecting glyph.
    this.textComponent = new Text(currentTheme.dim(command), COMMAND_INDENT, 0);
    this.maxLines = maxLines;
  }

  invalidate(): void {
    this.textComponent.invalidate();
  }

  render(width: number): string[] {
    const allLines = this.textComponent.render(width);
    const cap = this.maxLines;
    const capped = cap !== undefined && allLines.length > cap;
    const shown = capped ? allLines.slice(0, cap) : allLines;

    const lines = shown.map((line, i) =>
      i === 0 ? `  ${currentTheme.fg('shellMode', '$ ')}${line.slice(COMMAND_INDENT)}` : line,
    );

    if (capped) {
      const remaining = allLines.length - cap;
      const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
      const indentWidth = Math.min(COMMAND_INDENT, Math.max(0, width));
      lines.push(
        ' '.repeat(indentWidth) +
          currentTheme.dim(truncateToWidth(hint, Math.max(0, width - indentWidth), '…')),
      );
    }
    return lines;
  }
}

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
  readonly tailOutput?: boolean;
  readonly expandHint?: boolean;
}

export class ShellExecutionComponent extends Container {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.expanded ?? false,
        options.resultPreviewLines ?? PREVIEW_LINES,
        options.tailOutput ?? false,
        options.expandHint ?? true,
      );
    }
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    this.addChild(new CommandPreviewComponent(command, previewLines));
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    previewLines: number,
    tailOutput: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new TruncatedOutputComponent(result.output, {
        expanded,
        isError: result.is_error ?? false,
        maxLines: previewLines,
        tail: tailOutput,
        expandHint,
        color: 'textMuted',
      }),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  // Result only. The command preview is owned by ToolCallComponent's
  // buildCallPreview across the whole lifecycle (streaming, running, and
  // done); rendering it here too would duplicate the command once the result
  // lands.
  new ShellExecutionComponent({
    result,
    expanded: ctx.expanded,
  }),
];
