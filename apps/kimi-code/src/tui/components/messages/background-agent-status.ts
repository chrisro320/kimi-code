import { Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function formatTokens(tokens: number): string {
  return `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k` : tokens} tok`;
}

export class BackgroundAgentStatusComponent implements Component {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private data: BackgroundAgentStatusData,
    requestRender?: () => void,
  ) {
    if (data.phase === 'started' && data.startedAtMs !== undefined) {
      this.timer = setInterval(() => requestRender?.(), 1000);
      this.timer.unref?.();
    }
  }

  setData(data: BackgroundAgentStatusData): void {
    if (this.timer !== undefined && data.phase !== 'started') {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.data = data;
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const tone: keyof ColorPalette =
      this.data.phase === 'started'
        ? 'primary'
        : this.data.phase === 'completed'
          ? 'success'
          : 'error';

    const bullet =
      this.data.phase === 'failed' ? currentTheme.fg(tone, FAILURE_MARK) : currentTheme.fg(tone, STATUS_BULLET);
    const end = this.data.endedAtMs ?? Date.now();
    const elapsed =
      this.data.startedAtMs === undefined
        ? undefined
        : formatElapsed(end - this.data.startedAtMs);
    const metrics = [elapsed, this.data.tokens === undefined ? undefined : formatTokens(this.data.tokens)]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    const detail = [this.data.detail, metrics]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(' · ');
    const text =
      currentTheme.fg(tone, this.data.headline) +
      (detail.length > 0 ? currentTheme.fg('textDim', ` (${detail})`) : '');

    const textComponent = new Text(text, 0, 0);
    const contentWidth = Math.max(1, safeWidth - MESSAGE_INDENT.length);
    const contentLines = textComponent.render(contentWidth);
    return [
      '',
      ...contentLines.map((line, index) => (index === 0 ? bullet : MESSAGE_INDENT) + line),
    ].map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
