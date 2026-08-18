---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/agent-core-v2": minor
---

Add `--acp-context` to start a session under the ACP context manager without touching the config file. `/acp enable` writes the machine-wide `contextManager` section, so it turns ACP on for every other session too and outlives the process; the flag instead sets an agent-scoped override that is read ahead of the config section and never persisted. Conflicts with `--lean` at parse time. Named `--acp-context` because `kimi acp` already runs the Agent Client Protocol stdio server.
