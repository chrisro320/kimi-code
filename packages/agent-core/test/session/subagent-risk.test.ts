import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RISK_CONCURRENCY_THRESHOLD,
  checkConcurrencyThreshold,
  checkDirtyScope,
  checkFileFamilyOverlap,
  resolveEffectiveMaxConcurrency,
  type RiskCheckItem,
} from '../../src/session/subagent-risk';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-risk-'));
  tempDirs.push(dir);
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.test'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

async function writeFileDeep(dir: string, relPath: string, content: string): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

async function commitAll(dir: string, message = 'init'): Promise<void> {
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

function editingItem(scope: readonly string[]): RiskCheckItem {
  return { isEditingCapable: true, scope };
}
function readOnlyItem(): RiskCheckItem {
  return { isEditingCapable: false, scope: undefined };
}

// R-C1 signal 1: dirty scope. Dangerous cases are real uncommitted changes
// under the declared scope; safe-but-looks-risky cases are dirty state that
// must NOT count (dirty elsewhere, clean repo, git itself unavailable).
describe('checkDirtyScope', () => {
  it('[dangerous] flags an uncommitted modification inside the declared scope', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await commitAll(dir);
    await writeFile(join(dir, 'src/a/file.ts'), 'export const a = 2;');

    const hit = await checkDirtyScope([editingItem(['src/a'])], dir);
    expect(hit).toBe(true);
  });

  it('[dangerous] flags an untracked new file inside the declared scope', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await commitAll(dir);
    await writeFileDeep(dir, 'src/a/new-file.ts', 'export const b = 2;');

    const hit = await checkDirtyScope([editingItem(['src/a'])], dir);
    expect(hit).toBe(true);
  });

  it('[safe] does not flag a dirty file outside the declared scope (unrelated monorepo change)', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await writeFileDeep(dir, 'src/b/file.ts', 'export const b = 1;');
    await commitAll(dir);
    await writeFile(join(dir, 'src/b/file.ts'), 'export const b = 2;');

    const hit = await checkDirtyScope([editingItem(['src/a'])], dir);
    expect(hit).toBe(false);
  });

  it('[safe] does not flag a fully clean repo', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await commitAll(dir);

    const hit = await checkDirtyScope([editingItem(['src/a'])], dir);
    expect(hit).toBe(false);
  });

  it('[safe] fails open (does not throw, returns false) when the workspace is not a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-risk-nogit-'));
    tempDirs.push(dir);
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');

    await expect(checkDirtyScope([editingItem(['src/a'])], dir)).resolves.toBe(false);
  });

  it('[safe] skips detection when no item is editing-capable', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await commitAll(dir);
    await writeFile(join(dir, 'src/a/file.ts'), 'export const a = 2;');

    const hit = await checkDirtyScope([readOnlyItem()], dir);
    expect(hit).toBe(false);
  });
});

// R-C1 signal 2: concurrency threshold. Dangerous = at/above the threshold;
// safe = below threshold, or any number of read-only items (never counted).
describe('checkConcurrencyThreshold', () => {
  const n = DEFAULT_RISK_CONCURRENCY_THRESHOLD;

  it('[dangerous] flags exactly N concurrent editing items', () => {
    const items = Array.from({ length: n }, () => editingItem(['src/x']));
    expect(checkConcurrencyThreshold(items, n)).toBe(true);
  });

  it('[dangerous] flags more than N concurrent editing items', () => {
    const items = Array.from({ length: n + 2 }, () => editingItem(['src/x']));
    expect(checkConcurrencyThreshold(items, n)).toBe(true);
  });

  it('[safe] does not flag N-1 concurrent editing items', () => {
    const items = Array.from({ length: n - 1 }, () => editingItem(['src/x']));
    expect(checkConcurrencyThreshold(items, n)).toBe(false);
  });

  it('[safe] does not flag a large read-only swarm regardless of count', () => {
    const items = Array.from({ length: n + 10 }, () => readOnlyItem());
    expect(checkConcurrencyThreshold(items, n)).toBe(false);
  });

  it('[safe] does not flag a mix where editing items stay under N', () => {
    const items = [
      ...Array.from({ length: n - 1 }, () => editingItem(['src/x'])),
      ...Array.from({ length: 10 }, () => readOnlyItem()),
    ];
    expect(checkConcurrencyThreshold(items, n)).toBe(false);
  });
});

