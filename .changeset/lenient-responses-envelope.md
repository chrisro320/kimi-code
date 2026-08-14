---
"@moonshot-ai/agent-core-v2": patch
---

Tolerate stream events that omit the `response` envelope in the OpenAI Responses provider. `response.created`, `response.in_progress`, `response.completed` and `response.incomplete` required the envelope to be an object, so a gateway that streams the bare event (`{"type":"response.in_progress"}`) failed the whole request with `OpenAI Responses decode error: response.in_progress.response must be an object.` — and because the behaviour is deterministic per gateway, every retry hit the same event. The envelope only carries optional metadata (`id`, `usage`, finish reason) on those events, so they now skip it when absent instead of aborting a stream that is otherwise usable. `response.failed` still throws, since the event itself is the failure signal; only the error details go missing.
