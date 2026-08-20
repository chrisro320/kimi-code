---
"@moonshot-ai/agent-core-v2": patch
---

Automatically retry when Gemini ends a turn normally but returns no content, instead of failing the request with an empty-response error; the turn only fails after the retry budget is exhausted.
