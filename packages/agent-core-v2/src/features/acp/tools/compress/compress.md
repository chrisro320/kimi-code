Fold older context ranges into durable summary blocks.

Each entry in `content` cites stable message refs (`startId`/`endId`, e.g. "m00005"–"m00020") shown in `<acp>` tags or ACP nudge messages. Compress only consumed, no-longer-needed work; keep recent messages, protected tool interactions, and anything you still need verbatim.

Write the summary for your future self: decisions made, files touched, errors hit, and where to resume — not a narrative. The summary replaces the originals in your context view; originals stay recoverable through decompress.

Pass multiple ranges in one call's `content` array. The mutation is persisted before this call returns; on failure nothing is committed.
