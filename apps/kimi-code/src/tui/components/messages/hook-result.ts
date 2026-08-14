/**
 * Renders a hook result in the transcript.
 * The body is model-facing policy text, so it collapses behind Ctrl+O
 * (shared with tool output and thinking) leaving only the header.
 */

import { Text, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';

import { CARD_BODY_PREVIEW_LINES } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { HookResultTranscriptData } from '#/tui/types';
import { formatHookResultTitle } from '#/tui/utils/hook-result-format';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

interface RenderableBlock {
  readonly title: string;
  readonly body: string;
  readonly titleText: Text;
  readonly bodyText: Text;
}

export class HookResultComponent implements Component {
  private readonly blocks: readonly RenderableBlock[];

  private expanded = false;
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(data: HookResultTranscriptData) {
    this.blocks = data.blocks.map((block) => {
      const title = formatHookResultTitle(block.event, data.blocked);
      return {
        title,
        body: block.body,
        titleText: new Text(styledTitle(title), 0, 0),
        bodyText: new Text(styledBody(block.body), 0, 0),
      };
    });
  }

  invalidate(): void {
    this.renderCache = undefined;
    for (const block of this.blocks) {
      block.titleText.setText(styledTitle(block.title));
      block.titleText.invalidate();
      block.bodyText.setText(styledBody(block.body));
      block.bodyText.invalidate();
    }
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.renderCache = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const bullet = currentTheme.fg('textDim', STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const indent = ' '.repeat(bulletWidth);
    const lines: string[] = [''];

    for (const [blockIndex, block] of this.blocks.entries()) {
      // Only the card's first title carries the bullet; further blocks are
      // separated by a blank line, matching how the markdown card read.
      if (blockIndex > 0) lines.push('');
      const titleLines = block.titleText.render(contentWidth);
      for (const [i, line] of titleLines.entries()) {
        lines.push(`${blockIndex === 0 && i === 0 ? bullet : indent}${line}`);
      }

      const bodyLines = block.body.length > 0 ? block.bodyText.render(contentWidth) : [];
      const collapsed = !this.expanded && bodyLines.length > CARD_BODY_PREVIEW_LINES + 1;
      const shown = collapsed ? bodyLines.slice(0, CARD_BODY_PREVIEW_LINES) : bodyLines;
      for (const line of shown) {
        lines.push(`${indent}${line}`);
      }
      if (collapsed) {
        const remaining = bodyLines.length - CARD_BODY_PREVIEW_LINES;
        const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
        lines.push(indent + currentTheme.dim(truncateToWidth(hint, contentWidth, '…')));
      }
    }

    const rendered = lines.map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}

function styledTitle(title: string): string {
  return currentTheme.italicFg('textDim', title);
}

function styledBody(body: string): string {
  return currentTheme.fg('textDim', body);
}
