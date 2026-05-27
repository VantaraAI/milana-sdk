import type { eventWithTime } from "@rrweb/types";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

export const productId = "prd_00000000000000000000000000";
export const clientKey = "key_THIS_IS_A_FAKE_TEST_KEY_NOT_A_REAL_CREDENTIAL";

export const logMetricsIntervalDuration = 30000;

// Shared third-party SDK storage fixtures — captured from real PostHog
// v1.372.5 and Sentry replay v10.51.0.
// Used by tests/core/integration-detector.test.ts and integration-auto-detect.test.ts.
export const FAKE_POSTHOG_TOKEN = "phc_FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEY01";
export const FAKE_POSTHOG_KEY = `ph_${FAKE_POSTHOG_TOKEN}_posthog`;

export const FIXTURE_POSTHOG_STATE = {
	$initialization_time: "2026-05-07T22:01:33.026Z",
	$configured_session_timeout_ms: 1800000,
	distinct_id: "user_42",
	$device_id: "019e0475-da64-7c34-8497-e8a23c134e0c",
	$user_state: "identified",
	$user_id: "user_42",
	$sesid: [
		1778191293031,
		"019e0475-da67-7be9-9830-ec4c03005331",
		1778191293031,
	] as [number, string, number],
};

export const FIXTURE_SENTRY_REPLAY_SESSION = {
	id: "0ecb464e7d96416a90ce56a60f1e2750",
	started: 1778190678699,
	lastActivity: 1778190678699,
	segmentId: 0,
	sampled: "session" as const,
	dirty: false,
};

export type TestSessionInternals = {
	pushEvent: (event: eventWithTime) => void;
	logMetrics: () => Promise<void>;
	tryToSendEvents: () => unknown;
	stopRecording: () => void;
	stopRrwebRecording: (() => void) | null;
	events: Array<unknown>;
	bufferedCharacters: number;
	counters: {
		numSessionsAbortedDueToBufferExceeded: number;
	};
	isSendingMetrics: boolean;
	retryCount: number;
	retryTimeout: ReturnType<typeof setTimeout> | null;
	flushInterval: ReturnType<typeof setInterval> | null;
	logMetricsInterval: ReturnType<typeof setInterval> | null;
	worstInpValues: number[];
	totalInpEventCount: number;
	longTaskDurationSum: number;
	longTaskCount: number;
	totalLongTaskBlockingTime: number;
	recordingStartTime: number;
};

export const getUrlString = (url: RequestInfo | URL): string => {
	if (typeof url === "string") {
		return url;
	}
	if (url instanceof URL) {
		return url.href;
	}
	return url.url;
};

export const makeUpdateSuccessResponse = (
	sessionId: string,
	options?: { sampled?: boolean },
) =>
	({
		ok: true,
		json: () =>
			Promise.resolve({
				success: true,
				sessionId,
				sampled: options?.sampled ?? true,
			}),
	}) as Response;

export const makeUpdateFailureResponse = ({
	statusCode = 400,
	errorCode,
	shouldRestartSession = true,
}: {
	statusCode?: number;
	errorCode: string;
	shouldRestartSession?: boolean;
}) =>
	({
		ok: statusCode >= 200 && statusCode < 300,
		json: () =>
			Promise.resolve({
				success: false,
				shouldRestartSession,
				errorCode,
			}),
	}) as Response;

export const mockFetch = (
	responses: Record<string, Array<Response | Error>>,
) => {
	const callCounts: Record<string, number> = {};

	vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;

		const urlObj = new URL(url);
		const endpoint = urlObj.pathname;

		if (!callCounts[endpoint]) {
			callCounts[endpoint] = 0;
		}

		const responseList = responses[endpoint];
		if (!responseList || callCounts[endpoint] >= responseList.length) {
			return Promise.reject(
				new Error(
					`Unexpected fetch call to ${endpoint} (call #${callCounts[endpoint] + 1})`,
				),
			);
		}

		const response = responseList[callCounts[endpoint]];
		callCounts[endpoint]++;

		if (response instanceof Error) {
			return Promise.reject(response);
		}

		return Promise.resolve(response);
	});

	return { callCounts };
};

export type MockBufferedEvent = { timestamp: number } & Record<string, unknown>;

export const toEvents = (events: MockBufferedEvent[]) =>
	events.map((event) => ({
		serialized: JSON.stringify(event),
		timestamp: event.timestamp,
	}));

export const seedEvents = (session: unknown, events: MockBufferedEvent[]) => {
	const serializedEvents = toEvents(events);
	(session as { events: ReturnType<typeof toEvents> }).events =
		serializedEvents;
	(session as { bufferedCharacters: number }).bufferedCharacters =
		serializedEvents.reduce(
			(total, event) => total + event.serialized.length,
			0,
		);
};

export function dispatchPageHide(options: { persisted: boolean }): void {
	const event = new Event("pagehide");
	Object.defineProperty(event, "persisted", { value: options.persisted });
	window.dispatchEvent(event);
}

