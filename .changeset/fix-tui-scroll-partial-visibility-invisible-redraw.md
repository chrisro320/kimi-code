---
"@moonshot-ai/pi-tui": patch
---

When a change spans the viewport boundary with the buffer length unchanged (part of the edit is above the viewport and invisible, part is inside it and visible — e.g. a background-task ticker and a footer tip rotation landing in the same frame), clamp the render start to the viewport top and repaint only the visible tail instead of forcing a destructive `fullRender(true)`. Buffer-length changes (lines inserted or removed) still fall back to a full redraw, since the previous viewport position can no longer be trusted to describe what's on screen.
