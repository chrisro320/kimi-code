# pi-tui Agent Guide

`packages/pi-tui` is a vendored copy of pi-tui from the upstream pi-mono project, as re-vendored by the MoonshotAI kimi-code upstream. Since the 0.36.0 merge the package follows the upstream dual-renderer architecture (`src/tui-alt-screen.ts` fullscreen, `src/tui-main-screen.ts` normal mode, shared `src/tui.ts` base). The fork's former ledger engine (`src/ledger/`), its own fullscreen/selection/cursor patches, and the app-side mouse wiring (`terminal-mouse.ts`, `editor-mouse-position.ts`) were retired wholesale in that merge — upstream either absorbed the fix or replaced the layer. The only remaining divergences are listed below.

## Local divergences from upstream (must be preserved on every re-vendor)

Never overwrite this directory wholesale when syncing from upstream. Each of the following local fixes must be re-verified after a sync; all of them are guarded by tests:

1. **`src/components/editor.ts` — mouse click-to-position and drag text selection**: the editor owns a selection anchor (`selectionAnchor`, cursor is the focus) with `placeCursorAtComponentRow` / `beginSelectionAtComponentRow` / `extendSelectionToComponentRow` / `getSelectedText` / `clearSelection`, resolved through the recorded layout (shared `resolveComponentPosition`; component row 0 is the top border). Drags clamp to the text edges instead of being rejected like clicks; presses on a border row are refused. Rows inside the normalized range paint the selected slice in inverse video (`7m`/`27m`) and suppress the fake cursor, while the hardware-cursor marker still goes out for IME positioning. Any keyboard input or `setTextInternal` drops the anchor. This exists because managed mouse reporting disables the terminal's native selection everywhere — including the input box — so the app must provide it. Guarding tests: the "Mouse text selection" group in `test/editor.test.ts`.
2. **`src/layout.ts` — `getComponentBox(frame, component)`**: walks the laid-out frame (mirroring `getScrollViewBox`) and returns the screen rect of an arbitrary component. This is how the alt-screen renderer maps SGR mouse coordinates onto the editor's dock box. Guarding tests: exercised through the "editor mouse target" group in `test/tui-alt-screen.test.ts`.
3. **`src/tui-alt-screen.ts` — `mouseEditor` target (`TuiAltScreenMouseEditorTarget`, `setMouseEditorTarget`, `handleEditorMouseEvent`)**: routes press/drag/release landing on the editor's layout box to the editor's buffer-level API (divergence 1): a press places the cursor and anchors a selection, a drag extends it (freezing while the pointer is outside the box), and a release copies the selected text via OSC 52 with a "Copied!" flash. Editor-box events are consumed before screen-level transcript selection sees them; a press outside the box falls back to screen-level selection. `editorMouseSelecting` resets on focus-out. The type is re-exported from `src/index.ts`; the app-side wiring (`KIMI_TUI_NO_MOUSE=1` escape hatch, gutter `columnInset`) lives in `apps/kimi-code/src/tui/tui-state.ts`. Guarding tests: the "editor mouse target" group in `test/tui-alt-screen.test.ts`.

## Retired in the 0.36.0 merge (do not resurrect)

- **Ledger engine and its divergences** (old #6–#8, #10–#12: external-output resync, ED3-on-geometry-rebuild, in-place short-frame repaint, fullscreen virtual surface, app-owned transcript selection, one visible cursor) — upstream replaced the whole rendering layer; `src/ledger/` was deleted.
- **Restart-safe capability probes** (old #13) — absorbed upstream (`src/terminal-probe.ts`).
- **Narrow-width/negative-width guards and processed-line reuse** (old #1–#5) — absorbed upstream (`wordWrapLine` recursion guard, `Container.render` width clamp, overwide truncation, repeat clamps) or obsoleted by the renderer rewrite.
- **`wordWrapLine`/`TextChunk` index exports** (old #9) — only existed for `editor-mouse-position.ts`, which was retired with the app-side mouse wiring; `wordWrapLine` remains exported from `components/editor.ts` itself for tests.

## Acceptance after syncing from upstream

- `pnpm --filter @moonshot-ai/pi-tui test` must pass in full; any failure among the guarding tests above means a local divergence was overwritten and lost.

## Testing

- This package's tests run with `node --test` (`pnpm --filter @moonshot-ai/pi-tui test`), not vitest; the root `vitest run` does not execute them — CI covers them through the dedicated `test-pi-tui` job in `.github/workflows/ci.yml`.
- Prefer adding new narrow-width tests to the existing test file of the corresponding component.
