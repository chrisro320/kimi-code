import { describe, expect, it } from 'vitest';

import { SessionSkillRegistry } from '../../src/skill';
import type { SkillDefinition, SkillSource } from '../../src/skill';

describe('skill registry prompt rendering', () => {
  it('groups skills by scope under canonical section headings', () => {
    const registry = makeRegistry([
      makeSkill('builtin-a', 'builtin'),
      makeSkill('user-a', 'user'),
      makeSkill('proj-a', 'project'),
      makeSkill('extra-a', 'extra'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('### Project');
    expect(rendered).toContain('### User');
    expect(rendered).toContain('### Extra');
    expect(rendered).toContain('### Built-in');

    const projectIdx = rendered.indexOf('### Project');
    const userIdx = rendered.indexOf('### User');
    const extraIdx = rendered.indexOf('### Extra');
    const builtinIdx = rendered.indexOf('### Built-in');
    expect(projectIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(extraIdx);
    expect(extraIdx).toBeLessThan(builtinIdx);

    expect(sectionFor(rendered, '### Project')).toContain('proj-a');
    expect(sectionFor(rendered, '### User')).toContain('user-a');
    expect(sectionFor(rendered, '### Extra')).toContain('extra-a');
    expect(sectionFor(rendered, '### Built-in')).toContain('builtin-a');
    expect(sectionFor(rendered, '### Project')).not.toContain('user-a');
    expect(sectionFor(rendered, '### User')).not.toContain('proj-a');
  });

  it('omits scope headings that have no skills', () => {
    const registry = makeRegistry([makeSkill('alpha', 'user')]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('### User');
    expect(rendered).not.toContain('### Project');
    expect(rendered).not.toContain('### Extra');
    expect(rendered).not.toContain('### Built-in');
  });

  it('renders a "No skills" placeholder for an empty registry', () => {
    const registry = new SessionSkillRegistry();

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered.trim()).not.toBe('');
    expect(/no skills/i.test(rendered)).toBe(true);
  });

  it('sorts skills alphabetically within a scope', () => {
    const registry = makeRegistry([
      makeSkill('zebra', 'user'),
      makeSkill('alpha', 'user'),
      makeSkill('mango', 'user'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    const a = rendered.indexOf('alpha');
    const m = rendered.indexOf('mango');
    const z = rendered.indexOf('zebra');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it('end-to-end: a project skill that shadows other scopes renders once under Project', () => {
    const registry = makeRegistry([
      makeSkill('foo', 'project', 'project version', '/tmp/proj/foo/SKILL.md'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered.match(/\n- foo\n/g) ?? []).toHaveLength(1);
    expect(sectionFor(rendered, '### Project')).toContain('foo');
    expect(rendered).toContain('/tmp/proj/foo/SKILL.md');
    expect(rendered).toContain('project version');
  });

  it('renders each skill as name + Path + Description', () => {
    const registry = makeRegistry([
      makeSkill('alpha', 'user', 'Alpha does things', '/tmp/user/alpha/SKILL.md'),
    ]);

    const rendered = registry.getKimiSkillsDescription();

    expect(rendered).toContain('- alpha');
    expect(rendered).toContain('  - Path: /tmp/user/alpha/SKILL.md');
    expect(rendered).toContain('  - Description: Alpha does things');
  });
});

describe('getModelSkillListing description truncation', () => {
  it('keeps the default listing detailed for backward compatibility', () => {
    const skill = {
      ...makeSkill('demo', 'user', 'Detailed description', '/tmp/user/demo/SKILL.md'),
      metadata: { type: 'prompt' as const, whenToUse: 'Use for detailed work.' },
    };

    const rendered = makeRegistry([skill]).getModelSkillListing();

    expect(rendered).toContain('- demo: Detailed description');
    expect(rendered).toContain('  When to use: Use for detailed work.');
    expect(rendered).toContain('  Path: /tmp/user/demo/SKILL.md');
  });

  it('renders a short, path-free compact listing without changing scopes or names', () => {
    const visible = makeRegistry([
      makeSkill('builtin-a', 'builtin', 'builtin description'),
      makeSkill('user-a', 'user', 'user description'),
      makeSkill('project-a', 'project', 'project description'),
      makeSkill('extra-a', 'extra', 'extra description'),
      { ...makeSkill('subskill', 'user'), metadata: { type: 'prompt', isSubSkill: true } },
      { ...makeSkill('disabled', 'user'), metadata: { type: 'prompt', disableModelInvocation: true } },
    ]).getModelSkillListing({ compact: true });

    expect(visible).toContain('### Project');
    expect(visible.indexOf('### Project')).toBeLessThan(visible.indexOf('### User'));
    expect(visible.indexOf('### User')).toBeLessThan(visible.indexOf('### Extra'));
    expect(visible.indexOf('### Extra')).toBeLessThan(visible.indexOf('### Built-in'));
    expect(visible).toContain('- project-a: project description');
    expect(visible).toContain('- user-a: user description');
    expect(visible).toContain('- extra-a: extra description');
    expect(visible).toContain('- builtin-a: builtin description');
    expect(visible).not.toContain('subskill');
    expect(visible).not.toContain('disabled');
    expect(visible).not.toContain('Path:');
    expect(visible).not.toContain('When to use:');
  });

  it('truncates compact descriptions on grapheme boundaries', () => {
    const description = `${'a'.repeat(79)}😀${'b'.repeat(10)}`;
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing({
      compact: true,
    });

    expect(rendered).toContain(`- demo: ${'a'.repeat(79)}…`);
    expect(rendered).not.toContain('😀');
    expect(rendered).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it('normalizes compact descriptions to one line before truncation', () => {
    const rendered = makeRegistry([
      makeSkill('demo', 'user', 'first line\nPath: /secret\nWhen to use: leaked\n### Injected'),
    ]).getModelSkillListing({ compact: true });

    expect(rendered.split('\n').filter((line) => line.startsWith('- demo:'))).toHaveLength(1);
    expect(rendered).not.toContain('\nPath:');
    expect(rendered).not.toContain('\nWhen to use:');
    expect(rendered).not.toContain('\n### Injected');
  });
  it('keeps descriptions at or below the 250-char limit unchanged', () => {
    const description = 'a'.repeat(250);
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${description}`);
    expect(rendered).not.toContain('…');
  });

  it('appends an ellipsis and stays within the limit when a description is truncated', () => {
    const description = 'a'.repeat(300);
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${'a'.repeat(249)}…`);
    expect(rendered).not.toContain('a'.repeat(250));
  });

  it('does not split a grapheme cluster at the truncation boundary', () => {
    // The 250-char budget cuts at code-unit 249; the emoji spans 248-249, so a
    // naive slice would leave a dangling surrogate. Grapheme-safe truncation
    // must drop the whole emoji instead.
    const description = `${'a'.repeat(248)}😀${'b'.repeat(100)}`;
    const rendered = makeRegistry([makeSkill('demo', 'user', description)]).getModelSkillListing();

    expect(rendered).toContain(`- demo: ${'a'.repeat(248)}…`);
    expect(rendered).not.toContain('😀');
    // no lone high or low surrogate should remain in the rendered output
    expect(rendered).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

function makeRegistry(skills: readonly SkillDefinition[]): SessionSkillRegistry {
  const registry = new SessionSkillRegistry();
  for (const skill of skills) registry.register(skill);
  return registry;
}

function makeSkill(
  name: string,
  source: SkillSource,
  description = 'desc',
  skillPath?: string,
): SkillDefinition {
  const finalPath = skillPath ?? `/tmp/${source}/${name}/SKILL.md`;
  return {
    name,
    description,
    path: finalPath,
    dir: finalPath.replace(/\/SKILL\.md$/, ''),
    content: '',
    metadata: { type: 'prompt' },
    source,
  };
}

function sectionFor(rendered: string, header: string): string {
  const start = rendered.indexOf(header);
  if (start === -1) return '';
  const next = rendered.indexOf('### ', start + header.length);
  return next === -1 ? rendered.slice(start) : rendered.slice(start, next);
}
