import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	isSeparatorCode,
	maskTextValue,
	resetTextMaskStateForTesting,
	staticMaskText,
} from "../../src/core/text-mask";

const FW = "＊"; // U+FF0A FULLWIDTH ASTERISK

// Additive per-char width model for the fake canvas. Real fonts have kerning
// and shaping, but an additive model is enough to verify the greedy +
// hill-climb construction converges on the measured target. The * _ # & @
// basis widths mirror the narrow-to-extra-wide spread.
const CHAR_WIDTHS: Record<string, number> = {
	"*": 7,
	_: 9,
	"#": 12,
	"&": 14,
	"@": 16,
	i: 4,
	l: 3,
	t: 5,
	x: 7,
	o: 6,
	e: 7,
	h: 8,
	m: 12,
	w: 11,
	".": 2,
};
const DEFAULT_CHAR_WIDTH = 8;

function fakeWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += CHAR_WIDTHS[char] ?? DEFAULT_CHAR_WIDTH;
	}
	return width;
}

type FakeCtx = {
	font: string;
	measureText: ReturnType<typeof vi.fn>;
};

function installFakeCanvas(): FakeCtx {
	const ctx: FakeCtx = {
		font: "10px sans-serif",
		measureText: vi.fn((text: string) => ({ width: fakeWidth(text) })),
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		ctx as unknown as RenderingContext,
	);
	return ctx;
}

// jsdom's getComputedStyle leaves the font shorthand empty, so the masker
// composes the font from fontSize + fontFamily (the Firefox path).
function elementWithFont(): HTMLElement {
	const el = document.createElement("p");
	el.style.fontSize = "16px";
	el.style.fontFamily = "Arial";
	return el;
}

