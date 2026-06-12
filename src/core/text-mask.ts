/**
 * Layout-preserving text masking.
 *
 * Masked text must occupy the same rendered width as the original: if it
 * re-wraps, everything below it shifts, and replayed clicks/scrolls
 * (recorded against the real layout) land in the wrong place.
 *
 * Two layers:
 * - Measured (main path): per word, build a placeholder from the symbol
 *   alphabet * # _ & @ whose width (computed from canvas-measured per-font
 *   glyph advances) matches the original within WIDTH_TOLERANCE.
 * - Static (fallback, never throws): per-grapheme substitution — CJK and
 *   emoji → ＊, digits → 0, anything else → *. Used when measurement is
 *   unavailable or not worth it.
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
const DIGIT_RE = /^[0-9]$/;
// Separator classification for the tokenizer's scan loop: whitespace and
// hyphens are kept verbatim by both layers because they carry the
// line-break opportunities the layout depends on (browsers break after
// hyphens, so masking them away makes hyphenated tokens unbreakable in
// narrow columns). Hyphen positions are shape leakage of the same accepted
// class as digit positions. Classification is by charCode — the charCode
// equivalent of /[\s-]/ — since a per-char regex test would allocate a
// string per character. The Unicode whitespace set is enumerated by hand,
// so it is pinned against /\s/ by a test that sweeps the entire BMP;
// exported for that test only.
export function isSeparatorCode(code: number): boolean {
	if (code === 0x20 || code === 0x2d || (code >= 0x09 && code <= 0x0d)) {
		return true;
	}
	if (code < 0x80) {
		return false;
	}
	return (
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	);
}

// Index of the first separator in `value`, or -1. Lets maskTextValue take a
// zero-slice fast path for single-token values and start its scan loop past
// the part it has already classified.
function firstSeparatorIndex(value: string): number {
	for (let i = 0; i < value.length; i++) {
		if (isSeparatorCode(value.charCodeAt(i))) {
			return i;
		}
	}
	return -1;
}

// A grapheme is preserved verbatim when every code unit is a separator —
// the same set the tokenizer uses, so the two layers cannot diverge.
function isPreservedSeparator(grapheme: string): boolean {
	for (let i = 0; i < grapheme.length; i++) {
		if (!isSeparatorCode(grapheme.charCodeAt(i))) {
			return false;
		}
	}
	return true;
}

// Basis alphabet for measured placeholder construction: * # _ & @ —
// chosen on three hard constraints, in priority order:
//
// 1. Printable ASCII: present in every text font including aggressively
//    subset webfonts, so placeholders never mix in fallback-font glyphs
//    (which would perturb line height and diverge between the recording and
//    replay machines).
// 2. UAX#14 line-break class AL — the *formal* letter class, not just
//    empirically letter-like in Chrome. Placeholders must wrap exactly like
//    the words they replace in every engine and every word-break mode:
//    grawlix-style candidates (' ! $ %) and | passed normal-wrap probes in
//    Chrome but are formally quote/exclamation/prefix/postfix/break-after
//    class, and under word-break:break-all their runs stay unbreakable
//    while real words gain per-glyph break points — measured as multi-line
//    height drift by .context/browser-validation/wrap-modes-probe.mjs.
//    (ascii-probe.mjs also disqualified "?", which allows breaks against
//    adjacent letters even in normal mode.)
// 3. Advance spread for width composition: ~0.35em (*) to ~0.93em (@), all
//    case-invariant under text-transform, all reading as obviously masked
//    even in homogeneous runs ("****", "@@@@"). The backtick — the only
//    other AL-class ASCII symbol, and the only sub-* candidate — was
//    rejected here: its advance varies wildly across fonts (0.22em in
//    Arial, ~0.48em in Georgia) and long words fitted mostly from
//    backticks read as rendering corruption rather than masking.
//
// Listed in PREFERENCE order, not width order: baseAdvancesFor drops bases
// whose advance nearly duplicates an earlier-listed one (they add no
// fitting power, and the fitter would flood words with whichever duplicate
// fine-tunes best).
const BASES = ["*", "#", "_", "&", "@"];

// Intl.Segmenter is unavailable in some older browsers; Array.from (per code
// point) is the fallback. Code points still keep surrogate pairs (emoji)
// intact, just not multi-code-point graphemes like ZWJ sequences.
const graphemeSegmenter: Intl.Segmenter | null =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

// Graphemes only differ from code points when clustering characters are
// involved: combining marks (which include variation selectors), ZWJ,
// regional-indicator pairs, emoji skin-tone modifiers, conjoining Hangul
// jamo. Checked once per value so the common case can iterate by code
// point — the segmenter allocates a segment object per grapheme, which is a
// dominant garbage source when masking unique CJK/Latin text at churn rates.
const NEEDS_GRAPHEME_SEGMENTATION_RE =
	/\u200D|[\p{M}\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF]|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]/u;

// Static results are font-independent, so they're cached by value alone.
// This mostly matters for spaceless CJK: whole paragraphs arrive as one
// token and re-mask on every checkout snapshot. Eviction uses a character
// budget rather than an entry count because entries range from single words
// to multi-KB paragraphs. The budget caps cache memory at ~2MB (JS strings
// are 2 bytes/char); typical pages use a small fraction of it.
const STATIC_CACHE_MAX_CHARS = 1_000_000;
const staticMaskCache = new Map<string, string>();
let staticCacheChars = 0;

// Admission control for the static cache. Under text churn most values are
// seen exactly once, and caching them promotes short-lived strings into the
// old generation at a steady rate — which is what drives major-GC pauses on
// long sessions. A value is only cached on its second sighting, tracked by
// a numeric hash so first sightings allocate nothing. A hash collision just
// admits a value one sighting early, which is harmless.
const STATIC_SEEN_MAX_ENTRIES = 8_192;
const staticSeenOnce = new Set<number>();

function fnv1a(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash;
}

function maskGrapheme(grapheme: string): string {
	if (isPreservedSeparator(grapheme)) {
		// Whitespace/hyphens are kept verbatim (see isSeparatorCode) — this
		// covers multi-unit whitespace graphemes like "\r\n" too.
		return grapheme;
	}
	if (CJK_RE.test(grapheme) || EMOJI_RE.test(grapheme)) {
		return FULLWIDTH_ASTERISK;
	}
	if (DIGIT_RE.test(grapheme)) {
		// Digits keep their position as "0": numeric shape (prices,
		// phone-like patterns) is part of the accepted leak surface and
		// useful to downstream analysis.
		return "0";
	}
	// Everything else — letters, punctuation, any script. Uniform "*" by
	// choice: per-letter width classes would track widths slightly better,
	// but the fallback path is rare (no canvas, font failure, >200-char
	// tokens) and a single repeated symbol keeps its output and leak
	// surface trivial to reason about.
	return "*";
}

/** Layer 1: static width-class masking. Never throws, needs no DOM access. */
export function staticMaskText(value: string): string {
	const cached = staticMaskCache.get(value);
	if (cached !== undefined) {
		return cached;
	}

	let result = "";
	if (graphemeSegmenter && NEEDS_GRAPHEME_SEGMENTATION_RE.test(value)) {
		for (const segment of graphemeSegmenter.segment(value)) {
			result += maskGrapheme(segment.segment);
		}
	} else {
		// Per code point (a string iterator yields whole surrogate pairs, so
		// emoji stay intact; only multi-code-point clusters need the
		// segmenter, and those were excluded above).
		for (const grapheme of value) {
			result += maskGrapheme(grapheme);
		}
	}

	const hash = fnv1a(value);
	if (staticSeenOnce.has(hash)) {
		staticCacheChars += value.length + result.length;
		staticMaskCache.set(value, result);
		if (staticCacheChars > STATIC_CACHE_MAX_CHARS) {
			// Evict oldest-first (Map preserves insertion order) down to half
			// the budget so recently used entries survive.
			for (const [key, masked] of staticMaskCache) {
				staticMaskCache.delete(key);
				staticCacheChars -= key.length + masked.length;
				if (staticCacheChars <= STATIC_CACHE_MAX_CHARS / 2) {
					break;
				}
			}
		}
	} else {
		if (staticSeenOnce.size >= STATIC_SEEN_MAX_ENTRIES) {
			staticSeenOnce.clear();
		}
		staticSeenOnce.add(hash);
	}
	return result;
}

