import { beforeEach, describe, expect, test, vi } from "vitest";
import { removeItemMock, setItemMock } from "../setup";
import {
	clientKey,
	getUrlString,
	importMilana,
	importSession,
	mockFetch,
	productId,
	seedEvents,
	setupCoreTestHarness,
	type TestSessionInternals,
} from "./helpers";

describe("Batch send: exponential backoff and session restart", () => {
	setupCoreTestHarness();

	describe("Exponential backoff on failed /batch requests", () => {
		let stopRecordingMock: ReturnType<typeof vi.fn>;

		beforeEach(async () => {
			stopRecordingMock = vi.fn();
			vi.doMock("@rrweb/record", () => ({
				record: vi.fn(() => stopRecordingMock),
			}));

			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "test-session" }),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			vi.clearAllMocks();
		});

		test("succeeds after retries within the max limit", async () => {
			const { MilanaSession } = await importSession();

			let batchCallCount = 0;
			vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
				const urlStr = getUrlString(url);
				if (urlStr.endsWith("/batch")) {
					batchCallCount++;
					if (batchCallCount <= 3) {
						return Promise.reject(new Error("Network error"));
					}
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ success: true }),
					} as Response);
				}
				if (urlStr.endsWith("/metrics")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ success: true }),
					} as Response);
				}
				return Promise.reject(new Error("Unexpected URL"));
			});

			const testEvents = [
				{ type: 3, data: { test: "event1" }, timestamp: Date.now() },
				{ type: 3, data: { test: "event2" }, timestamp: Date.now() + 100 },
			];
			const session =
				MilanaSession.currentSession as unknown as TestSessionInternals;
			seedEvents(session, testEvents);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			await (
				MilanaSession.currentSession as unknown as TestSessionInternals
			).tryToSendEvents();

			// Retry timing: 5s, 15s, 30s
			await vi.advanceTimersByTimeAsync(5000);
			await vi.advanceTimersByTimeAsync(15000);
			await vi.advanceTimersByTimeAsync(30000);

			const batchCalls = vi
				.mocked(fetch)
				.mock.calls.filter((call) => getUrlString(call[0]).endsWith("/batch"));
			expect(batchCalls).toHaveLength(4);

			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals).events
					.length,
			).toBe(0);

			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.retryCount,
			).toBe(0);

			expect(stopRecordingMock).not.toHaveBeenCalled();

			expect(console.info).not.toHaveBeenCalledWith(
				"Milana: Max retry count reached for sending events. Stopping session.",
			);
		});

		test("stops recording when the max retry count is exceeded", async () => {
			const { MilanaSession } = await importSession();

			vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
				const urlStr = getUrlString(url);
				if (urlStr.endsWith("/batch")) {
					return Promise.reject(new Error("Network error"));
				}
				if (urlStr.endsWith("/metrics")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ success: true }),
					} as Response);
				}
				return Promise.reject(new Error("Unexpected URL"));
			});

			const testEvents = [
				{ type: 3, data: { test: "event1" }, timestamp: Date.now() },
			];
			const session =
				MilanaSession.currentSession as unknown as TestSessionInternals;
			seedEvents(session, testEvents);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			await (
				MilanaSession.currentSession as unknown as TestSessionInternals
			).tryToSendEvents();

			// Retry timing: 5s, 15s, 30s, 60s, 300s (MAX_RETRY_COUNT = 5)
			await vi.advanceTimersByTimeAsync(5000);
			await vi.advanceTimersByTimeAsync(15000);
			await vi.advanceTimersByTimeAsync(30000);
			await vi.advanceTimersByTimeAsync(60000);
			await vi.advanceTimersByTimeAsync(300000);

			const batchCalls = vi
				.mocked(fetch)
				.mock.calls.filter((call) => getUrlString(call[0]).endsWith("/batch"));
			expect(batchCalls).toHaveLength(6);

			expect(console.info).toHaveBeenCalledWith(
				"Milana: Max retry count reached for sending events. Stopping session.",
			);
			expect(stopRecordingMock).toHaveBeenCalled();
			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.stopRrwebRecording,
			).toBeNull();
			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals).events
					.length,
			).toBe(0);
			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.retryCount,
			).toBe(5);
		});

		test("follows the documented backoff cadence (5s, 15s, 30s, 60s, 300s)", async () => {
			const { MilanaSession } = await importSession();

			const session =
				MilanaSession.currentSession as unknown as TestSessionInternals;
			if (session.retryTimeout) {
				clearTimeout(session.retryTimeout);
				session.retryTimeout = null;
			}
			if (session.flushInterval) {
				clearInterval(session.flushInterval);
				session.flushInterval = null;
			}
			if (session.logMetricsInterval) {
				clearInterval(session.logMetricsInterval);
				session.logMetricsInterval = null;
			}
			session.retryCount = 0;

			let batchCallCount = 0;
			vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
				const urlStr = getUrlString(url);
				if (urlStr.endsWith("/batch")) {
					batchCallCount++;
					return Promise.reject(new Error("Network error"));
				}
				if (urlStr.endsWith("/metrics")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ success: true }),
					} as Response);
				}
				return Promise.reject(new Error("Unexpected URL"));
			});

			seedEvents(session, [
				{ type: 3, data: { test: "event1" }, timestamp: Date.now() },
			]);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			await session.tryToSendEvents();

			expect(batchCallCount).toBe(1);

			await vi.advanceTimersByTimeAsync(5000);
			expect(batchCallCount).toBe(2);

			await vi.advanceTimersByTimeAsync(15000);
			expect(batchCallCount).toBe(3);

			await vi.advanceTimersByTimeAsync(30000);
			expect(batchCallCount).toBe(4);

			await vi.advanceTimersByTimeAsync(60000);
			expect(batchCallCount).toBe(5);

			await vi.advanceTimersByTimeAsync(300000);
			expect(batchCallCount).toBe(6);

			expect(session.retryTimeout).toBeNull();
			expect(session.events.length).toBe(0);
			expect(console.info).toHaveBeenCalledWith(
				"Milana: Max retry count reached for sending events. Stopping session.",
			);
		});
	});

	describe("Server-driven session restart", () => {
		test("restarts the session when /batch returns shouldRestartSession", async () => {
			const { init } = await importMilana();

			mockFetch({
				"/session": [
					{
						ok: true,
						json: () =>
							Promise.resolve({ sampled: true, sessionId: "session-1" }),
					} as Response,
					{
						ok: true,
						json: () =>
							Promise.resolve({ sampled: true, sessionId: "session-2" }),
					} as Response,
				],
				"/batch": [
					{
						ok: true,
						json: () =>
							Promise.resolve({
								success: false,
								shouldRestartSession: true,
							}),
					} as Response,
					{
						ok: true,
						json: () => Promise.resolve({ success: true }),
					} as Response,
				],
			});

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			const { MilanaSession, StateType } = await importSession();
			expect(MilanaSession.currentSession).toBeTruthy();
			expect(MilanaSession.currentSession!.state.type).toBe(
				StateType.Recording,
			);
			if (MilanaSession.currentSession!.state.type === StateType.Recording) {
				expect(MilanaSession.currentSession!.state.sessionId).toBe("session-1");
			}

			const stopRecordingMock = vi.fn();
			vi.mocked(await import("@rrweb/record")).record.mockReturnValue(
				stopRecordingMock,
			);

			const oldEvents = [
				{ type: 3, data: { test: "event1" }, timestamp: Date.now() },
				{ type: 3, data: { test: "event2" }, timestamp: Date.now() + 100 },
			];
			const session =
				MilanaSession.currentSession as unknown as TestSessionInternals;
			seedEvents(session, oldEvents);

			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			await (
				MilanaSession.currentSession as unknown as TestSessionInternals
			).tryToSendEvents();

			expect(fetch).toHaveBeenCalledTimes(3);
			expect(removeItemMock).toHaveBeenCalledWith("milana_session_id");
			expect(setItemMock).toHaveBeenCalledWith(
				"milana_session_id",
				"session-2",
			);
			expect(MilanaSession.currentSession!.state.type).toBe(
				StateType.Recording,
			);
			if (MilanaSession.currentSession!.state.type === StateType.Recording) {
				expect(MilanaSession.currentSession!.state.sessionId).toBe("session-2");
			}
			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals).events
					.length,
			).toBe(0);

			seedEvents(session, [
				{ type: 3, data: { test: "new-event1" }, timestamp: Date.now() + 200 },
			]);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-call
			await (
				MilanaSession.currentSession as unknown as TestSessionInternals
			).tryToSendEvents();

			expect(fetch).toHaveBeenCalledTimes(4);
			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/batch",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "session-1",
					}) as Record<string, string>,
				}),
			);
			expect(fetch).toHaveBeenNthCalledWith(
				4,
				"https://in.getmilana.ai/batch",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "session-2",
					}) as Record<string, string>,
				}),
			);
			expect(
				(MilanaSession.currentSession as unknown as TestSessionInternals).events
					.length,
			).toBe(0);
		});
	});
});
