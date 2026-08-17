Restore the original content of a compressed block.

`blockId` is a block ref like "b3" (see acp_status or search_context). `full: false` restores one tier — nested summaries stay folded; `full: true` recursively restores all tiers.

The result carries only confirmation information (block id and item count); the restored originals rejoin your context view on the next request, not in this return. The mutation is persisted before this call returns.
