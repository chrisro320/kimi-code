---
"@moonshot-ai/kimi-code": patch
---

Fix the TUI transcript scrollback still clearing itself during long conversations with an active background task, when a periodic UI update (e.g. the footer's rotating tip) lands in the same frame as the background-task ticker. The ticker's invisible edit combined with a visible footer edit was misclassified as "not fully invisible," forcing a full redraw and interrupting mouse-wheel scroll-back.
