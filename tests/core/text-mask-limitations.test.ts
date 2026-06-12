/**
 * KNOWN LIMITATIONS of layout-preserving text masking.
 *
 * Each test pins the current behavior of a known-unhandled edge case, so the
 * list stays accurate: improving one of these will fail its test, which is
 * the cue to delete the test (and celebrate). These are documented
 * limitations, not bugs — none of them leak content; they only degrade the
 * layout-preservation goal in specific situations.
 *
 * Limitations that can't be pinned in jsdom unit tests, documented here for
 * completeness:
 *
 * - Font changes without text mutation: rrweb only re-serializes a text node
 *   when its text mutates, so a theme/font swap leaves old placeholders
 *   rendered in the new font in replay. Fixing this needs height
 *   recording/pinning (deliberately deferred).
 * - Same-origin iframes with iframe-local @font-face fonts: measurement uses
 *   a single canvas in the top-level document, so fonts only installed
 *   inside the iframe measure with fallback metrics. (Cross-origin iframes
 *   are fine: the SDK runs its own instance inside the child frame.)
 * - Webfonts not yet loaded at snapshot time bake fallback-font metrics into
 *   placeholders (accepted: we deliberately don't block on
 *   document.fonts.ready).
 * - Browsers without Intl.Segmenter (e.g. Firefox < 125): graphemes are
 *   approximated per code point, so multi-code-point emoji (ZWJ families,
 *   flags) expand to several fullwidth asterisks instead of one.
 * - Browsers without canvas letterSpacing support measure letter-spaced text
 *   slightly narrow/wide; the placeholder inherits the element's real
 *   letter-spacing at render so widths drift by the spacing delta.
 * - RTL/bidi: the masking symbols are direction-neutral, so a Latin word
 *   embedded in an RTL (Hebrew/Arabic) paragraph loses its LTR-ness and the
 *   line's bidi run ordering can shift — horizontal click positions inside
 *   such lines may drift.
 * - text-transform values beyond uppercase/lowercase/capitalize (e.g.
 *   full-width) are not simulated during measurement: the original is
 *   measured untransformed, so placeholder widths drift under such styles.
 *   (See applyTextTransform in text-mask.ts.)
 * - Placeholder width is a local optimum: the greedy + hill-climb
 *   construction can settle within roughly half the narrowest basis glyph
 *   (~2px at 16px font) of the target when no exact basis combination
 *   exists. Razor-edge wrap deltas only; non-accumulating across words.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
	maskTextValue,
	resetTextMaskStateForTesting,
	staticMaskText,
} from "../../src/core/text-mask";

const FW = "＊";

describe("known limitations (pinned behavior)", () => {
	beforeEach(resetTextMaskStateForTesting);

	test("Thai (and other spaceless SEA scripts) produce one unbreakable placeholder run", () => {
		// Thai has no inter-word spaces; browsers wrap it at dictionary-derived
		// boundaries. The masked output is an unbroken run with no break
		// opportunities, so a long Thai paragraph collapses toward one
		// overflowing line — the same failure the fullwidth asterisk fixed for
		// CJK. (Not a regression: the old "*"-masker had the same problem.)
		// A fix would inject break opportunities (e.g. U+200B every few
		// glyphs) for Thai/Lao/Khmer/Myanmar script runs.
		const masked = maskTextValue("สวัสดีครับยินดีต้อนรับ", null);
		expect(masked).not.toMatch(/[\s​]/u);
	});

	test("zero-width space (U+200B) break hints are masked away, not preserved", () => {
		// U+200B is not \s, so it is treated as content and masked to "*",
		// destroying the explicit break opportunity it provided. Common in
		// Thai content pipelines and long-technical-string typography.
		const masked = maskTextValue("ab​cd", null);
		expect(masked).not.toContain("​");
		expect(masked).toBe("*_**_");
	});

	test("Korean is approximated, not measured: one ＊ per Hangul syllable", () => {
		// Hangul syllables are ~1em wide, so the fullwidth asterisk is a
		// close width match — but it is not measured against the page's
		// actual font, so it is approximate, not exact.
		expect(maskTextValue("안녕하세요", null)).toBe(FW.repeat(5));
	});

	test("Arabic is not width-matched: * per grapheme", () => {
		// Arabic is shaped/cursive, so width-matching it would need in-script
		// basis letters — dropped to keep the masker simple. Width drift is
		// gradual rather than catastrophic because Arabic has word spaces.
		expect(maskTextValue("مرحبا", null)).toBe("*".repeat(5));
	});

	test("soft hyphens (U+00AD) lose their break opportunity", () => {
		// U+00AD is invisible until the browser breaks there; masking it to a
		// visible base glyph both widens the word slightly and removes the
		// hyphenation point. Same class as the accepted hyphens:auto edge.
		const masked = staticMaskText("super­califragilistic");
		expect(masked).not.toContain("­");
	});

	test("text glyphs matching Extended_Pictographic (©, ™, ®) inflate to fullwidth", () => {
		// These render as narrow text glyphs but match the emoji property, so
		// they become a ~1em fullwidth asterisk: slight width inflation, and
		// any word containing them routes to the static layer.
		expect(staticMaskText("Acme©")).toBe(`#*@*${FW}`);
	});

	test("keycap emoji are not Extended_Pictographic and mask narrow", () => {
		// "1️⃣" (digit + VS16 + combining keycap) renders emoji-wide but its
		// grapheme doesn't match the emoji property and isn't a single mapped
		// char, so it falls through to a medium-width "*": width undershoot.
		expect(staticMaskText("1️⃣")).toBe("*");
	});

	test("tokens narrower than the narrowest basis glyph overshoot", () => {
		// Lone thin punctuation (".", ",", "|") must produce a non-empty mask,
		// so it gets one narrowest basis glyph even when that is wider than
		// the original: per-token overshoot of a few px.
		const masked = maskTextValue(".", null);
		expect(masked.length).toBeGreaterThan(0);
	});

	test("whitespace is preserved verbatim, including exotic whitespace", () => {
		// All \s whitespace (NBSP, ideographic space U+3000, line/para
		// separators) passes through unmasked. This preserves word-length
		// patterns — part of the accepted leak surface, and identical to the
		// old "*"-masker's behavior.
		expect(staticMaskText("a b　c")).toBe("* _　*");
	});

	test("scripts without dedicated handling mask to uniform-width *", () => {
		// Greek, Cyrillic, Hebrew, Devanagari, Thai, etc. have no width-class
		// mapping — every grapheme becomes "*" in the static layer, losing
		// per-char width fidelity. The measured layer still width-matches
		// them via the symbol bases, so this only degrades the no-canvas
		// fallback path.
		expect(staticMaskText("привет")).toBe("******");
		expect(staticMaskText("שלום")).toBe("****");
	});
});
