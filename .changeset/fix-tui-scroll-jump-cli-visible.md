---
"@moonshot-ai/kimi-code": patch
---

Fix the TUI transcript scrollback repeatedly clearing itself (interrupting mouse-wheel scroll-back) during long conversations with an active background task, caused by the background-task status ticker forcing a full redraw every second.
