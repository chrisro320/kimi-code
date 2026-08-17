Fold older context ranges into durable summary blocks.

Each entry in `content` cites stable message refs (`startId`/`endId`, e.g. "m00005"–"m00020"). Refs appear in ACP nudge messages; if you have not seen any, run `acp_status` first to list the live refs — never guess them. Compress only consumed, no-longer-needed work; keep recent messages, protected tool interactions, and anything you still need verbatim.

Write the summary for your future self: decisions made, files touched, errors hit, and where to resume — not a narrative. The summary replaces the originals in your context view; originals stay recoverable through decompress.

Pass multiple ranges in one call's `content` array. The mutation is persisted before this call returns; on failure nothing is committed.

A call is rejected when its ranges cover under ~5000 chars of compressible content in total. Widen the range to include more adjacent messages instead of retrying the same one — identical retries always fail again.
