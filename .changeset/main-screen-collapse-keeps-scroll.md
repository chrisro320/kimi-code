---
"@moonshot-ai/pi-tui": patch
---

Keep the reader's scroll position when the transcript collapses in normal (non-fullscreen) mode. A collapse whose changed lines all sit above the viewport fell back to a full redraw, which clears scrollback with ED3 — and on terminals affected by microsoft/Terminal#20370 that snaps a user who is scrolled up reading history back to the top of the buffer. Those rows are read-only once they scroll off, so the renderer now repaints only the live screen area and lets scrollback keep its stale copy. Also revives the six e2e rendering regression cases, whose harness had imported a `TUI` export that the dual-renderer split removed, and runs them as part of the package's `test` script.