// --- Layer 2: canvas measurement ---

type FontSpec = {
	font: string;
	letterSpacing: string;
	textTransform: string;
	// `font|letterSpacing|textTransform`, precomputed once per element and
	// used as the key for the per-font caches below.
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
// Word-keyed placeholder caches, one inner map per font spec, so the
// per-word cache key is the word string itself. (A flat map keyed by
// `font|word` would allocate a concatenated key per token — at text-churn
// rates that alone produced hundreds of thousands of string allocations per
// second and measurable GC pressure.) Bounds keep worst-case memory in the
// single-digit MB; typical pages hold a few hundred entries. The caches
// live for the page lifetime — the element font cache is a WeakMap, so its
// entries go away with their elements.
const placeholderCache = new Map<string, Map<string, string>>();
const PLACEHOLDER_CACHE_MAX_FONTS = 50;
const PLACEHOLDER_CACHE_MAX_WORDS_PER_FONT = 10_000;
// Digit-bearing words (prices, IDs, timestamps, dates) are high-cardinality
// and rarely repeat: admitting them to the word cache would evict hot prose
// words and run the eviction loop continuously under churn. They are served
// by the width-bucket cache instead, at the cost of one measureText.
const CONTAINS_DIGIT_RE = /[0-9]/;

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

// Per-font advances of the BASES glyphs, ordered widest-first. Measured once
// per font spec from a run of ADVANCE_REF_RUN glyphs — runs of identical
// symbols have no kerning, so run width divided by run length gives the
// per-glyph advance including any canvas letterSpacing (which a single-glyph
// measurement would miscount). All candidate widths during construction are
// then computed arithmetically from these advances: construction costs zero
// measureText calls, which is what dominated cold-pass time when every
// candidate string was measured individually.
type BaseAdvance = { base: string; advance: number };
const ADVANCE_REF_RUN = 20;
const baseAdvanceCache = new Map<string, BaseAdvance[] | null>();

function baseAdvancesFor(
	spec: FontSpec,
	ctx: CanvasRenderingContext2D,
): BaseAdvance[] | null {
	const cached = baseAdvanceCache.get(spec.key);
	if (cached !== undefined) {
		return cached;
	}
	if (baseAdvanceCache.size >= PLACEHOLDER_CACHE_MAX_FONTS) {
		baseAdvanceCache.clear();
	}
	let degenerate = false;
	const kept: BaseAdvance[] = [];
	for (const base of BASES) {
		const single = ctx.measureText(base).width;
		const advance =
			ctx.measureText(base.repeat(ADVANCE_REF_RUN)).width / ADVANCE_REF_RUN;
		// An honest font measures a run at ~run-length × the single-glyph
		// width (identical symbols don't kern; letterSpacing inflates both
		// sides equally). A run-derived advance far below the single glyph
		// means sublinear metrics — clamped/saturating measureText from
		// canvas-fingerprinting extensions or broken polyfills — and any
		// width computed from them would be garbage.
		if (advance <= 0.05 || advance < single * 0.5) {
			degenerate = true;
			break;
		}
		// Drop near-duplicate rungs (within 5% of an earlier, more-preferred
		// base): they add no fitting power, and the fitter would otherwise
		// flood words with whichever duplicate fine-tunes best.
		if (!kept.some((k) => Math.abs(k.advance - advance) < advance * 0.05)) {
			kept.push({ base, advance });
		}
	}
	const result = degenerate ? null : kept.sort((a, b) => b.advance - a.advance);
	baseAdvanceCache.set(spec.key, result);
	return result;
}

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

// Candidates are built only from BASES, which are case-invariant, so no
// text-transform is applied here — only the target word's measurement (done
// by the caller) needs the transform.
//
// Construction is pure arithmetic over the per-font base advances: candidate
// width is the dot product of glyph counts and advances, never a measureText
// call. Runs of identical symbols carry no kerning and the (at most two)
// boundaries between different bases contribute sub-0.1px error, validated by
// the real-browser wrap-fidelity harness.
function buildMeasuredPlaceholder(
	target: number,
	advances: BaseAdvance[],
): string | null {
	// Absolute glyph cap. Tokens on the measured path are at most
	// MAX_MEASURED_WORD_LENGTH chars, and every base advance is wider than
	// the narrowest original glyph in practice, so a sane placeholder never
	// exceeds the original's length by much. Exceeding double means the
	// metrics are bogus (e.g. saturating measureText shrank the advances) →
	// static layer, instead of allocating a giant string.
	const maxGlyphs = MAX_MEASURED_WORD_LENGTH * 2;

	const widthOf = (c: number[]) => {
		let w = 0;
		for (let i = 0; i < c.length; i++) {
			w += c[i] * advances[i].advance;
		}
		return w;
	};

	// Multi-start greedy: a single widest-first fill can trap the hill climb
	// in a local optimum (grabbing one extra-wide glyph when two medium
	// glyphs would fit exactly), so the fill is retried with each rung as the
	// widest allowed base and the best result wins. Construction is pure
	// arithmetic, so the extra starts cost nothing measurable; most targets
	// hit the tolerance on the first start and exit early.
	let best: number[] | null = null;
	let bestError = Number.POSITIVE_INFINITY;
	for (
		let start = 0;
		start < advances.length && bestError > WIDTH_TOLERANCE;
		start++
	) {
		// Greedy fill widest-first (from this start) up to target + tolerance.
		const counts: number[] = advances.map(() => 0);
		let width = 0;
		let totalGlyphs = 0;
		for (let i = start; i < advances.length; i++) {
			const n = Math.floor(
				(target + WIDTH_TOLERANCE - width) / advances[i].advance,
			);
			if (n <= 0) {
				continue;
			}
			counts[i] = n;
			width += n * advances[i].advance;
			totalGlyphs += n;
		}
		if (totalGlyphs > maxGlyphs) {
			continue;
		}

		// Hill-climb single ±1 tweaks toward the smallest absolute width error.
		let current = counts;
		let currentError = Math.abs(width - target);
		for (
			let iteration = 0;
			iteration < HILL_CLIMB_MAX_ITERATIONS && currentError > WIDTH_TOLERANCE;
			iteration++
		) {
			let improved = false;
			for (let i = 0; i < advances.length; i++) {
				for (const delta of [1, -1]) {
					const candidate = current.slice();
					candidate[i] += delta;
					if (candidate[i] < 0) {
						continue;
					}
					const error = Math.abs(widthOf(candidate) - target);
					if (error < currentError) {
						current = candidate;
						currentError = error;
						improved = true;
					}
				}
			}
			if (!improved) {
				break;
			}
		}
		if (currentError < bestError) {
			best = current;
			bestError = currentError;
		}
	}
	if (best === null) {
		// Every start exceeded the glyph cap → metrics are bogus.
		return null;
	}

	if (!best.some((count) => count > 0)) {
		// Word narrower than the narrowest base (e.g. lone punctuation).
		// Never return an empty mask — use one narrowest base instead.
		best[best.length - 1] = 1;
	}
	let placeholder = "";
	for (let i = 0; i < best.length; i++) {
		placeholder += advances[i].base.repeat(best[i]);
	}
	return placeholder;
}

// Returns the word-keyed placeholder cache for one font spec; callers
// resolve it once per masked value rather than once per word.
function wordCacheFor(specKey: string): Map<string, string> {
	let words = placeholderCache.get(specKey);
	if (!words) {
		if (placeholderCache.size >= PLACEHOLDER_CACHE_MAX_FONTS) {
			// Pathological font diversity; wholesale clear is fine this rarely.
			placeholderCache.clear();
		}
		words = new Map();
		placeholderCache.set(specKey, words);
	}
	return words;
}

function maskWordMeasured(
	word: string,
	spec: FontSpec,
	words: Map<string, string>,
): string {
	// Cache first: only measured-path words are ever admitted, so a hit
	// proves the word needs none of the routing checks below — and the
	// Unicode-property regexes are the most expensive thing on this path.
	const cached = words.get(word);
	if (cached !== undefined) {
		return cached;
	}

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

	const ctx = getConfiguredCtx(spec);
	const advances = ctx ? baseAdvancesFor(spec, ctx) : null;
	let placeholder: string | null = null;
	if (ctx && advances) {
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
			placeholder = buildMeasuredPlaceholder(target, advances);
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

	if (!CONTAINS_DIGIT_RE.test(word)) {
		if (words.size >= PLACEHOLDER_CACHE_MAX_WORDS_PER_FONT) {
			// Evict oldest-first (Map preserves insertion order) down to
			// half, so hot common-word entries don't all vanish at once.
			for (const key of words.keys()) {
				words.delete(key);
				if (words.size <= PLACEHOLDER_CACHE_MAX_WORDS_PER_FONT / 2) {
					break;
				}
			}
		}
		words.set(word, result);
	}
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
	if (value.length === 0) {
		return value;
	}
	const spec = element ? resolveFontSpec(element) : null;
	if (!spec) {
		return staticMaskText(value);
	}

	// Tokenize keeping whitespace and hyphen separators verbatim — they
	// carry the line-break opportunities the layout depends on. Splitting at
	// hyphens also width-matches each segment of a hyphenated token
	// independently. Hand-rolled scan instead of split/map/join: those
	// allocate several arrays per call, which is a measurable share of GC
	// pressure at text-churn rates.
	const length = value.length;
	const words = wordCacheFor(spec.key);
	const firstSeparator = firstSeparatorIndex(value);
	// Single-token fast path (labels, table cells): no slicing at all.
	if (firstSeparator === -1) {
		return maskWordMeasured(value, spec, words);
	}
	let result =
		firstSeparator > 0
			? maskWordMeasured(value.slice(0, firstSeparator), spec, words)
			: "";
	let index = firstSeparator;
	while (index < length) {
		const start = index;
		if (isSeparatorCode(value.charCodeAt(index))) {
			do {
				index++;
			} while (index < length && isSeparatorCode(value.charCodeAt(index)));
			result += value.slice(start, index);
		} else {
			do {
				index++;
			} while (index < length && !isSeparatorCode(value.charCodeAt(index)));
			result += maskWordMeasured(value.slice(start, index), spec, words);
		}
	}
	return result;
}

/** Test-only: reset module-level caches and canvas state. */
export function resetTextMaskStateForTesting(): void {
	placeholderCache.clear();
	widthBucketCache.clear();
	widthBucketEntries = 0;
	baseAdvanceCache.clear();
	staticMaskCache.clear();
	staticSeenOnce.clear();
	staticCacheChars = 0;
	measureCtx = undefined;
	appliedFont = null;
	appliedLetterSpacing = null;
}
