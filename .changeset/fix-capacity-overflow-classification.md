---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core-v2": patch
---

Classify explicit capacity rejections mislabeled with an auth status (e.g. `401 k3-256k supports only 256K context`) as context overflow instead of an auth error, so the session recovers through compaction instead of bricking on every later request.
