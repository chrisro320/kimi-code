---
"@moonshot-ai/agent-core": patch
---

Recover compaction when a text-only provider rejects media parts outright: a `400 unknown variant 'image_url'` response (a provider whose content-part schema has no media variant at all) now takes the same strip-and-retry path as a poisoned image, instead of cancelling the fold.
