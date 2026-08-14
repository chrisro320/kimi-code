import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { CronMessageComponent } from '#/tui/components/messages/cron-message';
import { isExpandable } from '#/tui/utils/component-capabilities';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longPrompt = [
  'keepttl job: task=deploy state=active',
  'Fire decision rules:',
  '- Task done: rotate to grace',
  '- Not done and now >= rotate_at: safe renew',
  '- Grace fire before expiry: reply keepttl ping',
].join('\n');

describe('CronMessageComponent', () => {
  it('collapses the prompt behind ctrl+o and keeps the header visible', () => {
    const component = new CronMessageComponent(longPrompt, {
      jobId: '01KZZ6SF',
      cron: '7-59/20 * * * *',
    });

    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('Scheduled reminder fired');
    expect(out).toContain('7-59/20 * * * *');
    expect(out).toContain('job 01KZZ6SF');
    expect(out).toContain('ctrl+o to expand');
    expect(out).not.toContain('keepttl job');
    expect(out).not.toContain('Fire decision rules');
  });

  it('expands and collapses through setExpanded', () => {
    const component = new CronMessageComponent(longPrompt, { jobId: '01KZZ6SF' });

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('keepttl job');
    expect(expanded).toContain('Grace fire before expiry');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('keepttl job');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('is picked up by the shared ctrl+o expansion sweep', () => {
    expect(isExpandable(new CronMessageComponent('ping', {}))).toBe(true);
  });

  it('does not add a hint line when the prompt already fits in one line', () => {
    const component = new CronMessageComponent('keepttl ping', {});

    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('keepttl ping');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('counts wrapped lines, not newlines, in the hint', () => {
    // A single logical line that wraps into several rendered lines must still
    // collapse — otherwise a long one-line cron prompt escapes the cap.
    const component = new CronMessageComponent('x'.repeat(200), {});

    const out = strip(component.render(40).join('\n'));

    expect(out).toContain('ctrl+o to expand');
    expect(out).not.toContain('x'.repeat(40));
  });

  it('keeps the missed-reminder title and stays within the render width', () => {
    const component = new CronMessageComponent(longPrompt, { missedCount: 3 });

    const lines = component.render(37);
    expect(strip(lines.join('\n'))).toContain('Missed scheduled reminders');
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });
});
