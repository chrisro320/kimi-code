import type { AssetBomItem, AssetCategory } from './types';

export const REQUIRED_GAME_ASSET_CATEGORIES = [
  '2d',
  'ui',
  'icon',
  'font',
  '3d',
  'texture',
  'material',
  'animation',
  'vfx',
  'video',
  'music',
  'ambience',
  'sfx',
  'voice',
] as const satisfies readonly AssetCategory[];

export interface AssetBomValidation {
  readonly complete: boolean;
  readonly missingCategories: readonly AssetCategory[];
  readonly issues: readonly string[];
}

export function validateAssetBom(bom: readonly AssetBomItem[]): AssetBomValidation {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const item of bom) {
    if (item.id.trim().length === 0) issues.push('BOM item id cannot be empty.');
    if (seenIds.has(item.id)) issues.push(`Duplicate BOM item id: ${item.id}.`);
    seenIds.add(item.id);
    if (item.quantity < 1 || !Number.isInteger(item.quantity)) {
      issues.push(`BOM item ${item.id} requires a positive integer quantity.`);
    }
    if (item.targetPath.startsWith('/') || item.targetPath.includes('..') || item.targetPath.includes('\\')) {
      issues.push(`BOM item ${item.id} has an unsafe target path.`);
    }
    if (item.acceptanceRubric.length === 0 || item.acceptanceRubric.some((entry) => entry.trim().length === 0)) {
      issues.push(`BOM item ${item.id} requires a non-empty acceptance rubric.`);
    }
    if (item.budget !== undefined && (!Number.isFinite(item.budget.max) || item.budget.max < 0)) {
      issues.push(`BOM item ${item.id} has an invalid budget.`);
    }
  }
  const categories = new Set(bom.map((item) => item.category));
  const missingCategories = REQUIRED_GAME_ASSET_CATEGORIES.filter((category) => !categories.has(category));
  return {
    complete: issues.length === 0 && missingCategories.length === 0,
    missingCategories,
    issues,
  };
}

/** Keep the complete project BOM as source of truth while selecting one execution milestone. */
export function selectAssetBomMilestone(
  bom: readonly AssetBomItem[],
  milestone?: string,
): readonly AssetBomItem[] {
  if (milestone === undefined) return [...bom];
  const selected = bom.filter((item) => item.milestone === milestone);
  if (selected.length === 0) throw new Error(`Asset pipeline milestone "${milestone}" has no BOM items.`);
  return selected;
}
