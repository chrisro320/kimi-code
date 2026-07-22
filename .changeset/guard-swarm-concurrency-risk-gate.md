---
"@moonshot-ai/kimi-code": patch
---

Automatically run a parallel editing dispatch one item at a time instead of concurrently when the batch looks risky (uncommitted changes in the shared scope, a large number of concurrent editors, or editors touching the same package).
