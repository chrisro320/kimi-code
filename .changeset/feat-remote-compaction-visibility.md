---
"@moonshot-ai/agent-core": patch
---

Trace remote compaction requests on the wire (`llm.request` with `kind: "remote_compaction"`, distinct from the local summarizer's `"compaction"`) and warn when a remote fold's cache hit falls far below the same fold's summarizer, so a silent remote cache miss is diagnosable from the log.
