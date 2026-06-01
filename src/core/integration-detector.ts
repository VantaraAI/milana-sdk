// Read PostHog and Sentry session/replay state straight from the
// storage these SDKs themselves use to survive page reloads. Storage is
// preferred over their runtime APIs because it's version-stable, not
// coupled to any init lifecycle, and side-effect-free (calling
// posthog.get_session_id() actually mutates state).
//
// Schemas (verified against posthog-js v1.372.5 and @sentry/browser v10.51.0):
//
//   PostHog: localStorage["ph_<token>_posthog"] holds a JSON object
//     containing $sesid: [startMs, sessionId, lastActivityMs],
//     distinct_id, $device_id, $user_state, $user_id (after identify).
//     Also written to cookie or sessionStorage when persistence is
//     'cookie' or 'sessionStorage' instead of the default. The same key
//     in sessionStorage carries debug-only data when persistence is
//     localStorage-based, so we merge with localStorage winning.
//
//   Sentry replay: sessionStorage["sentryReplaySession"] holds JSON
//     { id, sampled, dirty, started, lastActivity, segmentId }. We use
//     `id` as the session-view identifier in Sentry's UI.

import type {
	IntegrationName,
	PostHogIntegrationState,
	SentryIntegrationState,
	SessionIntegrations,
} from "./types";

const POSTHOG_KEY_PATTERN = /^ph_(.+)_posthog$/;
const SENTRY_REPLAY_KEY = "sentryReplaySession";

/**
 * Reads enabled vendors' state from page storage. Vendors not in
 * `enabled` are skipped entirely — no DOM reads, no work. Returns an
 * object whose keys reflect what was actually found; pass it through
 * `Object.keys(...).length === 0` to decide if there's anything to send.
 */
export function detectIntegrations(
	enabled: ReadonlySet<IntegrationName>,
): SessionIntegrations {
	const result: SessionIntegrations = {};
	if (enabled.has("posthog")) {
		const posthog = detectPostHog();
		if (posthog) result.posthog = posthog;
	}
	if (enabled.has("sentry")) {
		const sentry = detectSentry();
		if (sentry) result.sentry = sentry;
	}
	return result;
}

function detectPostHog(): PostHogIntegrationState | null {
	const token = findPostHogToken();
	if (!token) return null;

	const state = readPostHogState(token);
	const sesid = Array.isArray(state?.$sesid) ? state.$sesid : null;
	const sessionId = typeof sesid?.[1] === "string" ? sesid[1] : null;
	if (!sessionId) {
		// Token-key sentinel exists but $sesid hasn't landed yet (PostHog
		// persists it lazily on the first event capture). The auto-detect
		// warmup recheck and poll interval will pick it up.
		return null;
	}

	const distinctId = stringOrUndefined(state?.distinct_id);
	const userId = stringOrUndefined(state?.$user_id);

	const out: PostHogIntegrationState = { sessionId };
	if (distinctId !== undefined) out.distinctId = distinctId;
	if (userId !== undefined) out.userId = userId;
	return out;
}

// Single-instance — we don't enumerate children for named secondary
// instances.
function findPostHogToken(): string | null {
	const fromLs = firstMatchingStorageKey(safeLocalStorage());
	if (fromLs) return fromLs;
	const fromSs = firstMatchingStorageKey(safeSessionStorage());
	if (fromSs) return fromSs;
	const fromCookie = firstMatchingCookieToken();
	if (fromCookie) return fromCookie;
	return null;
}

function firstMatchingCookieToken(): string | null {
	try {
		const raw = document.cookie;
		if (!raw) return null;
		// Match `ph_<token>_posthog=` directly against the cookie string —
		// cheaper than splitting twice and avoids allocating an array.
		const match = /(?:^|;\s*)ph_(.+?)_posthog=/.exec(raw);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

function firstMatchingStorageKey(storage: Storage | null): string | null {
	if (!storage) return null;
	try {
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (!key) continue;
			const m = POSTHOG_KEY_PATTERN.exec(key);
			if (m) return m[1];
		}
	} catch {
		// Storage may throw on access in some sandboxed contexts.
	}
	return null;
}

function readPostHogState(token: string): Record<string, unknown> | null {
	const key = `ph_${token}_posthog`;
	// Layer order: localStorage is the richest source (default
	// 'localStorage+cookie' writes the full blob there) and must override
	// the sessionStorage entry, which under that same persistence holds
	// only extension/debug data.
	const ss = parseJson(safeSessionStorageGet(key));
	const cookie = parseJson(readCookie(key));
	const ls = parseJson(safeLocalStorageGet(key));
	if (!ss && !cookie && !ls) return null;
	return { ...(ss ?? {}), ...(cookie ?? {}), ...(ls ?? {}) };
}

function detectSentry(): SentryIntegrationState | null {
	const raw = safeSessionStorageGet(SENTRY_REPLAY_KEY);
	if (!raw) return null;
	const parsed = parseJson(raw);
	if (!parsed) return null;
	const replayId = stringOrUndefined(parsed.id);
	if (!replayId) return null;
	return { replayId };
}

function safeLocalStorage(): Storage | null {
	try {
		return window.localStorage ?? null;
	} catch {
		return null;
	}
}

function safeSessionStorage(): Storage | null {
	try {
		return window.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function safeLocalStorageGet(key: string): string | null {
	try {
		return window.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function safeSessionStorageGet(key: string): string | null {
	try {
		return window.sessionStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function readCookie(name: string): string | null {
	try {
		const raw = document.cookie;
		if (!raw) return null;
		for (const part of raw.split(";")) {
			const trimmed = part.trim();
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;
			if (trimmed.slice(0, eq) === name) {
				return decodeURIComponent(trimmed.slice(eq + 1));
			}
		}
	} catch {
		// document.cookie can throw under tight CSP / partitioned cookie
		// rules; swallow.
	}
	return null;
}

function parseJson(s: string | null): Record<string, unknown> | null {
	if (!s) return null;
	try {
		const parsed = JSON.parse(s);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function stringOrUndefined(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
