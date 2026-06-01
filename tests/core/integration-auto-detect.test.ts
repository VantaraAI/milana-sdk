import { describe, expect, test, vi } from "vitest";
import type {
	IntegrationName,
	SessionInfo,
	SessionIntegrations,
} from "../../src/core/types";
import {
	clientKey,
	FAKE_POSTHOG_KEY,
	FIXTURE_POSTHOG_STATE,
	FIXTURE_SENTRY_REPLAY_SESSION,
	getUrlString,
	importMilana,
	makeUpdateSuccessResponse,
	mockFetch,
	productId,
	setupCoreTestHarness,
} from "./helpers";

const DEFAULT_SESSION_INFO: SessionInfo = {
	environment: "test",
	version: "1.0",
	metadata: {},
};

function updateBodies(): Array<Record<string, unknown>> {
	return vi
		.mocked(fetch)
		.mock.calls.filter(
			(call) =>
				getUrlString(call[0] as RequestInfo) ===
				"https://in.getmilana.ai/update",
		)
		.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

function lastUpdateIntegrations(): SessionIntegrations | undefined {
	const updates = updateBodies();
	if (updates.length === 0) return undefined;
	const session = updates[updates.length - 1].session as
		| { integrations?: SessionIntegrations }
		| undefined;
	return session?.integrations;
}

function seedBothVendors() {
	localStorage.setItem(FAKE_POSTHOG_KEY, JSON.stringify(FIXTURE_POSTHOG_STATE));
	sessionStorage.setItem(
		"sentryReplaySession",
		JSON.stringify(FIXTURE_SENTRY_REPLAY_SESSION),
	);
}

async function initWith(
	integrations?: IntegrationName[],
	info: SessionInfo = DEFAULT_SESSION_INFO,
) {
	const { init } = await importMilana();
	mockFetch({
		"/session": [
			{
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "test-session" }),
			} as Response,
		],
		"/update": Array.from({ length: 5 }, () =>
			makeUpdateSuccessResponse("test-session"),
		),
	});
	await init(
		productId,
		clientKey,
		info,
		integrations !== undefined ? { integrations } : undefined,
	);
}

describe("Integration auto-detection", () => {
	setupCoreTestHarness();

	test("default (integrations option absent) does not auto-detect or call /update", async () => {
		seedBothVendors();
		await initWith();
		await vi.advanceTimersByTimeAsync(70_000);

		expect(updateBodies()).toHaveLength(0);
	});

	test("explicit integrations: [] does not auto-detect", async () => {
		seedBothVendors();
		await initWith([]);
		await vi.advanceTimersByTimeAsync(70_000);

		expect(updateBodies()).toHaveLength(0);
	});

	test("integrations: ['sentry', 'posthog'] sends both vendor entries on first tick", async () => {
		seedBothVendors();
		await initWith(["sentry", "posthog"]);
		// Drain microtasks so the synchronous first detect's fetch resolves.
		await vi.advanceTimersByTimeAsync(0);

		const updates = updateBodies();
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates[0]).toEqual({
			session: {
				integrations: {
					sentry: { replayId: FIXTURE_SENTRY_REPLAY_SESSION.id },
					posthog: {
						sessionId: FIXTURE_POSTHOG_STATE.$sesid[1],
						distinctId: "user_42",
						userId: "user_42",
					},
				},
			},
		});
	});

	test("integrations: ['sentry'] only sends sentry even when posthog state is on the page", async () => {
		seedBothVendors();
		await initWith(["sentry"]);
		await vi.advanceTimersByTimeAsync(0);

		const integrations = lastUpdateIntegrations();
		expect(integrations?.sentry).toBeDefined();
		expect(integrations?.posthog).toBeUndefined();
	});

	test("warm-up recheck catches a late-landing PostHog $sesid", async () => {
		// Sentry available immediately, PostHog NOT seeded yet.
		sessionStorage.setItem(
			"sentryReplaySession",
			JSON.stringify(FIXTURE_SENTRY_REPLAY_SESSION),
		);
		await initWith(["sentry", "posthog"]);
		await vi.advanceTimersByTimeAsync(0);

		const firstIntegrations = lastUpdateIntegrations();
		expect(firstIntegrations?.sentry).toBeDefined();
		expect(firstIntegrations?.posthog).toBeUndefined();

		// PostHog warmup completes — $sesid lands.
		localStorage.setItem(
			FAKE_POSTHOG_KEY,
			JSON.stringify(FIXTURE_POSTHOG_STATE),
		);
		await vi.advanceTimersByTimeAsync(5000);

		expect(lastUpdateIntegrations()?.posthog?.sessionId).toBe(
			FIXTURE_POSTHOG_STATE.$sesid[1],
		);
	});

	test("identical integrations between ticks are deduped via the local fingerprint", async () => {
		seedBothVendors();
		await initWith(["sentry", "posthog"]);
		await vi.advanceTimersByTimeAsync(0);
		const afterFirst = updateBodies().length;
		expect(afterFirst).toBeGreaterThanOrEqual(1);

		// Warm-up tick + 30s interval tick — neither should add a new HTTP
		// call because the integration fingerprint hasn't changed.
		await vi.advanceTimersByTimeAsync(35_000);

		expect(updateBodies()).toHaveLength(afterFirst);
	});

	test("storage rotation between ticks triggers a fresh /update", async () => {
		seedBothVendors();
		await initWith(["sentry", "posthog"]);
		await vi.advanceTimersByTimeAsync(0);
		const baseline = updateBodies().length;

		const rotatedSentry = {
			...FIXTURE_SENTRY_REPLAY_SESSION,
			id: "rotatedreplay00000000000000000ab",
		};
		sessionStorage.setItem(
			"sentryReplaySession",
			JSON.stringify(rotatedSentry),
		);
		await vi.advanceTimersByTimeAsync(5000);

		expect(updateBodies().length).toBeGreaterThan(baseline);
		expect(lastUpdateIntegrations()?.sentry?.replayId).toBe(rotatedSentry.id);
	});

	test("appSessionId at init goes into the /session POST body", async () => {
		await initWith(undefined, {
			environment: "test",
			version: "1.0",
			metadata: { foo: 1 },
			appSessionId: "auth_sess_abc123",
		});

		const sessionCall = vi
			.mocked(fetch)
			.mock.calls.find(
				(call) =>
					getUrlString(call[0] as RequestInfo) ===
					"https://in.getmilana.ai/session",
			);
		expect(sessionCall).toBeDefined();
		const body = JSON.parse(String((sessionCall?.[1] as RequestInit).body));
		expect(body.appSessionId).toBe("auth_sess_abc123");
		expect(body.metadata).toEqual({ foo: 1 });
	});

	test("appSessionId via updateSession lands in /update body", async () => {
		const { updateSession } = await importMilana();
		await initWith();

		await updateSession({ appSessionId: "rotation_id_2" });

		expect(updateBodies()[0].session).toEqual({
			appSessionId: "rotation_id_2",
		});
	});
});
