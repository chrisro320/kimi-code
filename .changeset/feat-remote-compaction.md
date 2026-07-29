---
"@moonshot-ai/kimi-code": minor
---

Add provider-side conversation compaction: on models that support it, a fold now keeps the model's own reasoning and tool state through a provider checkpoint instead of a text summary, and falls back to the text summary whenever the provider cannot deliver one. Enable it per model by adding `remote_compaction` to that model's `capabilities` in `config.toml`.
