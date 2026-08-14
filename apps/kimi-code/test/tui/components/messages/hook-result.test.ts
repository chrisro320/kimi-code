import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { HookResultComponent } from '#/tui/components/messages/hook-result';
import { isExpandable } from '#/tui/utils/component-capabilities';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const policyBody = [
  'Session policy: caveman:full.',
  'Before first reply: CronList.',
  'Non-trivial task: start 20-minute keepttl immediately.',
  'Web search: Tavily CLI. Follow AGENTS.md otherwise.',
].join('\n');

describe('HookResultComponent', () => {
  it('collapses the body behind ctrl+o and keeps only the header', () => {
    const component = new HookResultComponent({
      blocks: [{ event: 'UserPromptSubmit', body: policyBody }],
      blocked: false,
    });

    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('UserPromptSubmit hook');
    expect(out).toContain('ctrl+o to expand');
    expect(out).not.toContain('Session policy');
    expect(out).not.toContain('Tavily CLI');
  });

  it('marks a blocked hook in the header', () => {
    const component = new HookResultComponent({
      blocks: [{ event: 'PreToolUse', body: policyBody }],
      blocked: true,
    });

    expect(strip(component.render(80).join('\n'))).toContain('PreToolUse hook blocked');
  });

  it('expands and collapses through setExpanded', () => {
    const component = new HookResultComponent({
      blocks: [{ event: 'UserPromptSubmit', body: policyBody }],
      blocked: false,
    });

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('Session policy');
    expect(expanded).toContain('Tavily CLI');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('Session policy');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('is picked up by the shared ctrl+o expansion sweep', () => {
    expect(
      isExpandable(new HookResultComponent({ blocks: [{ event: 'Stop', body: 'ok' }], blocked: false })),
    ).toBe(true);
  });

  it('does not add a hint line when the body already fits in one line', () => {
    const component = new HookResultComponent({
      blocks: [{ event: 'Stop', body: 'ok' }],
      blocked: false,
    });

    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('ok');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('counts wrapped lines, not newlines, in the hint', () => {
    // A single logical line that wraps must still collapse — otherwise a long
    // one-line hook payload escapes the cap.
    const component = new HookResultComponent({
      blocks: [{ event: 'SessionStart', body: 'y'.repeat(200) }],
      blocked: false,
    });

    const out = strip(component.render(40).join('\n'));

    expect(out).toContain('ctrl+o to expand');
    expect(out).not.toContain('y'.repeat(40));
  });

  it('renders every block of a multi-hook card', () => {
    // Replay folds several hook payloads into one card; each block keeps its
    // own header and its own collapse hint.
    const component = new HookResultComponent({
      blocks: [
        { event: 'UserPromptSubmit', body: policyBody },
        { event: 'SessionStart', body: 'first\nsecond\nthird' },
      ],
      blocked: false,
    });

    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).toContain('UserPromptSubmit hook');
    expect(collapsed).toContain('SessionStart hook');
    expect(collapsed).not.toContain('Session policy');
    expect(collapsed).not.toContain('second');
    expect(collapsed.match(/ctrl\+o to expand/g)).toHaveLength(2);

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('Session policy');
    expect(expanded).toContain('second');
    expect(expanded).not.toContain('ctrl+o to expand');
  });

  it('stays within the requested render width', () => {
    const component = new HookResultComponent({
      blocks: [{ event: 'UserPromptSubmit', body: policyBody }],
      blocked: false,
    });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });
});
