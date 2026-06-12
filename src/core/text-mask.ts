/**
 * Layout-preserving text masking.
 *
 * Masked text must occupy the same rendered width as the original: if it
 * re-wraps, everything below it shifts, and replayed clicks/scrolls
 * (recorded against the real layout) land in the wrong place.
 *
 * Two layers:
 * - Measured (main path): per word, build a placeholder from • * # whose
 *   canvas-measured width matches the original within WIDTH_TOLERANCE.
 * - Static (fallback, never throws): per-grapheme substitution — CJK and
 *   emoji → ＊, Latin letters → a width-class symbol, digits → 0, anything
 *   else → *. Used when measurement is unavailable or not worth it.
 */

const FULLWIDTH_ASTERISK = "＊";

// How close a measured placeholder must come to the original word's width.
const WIDTH_TOLERANCE = 0.4;
const HILL_CLIMB_MAX_ITERATIONS = 12;

// Tokens longer than this skip the measured path: their layout is governed
// by overflow-wrap rather than exact width, measurement cost grows
// superlinearly with token length, and caching them would only collect
// garbage (URLs, base64 blobs, and hashes rarely repeat).
const MAX_MEASURED_WORD_LENGTH = 200;

// Han/Hiragana/Katakana/Hangul plus halfwidth/fullwidth forms (FF00–FF60).
// Words containing these always take the static layer: the fullwidth
// asterisk has roughly the same ~1em advance and the same break behavior as
// the original characters (exact for Han/kana, close for Hangul syllables).
// Keep this built from Script_Extensions properties, not hand-built ranges
// or plain Script: ranges are easy to get wrong (e.g. missing the Hangul
// syllables block U+AC00–D7A3), and plain Script classifies shared CJK
// characters — the prolonged sound mark ー, middle dot ・, ideographic
// punctuation 。、 — as Common, which would give them narrow masks inside
// full-width runs and shift line wrapping.
const CJK_RE =
	/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}＀-｠]/u;
// Arabic is cursive/shaped, so width-matching it would require in-script
// basis letters. We deliberately keep it simple instead: Arabic words take
// the static layer ("*" per grapheme), accepting approximate widths for this
// rarer case. Arabic has spaces between words, so drift stays gradual rather
// than collapsing like spaceless CJK would.
const ARABIC_RE = /\p{scx=Arabic}/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const LATIN_LETTER_RE = /^[A-Za-z]$/;
const DIGIT_RE = /^[0-9]$/;
const WHITESPACE_ONLY_RE = /^\s+$/;
// Separators kept verbatim by both layers. Whitespace and hyphens carry the
// line-break opportunities the layout depends on (browsers break after
// hyphens, so masking them away makes hyphenated tokens unbreakable and
// re-wraps narrow columns). Hyphen positions are shape leakage of the same
// accepted class as digit positions.
const PRESERVED_SEPARATOR_RE = /^(?:\s+|-+)$/;

// Static-layer width classes for Latin letters, derived from averaged canvas
// advance widths across common fonts. Letters not in either set (the o/m
// width classes and most capitals) map to "#". The three symbols span
// ~0.35em (•) / ~0.45em (*) / ~0.6em (#); wide letters like m/w/M land on
// "#" with some undershoot — acceptable for a fallback layer whose goal is
// staying within a line, not exactness.
const NARROW_LETTERS = new Set("fijlrtI");
const MEDIUM_LETTERS = new Set("aceksvxyzJL");

// Basis alphabet for measured placeholder construction: • * # — chosen
// because they are present in effectively every font (ASCII + WGL4), carry
// the letter line-break class (a run of them wraps exactly like a word,
// adding no break opportunities), span narrow-to-wide advances for width
// composition, and read as obviously masked.
const BASES = ["•", "*", "#"];

// Intl.Segmenter is unavailable in some older browsers; Array.from (per code
// point) is the fallback. Code points still keep surrogate pairs (emoji)
// intact, just not multi-code-point graphemes like ZWJ sequences.
const graphemeSegmenter: Intl.Segmenter | null =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