// R-C1 signal 3: file-family overlap. Dangerous = different subdirs sharing
// the same nearest package.json/tsconfig.json ancestor; safe = each item has
// its own nearer manifest (real sub-package isolation), or neither resolves
// to any manifest at all.
describe('checkFileFamilyOverlap', () => {
  it('[dangerous] flags two items in different subdirs of the same package', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'package.json'), '{}');
    await mkdir(join(dir, 'src/moduleA'), { recursive: true });
    await mkdir(join(dir, 'src/moduleB'), { recursive: true });

    const hit = await checkFileFamilyOverlap(
      [editingItem(['src/moduleA/file.ts']), editingItem(['src/moduleB/file.ts'])],
      dir,
    );
    expect(hit).toBe(true);
  });

  it('[safe] does not flag two items each isolated under their own nested package', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'package.json'), '{}');
    await mkdir(join(dir, 'packages/a'), { recursive: true });
    await mkdir(join(dir, 'packages/b'), { recursive: true });
    await writeFile(join(dir, 'packages/a/package.json'), '{}');
    await writeFile(join(dir, 'packages/b/package.json'), '{}');

    const hit = await checkFileFamilyOverlap(
      [editingItem(['packages/a/src/file.ts']), editingItem(['packages/b/src/file.ts'])],
      dir,
    );
    expect(hit).toBe(false);
  });

  it('[safe] does not flag when neither item resolves to any manifest', async () => {
    const dir = await makeRepo();
    await mkdir(join(dir, 'notes/a'), { recursive: true });
    await mkdir(join(dir, 'notes/b'), { recursive: true });

    const hit = await checkFileFamilyOverlap(
      [editingItem(['notes/a/file.md']), editingItem(['notes/b/file.md'])],
      dir,
    );
    expect(hit).toBe(false);
  });

  it('[safe] does not flag a single editing item (needs at least two to overlap)', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'package.json'), '{}');

    const hit = await checkFileFamilyOverlap([editingItem(['src/a/file.ts'])], dir);
    expect(hit).toBe(false);
  });
});

// End-to-end: any single signal hitting forces maxConcurrency to 1; none
// hitting leaves the configured value untouched; a read-only batch is never
// even evaluated.
describe('resolveEffectiveMaxConcurrency', () => {
  it('leaves configured maxConcurrency untouched when no signal hits', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'package.json'), '{}');
    await commitAll(dir);

    const result = await resolveEffectiveMaxConcurrency(
      [editingItem(['src/a/file.ts'])],
      8,
      { workspaceDir: dir, concurrencyThreshold: DEFAULT_RISK_CONCURRENCY_THRESHOLD },
    );
    expect(result).toBe(8);
  });

  it('forces maxConcurrency to 1 when the dirty-scope signal hits', async () => {
    const dir = await makeRepo();
    await writeFileDeep(dir, 'src/a/file.ts', 'export const a = 1;');
    await commitAll(dir);
    await writeFile(join(dir, 'src/a/file.ts'), 'export const a = 2;');

    const result = await resolveEffectiveMaxConcurrency(
      [editingItem(['src/a'])],
      8,
      { workspaceDir: dir, concurrencyThreshold: DEFAULT_RISK_CONCURRENCY_THRESHOLD },
    );
    expect(result).toBe(1);
  });

  it('forces maxConcurrency to 1 when the concurrency-threshold signal hits', async () => {
    const dir = await makeRepo();
    const items = Array.from({ length: DEFAULT_RISK_CONCURRENCY_THRESHOLD }, (_, i) =>
      editingItem([`src/item-${String(i)}`]),
    );

    const result = await resolveEffectiveMaxConcurrency(items, 8, {
      workspaceDir: dir,
      concurrencyThreshold: DEFAULT_RISK_CONCURRENCY_THRESHOLD,
    });
    expect(result).toBe(1);
  });

  it('skips all detection and returns configured unchanged for a read-only batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-subagent-risk-readonly-'));
    tempDirs.push(dir);
    const items = Array.from({ length: 20 }, () => readOnlyItem());

    const result = await resolveEffectiveMaxConcurrency(items, 8, {
      workspaceDir: dir,
      concurrencyThreshold: DEFAULT_RISK_CONCURRENCY_THRESHOLD,
    });
    expect(result).toBe(8);
  });

  it('returns undefined unchanged when nothing is configured and no signal hits', async () => {
    const dir = await makeRepo();
    await writeFile(join(dir, 'package.json'), '{}');
    await commitAll(dir);

    const result = await resolveEffectiveMaxConcurrency(
      [editingItem(['src/a/file.ts'])],
      undefined,
      { workspaceDir: dir, concurrencyThreshold: DEFAULT_RISK_CONCURRENCY_THRESHOLD },
    );
    expect(result).toBeUndefined();
  });
});
