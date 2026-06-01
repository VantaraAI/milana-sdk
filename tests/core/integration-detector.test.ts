import { beforeEach, describe, expect, test } from "vitest";
import { detectIntegrations } from "../../src/core/integration-detector";
import type { IntegrationName } from "../../src/core/types";
import {
	FAKE_POSTHOG_KEY,
	FIXTURE_POSTHOG_STATE,
	FIXTURE_SENTRY_REPLAY_SESSION,
} from "./helpers";

const ALL: ReadonlySet<IntegrationName> = new Set(["sentry", "posthog"]);
const ONLY_SENTRY: ReadonlySet<IntegrationName> = new Set(["sentry"]);
const ONLY_POSTHOG: ReadonlySet<IntegrationName> = new Set(["posthog"]);
const NONE: ReadonlySet<IntegrationName> = new Set();

function clearCookies() {
	for (const part of document.cookie.split(";")) {
		const name = part.trim().split("=", 1)[0];
		// biome-ignore lint/suspicious/noDocumentCookie: tests need to set/reset jsdom cookies directly to exercise the cookie-reading code path
		if (name) document.cookie = `${name}=; max-age=0; path=/`;
	}
}

describe("integration-detector", () => {
	beforeEach(() => {
		// localStorage / sessionStorage are reset in tests/setup.ts beforeEach;
		// document.cookie persists in jsdom across tests, so wipe explicitly.
		clearCookies();
	});

	test("returns {} when no vendors enabled", () => {
		// Even with both SDKs' state seeded, an empty enabled set must
		// short-circuit and produce no result.
		localStorage.setItem(
			FAKE_POSTHOG_KEY,
			JSON.stringify(FIXTURE_POSTHOG_STATE),
		);
		sessionStorage.setItem(
			"sentryReplaySession",
			JSON.stringify(FIXTURE_SENTRY_REPLAY_SESSION),
		);

		const result = detectIntegrations(NONE);
		expect(result).toEqual({});
	});

	test("returns {} on a fresh page with no SDK state", () => {
		const result = detectIntegrations(ALL);
		expect(result).toEqual({});
	});

	describe("PostHog", () => {
		test("reads from localStorage in the default config", () => {
			localStorage.setItem(
				FAKE_POSTHOG_KEY,
				JSON.stringify(FIXTURE_POSTHOG_STATE),
			);

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog).toEqual({
				sessionId: "019e0475-da67-7be9-9830-ec4c03005331",
				distinctId: "user_42",
				userId: "user_42",
			});
		});

		test("reads from cookie when persistence is 'cookie'", () => {
			// Mirrors persistence: 'cookie' — only the cookie store has the
			// session blob; localStorage and sessionStorage are empty.
			// biome-ignore lint/suspicious/noDocumentCookie: tests need to set jsdom cookies directly to exercise the cookie-reading code path
			document.cookie = `${FAKE_POSTHOG_KEY}=${encodeURIComponent(JSON.stringify(FIXTURE_POSTHOG_STATE))}`;

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog?.sessionId).toBe(
				"019e0475-da67-7be9-9830-ec4c03005331",
			);
		});

		test("returns null PostHog entry when token sentinel exists but $sesid hasn't landed", () => {
			// Mimics the warm-up race: token key present, but PostHog hasn't
			// captured its first event yet so $sesid is missing. The detector
			// must NOT emit a partial entry; the auto-detect loop will retry.
			const partial = { ...FIXTURE_POSTHOG_STATE };
			// @ts-expect-error: deleting an optional field intentionally
			delete partial.$sesid;
			localStorage.setItem(FAKE_POSTHOG_KEY, JSON.stringify(partial));

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog).toBeUndefined();
		});

		test("merges localStorage and sessionStorage so localStorage wins on overlapping fields", () => {
			// sessionStorage often holds extension/debug data at the same
			// key as localStorage when persistence is localStorage-based.
			// localStorage is the richer source and must win.
			sessionStorage.setItem(
				FAKE_POSTHOG_KEY,
				JSON.stringify({
					$sdk_debug_extensions_init_method: "synchronous",
					distinct_id: "should-be-ignored",
				}),
			);
			localStorage.setItem(
				FAKE_POSTHOG_KEY,
				JSON.stringify(FIXTURE_POSTHOG_STATE),
			);

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog?.distinctId).toBe("user_42");
		});

		test("omits userId when the user is anonymous (no $user_id)", () => {
			const anonymous = { ...FIXTURE_POSTHOG_STATE };
			// @ts-expect-error: deleting an optional field intentionally
			delete anonymous.$user_id;
			anonymous.distinct_id = "anonymous-uuid";
			anonymous.$user_state = "anonymous";
			localStorage.setItem(FAKE_POSTHOG_KEY, JSON.stringify(anonymous));

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog?.userId).toBeUndefined();
			expect(result.posthog?.distinctId).toBe("anonymous-uuid");
		});

		test("returns no posthog field on malformed JSON", () => {
			localStorage.setItem(FAKE_POSTHOG_KEY, "{not valid json");

			const result = detectIntegrations(ONLY_POSTHOG);
			expect(result.posthog).toBeUndefined();
		});
	});

	describe("Sentry", () => {
		test("reads replayId from sessionStorage", () => {
			sessionStorage.setItem(
				"sentryReplaySession",
				JSON.stringify(FIXTURE_SENTRY_REPLAY_SESSION),
			);

			const result = detectIntegrations(ONLY_SENTRY);
			expect(result.sentry).toEqual({
				replayId: "0ecb464e7d96416a90ce56a60f1e2750",
			});
		});

		test("returns no sentry field when replay integration is not enabled", () => {
			// When customer didn't add replayIntegration() to Sentry.init,
			// the sessionStorage key is simply absent.
			const result = detectIntegrations(ONLY_SENTRY);
			expect(result.sentry).toBeUndefined();
		});

		test("returns no sentry field on malformed JSON", () => {
			sessionStorage.setItem("sentryReplaySession", "}}}");

			const result = detectIntegrations(ONLY_SENTRY);
			expect(result.sentry).toBeUndefined();
		});

		test("returns no sentry field when id is missing", () => {
			sessionStorage.setItem(
				"sentryReplaySession",
				JSON.stringify({ ...FIXTURE_SENTRY_REPLAY_SESSION, id: undefined }),
			);

			const result = detectIntegrations(ONLY_SENTRY);
			expect(result.sentry).toBeUndefined();
		});
	});

	describe("enabled-set filtering", () => {
		test("returns only sentry when only sentry is enabled, even if posthog is on the page", () => {
			localStorage.setItem(
				FAKE_POSTHOG_KEY,
				JSON.stringify(FIXTURE_POSTHOG_STATE),
			);
			sessionStorage.setItem(
				"sentryReplaySession",
				JSON.stringify(FIXTURE_SENTRY_REPLAY_SESSION),
			);

			const result = detectIntegrations(ONLY_SENTRY);
			expect(result.sentry).toBeDefined();
			expect(result.posthog).toBeUndefined();
		});
	});
});