beforeEach(() => {
	resetTextMaskStateForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("staticMaskText (layer 1)", () => {
	test("maps letters and punctuation uniformly to *", () => {
		expect(staticMaskText("Secret")).toBe("******");
		expect(staticMaskText("will")).toBe("****");
	});

	test("preserves all whitespace verbatim", () => {
		expect(staticMaskText("a b\tc\nd  e")).toBe("* *\t*\n*  *");
	});

	test("masks digits like any other character and preserves hyphens", () => {
		expect(staticMaskText("call 555-1234")).toBe("**** ***-****");
	});

	test("maps CJK graphemes to fullwidth asterisks", () => {
		expect(staticMaskText("日本語のテスト")).toBe(FW.repeat(7));
		expect(staticMaskText("中文文本")).toBe(FW.repeat(4));
	});

	test("maps shared CJK characters (ー ・ 。 、) to fullwidth asterisks", () => {
		// These are Script=Common but Script_Extensions=CJK; a narrow mask
		// for them inside a full-width run shifts line wrapping.
		expect(staticMaskText("サーバー設定。")).toBe(FW.repeat(7));
		expect(staticMaskText("ミドル・ドット、")).toBe(FW.repeat(8));
	});

	test("maps Hangul syllables to fullwidth asterisks", () => {
		// Hangul syllables (U+AC00–D7A3) live in their own block, away from
		// the other CJK scripts — easy to miss with hand-built ranges.
		expect(staticMaskText("한국어")).toBe(FW.repeat(3));
	});

	test("maps a multi-code-point emoji grapheme to a single fullwidth asterisk", () => {
		expect(staticMaskText("👨‍👩‍👧‍👦")).toBe(FW);
		expect(staticMaskText("hi 🎉🎉")).toBe(`** ${FW}${FW}`);
	});

	test("does not split surrogate pairs", () => {
		// One emoji is two UTF-16 code units; per-code-unit masking would
		// produce two glyphs for one rendered character.
		expect(staticMaskText("😀")).toBe(FW);
	});

	test("masks punctuation and unhandled scripts as *", () => {
		expect(staticMaskText("@~%")).toBe("***");
		expect(staticMaskText("привет")).toBe("******");
	});

	test("returns empty string for empty input", () => {
		expect(staticMaskText("")).toBe("");
	});
});

describe("isSeparatorCode", () => {
	test("matches /[\\s-]/ exactly across the entire BMP", () => {
		// The tokenizer classifies separators by charCode (a per-char regex
		// test would allocate a string per character); the whitespace set is
		// enumerated by hand, so pin it against the engine's own /\s/.
		const re = /[\s-]/;
		for (let code = 0; code <= 0xffff; code++) {
			expect(isSeparatorCode(code)).toBe(re.test(String.fromCharCode(code)));
		}
	});
});

describe("maskTextValue (layer 2, measured)", () => {
	test("falls back to static masking when element is null", () => {
		expect(maskTextValue("Secret text", null)).toBe(
			staticMaskText("Secret text"),
		);
	});

	test("falls back to static masking when no canvas 2d context is available", () => {
		// jsdom's default getContext("2d") returns null.
		expect(maskTextValue("Secret text", elementWithFont())).toBe(
			staticMaskText("Secret text"),
		);
	});

	test("falls back to static masking when the font fails to apply", () => {
		const ctx = installFakeCanvas();
		// Simulate canvas rejecting the font string: assignment doesn't take.
		Object.defineProperty(ctx, "font", {
			get: () => "10px serif",
			set: () => {},
		});
		expect(maskTextValue("hello", elementWithFont())).toBe(
			staticMaskText("hello"),
		);
	});

	test("builds placeholders whose measured width matches the original word", () => {
		installFakeCanvas();
		const masked = maskTextValue("hello world", elementWithFont());

		const [maskedHello, maskedWorld] = masked.split(" ");
		// Placeholders are built only from the grawlix basis glyphs.
		expect(maskedHello).toMatch(/^[*_#&@]+$/);
		expect(maskedWorld).toMatch(/^[*_#&@]+$/);
		// Within one narrowest-base width of the target (the hill climb is
		// local, so sub-tolerance exactness isn't guaranteed for every sum).
		expect(Math.abs(fakeWidth(maskedHello) - fakeWidth("hello"))).toBeLessThan(
			CHAR_WIDTHS["*"],
		);
		expect(Math.abs(fakeWidth(maskedWorld) - fakeWidth("world"))).toBeLessThan(
			CHAR_WIDTHS["*"],
		);
	});

	test("matches width exactly when the target is representable", () => {
		installFakeCanvas();
		// "oooo" = 24 = two # glyphs (12 each).
		const masked = maskTextValue("oooo", elementWithFont());
		expect(fakeWidth(masked)).toBe(fakeWidth("oooo"));
	});

	test("preserves whitespace structure between words", () => {
		installFakeCanvas();
		const masked = maskTextValue("one  two\nthree", elementWithFont());
		expect(masked).toMatch(/^[*_#&@]+ {2}[*_#&@]+\n[*_#&@]+$/);
	});

	test("never returns an empty mask for a non-empty word", () => {
		installFakeCanvas();
		// "." (width 2) is narrower than the narrowest base "*" (width 7).
		const masked = maskTextValue(".", elementWithFont());
		expect(masked).not.toBe("");
		expect(masked).toMatch(/^[*_#&@]+$/);
	});

	test("routes CJK words through the static layer", () => {
		installFakeCanvas();
		expect(maskTextValue("日本語", elementWithFont())).toBe(FW.repeat(3));
	});

	test("routes Hangul words through the static layer", () => {
		// Hangul syllables are ~1em wide, so ＊ is a close width match
		// without per-word measurement.
		const ctx = installFakeCanvas();
		expect(maskTextValue("안녕하세요", elementWithFont())).toBe(FW.repeat(5));
		expect(ctx.measureText).not.toHaveBeenCalled();
	});

	test("routes Arabic words through the static layer", () => {
		// Arabic is shaped/cursive; measuring it correctly would need
		// in-script bases. We accept approximate "*" widths instead.
		const ctx = installFakeCanvas();
		expect(maskTextValue("مرحبا", elementWithFont())).toBe("*".repeat(5));
		expect(ctx.measureText).not.toHaveBeenCalled();
	});

	test("routes very long tokens through the static layer without measuring", () => {
		const ctx = installFakeCanvas();
		const token = "A".repeat(5000);
		expect(maskTextValue(token, elementWithFont())).toBe("*".repeat(5000));
		expect(ctx.measureText).not.toHaveBeenCalled();
	});

	test("falls back to static masking when measureText saturates instead of looping forever", () => {
		// Canvas-fingerprinting extensions / broken polyfills can clamp
		// measureText so width stops growing with string length. The greedy
		// fill must bail out via its glyph budget, not spin.
		const ctx = installFakeCanvas();
		ctx.measureText.mockImplementation((text: string) => ({
			width: Math.min(fakeWidth(text), 20),
		}));
		expect(maskTextValue("wwwwwwwwww", elementWithFont())).toBe(
			staticMaskText("wwwwwwwwww"),
		);
	});

	test("measures under the element's text-transform", () => {
		const ctx = installFakeCanvas();
		// Uppercase widths in the fake model: unmapped chars are 8px wide,
		// so "HELLO" = 40px while "hello" = 8+7+3+3+6 = 27px. The symbol
		// bases are unaffected by toUpperCase.
		const el = document.createElement("p");
		const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
			font: "16px Arial",
			textTransform: "uppercase",
		} as CSSStyleDeclaration);
		try {
			const masked = maskTextValue("hello", el);
			// The placeholder must match the UPPERCASED width of the word.
			expect(Math.abs(fakeWidth(masked) - fakeWidth("HELLO"))).toBeLessThan(
				CHAR_WIDTHS["*"],
			);
			expect(ctx.measureText).toHaveBeenCalledWith("HELLO");
		} finally {
			computedStyle.mockRestore();
		}
	});

	test("re-resolves an element's font after the TTL", () => {
		vi.useFakeTimers();
		try {
			const ctx = installFakeCanvas();
			const el = document.createElement("p");
			// jsdom's getComputedStyle is a stale snapshot, so a mid-session
			// font change is simulated by swapping the spy's return value.
			const style = (fontSize: string) =>
				({ font: `${fontSize} Arial` }) as CSSStyleDeclaration;
			const computedStyle = vi
				.spyOn(window, "getComputedStyle")
				.mockReturnValue(style("16px"));

			maskTextValue("hello", el);
			computedStyle.mockReturnValue(style("20px"));

			// Within the TTL the stale 16px spec is served from cache: the
			// style is not re-read and the placeholder cache hits.
			maskTextValue("hello", el);
			expect(computedStyle).toHaveBeenCalledTimes(1);
			const callsWhileCached = ctx.measureText.mock.calls.length;

			// Past the TTL the font re-resolves to 20px, a new placeholder
			// cache key, forcing re-measurement.
			vi.advanceTimersByTime(6_000);
			maskTextValue("hello", el);
			expect(computedStyle).toHaveBeenCalledTimes(2);
			expect(ctx.measureText.mock.calls.length).toBeGreaterThan(
				callsWhileCached,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("returns empty and whitespace-only values unchanged", () => {
		installFakeCanvas();
		expect(maskTextValue("", elementWithFont())).toBe("");
		expect(maskTextValue("  \n\t ", elementWithFont())).toBe("  \n\t ");
	});

	test("preserves hyphens and width-matches each segment of hyphenated tokens", () => {
		installFakeCanvas();
		// Browsers can break after hyphens; the placeholder must keep them
		// so hyphenated tokens stay breakable in narrow columns.
		const masked = maskTextValue("INV-2026-0512", elementWithFont());
		expect(masked).toMatch(/^[*_#&@]+-[*_#&@]+-[*_#&@]+$/);
	});

	test("masks words with attached punctuation as one placeholder", () => {
		installFakeCanvas();
		const masked = maskTextValue("hello,", elementWithFont());
		expect(masked).toMatch(/^[*_#&@]+$/);
		expect(Math.abs(fakeWidth(masked) - fakeWidth("hello,"))).toBeLessThan(
			CHAR_WIDTHS["*"],
		);
	});

	test("applies the element's letter-spacing to the measuring context", () => {
		const ctx = installFakeCanvas();
		// The in-operator guard requires the property to exist on the ctx.
		(ctx as unknown as { letterSpacing: string }).letterSpacing = "";
		const el = document.createElement("p");
		const computedStyle = vi.spyOn(window, "getComputedStyle").mockReturnValue({
			font: "16px Arial",
			letterSpacing: "2px",
		} as CSSStyleDeclaration);
		try {
			maskTextValue("hello", el);
			expect((ctx as unknown as { letterSpacing: string }).letterSpacing).toBe(
				"2px",
			);
		} finally {
			computedStyle.mockRestore();
		}
	});

	test('maps letter-spacing "normal" to the valid canvas value "0px"', () => {
		const ctx = installFakeCanvas();
		(ctx as unknown as { letterSpacing: string }).letterSpacing = "";
		maskTextValue("hello", elementWithFont());
		expect((ctx as unknown as { letterSpacing: string }).letterSpacing).toBe(
			"0px",
		);
	});

	test("measures under lowercase and capitalize text-transforms", () => {
		const ctx = installFakeCanvas();
		const el = document.createElement("p");
		const style = (textTransform: string) =>
			({ font: "16px Arial", textTransform }) as CSSStyleDeclaration;
		const computedStyle = vi
			.spyOn(window, "getComputedStyle")
			.mockReturnValue(style("lowercase"));
		try {
			maskTextValue("HELLO", el);
			expect(ctx.measureText).toHaveBeenCalledWith("hello");

			computedStyle.mockReturnValue(style("capitalize"));
			const otherEl = document.createElement("p");
			maskTextValue("mello", otherEl);
			expect(ctx.measureText).toHaveBeenCalledWith("Mello");
		} finally {
			computedStyle.mockRestore();
		}
	});

	test("shares cached placeholders across elements with the same font", () => {
		const ctx = installFakeCanvas();
		maskTextValue("hello", elementWithFont());
		const calls = ctx.measureText.mock.calls.length;

		// A different element, same computed font: placeholder cache hit.
		maskTextValue("hello", elementWithFont());
		expect(ctx.measureText.mock.calls.length).toBe(calls);
	});

	test("reuses placeholders across different words with the same measured width", () => {
		// Text churn (counters, tickers) produces brand-new words every
		// update; width-bucket reuse keeps that from re-running placeholder
		// construction (and generating GC-triggering garbage) per update.
		const ctx = installFakeCanvas();
		const el = elementWithFont();

		const first = maskTextValue("ox", el); // o=6 + x=7 = 13px
		const calls = ctx.measureText.mock.calls.length;

		// New word, same 13px width: one measureText for the target, no
		// construction measurements.
		const second = maskTextValue("xo", el);
		expect(second).toBe(first);
		expect(ctx.measureText.mock.calls.length).toBe(calls + 1);
	});

	test("caches placeholders per font and word", () => {
		const ctx = installFakeCanvas();
		const el = elementWithFont();

		maskTextValue("hello", el);
		const callsAfterFirst = ctx.measureText.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		maskTextValue("hello", el);
		expect(ctx.measureText.mock.calls.length).toBe(callsAfterFirst);
	});

	test("evicts oldest placeholder cache entries first when the cap is hit", () => {
		// A non-recording fake context: this test masks >10k unique words and
		// vi.fn call records would dominate the runtime.
		let measureCalls = 0;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			font: "16px Arial",
			measureText: (text: string) => {
				measureCalls++;
				return { width: fakeWidth(text) };
			},
		} as unknown as RenderingContext);
		const el = elementWithFont();

		// Unique letter-only words (digit-bearing words are never admitted).
		const word = (i: number) =>
			`w${i.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[Number(d)])}`;

		// Fill past the per-font cap; the insert that hits the cap evicts
		// the oldest half.
		for (let i = 0; i <= 10_000; i++) {
			maskTextValue(word(i), el);
		}

		const calls = measureCalls;
		maskTextValue(word(10_000), el); // recent → still cached
		expect(measureCalls).toBe(calls);
		maskTextValue(word(0), el); // oldest → evicted, re-measured
		expect(measureCalls).toBeGreaterThan(calls);
	});

	test("does not admit digit-bearing words to the word cache", () => {
		// Prices, IDs, and timestamps are high-cardinality and rarely repeat;
		// admitting them would churn out hot prose words. They re-measure
		// their target width each time (one call) and reuse a width-bucket
		// placeholder.
		const ctx = installFakeCanvas();
		const el = elementWithFont();

		maskTextValue("$1,284.50", el);
		const calls = ctx.measureText.mock.calls.length;
		maskTextValue("$1,284.50", el);
		// Re-measured (cache skip) but construction-free via the bucket cache.
		expect(ctx.measureText.mock.calls.length).toBe(calls + 1);
	});
});
