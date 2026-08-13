import assert from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProcessTerminalCapabilities } from "../src/terminal-capabilities.ts";
import type { ProbeResult } from "../src/terminal-probe.ts";
import { type Component, TUI } from "../src/tui.ts";
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

	/**
	 * The fix for the empty band below the input line: a TUI-requested repaint of
	 * a short frame rewrites its own rows in place instead of erasing the screen,
	 * so whatever the terminal holds below those rows survives. `\x1b[2J` is the
	 * thing that used to destroy it, so its absence is the property under test.
	 *
	 * The escape hatches are deliberately narrow — a first paint, a geometry
	 * rebuild, or external output all leave the cursor somewhere this path cannot
	 * reason about, and each still takes the absolute repaint.
	 */
	it("rewrites a short frame in place instead of erasing the screen", async () => {
		await withLedger(async () => {
			await withoutMultiplexer(async () => {
				const terminal = new LoggingVirtualTerminal(40, 10);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = ["content-0", "content-1", "content-2"];
				tui.start();
				await terminal.waitForRender();

				terminal.clearWrites();
				tui.requestRender(true);
				await terminal.waitForRender();

				const writes = terminal.getWrites();
				assert.ok(
					!writes.includes("\x1b[2J"),
					`an in-place repaint must not erase the screen, got: ${JSON.stringify(writes)}`,
				);
				assert.deepStrictEqual(
					terminal.getViewport().slice(0, 3),
					c.lines,
					"the content must still be correct after an in-place repaint",
				);

				tui.stop();
			});
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
