import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KIMI_BUILD_INFO } from '#/cli/build-info';
import {
  createKimiCodeUserAgent,
  getHostPackageJsonPath,
  getHostPackageRoot,
  getVersion,
} from '#/cli/version';

describe('cli version helpers', () => {
  it('resolves the host package manifest near apps/kimi-code and reads its version', () => {
    const pkgPath = getHostPackageJsonPath();
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

    expect(pkgPath.endsWith(join('apps', 'kimi-code', 'package.json'))).toBe(true);
    expect(getHostPackageRoot()).toBe(dirname(pkgPath));
    expect(getVersion()).toBe(pkg.version);
  });

  it('advertises the fork feature provenance used to detect stale wrappers', () => {
    expect(KIMI_BUILD_INFO.features).toEqual([
      'agora',
      'reference-audit',
      'asset-pipeline',
    ]);
  });

  it('builds the product user-agent for ad-hoc fetches', () => {
    expect(createKimiCodeUserAgent('1.2.3')).toBe('kimi-code-cli/1.2.3');
  });
});
