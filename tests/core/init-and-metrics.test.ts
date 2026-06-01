import { describe, expect, test, vi } from "vitest";
import type { SessionPerfMetrics } from "@/core/session.ts";
import { MILANA_CUSTOM_EVENT_TAG } from "../../src/core/session.ts";
import { setItemMock } from "../setup";
import {
	clientKey,
	getUrlString,
	importMilana,
	importSession,
	logMetricsIntervalDuration,
	mockFetch,
	productId,
	readStoredSessionId,
	setupCoreTestHarness,
	type TestSessionInternals,
} from "./helpers";

describe("Core Library - Init and Metrics", () => {
	setupCoreTestHarness();

	describe("Init API", () => {
		describe("Success Cases", () => {
			test("should initialize with valid parameters", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "direct-session" }),
						} as Response,
					],
				});

				await init(productId, clientKey, {
					environment: "production",
					version: "2.0",
					metadata: { userId: "user-123" },
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/session",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({
							"X-Milana-Product-Id": productId,
							"X-Milana-Client-Key": clientKey,
							"X-Milana-Caller-Type": "core",
						}) as Record<string, string>,
						body: JSON.stringify({
							environment: "production",
							version: "2.0",
							metadata: { userId: "user-123" },
						}),
					}),
				);
			});

			test("should store session ID when sampled", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-123" }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(readStoredSessionId()).toBe("test-session-123");
			});

			test("should use custom endpoint when provided", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session" }),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{ endpoint: "https://custom.example.com" },
				);

				expect(fetch).toHaveBeenCalledWith(
					"https://custom.example.com/session",
					expect.any(Object),
				);
			});
		});

		describe("Error Cases", () => {
			test("should handle network failures gracefully", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockRejectedValueOnce(
					new Error("Network disconnected"),
				);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize, application will continue unaffected",
					expect.any(Error),
				);
			});

			test("should handle HTTP errors from server", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: false,
					statusText: "Internal Server Error",
					json: () => Promise.resolve({}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize session",
				);
			});

			test("should validate required parameters", async () => {
				const { init } = await importMilana();

				await init("", clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize, application will continue unaffected",
					expect.objectContaining({
						message:
							"Milana: Invalid product ID, product ID must start with 'prd_' and be 30 characters long",
					}),
				);
				expect(fetch).not.toHaveBeenCalled();
			});
		});

		describe("Edge Cases", () => {
			test("should handle unsampled sessions (no recording)", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: false }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(setItemMock).not.toHaveBeenCalledWith(
					"milana_session_id",
					expect.anything(),
				);
			});

			test("should prevent multiple initialization", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValue({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session" }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(console.info).toHaveBeenCalledWith(
					"Milana: Already initializing or initialized",
				);
			});

			test("should result in multiple network requests with same sessionId after reset", async () => {
				const { init } = await importMilana();

				const sessionId = "consistent-session-id";

				// Seed an existing session in the blob so both inits resume it.
				window.sessionStorage.setItem(
					"milana_session_state",
					JSON.stringify({ sessionId, user: null, sessionContext: null }),
				);

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: false,
					status: 500,
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: true, sessionId }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(fetch).toHaveBeenCalledTimes(2);

				const firstCall = vi.mocked(fetch).mock.calls[0];
				const secondCall = vi.mocked(fetch).mock.calls[1];

				expect(firstCall[1]?.headers).toEqual(
					expect.objectContaining({
						"X-Milana-Session-Id": sessionId,
					}),
				);
				expect(secondCall[1]?.headers).toEqual(
					expect.objectContaining({
						"X-Milana-Session-Id": sessionId,
					}),
				);
			});

			test("should handle response with missing sessionId", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: true }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(setItemMock).not.toHaveBeenCalledWith(
					"milana_session_id",
					expect.anything(),
				);
			});
		});
	});

	describe("Metrics API", () => {
		const metricsEnabledInternalOptions = {
			_internal: {
				shouldTrackPerformance: true,
				shouldForceUncompressedPayloads: false,
			},
		};

		describe("Default Behavior", () => {
			test("should send buffer metrics by default when no _internal options provided", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "default-metrics-session",
								}),
						} as Response,
					],
					"/metrics": [
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

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");

				expect(metricsBody.histograms.inpP98Ms).toBeUndefined();
				expect(
					metricsBody.histograms.averageLongTaskDurationMs,
				).toBeUndefined();
				expect(metricsBody.histograms.blockedTimePerSecondMs).toBeUndefined();
			});
		});

		describe("Success Cases", () => {
			test("should send metrics automatically after initialization", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "metrics-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();
				expect(metricsCall?.[0]).toBe("https://in.getmilana.ai/metrics");
				expect(metricsCall?.[1]?.method).toBe("POST");

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;
				expect(metricsBody.version).toBe(1);
				expect(typeof metricsBody.clientTimestamp).toBe("number");
				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");
			});

			test("should calculate inpP98Ms correctly with worst-10 tracking", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "inp-calc-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Test Case 1: <50 interactions - should NOT report inpP98Ms
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).worstInpValues = [500, 450, 400, 380, 350, 320, 300, 280, 260, 240];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalInpEventCount = 20;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall1 = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall1).toBeDefined();

				const body1 = JSON.parse(
					metricsCall1?.[1]?.body as string,
				) as SessionPerfMetrics;

				// For <50 interactions, should NOT report inpP98Ms
				expect(body1.histograms.inpP98Ms).toBeUndefined();

				// Test Case 2: >=50 interactions - should use 2nd worst (p98 approximation)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalInpEventCount = 100;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall2 = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall2).toBeDefined();

				const body2 = JSON.parse(
					metricsCall2?.[1]?.body as string,
				) as SessionPerfMetrics;

				// For >=50 interactions, should report 2nd worst (p98)
				expect(body2.histograms.inpP98Ms).toBe(450);
			});

			test("should calculate long task metrics correctly", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "longtask-calc-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Simulate long tasks: 3 tasks with durations 200ms, 150ms, 250ms
				// Average duration: 600/3 = 200ms
				// Blocking time: (200-50) + (150-50) + (250-50) = 150 + 100 + 200 = 450ms
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).longTaskDurationSum = 600;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).longTaskCount = 3;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalLongTaskBlockingTime = 450;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				// Set recordingStartTime to 30 seconds ago (matching the time we advanced)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).recordingStartTime = Date.now() - logMetricsIntervalDuration;

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const body = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				// Average duration: 600ms / 3 tasks = 200ms
				expect(body.histograms.averageLongTaskDurationMs).toBe(200);

				// Blocking rate: (450ms / 30000ms) * 1000 = 15ms/sec
				expect(body.histograms.blockedTimePerSecondMs).toBeCloseTo(15, 1);
			});

			test("should send metrics at 30-second intervals", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "interval-test" }),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(1);

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(2);

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(3);

				const allMetricsCalls = vi
					.mocked(fetch)
					.mock.calls.every((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);
				expect(allMetricsCalls).toBe(true);
			});
		});

		describe("Error Cases", () => {
			test("should silently fail when metrics endpoint returns error", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "error-test" }),
						} as Response,
					],
					"/metrics": [new Error("Network timeout")],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(30000);

				expect(console.debug).toHaveBeenCalledWith(
					"Milana: Failed to send metrics",
					expect.any(Error),
				);
			});

			test("should handle HTTP errors from metrics endpoint", async () => {
				const { init } = await importMilana();

				let metricsCallCount = 0;
				vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
					const urlStr = getUrlString(url);
					if (urlStr.endsWith("/session")) {
						return Promise.resolve({
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "http-error-test",
								}),
						} as Response);
					}
					if (urlStr.endsWith("/metrics")) {
						metricsCallCount++;
						return Promise.reject(new Error("Internal Server Error"));
					}
					return Promise.reject(new Error("Unexpected URL"));
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(30000);

				expect(metricsCallCount).toBe(1);
				expect(console.debug).toHaveBeenCalledWith(
					"Milana: Failed to send metrics",
					expect.any(Error),
				);
			});
		});

		describe("Counter Metrics", () => {
			test("should track aborted sessions when buffer exceeds hard limit", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "buffer-test-session",
								}),
						} as Response,
					],
					"/batch": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Keep the event size below the single-event cap (~2.6MB) but large enough to overflow the buffer quickly
				const largePayloadSize = Math.floor(1.5 * 1024 * 1024); // ~1.5MB per event
				const largePayload = "x".repeat(largePayloadSize);
				const session =
					MilanaSession.currentSession as unknown as TestSessionInternals;
				session.tryToSendEvents = vi.fn(); // avoid actual network attempts

				for (let i = 0; i < 16; i++) {
					session.pushEvent({
						type: 5,
						data: {
							tag: MILANA_CUSTOM_EVENT_TAG,
							payload: {
								name: "ManualBufferOverflowTest",
								index: i,
								data: largePayload,
							},
						},
						timestamp: Date.now() + i,
					});
				}

				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(1);

				// Manually send metrics to observe the counter
				await session.logMetrics();
				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(0);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				// Verify aborted session counter was reported and reset
				expect(metricsBody.counters.numSessionsAbortedDueToBufferExceeded).toBe(
					1,
				);
			});

			test("should track single-event aborts when payload exceeds per-event limit", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "single-event-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				const session =
					MilanaSession.currentSession as unknown as TestSessionInternals;
				session.tryToSendEvents = vi.fn();

				const oversizedPayload = "x".repeat(6 * 1024 * 1024); // ~6MB, exceeds per-event limit

				session.pushEvent({
					type: 5,
					data: {
						tag: MILANA_CUSTOM_EVENT_TAG,
						payload: {
							name: "ManualHugeEvent",
							data: oversizedPayload,
						},
					},
					timestamp: Date.now(),
				});

				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(1);
				expect(session.events.length).toBe(0);

				await session.logMetrics();
				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(0);
			});

			test("should prevent concurrent metrics logging", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "concurrent-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set counter to track
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 5;

				vi.clearAllMocks();

				// Create a slow metrics response
				let resolveMetrics: () => void;
				const metricsPromise = new Promise<Response>((resolve) => {
					resolveMetrics = () =>
						resolve({
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response);
				});

				vi.mocked(fetch).mockReturnValueOnce(metricsPromise);

				// Start first logMetrics call
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				const firstCall = (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Verify guard flag is set
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.isSendingMetrics,
				).toBe(true);

				// Try to call logMetrics again while first is in progress
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Should only have made 1 fetch call (second was skipped)
				expect(fetch).toHaveBeenCalledTimes(1);

				// Complete the first call
				resolveMetrics!();
				await firstCall;

				// Guard flag should be reset
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.isSendingMetrics,
				).toBe(false);
			});

			test("should accumulate counters when metrics request fails", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "accumulate-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						new Error("Network error"),
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set counter to 3
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 3;

				vi.clearAllMocks();

				// First call fails
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Counter should still be 3 (not lost due to failure)
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(3);

				// Second call succeeds
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Counter should now be 0 (3 - 3)
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(0);

				// Verify both calls were made
				expect(fetch).toHaveBeenCalledTimes(2);
			});

			test("should preserve counter increments during in-flight request", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "race-test-session",
								}),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set initial counter to 3
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 3;

				vi.clearAllMocks();

				// Create a delayed metrics response
				let resolveMetrics: () => void;
				const metricsPromise = new Promise<Response>((resolve) => {
					resolveMetrics = () =>
						resolve({
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response);
				});

				vi.mocked(fetch).mockReturnValueOnce(metricsPromise);

				// Start logMetrics (snapshots counter = 3)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				const metricsCall = (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// While request is in flight, increment counter twice (3 -> 4 -> 5)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.counters.numSessionsAbortedDueToBufferExceeded++;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.counters.numSessionsAbortedDueToBufferExceeded++;

				// Verify counter is now 5
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(5);

				// Complete the request
				resolveMetrics!();
				await metricsCall;

				// Counter should be 2 (5 - 3), proving increments during request were preserved
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(2);
			});
		});

		describe("Metrics on Session End", () => {
			test("should send final metrics when stopRecording is called", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "normal-stop-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				vi.clearAllMocks();

				const { MilanaSession } = await importSession();

				// Mock metrics to succeed
				vi.mocked(fetch).mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ success: true }),
				} as Response);

				// Manually stop recording (simulating session end)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).stopRecording();

				// Allow async operations to complete
				await vi.advanceTimersByTimeAsync(100);

				// Verify metrics were sent
				const metricsCalls = vi
					.mocked(fetch)
					.mock.calls.filter((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCalls.length).toBeGreaterThan(0);

				// Verify metrics structure
				const metricsBody = JSON.parse(
					metricsCalls[0][1]?.body as string,
				) as SessionPerfMetrics;

				expect(metricsBody.version).toBe(1);
				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");
			});
		});
	});

	describe("Caller-Type Pinning", () => {
		test("a prior wrapper init does not bleed into a later direct core init", async () => {
			const { _initWithCallerType, init, stopRecording } = await importMilana();

			// First session: simulate a wrapper (React provider) initializing
			// with caller type "react".
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "react-session" }),
			} as Response);

			await _initWithCallerType(
				productId,
				clientKey,
				{ environment: "test", version: "1.0", metadata: {} },
				"react",
				undefined,
			);

			await stopRecording();

			// Second session: direct core init via the public API. Must tag
			// as "core" — wrapper attribution must not leak across sessions.
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "core-session" }),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			expect(fetch).toHaveBeenLastCalledWith(
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Milana-Caller-Type": "core",
					}) as Record<string, string>,
				}),
			);
		});
	});
});
