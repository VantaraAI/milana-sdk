import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clientKey,
	dispatchBeforeUnload,
	dispatchPageHide,
	dispatchPageShow,
	dispatchVisibilityChange,
	getBatchCalls,
	getPageCloseCalls,
	getUrlString,
	importMilana,
	importSession,
	makeUpdateSuccessResponse,
	mockFetch,
	productId,
	seedEvents,
	setupCoreTestHarness,
	teardownLingeringSession,
} from "./helpers";

const defaultUserAgent = navigator.userAgent;
const defaultUserActivation = (
	navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }
).userActivation;
const chromeUserAgent =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

function setUserAgent(userAgent: string): void {
	Object.defineProperty(navigator, "userAgent", {
		value: userAgent,
		configurable: true,
	});
}

function setUserActivation(hasBeenActive: boolean | undefined): void {
	Object.defineProperty(navigator, "userActivation", {
		value:
			hasBeenActive === undefined ? defaultUserActivation : { hasBeenActive },
		configurable: true,
	});
}

describe("Core Library - Page Close Events", () => {
	setupCoreTestHarness();

	beforeEach(() => {
		setUserAgent(chromeUserAgent);
	});

	afterEach(async () => {
		await teardownLingeringSession();
		setUserAgent(defaultUserAgent);
		setUserActivation(undefined);
	});

	test("fires POST /batch with isPageClose on pagehide with persisted=false (empty buffer)", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "page-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("page-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);

		const [url, init_] = closeCalls[0];
		// URL is identical to regular /batch — same preflight cache entry.
		expect(getUrlString(url)).toBe("https://in.getmilana.ai/batch");
		expect(init_).toMatchObject({
			method: "POST",
			keepalive: true,
			headers: expect.objectContaining({
				"X-Milana-Product-Id": productId,
				"X-Milana-Client-Key": clientKey,
				"X-Milana-Session-Id": "page-close-session",
			}) as Record<string, string>,
		});

		const body = JSON.parse(init_?.body as string);
		expect(body).toMatchObject({ version: 1, isPageClose: true, events: [] });
		expect(body.isTruncated).toBeUndefined();
		expect(typeof body.batchStartedAt).toBe("number");
	});

	test("close ping ignores buffered events — visibility-hidden owns delivery", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "page-close-with-events",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("page-close-with-events")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: unknown[];
			bufferedCharacters: number;
		};
		seedEvents(session as never, [
			{ timestamp: 1000, type: 3, data: { source: 2 } },
			{ timestamp: 1200, type: 3, data: { source: 3 } },
		]);

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);

		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({
			version: 1,
			isPageClose: true,
			events: [],
		});
		expect(body.isTruncated).toBeUndefined();
		expect(typeof body.batchStartedAt).toBe("number");
	});

	test("does not fire when pagehide has persisted=true (bfcache freeze)", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "bfcache-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: true });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("does not fire for unsampled sessions", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: false,
							sessionId: "unsampled-close-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("sends close exactly once even if pagehide fires multiple times", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "idempotent-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("idempotent-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });
		dispatchPageHide({ persisted: false });
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(1);
	});

	test("removes the pagehide listener after stopRecording", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "stop-recording-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Force stopRecording by driving the session into a terminal state. We
		// invoke the private method directly rather than replay a sampling
		// downgrade on /update because this test only cares about listener
		// cleanup, not the upstream trigger.
		const session = MilanaSession.currentSession as unknown as {
			stopRecording: () => void;
			pageCloseHandler: unknown;
		};
		session.stopRecording();

		expect(session.pageCloseHandler).toBeNull();

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("close ping is fixed-size regardless of buffer state", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "fixed-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("fixed-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Seed a buffer larger than the keepalive budget to verify the
		// close ping is unaffected by buffer state.
		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
		};
		session.events = [
			{ serialized: `"${"x".repeat(70_000)}"`, timestamp: 1000 },
		];
		session.bufferedCharacters = 70_000;

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);
		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({
			version: 1,
			isPageClose: true,
			events: [],
		});
		expect(body.isTruncated).toBeUndefined();
		// Sanity-check the budget headroom claim: well under the 65,536-byte
		// per-document keepalive limit.
		expect((closeCalls[0][1]?.body as string).length).toBeLessThan(200);
	});

	test("close ping ignores in-flight regular batches (visibility-hidden aborts them)", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "inflight-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("inflight-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: unknown[];
			bufferedCharacters: number;
			isSendingEvents: boolean;
		};
		seedEvents(session as never, [
			{ timestamp: 1000, type: 3, data: { source: 2 } },
		]);
		// Exercise pagehide in isolation. Aborting + reclaiming an
		// in-flight batch is tested in visibility-change.test.ts.
		session.isSendingEvents = true;

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);
		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({ isPageClose: true, events: [] });
		expect(body.isTruncated).toBeUndefined();
	});

	// MIL-697: Mobile Chrome / Android fires pagehide(persisted=false) when
	// the OS backgrounds a tab whose page is bfcache-ineligible. Without a
	// preceding beforeunload, that is NOT a real unload — the user will
	// likely return to the tab. Sending isPageClose causes the server to
	// close the session, and subsequent batches under the same session id
	// get rejected, splitting one user session into two server sessions.
	test("MIL-697: does NOT fire close on pagehide(persisted=false) when no beforeunload preceded it", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "mil-697-background-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("Chromium close falls back to pagehide when sticky activation is absent", async () => {
		setUserActivation(false);

		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "chromium-no-activation-close-session",
						}),
				} as Response,
			],
			"/batch": [
				makeUpdateSuccessResponse("chromium-no-activation-close-session"),
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(1);
	});

	test("Chromium without sticky activation still skips close after background visibility", async () => {
		setUserActivation(false);

		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "chromium-no-activation-background-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchVisibilityChange("hidden");
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("does NOT fire close on pagehide(persisted=true) even if beforeunload preceded it", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "bfcache-with-intent-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: true });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("unload intent resets on visibilitychange to visible", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "visible-reset-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Stale unload intent from an earlier navigation attempt.
		dispatchBeforeUnload();
		// User returns to the tab (e.g., after dismissing a navigation
		// prompt elsewhere on the page).
		dispatchVisibilityChange("visible");
		// Now the tab is backgrounded — should NOT close.
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("unload intent resets on pageshow", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "pageshow-reset-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Outgoing navigation: beforeunload, then page enters bfcache.
		dispatchBeforeUnload();
		dispatchPageHide({ persisted: true });
		// Back navigation restores the page from bfcache.
		dispatchPageShow({ persisted: true });
		// Later, user backgrounds the tab — should NOT close.
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("unload intent resets at next animation frame after cancelled navigation", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "cancelled-nav-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Customer's own beforeunload handler prompted the user, who clicked
		// "Stay". beforeunload fired, but pagehide never did.
		dispatchBeforeUnload();
		// The page is still alive — animation frames fire. Advance past it.
		await vi.advanceTimersByTimeAsync(20);
		// Now the user backgrounds the tab — should NOT close.
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("beforeunload handler is a no-op: does not preventDefault or set returnValue", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "no-op-beforeunload-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Sanity-check that init actually registered a beforeunload listener.
		// Without this, the assertions below would pass vacuously.
		const session = MilanaSession.currentSession as unknown as {
			beforeUnloadHandler: unknown;
		};
		expect(typeof session.beforeUnloadHandler).toBe("function");

		const event = dispatchBeforeUnload();

		expect(event.defaultPrevented).toBe(false);
		// Per the BeforeUnloadEvent spec, assigning a non-empty string to
		// `event.returnValue` is what triggers the native "Leave site?"
		// prompt and historically blocked bfcache. The handler must not
		// touch it.
		const returnValue = (event as unknown as { returnValue: unknown })
			.returnValue;
		expect(typeof returnValue).not.toBe("string");
	});

	test("does not require beforeunload outside Chromium browsers", async () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
		);

		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "firefox-page-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("firefox-page-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			beforeUnloadHandler: unknown;
		};
		expect(session.beforeUnloadHandler).toBeNull();

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(1);
	});

	test("does not require beforeunload on mobile WebKit", async () => {
		setUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		);

		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "mobile-webkit-page-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("mobile-webkit-page-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			beforeUnloadHandler: unknown;
		};
		expect(session.beforeUnloadHandler).toBeNull();

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(1);
	});

	test("removes beforeunload and pageshow listeners after stopRecording", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "stop-recording-unload-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			stopRecording: () => void;
			beforeUnloadHandler: unknown;
			pageShowHandler: unknown;
		};
		session.stopRecording();

		expect(session.beforeUnloadHandler).toBeNull();
		expect(session.pageShowHandler).toBeNull();

		dispatchBeforeUnload();
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("MIL-697 integration: backgrounding flushes events via visibility-hidden without sending isPageClose", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "mil-697-integration-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("mil-697-integration-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: unknown[];
			bufferedCharacters: number;
		};
		seedEvents(session as never, [
			{ timestamp: 1000, type: 3, data: { source: 2 } },
			{ timestamp: 1200, type: 3, data: { source: 3 } },
		]);

		// Mobile backgrounding sequence: visibility-hidden then pagehide,
		// neither preceded by beforeunload.
		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		dispatchPageHide({ persisted: false });
		const newBatchCalls = getBatchCalls().slice(callCountBefore);

		// Exactly one /batch call (the visibility-hidden flush); no close ping.
		expect(newBatchCalls).toHaveLength(1);
		const body = JSON.parse(newBatchCalls[0][1]?.body as string);
		expect(body.events).toHaveLength(2);
		expect(body.isPageClose).toBeUndefined();
		expect(getPageCloseCalls()).toHaveLength(0);

		// Sanity: the flushed batch went to /batch with keepalive.
		expect(getUrlString(newBatchCalls[0][0])).toBe(
			"https://in.getmilana.ai/batch",
		);
		expect(newBatchCalls[0][1]).toMatchObject({ keepalive: true });
	});
});
