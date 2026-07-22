---
"@moonshot-ai/pi-tui": patch
---

Skip a full redraw (which clears terminal scrollback) when every changed line is above the current viewport and therefore invisible — for example a background-task status ticker rewriting an already-scrolled-past line. Previously any such invisible change forced `fullRender(true)`, which cleared and reprinted the entire transcript on every tick, interrupting the user's mouse-wheel scroll-back.
