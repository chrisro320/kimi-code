/**
 * `contextProjector` domain — target-aware model-history projection.
 *
 * Walks the stored history and decides, per compaction-summary message,
 * whether the outgoing request should carry the readable summary text or the
 * opaque remote-compaction checkpoint bound to its `origin`. A checkpoint is
 * emitted IN PLACE of its summary (the summary already sits after the
 * retained messages, so the checkpoint keeps that exact slot — ordering never
 * moves) and only when the target BOTH supports checkpoint replay AND owns
 * the checkpoint's lineage (`sameOrigin`). Otherwise the summary degrades to
 * its portable text form via `toWireMessage`, which picks only wire-facing
 * fields and can never leak `origin` — the sentinel test pins this.
 */

import {
  sameOrigin,
  type CheckpointTarget,
  type ModelHistoryItem,
} from '#/kosong/contract/compaction';
import type { ContextMessage } from '#/agent/contextMemory/types';

import { toWireMessage } from './contextProjectorService';

// The item/target types live in `kosong/contract/compaction` so the kosong
// compaction request can share them; re-exported here for the projector's
// existing consumers.
export type { CheckpointTarget, ModelHistoryItem };

/**
 * Project stored history into model-facing items. `target` is REQUIRED — a
 * caller that has not resolved the endpoint's capability and lineage must not
 * accidentally get checkpoint replay by omission.
 */
export function projectModelHistory(
  messages: readonly ContextMessage[],
  target: CheckpointTarget,
): ModelHistoryItem[] {
  const items: ModelHistoryItem[] = [];
  for (const message of messages) {
    const checkpoint =
      message.origin?.kind === 'compaction_summary' ? message.origin.checkpoint : undefined;
    if (
      checkpoint !== undefined &&
      target.supportsCheckpointReplay &&
      sameOrigin(target.lineage, checkpoint.lineage)
    ) {
      // `target.lineage` narrows off the discriminant above — an
      // unsupported target carries no lineage to consult.
      items.push({ kind: 'checkpoint', checkpoint });
    } else {
      items.push({ kind: 'message', message: toWireMessage(message, [...message.content]) });
    }
  }
  return items;
}
