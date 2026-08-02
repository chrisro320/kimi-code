---
"@moonshot-ai/kosong": patch
---

Fix remote-compaction prompt-cache misses on the Responses compact endpoint: the fold request now mirrors the loop's `reasoning` field (measured 0% cached without it, 99%+ with it on real 118k/189k folds) and strips `deferred` tools the same way `generate()` does (one extra top-level tool dropped cached_tokens to 0).
