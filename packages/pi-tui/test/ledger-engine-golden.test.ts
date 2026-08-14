import assert from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTerminalCapabilities } from "../src/terminal-capabilities.ts";
import type { ProbeResult } from "../src/terminal-probe.ts";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { LoggingVirtualTerminal } from "./virtual-terminal.ts";

const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
const SYNC_OUTPUT_END = "\x1b[?2026l";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/**
 * A LoggingVirtualTerminal that exposes the mutable, probe-backed capabilities
 * and a controllable `probeReady` promise, mirroring ProcessTerminal. Resolving
 * the probe applies the result to the shared capabilities first, so the TUI's
 * probe-refresh re-reads the probed values — the same ordering ProcessTerminal
 * guarantees.
 */
class ProbeVirtualTerminal extends LoggingVirtualTerminal {
	readonly terminalCapabilities: ProcessTerminalCapabilities;
	readonly probeReady: Promise<ProbeResult>;
	private resolveProbe: (result: ProbeResult) => void = () => {};

	constructor(columns: number, rows: number, env: NodeJS.ProcessEnv) {
		super(columns, rows);
		this.terminalCapabilities = new ProcessTerminalCapabilities(env);
		this.probeReady = new Promise<ProbeResult>((resolve) => {
			this.resolveProbe = resolve;
		});
	}

	resolveProbeResult(result: ProbeResult): void {
		this.terminalCapabilities.applyProbe(result);
		this.resolveProbe(result);
	}
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prev = process.env["PI_TUI_ENGINE"];
	process.env["PI_TUI_ENGINE"] = "ledger";
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prev;
	}
}

/**
 * Forces the non-multiplexer, non-Warp path: `geometryRebuild` requires
 * `!resizeRepaintsInPlace()`, and the scrollback-clearing gate reads
 * `isMultiplexerSession()`. Both consult `process.env` at call time, so a
 * developer running the suite inside tmux would otherwise skip the branch
 * entirely and see the assertions pass for the wrong reason.
 */
