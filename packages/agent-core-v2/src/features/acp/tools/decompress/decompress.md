Restore the original content of a compressed block.

`blockId` is a block ref like "b3" (see acp_status or search_context). `full: false` restores one tier — nested summaries stay folded; `full: true` recursively restores all tiers.

Restored content is returned here and rejoins your context view on the next request. The mutation is persisted before this call returns.
