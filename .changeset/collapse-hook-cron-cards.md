---
"@moonshot-ai/kimi-code": patch
---

Collapse hook-result and scheduled-reminder cards behind Ctrl+O so the transcript keeps only their header, and tighten the shared command/diff preview cap from 10 lines to 3. Hook payloads and cron prompts are model-facing text, so a long keepalive prompt or a multi-paragraph `UserPromptSubmit` policy block no longer floods the transcript; both card types now participate in the same expansion sweep as thinking and tool output.