function splitGraphemes(value: string): string[] {
	if (graphemeSegmenter) {
		return Array.from(graphemeSegmenter.segment(value), (s) => s.segment);
	}
	return Array.from(value);
}

// Static results are font-independent, so they're cached by value alone.
// This mostly matters for spaceless CJK: whole paragraphs arrive as one
// token and re-mask on every checkout snapshot. Eviction uses a character
// budget rather than an entry count because entries range from single words
// to multi-KB paragraphs. The budget caps cache memory at ~2MB (JS strings
// are 2 bytes/char); typical pages use a small fraction of it.
const STATIC_CACHE_MAX_CHARS = 1_000_000;
const staticMaskCache = new Map<string, string>();
let staticCacheChars = 0;

/** Layer 1: static width-class masking. Never throws, needs no DOM access. */
export function staticMaskText(value: string): string {
	const cached = staticMaskCache.get(value);
	if (cached !== undefined) {
		return cached;
	}

	let result = "";
	for (const grapheme of splitGraphemes(value)) {
		if (WHITESPACE_ONLY_RE.test(grapheme)) {
			// Whitespace is kept verbatim: it carries the line-break
			// opportunities the layout depends on and is not sensitive.
			result += grapheme;
		} else if (CJK_RE.test(grapheme) || EMOJI_RE.test(grapheme)) {
			result += FULLWIDTH_ASTERISK;
		} else if (LATIN_LETTER_RE.test(grapheme)) {
			result += NARROW_LETTERS.has(grapheme)
				? "•"
				: MEDIUM_LETTERS.has(grapheme)
					? "*"
					: "#";
		} else if (DIGIT_RE.test(grapheme)) {
			// Digits keep their position as "0": numeric shape (prices,
			// phone-like patterns) is part of the accepted leak surface and
			// useful to downstream analysis.
			result += "0";
		} else if (grapheme === "-") {
			// See PRESERVED_SEPARATOR_RE: hyphens carry break opportunities.
			result += "-";
		} else {
			// Punctuation, combining-mark graphemes, and any script without
			// dedicated handling (Greek, Cyrillic, Thai, …).
			result += "*";
		}
	}

	staticCacheChars += value.length + result.length;
	staticMaskCache.set(value, result);
	if (staticCacheChars > STATIC_CACHE_MAX_CHARS) {
		// Evict oldest-first (Map preserves insertion order) down to half the
		// budget so recently used entries survive.
		for (const [key, masked] of staticMaskCache) {
			staticMaskCache.delete(key);
			staticCacheChars -= key.length + masked.length;
			if (staticCacheChars <= STATIC_CACHE_MAX_CHARS / 2) {
				break;
			}
		}
	}
	return result;
}

// --- Layer 2: canvas measurement ---

type FontSpec = {
	font: string;
	letterSpacing: string;
	textTransform: string;
	// `font|letterSpacing|textTransform`, precomputed once per element so the
	// per-word cache-key concatenation stays cheap on hot paths.
	key: string;
};

// maskTextFn runs during snapshot and on every text mutation, so per-call
// cost must stay ~µs: computed font strings are cached per element, and
// placeholders per font|letterSpacing|textTransform|word.
//
// Font specs can go stale mid-session (theme class on an ancestor,
// stylesheet swap) with nothing observable on the element itself, so entries
// expire after a short TTL instead of being trusted forever. Staleness only
// matters when the text re-serializes after a font change, so a coarse TTL
// is enough.
const FONT_SPEC_TTL_MS = 5_000;
const elementFontCache = new WeakMap<
	HTMLElement,
	{ spec: FontSpec | null; expiresAt: number }
>();
const placeholderCache = new Map<string, string>();
// Bounds memory on pathological pages (e.g. unique prices/IDs as words).
// Entries are short (font string + word + placeholder, ≲200 chars), so the
// cap keeps worst-case cache memory in the single-digit MB; typical pages
// hold a few hundred entries. The caches live for the page lifetime — the
// element font cache is a WeakMap, so its entries go away with their
// elements.
const PLACEHOLDER_CACHE_MAX_ENTRIES = 20_000;

