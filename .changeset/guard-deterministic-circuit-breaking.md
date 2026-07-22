---
"@moonshot-ai/kimi-code": patch
---

Avoid repeating a tool call that already failed for a path-shape reason that cannot change (e.g. the target is a directory, or does not exist), and automatically retry a subagent dispatch through a configured backup model when its route fails for a non-retryable reason.
