import assert from "node:assert";
import { describe, it } from "node:test";
import { highlightByColumn, textByColumn, visibleWidth } from "../src/utils.ts";

describe("text selection utilities", () => {
	it("extracts styled CJK and ZWJ text without escape bytes", () => {
		const line = "\x1b[31m甲乙\x1b[0m A👩‍💻B";
		assert.strictEqual(textByColumn(line, 2, 5), "乙 A👩‍💻");
		assert.strictEqual(textByColumn(line, 7, 1), "👩‍💻");
	});

	it("highlights complete graphemes without changing visible width", () => {
		const line = "甲A👩‍💻B";
		const highlighted = highlightByColumn(line, 2, 3);
		assert.strictEqual(visibleWidth(highlighted), visibleWidth(line));
		assert.ok(highlighted.includes("\x1b[7mA👩‍💻\x1b[27m"));
	});

	it("reapplies selection inverse after ANSI reset and inverse-off codes", () => {
		const line = "A\x1b[31mB\x1b[0mC\x1b[7mD\x1b[27mE";
		const highlighted = highlightByColumn(line, 0, 5);
		assert.strictEqual(visibleWidth(highlighted), 5);
		assert.ok(highlighted.includes("B\x1b[0m\x1b[7mC"), "SGR reset must not end the visible selection");
		assert.ok(highlighted.includes("D\x1b[27m\x1b[7mE"), "inverse-off must not end the visible selection");
		assert.ok(highlighted.endsWith("\x1b[27m"), "the selection wrapper must still close inverse at the range end");
	});
});