// Placeholders are additionally cached by quantized target width, per font
// spec. Under text churn (counters, tickers, live logs re-rendering every
// frame) each update is a brand-new word — a guaranteed miss in the
// word-keyed cache — but rendered widths repeat heavily, so width-keyed
// reuse collapses unbounded unique strings into a bounded set of
// constructions. Without it, sustained churn rebuilds placeholders
// constantly and the construction garbage triggers major GC pauses.
//
// Reusing a placeholder built for a width within the same 0.25px bucket
// adds at most 0.25px of error on top of WIDTH_TOLERANCE — well inside the
// validated wrap-fidelity envelope.
const WIDTH_BUCKET_PX = 0.25;
const WIDTH_BUCKET_CACHE_MAX_ENTRIES = 20_000;
const widthBucketCache = new Map<string, Map<number, string>>();
let widthBucketEntries = 0;

let measureCtx: CanvasRenderingContext2D | null | undefined;
// The font/letterSpacing last successfully applied to measureCtx, so
// repeated measurements under one font skip the assign-and-verify dance.
let appliedFont: string | null = null;
let appliedLetterSpacing: string | null = null;

// The canvas is created detached and never attached to the document or drawn
// to: measureText only computes text metrics. It has no visual, layout, or
// paint effect on the host page while recording.
function getMeasureCtx(): CanvasRenderingContext2D | null {
	if (measureCtx === undefined) {
		try {
			measureCtx = document.createElement("canvas").getContext("2d");
		} catch {
			measureCtx = null;
		}
	}
	return measureCtx;
}

function resolveFontSpec(element: HTMLElement): FontSpec | null {
	const cached = elementFontCache.get(element);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.spec;
	}

	let spec: FontSpec | null = null;
	try {
		const view = element.ownerDocument?.defaultView;
		const style = view?.getComputedStyle(element);
		if (style) {
			// The font shorthand can be empty (Firefox); compose it from parts.
			let font = style.font;
			if (!font && style.fontSize && style.fontFamily) {
				font =
					`${style.fontStyle ?? ""} ${style.fontWeight ?? ""} ${style.fontSize} ${style.fontFamily}`
						.replace(/\s+/g, " ")
						.trim();
			}
			if (font) {
				const letterSpacing = style.letterSpacing || "normal";
				const textTransform = style.textTransform || "none";
				spec = {
					font,
					letterSpacing,
					textTransform,
					key: `${font}|${letterSpacing}|${textTransform}`,
				};
			}
		}
	} catch {
		spec = null;
	}

	elementFontCache.set(element, {
		spec,
		expiresAt: Date.now() + FONT_SPEC_TTL_MS,
	});
	return spec;
}

// Returns a context configured for `spec`, or null if the font didn't take
// (assigning an invalid font string leaves ctx.font unchanged, which would
// silently measure against the wrong metrics).
function getConfiguredCtx(spec: FontSpec): CanvasRenderingContext2D | null {
	const ctx = getMeasureCtx();
	if (!ctx) {
		return null;
	}

	if (appliedFont !== spec.font) {
		// Canvas has no API to ask whether a font string parsed: an invalid
		// assignment silently leaves ctx.font unchanged, and reading ctx.font
		// back returns a canonicalized form that can't be string-compared to
		// the input. Parking on a known sentinel first makes failure
		// detectable: if ctx.font still reads as the sentinel afterwards, the
		// requested font didn't take.
		ctx.font = "10px serif";
		ctx.font = spec.font;
		if (ctx.font === "10px serif" && spec.font !== "10px serif") {
			appliedFont = null;
			return null;
		}
		appliedFont = spec.font;
	}

	if (appliedLetterSpacing !== spec.letterSpacing) {
		// letterSpacing is not supported on the 2d context in all browsers;
		// "normal" is not a valid value for it, so map it to 0px.
		if ("letterSpacing" in ctx) {
			ctx.letterSpacing =
				spec.letterSpacing === "normal" ? "0px" : spec.letterSpacing;
		}
		appliedLetterSpacing = spec.letterSpacing;
	}

	return ctx;
}

