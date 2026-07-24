import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER } from "../src/tui.ts";
import { countInBuffer, createHarness } from "./harness.ts";

// Case 06 — rows written to the wrong screen position after a pinned shrink.
//
// Symptom: after the transcript shrank while the viewport stayed pinned,
// subsequent updates landed on the wrong screen rows: lines duplicated or
// misplaced a couple of rows below where they belonged.
//
// Root cause (invariant 3, cursor bookkeeping sync): extractCursorPosition
// scans the bottom `height` rows of the content, but a pinned repaint
// paints `pinnedTop..pinnedTop+height-1` — a higher window. A cursor
// marker in the gap between the two (e.g. a tall input editor poking above
// the pinned window) made positionHardwareCursor record hardwareCursorRow
// on an invisible logical row while the real cursor clamped at the screen
// top. The next differential frame computed its relative move from the
// desynced value and wrote to the wrong rows. Found by review on #1353.
//
// Fixed on #1353: the cursor is only positioned when the marker row is
// inside the visible window; otherwise it is hidden and the bookkeeping
// stays on the real cursor row.

describe("e2e case06: pinned repaint must keep cursor bookkeeping in sync", () => {
	it("places the next differential update on the correct screen row", async () => {
		// 60 lines at height 10 -> anchor 50; cursor marker at the bottom.
		const h = await createHarness(
			[...Array.from({ length: 59 }, (_, i) => `old-${i}`), `[INPUT]${CURSOR_MARKER}`],
			{ rows: 10 },
		);

		// Shrink 60 -> 56 with everything shifted (change above the
		// viewport). Under the legacy engine this pinned the window at the
		// stale anchor (row 50), which is what triggered the original #1353
		// cursor-bookkeeping desync (a cursor marker landing between the
		// scan window and the pinned window). The ledger engine recomputes
		// windowTop = max(committedRows, frameLength - height) fresh every
		// frame instead of pinning to a stale anchor, so it doesn't have
		// that class of desync -- windowTop lands at 56 - 10 = 46 here, not
		// 50. Assert against the engine's actual window rather than
		// hardcoding the legacy pinned-window offset.
		const pinned = Array.from({ length: 56 }, (_, i) => (i === 48 ? `new-48${CURSOR_MARKER}` : `new-${i}`));
		await h.frame(pinned);
		const windowTop = 56 - 10;
		const changedScreenRow = 55 - windowTop;

		// Next frame changes row 55.
		const next = pinned.map((line, i) => (i === 55 ? "new-55 CHANGED" : line));
		await h.frame(next);

		const viewport = h.terminal.getViewport();
		assert.ok(
			viewport[changedScreenRow]!.includes("new-55 CHANGED"),
			`row 55 must render on screen row ${changedScreenRow}, got: ${JSON.stringify(viewport)}`,
		);
		assert.strictEqual(
			countInBuffer(viewport, "new-55"),
			1,
			"the changed row must not be duplicated onto another screen row",
		);

		h.stop();
	});
});