async function withoutMultiplexer<T>(run: () => Promise<T>): Promise<T> {
	const keys = ["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TERM", "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"];
	const prev = new Map(keys.map((k) => [k, process.env[k]]));
	for (const k of keys) delete process.env[k];
	process.env["TERM"] = "xterm-256color";
	try {
		return await run();
	} finally {
		for (const [k, v] of prev) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe("ledger engine golden", () => {
	it("owns a fullscreen alternate-screen lifetime", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal, undefined, { fullscreen: true });
			const c = new TestComponent();
			c.lines = ["Hello", "World"];
			tui.addChild(c);

			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getWrites().includes("\x1b[?1049h"), "fullscreen start must enter the alternate screen");

			terminal.clearWrites();
			tui.stop();
			assert.ok(terminal.getWrites().includes("\x1b[?1049l"), "fullscreen stop must leave the alternate screen");
		});
	});

	it("repaints the viewport after restarting the same fullscreen instance", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal, undefined, { fullscreen: true });
			const c = new TestComponent();
			c.lines = ["A", "B", "C"];
			tui.addChild(c);

			tui.start();
			await terminal.waitForRender();
			assert.deepStrictEqual(terminal.getViewport().slice(0, 3), c.lines);
			tui.stop();

			terminal.clearWrites();
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getWrites().includes("\x1b[?1049h"));
			assert.deepStrictEqual(terminal.getViewport().slice(0, 3), c.lines);
			tui.stop();
		});
	});

	it("forces the ledger engine for fullscreen even when legacy is requested", async () => {
		const previousEngine = process.env["PI_TUI_ENGINE"];
		process.env["PI_TUI_ENGINE"] = "legacy";
		try {
			const terminal = new LoggingVirtualTerminal(40, 4, 100);
			const tui = new TUI(terminal, undefined, { fullscreen: true });
			const c = new TestComponent();
			c.lines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
			tui.addChild(c);

			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getWrites().includes("\x1b[?1049h"), "fullscreen must not accept legacy fallback");
			assert.strictEqual(terminal.getScrollbackLength(), 0, "fullscreen must not populate native scrollback");
			assert.strictEqual(tui.scrollViewportBy(3), true, "managed scrolling must remain available");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportScrollState.offset, 3);
			assert.strictEqual(terminal.getScrollbackLength(), 0, "scroll repaint must stay inside one viewport");
			tui.stop();
		} finally {
			if (previousEngine === undefined) delete process.env["PI_TUI_ENGINE"];
			else process.env["PI_TUI_ENGINE"] = previousEngine;
		}
	});

	it("renders basic content", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello", "World"];
			tui.start();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("Hello"));
			assert.ok(v[1]?.includes("World"));
			tui.stop();
		});
	});

	it("renders exactly one cursor in hardware and software modes", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal, false);
			const c = new TestComponent();
			c.lines = [`before${CURSOR_MARKER}\x1b[7mX\x1b[0m`];
			tui.addChild(c);
			tui.start();
			await terminal.waitForRender();

			assert.ok(!terminal.getWrites().includes("\x1b[?25h"), "software mode must keep the hardware cursor hidden");
			assert.ok(terminal.getWrites().includes("\x1b[7m"), "software mode must retain the reverse-video cursor");

			tui.setShowHardwareCursor(true);
			terminal.clearWrites();
			c.lines = [`after${CURSOR_MARKER}\x1b[7mY\x1b[0m`];
			tui.requestRender();
			await terminal.waitForRender();
			const hardwarePaint = terminal.getWrites();
			assert.ok(hardwarePaint.includes("\x1b[?25h"), "hardware mode must show the terminal cursor");
			assert.ok(!hardwarePaint.includes("\x1b[7m"), "hardware mode must remove the reverse-video software cursor");
			assert.ok(terminal.getViewport()[0]?.includes("afterY"), "removing the software cursor must preserve its text");
			tui.stop();
		});
	});

	it("gives a focused overlay sole ownership of the hardware cursor", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui = new TUI(terminal, true, { fullscreen: true });
			const c = new TestComponent();
			c.lines = ["base"];
			tui.addChild(c);
			const overlay: Component & { focused: boolean } = {
				focused: false,
				render: () => [`dialog:${CURSOR_MARKER}\x1b[7mX\x1b[0m`],
				invalidate: () => {},
			};
			tui.showOverlay(overlay, { row: 3, col: 4, width: 12 });
			assert.strictEqual(overlay.focused, true, "capturing overlay must own focus");

			tui.start();
			await terminal.waitForRender();

			const paint = terminal.getWrites();
			assert.ok(!paint.includes(CURSOR_MARKER), "overlay cursor marker must not reach the terminal");
			assert.ok(!paint.includes("\x1b[7m"), "hardware mode must remove the overlay's software cursor");
			assert.ok(paint.includes("\x1b[?25h"), "focused overlay must show the hardware cursor");
			assert.deepStrictEqual(terminal.getCursorPosition(), { x: 11, y: 3 });
			assert.ok(terminal.getViewport()[3]?.includes("dialog:X"));
			tui.stop();
		});
	});

	it("resynchronizes the ledger after notified external output", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 6);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["content-0", "content-1", "content-2"];
			tui.start();
			await terminal.waitForRender();

			const redrawsBeforeExternalOutput = tui.fullRedraws;
			terminal.clearWrites();
			terminal.write("[external] Error: boom\r\n    at first\r\n    at second");
			await terminal.flush();
			tui.notifyExternalOutput();
			await terminal.waitForRender();

			assert.deepStrictEqual(terminal.getViewport().slice(0, 3), c.lines);
			assert.ok(tui.fullRedraws > redrawsBeforeExternalOutput, "external output must trigger a full repaint");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "external-output repaint must preserve scrollback");
			tui.stop();
		});
	});

	/**
	 * ED3 erases saved lines, so it destroys whatever history the user had
	 * scrolled back to read. The property under test is that `geometryRebuild`
	 * is the *only* condition that may emit it: a reflow genuinely invalidates
	 * the saved lines, every other forced repaint does not. The resize-settle
	 * repaint is the case that matters in practice — it runs 120ms after the
	 * geometry has already stabilised, so it repaints with `geometryRebuild`
	 * false and used to clear scrollback purely because `replaceRequested` was
	 * set.
	 */
	it("clears scrollback only on geometry rebuild, not on later forced repaints", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = ["content-0", "content-1", "content-2"];
				tui.start();
				await terminal.waitForRender();

				// Forced repaint at unchanged geometry: nothing invalidated the saved
				// lines, so this repaint has no claim on the user's history.
				terminal.clearWrites();
				tui.requestRender(true);
				await terminal.waitForRender();
				assert.ok(
					!terminal.getWrites().includes("\x1b[3J"),
					"a forced repaint at unchanged geometry must preserve scrollback",
				);

				// Geometry rebuild: the reflow invalidates every saved line, so ED3 is
				// correct here. The repaint lands on the resize settle, not on the
				// resize event itself.
				terminal.clearWrites();
				terminal.resize(50, 10);
				await delay(250); // > LedgerTuiEngine.#RESIZE_SETTLE_MS (120)
				await terminal.flush();
				assert.ok(
					terminal.getWrites().includes("\x1b[3J"),
					"a geometry rebuild must still clear scrollback",
				);

				tui.stop();
			});
		});
	});

	/**
	 * A full paint writes `height` rows unconditionally — a short frame is padded
	 * with blank rows — and then parks the cursor back up at the content bottom
	 * (`parkUp`), so the input line sits directly under the transcript rather than
	 * at the screen bottom. Those blank rows below the cursor are what a user sees
	 * as "the bottom of the screen went empty" after a forced repaint; ordinary
	 * differential updates never clear the screen and so never show it.
	 *
	 * This pins the current behaviour. Changing where the cursor parks, or padding
	 * differently, should be a deliberate decision that updates this test.
	 */
	it("pads a short frame to full height and parks the cursor at the content bottom", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = ["content-0", "content-1", "content-2"];
				tui.start();
				await terminal.waitForRender();

				const viewport = terminal.getViewport();
				assert.deepStrictEqual(viewport.slice(0, 3), c.lines);
				assert.deepStrictEqual(
					viewport.slice(3).map((row) => row.trim()),
					new Array(7).fill(""),
					"rows below the content must be blank",
				);
				assert.strictEqual(
					terminal.getCursorPosition().y,
					2,
					"the cursor parks on the last content row, not at the screen bottom",
				);

				tui.stop();
			});
		});
	});

	/**
	 * The counterpart to the test above: when the frame is longer than the screen,
	 * a forced repaint must fill every row. If this one shows blank rows at the
	 * bottom, "the bottom of the screen went empty" is a real defect rather than
	 * the short-frame padding behaviour.
	 */
	it("fills the whole screen on a forced repaint when the frame is longer than the viewport", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = Array.from({ length: 30 }, (_, i) => `content-${i}`);
				tui.start();
				await terminal.waitForRender();

				tui.requestRender(true);
				await terminal.waitForRender();

				const viewport = terminal.getViewport();
				const blank = viewport.filter((row) => row.trim() === "").length;
				assert.strictEqual(
					blank,
					0,
					`a forced repaint with a 30-row frame left ${blank} blank row(s): ${JSON.stringify(viewport)}`,
				);

				tui.stop();
			});
		});
	});


	/**
	 * Regression: the scroll position must be an absolute frame row, not a
	 * distance from the bottom. Streaming output grows the frame every token; a
	 * relative offset would slide the view downward each time and the content
	 * being read would drift away — which is exactly what "it still scrolls while
	 * the model is thinking" looks like.
	 */
	it("holds the scrolled position while new content streams in", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 5);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
				tui.start();
				await terminal.waitForRender();

				tui.scrollViewportBy(5);
				await terminal.waitForRender();
				const before = terminal.getViewport();
				assert.ok(before.at(-1)?.includes("line-14"), `expected line-14 at the bottom, got ${JSON.stringify(before)}`);

				// Ten more rows stream in while the user is reading history.
				c.lines = [...c.lines, ...Array.from({ length: 10 }, (_, i) => `new-${i}`)];
				tui.requestRender();
				await terminal.waitForRender();

				assert.deepStrictEqual(
					terminal.getViewport(),
					before,
					"streaming output must not move a scrolled-back view",
				);

				// Returning to the bottom shows the newest content.
				tui.resetViewportScroll();
				await terminal.waitForRender();
				assert.ok(terminal.getViewport().at(-1)?.includes("new-9"), "reset must land on the newest row");

				tui.stop();
			});
		});
	});

	/**
	 * An input line that scrolls out of view is unusable, so pinned components
	 * keep showing their own rows while everything above them scrolls.
	 */
	it("keeps pinned components at the bottom while scrolled back", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 6);
				const tui = new TUI(terminal, true);
				const transcript = new TestComponent();
				const editor = new TestComponent();
				const footer = new TestComponent();
				transcript.lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
				editor.lines = [`> prompt${CURSOR_MARKER}`];
				footer.lines = ["status"];
				tui.addChild(transcript);
				tui.addChild(editor);
				tui.addChild(footer);
				tui.setPinnedBottomComponents([editor, footer]);
				tui.start();
				await terminal.waitForRender();

				assert.deepStrictEqual(terminal.getViewport().slice(-2), ["> prompt", "status"], "before scrolling");

				tui.scrollViewportBy(6);
				await terminal.waitForRender();

				const viewport = terminal.getViewport();
				assert.deepStrictEqual(
					viewport.slice(-2),
					["> prompt", "status"],
					`pinned rows must survive scrolling, got ${JSON.stringify(viewport)}`,
				);
				// The rows above them show history, not the frame tail.
				assert.ok(viewport[0]?.includes("line-"), "the scrolling region must show transcript rows");
				assert.ok(
					!viewport.slice(0, -2).some((row) => row.includes("prompt") || row.includes("status")),
					"pinned content must not also appear in the scrolling region",
				);
				assert.deepStrictEqual(
					tui.hitTestScreenRow(4),
					{ component: editor, rowWithinComponent: 0 },
					"the editor's pinned screen row must hit the editor, not the historical frame row",
				);
				assert.deepStrictEqual(
					tui.hitTestScreenRow(5),
					{ component: footer, rowWithinComponent: 0 },
					"the footer's pinned screen row must hit the footer",
				);
				assert.deepStrictEqual(
					terminal.getCursorPosition(),
					{ x: 8, y: 4 },
					"the hardware cursor must follow the editor's pinned screen row",
				);

				assert.strictEqual(tui.beginTextSelection(3, 0), true);
				assert.strictEqual(tui.updateTextSelection(4, 4), true);
				assert.strictEqual(
					tui.selectedText,
					"line",
					"dragging into pinned editor rows must stop at the visible transcript edge",
				);

				tui.stop();
			});
		});
	});

	/**
	 * Mouse hit testing. Components render rows without knowing where they land,
	 * so the frame segments are the only record of which component owns which
	 * row. The mapping has to follow the scroll offset, or a click while scrolled
	 * back would resolve against the wrong content.
	 */
	it("resolves a screen row to the component that painted it", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui = new TUI(terminal);
				const top = new TestComponent();
				const bottom = new TestComponent();
				top.lines = ["top-0", "top-1"];
				bottom.lines = ["bottom-0", "bottom-1", "bottom-2"];
				tui.addChild(top);
				tui.addChild(bottom);
				tui.start();
				await terminal.waitForRender();

				assert.strictEqual(tui.hitTestScreenRow(0)?.component, top);
				assert.strictEqual(tui.hitTestScreenRow(1)?.rowWithinComponent, 1);
				assert.strictEqual(tui.hitTestScreenRow(2)?.component, bottom);
				assert.strictEqual(tui.hitTestScreenRow(2)?.rowWithinComponent, 0);
				assert.strictEqual(tui.hitTestScreenRow(4)?.rowWithinComponent, 2);
				// Below the last component: padding, owned by nobody.
				assert.strictEqual(tui.hitTestScreenRow(9), undefined);
				assert.strictEqual(tui.hitTestScreenRow(-1), undefined);

				tui.stop();
			});
		});
	});

	/**
	 * User scrollback. Enabling mouse reporting takes the wheel away from the
	 * terminal, so the TUI has to provide the scrolling itself. Only the window
	 * origin moves — `window[r]` still maps to `frame[windowTop + r]` — which is
	 * why the differential paths need no changes: they already handle a moving
	 * `windowTop`.
	 */
	it("scrolls the viewport back through frame history and snaps back on reset", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 5);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
				tui.start();
				await terminal.waitForRender();

				// Bottom-following: the last frame rows are on screen.
				assert.ok(terminal.getViewport().at(-1)?.includes("line-19"), "should start at the bottom");

				assert.strictEqual(tui.scrollViewportBy(3), true, "scrolling back must report a change");
				await terminal.waitForRender();
				assert.ok(
					terminal.getViewport().at(-1)?.includes("line-16"),
					`three rows back should end at line-16, got ${JSON.stringify(terminal.getViewport())}`,
				);
				assert.deepStrictEqual(tui.viewportScrollState, { offset: 3, maxOffset: 15 });
				assert.strictEqual(tui.setViewportScrollOffset(8), true, "thumb drag must set an absolute offset");
				await terminal.waitForRender();
				assert.deepStrictEqual(tui.viewportScrollState, { offset: 8, maxOffset: 15 });
				assert.ok(terminal.getViewport().at(-1)?.includes("line-11"));
				assert.strictEqual(tui.scrollViewportBy(-8), true, "the inverse wheel delta must return to bottom-following");
				await terminal.waitForRender();
				assert.strictEqual(tui.viewportScrollOffset, 0);
				assert.ok(terminal.getViewport().at(-1)?.includes("line-19"), "inverse scrolling must return to the newest row");

				assert.strictEqual(tui.scrollViewportBy(3), true);
				await terminal.waitForRender();
				// Clamped at the top of the frame: 20 rows of frame, 5 of screen.
				assert.strictEqual(tui.scrollViewportBy(999), true);
				await terminal.waitForRender();
				assert.ok(terminal.getViewport()[0]?.includes("line-0"), "should clamp at the first frame row");
				assert.strictEqual(tui.scrollViewportBy(999), false, "further scrolling at the limit is a no-op");

				assert.strictEqual(tui.resetViewportScroll(), true);
				await terminal.waitForRender();
				assert.ok(terminal.getViewport().at(-1)?.includes("line-19"), "reset must resume following");
				assert.strictEqual(tui.resetViewportScroll(), false, "reset when already following is a no-op");

				tui.stop();
			});
		});
	});

	it("selects and highlights fullscreen frame text across ANSI, CJK, ZWJ and rows", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(30, 4);
			const tui = new TUI(terminal, undefined, { fullscreen: true });
			const c = new TestComponent();
			c.lines = ["old", "\x1b[31m甲乙\x1b[0m A👩‍💻B", "second row", "tail"];
			tui.addChild(c);
			tui.start();
			await terminal.waitForRender();

			assert.strictEqual(tui.beginTextSelection(1, 2), true);
			assert.strictEqual(tui.updateTextSelection(2, 6), true);
			await terminal.waitForRender();
			assert.strictEqual(tui.selectedText, "乙 A👩‍💻B\nsecond");
			assert.ok(terminal.getWrites().includes("\x1b[7m"), "selection must be visibly highlighted");

			assert.strictEqual(tui.clearTextSelection(), true);
			assert.strictEqual(tui.selectedText, "");
			tui.stop();
		});
	});

	it("atomically extends a selection across multiple fullscreen viewports", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(30, 5);
			const tui = new TUI(terminal, undefined, { fullscreen: true });
			const c = new TestComponent();
			c.lines = Array.from({ length: 30 }, (_, i) => `row-${String(i).padStart(2, "0")}`);
			tui.addChild(c);
			tui.start();
			await terminal.waitForRender();

			assert.strictEqual(tui.beginTextSelection(4, 6), true);
			for (let i = 0; i < 12; i++) {
				assert.strictEqual(tui.scrollAndUpdateTextSelection(1, 0, 0), true);
			}
			assert.strictEqual(tui.viewportScrollOffset, 12);
			assert.ok(tui.selectedText.startsWith("row-13"));
			assert.ok(tui.selectedText.endsWith("row-29"));
			assert.strictEqual(tui.selectedText.split("\n").length, 17);
			tui.stop();
		});
	});

	it("repaints a scrolled fullscreen window without re-emitting frame history", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(80, 40, 20_000);
				const tui = new TUI(terminal, undefined, { fullscreen: true });
				const c = new TestComponent();
				c.lines = Array.from({ length: 2_000 }, (_, i) => `history-${i}`);
				tui.addChild(c);
				tui.start();
				await terminal.waitForRender();

				const scrollbackBefore = terminal.getScrollbackLength();
				terminal.clearWrites();
				assert.strictEqual(tui.scrollViewportBy(3), true);
				await terminal.waitForRender();

				const writes = terminal.getWrites();
				assert.ok(!writes.includes("history-0"), "scroll repaint must not write rows above the visible window");
				assert.ok(
					writes.split("\n").length - 1 <= terminal.rows,
					`scroll repaint wrote more than one viewport: ${String(writes.split("\n").length - 1)} line feeds`,
				);
				assert.strictEqual(
					terminal.getScrollbackLength(),
					scrollbackBefore,
					"moving the app viewport must not grow terminal scrollback",
				);
				assert.ok(terminal.getViewport().at(-1)?.includes("history-1996"));

				terminal.clearWrites();
				assert.strictEqual(tui.resetViewportScroll(), true);
				await terminal.waitForRender();
				assert.ok(!terminal.getWrites().includes("history-0"), "jumping to bottom must not replay frame history");
				assert.strictEqual(
					terminal.getScrollbackLength(),
					scrollbackBefore,
					"jumping to bottom must not grow terminal scrollback",
				);
				assert.ok(terminal.getViewport().at(-1)?.includes("history-1999"));

				tui.stop();
			});
		});
	});

	it("paints only the current fullscreen window after a batched append", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5, 20_000);
			const tui = new TUI(terminal, true, { fullscreen: true });
			const c = new TestComponent();
			c.lines = Array.from({ length: 20 }, (_, i) => `row-${i}`);
			tui.addChild(c);
			const overlay: Component = { render: () => ["S"], invalidate: () => {} };
			tui.showOverlay(overlay, { anchor: "top-right", width: 1, nonCapturing: true });
			tui.start();
			await terminal.waitForRender();

			terminal.clearWrites();
			c.lines = [...c.lines, ...Array.from({ length: 80 }, (_, i) => `batch-${i}`)];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(!writes.includes("row-15"), "batched append must not replay the previous off-screen seam");
			assert.ok(!writes.includes("batch-0"), "batched append must not replay newly committed off-screen rows");
			assert.ok(writes.includes("batch-79"), "current viewport must include the newest row");
			assert.ok(
				writes.split("\n").length - 1 <= terminal.rows,
				`batched append wrote more than one viewport: ${String(writes.split("\n").length - 1)} line feeds`,
			);
			assert.strictEqual(terminal.getScrollbackLength(), 0);
			tui.stop();
		});
	});

	it("keeps wheel and scrollbar offsets synchronized through 100 fullscreen updates", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(80, 24, 20_000);
			const tui = new TUI(terminal, true, { fullscreen: true });
			const c = new TestComponent();
			c.lines = Array.from({ length: 1_000 }, (_, i) => `stress-${i}`);
			tui.addChild(c);
			tui.start();
			await terminal.waitForRender();

			const terminalHistory = terminal.getScrollbackLength();
			for (let cycle = 0; cycle < 100; cycle++) {
				terminal.clearWrites();
				const offset = cycle % 2 === 0 ? 12 : 3;
				assert.strictEqual(tui.setViewportScrollOffset(offset), true);
				if (cycle % 10 === 0) c.lines.push(`stream-${cycle}`);
				tui.requestRender();
				await terminal.waitForRender();

				const expectedOffset = offset + (cycle % 10 === 0 ? 1 : 0);
				assert.strictEqual(
					tui.viewportScrollState.offset,
					expectedOffset,
					"thumb state must track the anchored viewport, including newly streamed rows",
				);
				const writes = terminal.getWrites();
				assert.ok(!writes.includes("stress-0"), `cycle ${cycle} replayed frame history above the viewport`);
				assert.ok(
					writes.split("\n").length - 1 <= terminal.rows,
					`cycle ${cycle} wrote more than one viewport`,
				);
				assert.strictEqual(
					terminal.getScrollbackLength(),
					terminalHistory,
					`cycle ${cycle} grew native scrollback`,
				);
			}

			assert.strictEqual(tui.resetViewportScroll(), true);
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportScrollState.offset, 0);
			assert.ok(terminal.getViewport().at(-1)?.includes("stream-90"));
			tui.stop();
			assert.ok(terminal.getWrites().includes("\x1b[?1049l"), "stress cleanup must leave fullscreen mode");
		});
	});

	it("composites scrollbar overlays with the frame geometry being painted", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal, true, { fullscreen: true });
			const c = new TestComponent();
			c.lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
			tui.addChild(c);
			const observed: { offset: number; maxOffset: number }[] = [];
			const overlay: Component = {
				render: () => {
					const state = tui.viewportScrollState;
					observed.push(state);
					return [String(state.maxOffset % 10)];
				},
				invalidate: () => {},
			};
			tui.showOverlay(overlay, { anchor: "top-right", width: 1, nonCapturing: true });
			tui.start();
			await terminal.waitForRender();
			assert.deepStrictEqual(observed.at(-1), { offset: 0, maxOffset: 15 });
			assert.strictEqual(terminal.getViewport()[0]?.at(-1), "5");

			c.lines.push("line-20");
			tui.requestRender();
			await terminal.waitForRender();
			assert.deepStrictEqual(observed.at(-1), { offset: 0, maxOffset: 16 }, "append overlay must see the new frame length");
			assert.strictEqual(terminal.getViewport()[0]?.at(-1), "6", "painted overlay must match the appended frame");

			terminal.resize(40, 6);
			await terminal.waitForRender();
			assert.deepStrictEqual(observed.at(-1), { offset: 0, maxOffset: 15 }, "resize overlay must see the new viewport height");
			assert.strictEqual(terminal.getViewport()[0]?.at(-1), "5", "painted overlay must match the resized viewport");
			tui.stop();
		});
	});

	it("commits appended rows and repaints window on streaming append", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["L0", "L1", "L2"];
			tui.start();
			await terminal.waitForRender();
			// append beyond viewport
			for (let i = 3; i < 12; i++) {
				c.lines = [...c.lines, `L${i}`];
				tui.requestRender();
				await terminal.waitForRender();
			}
			const v = terminal.getViewport();
			assert.ok(v.join("\n").includes("L11"), `tail visible: ${v.join("|")}`);
			tui.stop();
		});
	});

	it("clamps over-wide lines instead of throwing", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(10, 4);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["1234567890ABCDEF"];
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("1234567890"));
			c.lines = ["ok"];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("ok"));
			tui.stop();
		});
	});

	it("handles content shrink", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["a", "b", "c", "d"];
			tui.start();
			await terminal.waitForRender();
			c.lines = ["a", "b"];
			tui.requestRender();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("a"));
			assert.ok(v[1]?.includes("b"));
			tui.stop();
		});
	});

	it("parks cursor past content on stop()", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello", "World"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();
			tui.stop();
			const writes = terminal.getWrites();
			// stop() must emit a cursor-parking sequence ending with CRLF so the host
			// shell prompt lands on a fresh line below the painted content (not
			// overwriting it). This regresses the ledger-path exit artifact.
			assert.ok(
				writes.includes("\r\n"),
				`stop() should park cursor with a trailing CRLF; got: ${JSON.stringify(writes)}`,
			);
		});
	});

	it("re-frames the ledger paint with sync markers after a probe reports synchronized output", async () => {
		await withLedger(async () => {
			// Plain "xterm" is not in the static sync-known list, so capabilities
			// start with syncEnabled=false until the probe says otherwise.
			const terminal = new ProbeVirtualTerminal(40, 8, { TERM: "xterm" });
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello"];
			tui.start();
			await terminal.waitForRender();

			const before = terminal.getWrites();
			assert.ok(
				!before.includes(SYNC_OUTPUT_BEGIN),
				`no sync begin before probe resolves: ${JSON.stringify(before)}`,
			);
			assert.ok(
				!before.includes(SYNC_OUTPUT_END),
				`no sync end before probe resolves: ${JSON.stringify(before)}`,
			);

			terminal.clearWrites();
			// Append a line so the post-probe render is a real diff: the ledger engine
			// skips the paint framing entirely when nothing changed between frames.
			c.lines = ["Hello", "Probed"];
			terminal.resolveProbeResult({
				kittyKeyboard: false,
				syncOutput: true,
				inBandResize: undefined,
				appearancePush: undefined,
				background: undefined,
			});
			await terminal.waitForRender();

			const after = terminal.getWrites();
			assert.ok(
				after.includes(SYNC_OUTPUT_BEGIN),
				`sync begin after probe resolves: ${JSON.stringify(after)}`,
			);
			assert.ok(
				after.includes(SYNC_OUTPUT_END),
				`sync end after probe resolves: ${JSON.stringify(after)}`,
			);
			tui.stop();
		});
	});
});