// CSS renders both the original and our placeholder through text-transform,
// but canvas doesn't, so candidates and targets are transformed before
// measuring. The placeholder itself is stored untransformed — CSS transforms
// it at render time just like it did the original. Values beyond these three
// (e.g. full-width) pass through unsimulated.
function applyTextTransform(text: string, transform: string): string {
	switch (transform) {
		case "uppercase":
			return text.toUpperCase();
		case "lowercase":
			return text.toLowerCase();
		case "capitalize":
			// Tokens are single words, so transforming the first character
			// matches what CSS does to both the original and the placeholder.
			return text.charAt(0).toUpperCase() + text.slice(1);
		default:
			return text;
	}
}

function buildMeasuredPlaceholder(
	target: number,
	ctx: CanvasRenderingContext2D,
	bases: string[],
	textTransform: string,
): string | null {
	const measure = (text: string) =>
		ctx.measureText(applyTextTransform(text, textTransform)).width;

	// Single-base widths are used only for ordering and count estimates;
	// candidates are always measured as whole strings.
	const ordered = bases
		.map((base) => ({ base, width: measure(base) }))
		.sort((a, b) => b.width - a.width);
	if (ordered.some((b) => b.width <= 0.05)) {
		// Degenerate metrics (font not really applied); measuring would loop.
		return null;
	}

	// Hard budget on placeholder glyph count. Clamped/saturating measureText
	// (canvas-fingerprinting extensions, broken polyfills) reports widths
	// that stop growing as the candidate grows, which would otherwise make
	// the fill loop below append glyphs forever on the customer's main
	// thread. Hitting the budget means metrics are unusable → static layer.
	const maxGlyphs =
		Math.ceil(target / ordered[ordered.length - 1].width) * 2 + 8;
	let total = 0;

	// Greedy fill widest-first: jump to an estimate from the single-glyph
	// width, then correct against whole-string measurements (kerning and
	// letter-spacing make the estimate inexact). The candidate string is
	// grown/shrunk incrementally rather than re-rendered per measurement —
	// this loop runs on every placeholder construction, and per-measurement
	// rebuild garbage is what caused major-GC pauses under text churn.
	const counts: number[] = ordered.map(() => 0);
	let placeholder = "";
	let width = 0;
	for (let i = 0; i < ordered.length; i++) {
		const { base, width: baseWidth } = ordered[i];
		const room = target - width;
		if (room < baseWidth) {
			continue;
		}
		const jump = Math.min(Math.floor(room / baseWidth), maxGlyphs - total);
		placeholder += base.repeat(jump);
		counts[i] += jump;
		total += jump;
		width = measure(placeholder);
		while (counts[i] > 0 && width > target + WIDTH_TOLERANCE) {
			placeholder = placeholder.slice(0, placeholder.length - base.length);
			counts[i]--;
			total--;
			width = measure(placeholder);
		}
		let widthBeforeAppend = width;
		do {
			widthBeforeAppend = width;
			placeholder += base;
			counts[i]++;
			total++;
			if (total > maxGlyphs) {
				return null;
			}
			width = measure(placeholder);
		} while (width <= target + WIDTH_TOLERANCE);
		placeholder = placeholder.slice(0, placeholder.length - base.length);
		counts[i]--;
		total--;
		width = widthBeforeAppend;
	}

	// Hill-climb single ±1 tweaks toward the smallest absolute width error.
	const render = (c: number[]) =>
		ordered.map((o, i) => o.base.repeat(c[i])).join("");
	const widthOf = (c: number[]) => measure(render(c));
	let best = counts;
	let bestError = Math.abs(width - target);
	for (
		let iteration = 0;
		iteration < HILL_CLIMB_MAX_ITERATIONS && bestError > WIDTH_TOLERANCE;
		iteration++
	) {
		let improved = false;
		for (let i = 0; i < ordered.length; i++) {
			for (const delta of [1, -1]) {
				const candidate = best.slice();
				candidate[i] += delta;
				if (candidate[i] < 0) {
					continue;
				}
				const error = Math.abs(widthOf(candidate) - target);
				if (error < bestError) {
					best = candidate;
					bestError = error;
					improved = true;
				}
			}
		}
		if (!improved) {
			break;
		}
	}

	if (!best.some((count) => count > 0)) {
		// Word narrower than the narrowest base (e.g. lone punctuation).
		// Never return an empty mask — use one narrowest base instead.
		best[best.length - 1] = 1;
	}
	return render(best);
}

