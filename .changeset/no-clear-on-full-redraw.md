---
"@moonshot-ai/pi-tui": patch
---

Stop clearing the screen before a fullscreen full redraw. The repaint rewrites every row with its own erase-line, so the leading `ED2` could not change the resulting frame — but a terminal that ignores synchronized output (DECSET 2026) presents the clear on its own, flashing an empty viewport before the repaint arrives. Resizing the terminal forces a full redraw, so any host that resizes on pane switch made the flash easy to hit.
