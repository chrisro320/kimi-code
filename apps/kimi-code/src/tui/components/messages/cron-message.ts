/**
 * Renders a cron-fired (or missed) scheduled reminder in the transcript.
 * The prompt body is model-facing text, so it collapses behind Ctrl+O
 * (shared with tool output and thinking) leaving only header + detail.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { Spacer, Text, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { CARD_BODY_PREVIEW_LINES } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { CronTranscriptData } from '#/tui/types';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class CronMessageComponent implements Component {
  private readonly spacer = new Spacer(1);
  private readonly title: string;
  private readonly titleToken: keyof ColorPalette;
  private readonly detail: string | undefined;
  private readonly prompt: string;
  // Hold the Text instances so pi-tui's (text, width) → lines cache survives
  // across renders; re-constructing them per render forces a full re-wrap on
  // every frame.
  private readonly titleText: Text;
  private readonly detailText: Text | undefined;
  private readonly promptText: Text;

  private expanded = false;
  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    prompt: string,
    data: CronTranscriptData,
  ) {
    const missed = data.missedCount !== undefined;
    this.title = missed ? 'Missed scheduled reminders' : 'Scheduled reminder fired';
    this.titleToken = data.stale === true || missed ? 'warning' : 'accent';
    this.detail = cronDetail(data);
    this.prompt = prompt;
    this.titleText = new Text(currentTheme.boldFg(this.titleToken, this.title), 0, 0);
    this.detailText =
      this.detail === undefined
        ? undefined
        : new Text(currentTheme.fg('textDim', this.detail), 0, 0);
    this.promptText = new Text(currentTheme.fg('text', prompt), 0, 0);
  }

  invalidate(): void {
    this.renderCache = undefined;
    this.titleText.setText(currentTheme.boldFg(this.titleToken, this.title));
    this.titleText.invalidate();
    if (this.detail !== undefined) {
      this.detailText?.setText(currentTheme.fg('textDim', this.detail));
      this.detailText?.invalidate();
    }
    this.promptText.setText(currentTheme.fg('text', this.prompt));
    this.promptText.invalidate();
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

    const bullet = currentTheme.boldFg(this.titleToken, STATUS_BULLET);
    const bulletWidth = visibleWidth(bullet);
    const contentWidth = Math.max(1, safeWidth - bulletWidth);
    const continuationIndent = ' '.repeat(bulletWidth);
    const lines: string[] = [];

    for (const line of this.spacer.render(safeWidth)) {
      lines.push(line);
    }

    const titleLines = this.titleText.render(contentWidth);
    for (let i = 0; i < titleLines.length; i += 1) {
      lines.push(`${i === 0 ? bullet : continuationIndent}${titleLines[i]}`);
    }

    if (this.detailText !== undefined) {
      for (const line of this.detailText.render(contentWidth)) {
        lines.push(`${continuationIndent}${line}`);
      }
    }

    const promptLines = this.promptText.render(contentWidth);
    const collapsed = !this.expanded && promptLines.length > CARD_BODY_PREVIEW_LINES + 1;
    const shown = collapsed ? promptLines.slice(0, CARD_BODY_PREVIEW_LINES) : promptLines;
    for (const line of shown) {
      lines.push(`${continuationIndent}${line}`);
    }
    if (collapsed) {
      const remaining = promptLines.length - CARD_BODY_PREVIEW_LINES;
      const hint = `... (${String(remaining)} more lines, ctrl+o to expand)`;
      lines.push(
        continuationIndent + currentTheme.dim(truncateToWidth(hint, contentWidth, '…')),
      );
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines };
    }
    return lines;
  }
}

function cronDetail(data: CronTranscriptData): string | undefined {
  const parts: string[] = [];
  if (data.cron !== undefined && data.cron.length > 0) parts.push(data.cron);
  if (data.jobId !== undefined && data.jobId.length > 0) parts.push(`job ${data.jobId}`);
  if (data.recurring === false) parts.push('one-shot');
  if (data.coalescedCount !== undefined && data.coalescedCount > 1) {
    parts.push(`${String(data.coalescedCount)} fires coalesced`);
  }
  if (data.missedCount !== undefined) {
    parts.push(`${String(data.missedCount)} missed`);
  }
  if (data.stale === true) parts.push('final delivery');
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