export function dispatchPageShow(options: { persisted: boolean }): void {
	const event = new Event("pageshow");
	Object.defineProperty(event, "persisted", { value: options.persisted });
	window.dispatchEvent(event);
}

export function dispatchBeforeUnload(): Event {
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	return event;
}

export function dispatchVisibilityChange(
	visibilityState: "hidden" | "visible",
): void {
	Object.defineProperty(document, "visibilityState", {
		value: visibilityState,
		configurable: true,
	});
	document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Reads the persisted session-state blob the SDK now writes to
 * sessionStorage (replacing the bare "sessionId" string). Returns null when
 * no blob is present.
 */
export function readStoredSessionState(): {
	sessionId: string | null;
	user: Record<string, unknown> | null;
	sessionContext: Record<string, unknown> | null;
} | null {
	const raw = window.sessionStorage.getItem("milana_session_state");
	return raw ? JSON.parse(raw) : null;
}

export function readStoredSessionId(): string | null {
	return readStoredSessionState()?.sessionId ?? null;
}

export function getCallsToEndpoint(endpoint: string) {
	return vi
		.mocked(fetch)
		.mock.calls.filter((call) => getUrlString(call[0]).endsWith(endpoint));
}

export function getBatchCalls() {
	return getCallsToEndpoint("/batch");
}

export function getPageCloseCalls() {
	return vi.mocked(fetch).mock.calls.filter((call) => {
		const init = call[1] as RequestInit | undefined;
		const body = init?.body;
		if (typeof body !== "string") return false;
		try {
			return JSON.parse(body).isPageClose === true;
		} catch {
			return false;
		}
	});
}

/**
 * vi.resetModules() gives each test a fresh MilanaSession class, but listeners
 * attached to `window`/`document` (pagehide, visibilitychange) survive the
 * module reset. If a test leaves a live session behind, its handlers fire
 * during the next test's dispatch and issue stray requests. Call this from
 * `afterEach` in any suite that drives those events.
 */
export async function teardownLingeringSession(): Promise<void> {
	const mod = await import("../../src/core/session.ts");
	const session = mod.MilanaSession.currentSession as unknown as {
		stopRecording?: () => void;
	} | null;
	session?.stopRecording?.();
}

const unhandledRejectionHandler = (reason: unknown) => {
	console.warn("unhandledRejection during this test", reason);
};

export let addCustomEventMock: ReturnType<typeof vi.fn>;

/**
 * Call this in every core test file's top-level describe block to set up
 * the rrweb mock and fake timers shared by all core tests.
 */
export function setupCoreTestHarness() {
	beforeAll(() => {
		process.on("unhandledRejection", unhandledRejectionHandler);
	});

	beforeEach(() => {
		vi.useFakeTimers();

		addCustomEventMock = vi.fn();
		const stopRecordingMock = vi.fn();
		const recordMock = vi.fn(() => stopRecordingMock);
		Object.assign(recordMock, {
			addCustomEvent: addCustomEventMock,
			freezePage: vi.fn(),
			takeFullSnapshot: vi.fn(),
			mirror: {},
		});
		vi.doMock("@rrweb/record", () => ({
			record: recordMock,
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("@rrweb/record");
	});

	afterAll(() => {
		process.off("unhandledRejection", unhandledRejectionHandler);
	});
}

/**
 * Sets up the documented script-tag stub on `window`. Mirrors the
 * documented script-tag snippet:
 *
 *     window._milanaQueue = window._milanaQueue || [];
 *     function Milana() { window._milanaQueue.push([].slice.call(arguments)); }
 *
 * Tests that exercise the script-tag flow should call this before
 * `Milana(...)` to stage pre-load behavior, then `await import(cdn-entry)`
 * to "load" the SDK; after that, `window.Milana` is the real callable.
 */
export function setupDocumentedStub(): void {
	if (typeof window === "undefined") return;
	window._milanaQueue = window._milanaQueue || [];
	window.Milana = function Milana(...args: unknown[]) {
		window._milanaQueue?.push(args as [string, ...unknown[]]);
	} as unknown as typeof window.Milana;
}

/**
 * Calls `window.Milana(...)` exactly the way a customer's script tag
 * would. Goes through whichever implementation is currently on the
 * window — the docs stub before script load, the real SDK after.
 */
export function callMilana(...args: unknown[]): void {
	(window.Milana as unknown as (...a: unknown[]) => void)(...args);
}

/**
 * Import the milana core module fresh (after vi.resetModules in setup.ts).
 * Returns the exported API functions.
 */
export async function importMilana() {
	const mod = await import("../../src/core/index.ts");
	return mod;
}

/**
 * Import the MilanaSession class for internal inspection in tests.
 */
export async function importSession() {
	const mod = await import("../../src/core/session.ts");
	return mod;
}
