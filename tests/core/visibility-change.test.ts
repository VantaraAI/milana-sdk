import { afterEach, describe, expect, test, vi } from "vitest";
import { MILANA_CUSTOM_EVENT_TAG } from "../../src/core/session.ts";
import {
	addCustomEventMock,
	clientKey,
	dispatchVisibilityChange,
	getBatchCalls,
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

describe("Core Library - Visibility Change Events", () => {
	setupCoreTestHarness();

	afterEach(async () => {
		await teardownLingeringSession();
		// Reset for the next test so its first hidden transition fires.
		dispatchVisibilityChange("visible");
	});

	test("emits custom event on visibility change to hidden during recording", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "visibility-test-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		addCustomEventMock.mockClear();
		dispatchVisibilityChange("hidden");

		expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
			type: 4,
			visibilityState: "hidden",
		});
	});

	test("does not emit when session is not sampled", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: false,
							sessionId: "unsampled-visibility-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		addCustomEventMock.mockClear();
		dispatchVisibilityChange("hidden");

		expect(addCustomEventMock).not.toHaveBeenCalled();
	});

	test("flushes buffered events via keepalive when visibility goes hidden", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "vis-flush-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("vis-flush-session")],
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

		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		const newCalls = getBatchCalls().slice(callCountBefore);

		expect(newCalls).toHaveLength(1);
		const [url, init_] = newCalls[0];
		expect(getUrlString(url)).toBe("https://in.getmilana.ai/batch");
		expect(init_).toMatchObject({
			method: "POST",
			keepalive: true,
		});

		const body = JSON.parse(init_?.body as string);
		expect(body.batchStartedAt).toBe(1000);
		expect(body.events).toHaveLength(2);
		expect(body.isPageClose).toBeUndefined();

		// Buffer is cleared so a subsequent pagehide close doesn't re-send.
		expect(session.events).toHaveLength(0);
		expect(session.bufferedCharacters).toBe(0);
	});

	test("uses the full keepalive budget on visibility-hidden", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "vis-budget-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("vis-budget-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
		};
		// Sits just inside the 65,536-byte keepalive budget after the
		// JSON envelope.
		session.events = [
			{ serialized: `"${"x".repeat(64_900)}"`, timestamp: 1000 },
		];
		session.bufferedCharacters = 64_900;

		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		const newCalls = getBatchCalls().slice(callCountBefore);

		expect(newCalls).toHaveLength(1);
		expect(newCalls[0][1]).toMatchObject({ keepalive: true });
		expect(session.events).toHaveLength(0);
	});

	test("does not abort in-flight batch when the would-be payload exceeds the keepalive budget", async () => {
		// Boundary case: `bufferedCharacters` is just under the limit but
		// the JSON envelope pushes the final payload over. The handler
		// must check the built payload size *before* aborting the in-flight
		// batch — otherwise we'd kill the active send AND skip the keepalive.
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		const abortSpy = vi.fn();
		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "vis-boundary-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("vis-boundary-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
			isSendingEvents: boolean;
			inFlightEventsAbortController: { abort: () => void } | null;
		};
		// Just under the 65,536 raw-char limit, but the {"version":1,...}
		// envelope + commas push the built payload over.
		session.events = [
			{ serialized: `"${"x".repeat(65_500)}"`, timestamp: 1000 },
		];
		session.bufferedCharacters = 65_500;
		session.isSendingEvents = true;
		session.inFlightEventsAbortController = { abort: abortSpy };

		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		const newCalls = getBatchCalls().slice(callCountBefore);

		expect(newCalls).toHaveLength(0);
		expect(abortSpy).not.toHaveBeenCalled();
		expect(session.events).toHaveLength(1);
	});

	test("drops payloads that exceed the keepalive budget", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "vis-oversize-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("vis-oversize-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
		};
		session.events = [
			{ serialized: `"${"x".repeat(70_000)}"`, timestamp: 1000 },
		];
		session.bufferedCharacters = 70_000;

		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		const newCalls = getBatchCalls().slice(callCountBefore);

		// No keepalive request is issued — the buffer is preserved for the
		// next regular-fetch flush instead (we may not be unloading at all).
		expect(newCalls).toHaveLength(0);
		expect(session.events).toHaveLength(1);
	});

	test("aborts in-flight regular batch and reclaims its events via keepalive", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		let resolveInFlightBatch: (response: Response) => void = () => {};
		const inFlightBatch = new Promise<Response>((resolve) => {
			resolveInFlightBatch = resolve;
		});

		vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init_) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			if (url.endsWith("/session")) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "vis-abort-session",
						}),
				} as Response);
			}
			if (url.endsWith("/batch")) {
				const isKeepalive = (init_ as RequestInit | undefined)?.keepalive;
				if (isKeepalive) {
					return Promise.resolve(
						makeUpdateSuccessResponse("vis-abort-session"),
					);
				}
				// Regular fetch — hold it open and rig it to reject on abort.
				const signal = (init_ as RequestInit | undefined)?.signal;
				if (signal) {
					signal.addEventListener("abort", () => {
						resolveInFlightBatch(
							Promise.reject(
								new DOMException("Aborted", "AbortError"),
							) as unknown as Response,
						);
					});
				}
				return inFlightBatch;
			}
			return Promise.reject(new Error(`Unexpected fetch ${url}`));
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
			isSendingEvents: boolean;
			tryToSendEvents: () => Promise<void>;
		};
		seedEvents(session as never, [
			{ timestamp: 1000, type: 3, data: { source: 2 } },
		]);

		const inflightFlush = session.tryToSendEvents();
		await vi.waitFor(() => {
			expect(session.isSendingEvents).toBe(true);
		});

		const callCountBefore = getBatchCalls().length;
		dispatchVisibilityChange("hidden");
		const newCalls = getBatchCalls().slice(callCountBefore);

		expect(newCalls).toHaveLength(1);
		expect(newCalls[0][1]).toMatchObject({ keepalive: true });
		const body = JSON.parse(newCalls[0][1]?.body as string);
		expect(body.events).toHaveLength(1);
		expect(session.events).toHaveLength(0);

		// Let the aborted send unwind before the test exits.
		await inflightFlush;
	});
});