function maskWordMeasured(word: string, spec: FontSpec): string {
	// CJK, emoji, and Arabic go straight to the static layer (see the regex
	// comments above for why), as do very long tokens (see
	// MAX_MEASURED_WORD_LENGTH).
	if (
		word.length > MAX_MEASURED_WORD_LENGTH ||
		CJK_RE.test(word) ||
		EMOJI_RE.test(word) ||
		ARABIC_RE.test(word)
	) {
		return staticMaskText(word);
	}

	const cacheKey = `${spec.key}|${word}`;
	const cached = placeholderCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	const ctx = getConfiguredCtx(spec);
	let placeholder: string | null = null;
	if (ctx) {
		const target = ctx.measureText(
			applyTextTransform(word, spec.textTransform),
		).width;
		// Width-bucket reuse (see WIDTH_BUCKET_PX): a new word whose width
		// matches an already-built placeholder costs one measureText and no
		// construction.
		const bucket = Math.round(target / WIDTH_BUCKET_PX);
		let byWidth = widthBucketCache.get(spec.key);
		placeholder = byWidth?.get(bucket) ?? null;
		if (placeholder === null) {
			placeholder = buildMeasuredPlaceholder(
				target,
				ctx,
				BASES,
				spec.textTransform,
			);
			if (placeholder !== null) {
				if (widthBucketEntries >= WIDTH_BUCKET_CACHE_MAX_ENTRIES) {
					// Wholesale clear is fine here: entries are width-keyed, so
					// the hot buckets rebuild in a bounded number of
					// constructions.
					widthBucketCache.clear();
					widthBucketEntries = 0;
					byWidth = undefined;
				}
				if (!byWidth) {
					byWidth = new Map();
					widthBucketCache.set(spec.key, byWidth);
				}
				byWidth.set(bucket, placeholder);
				widthBucketEntries++;
			}
		}
	}
	const result = placeholder ?? staticMaskText(word);

	if (placeholderCache.size >= PLACEHOLDER_CACHE_MAX_ENTRIES) {
		// Evict oldest-first (Map preserves insertion order) down to half, so
		// hot common-word entries don't all vanish at once.
		for (const key of placeholderCache.keys()) {
			placeholderCache.delete(key);
			if (placeholderCache.size <= PLACEHOLDER_CACHE_MAX_ENTRIES / 2) {
				break;
			}
		}
	}
	placeholderCache.set(cacheKey, result);
	return result;
}

/**
 * Mask `value` while preserving its rendered layout. Uses measured
 * placeholders when `element` and canvas metrics are available, otherwise
 * the static width-class map.
 */
export function maskTextValue(
	value: string,
	element: HTMLElement | null,
): string {
	const spec = element ? resolveFontSpec(element) : null;
	if (!spec) {
		return staticMaskText(value);
	}

	// Tokenize keeping whitespace and hyphen separators verbatim (see
	// PRESERVED_SEPARATOR_RE). Splitting at hyphens also width-matches each
	// segment of a hyphenated token independently.
	return value
		.split(/(\s+|-+)/u)
		.map((token) =>
			token === "" || PRESERVED_SEPARATOR_RE.test(token)
				? token
				: maskWordMeasured(token, spec),
		)
		.join("");
}

/** Test-only: reset module-level caches and canvas state. */
export function resetTextMaskStateForTesting(): void {
	placeholderCache.clear();
	widthBucketCache.clear();
	widthBucketEntries = 0;
	staticMaskCache.clear();
	staticCacheChars = 0;
	measureCtx = undefined;
	appliedFont = null;
	appliedLetterSpacing = null;
}
