import { describe, expect, test, vi } from "vitest";
import { setItemMock } from "../setup";
import {
	callMilana,
	clientKey,
	importSession,
	makeUpdateSuccessResponse,
	productId,
	setupCoreTestHarness,
	setupDocumentedStub,
} from "./helpers";

// Every test here exercises the script-tag flow exactly like a customer's
// page does it: drop in the documented stub, call Milana(...), then load
// the SDK by importing the CDN entry. Direct manipulation of
// `window._milanaQueue` is intentionally avoided — that bypasses the
// customer-facing call shape and was how the v1.0.12 regression slipped
// through (Milana("identify") threw `TypeError: Milana is not a function`
// even though every test was green).
describe("CDN script-tag loading", () => {
	setupCoreTestHarness();

	describe("Customer calls Milana(...) before the SDK loads", () => {
		test("a single init() is dispatched once the SDK loads", async () => {
			setupDocumentedStub();
			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "test-session-123" }),
			} as Response);

			await import("../../src/core/cdn-entry.ts");

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Product-Id": productId,
						"X-Milana-Client-Key": clientKey,
						"X-Milana-Caller-Type": "cdn",
					}) as Record<string, string>,
					body: JSON.stringify({
						environment: "test",
						version: "1.0",
						metadata: {},
					}),
				}),
			);
			expect(setItemMock).toHaveBeenCalledWith(
				"milana_session_id",
				"test-session-123",
			);
		});

		test("identify queued before init is dispatched after init resolves", async () => {
			setupDocumentedStub();
			callMilana("identify", {
				userId: "user-first",
				email: "first@example.com",
			});
			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-456" }),
				} as Response)
				.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session-456"));

			await import("../../src/core/cdn-entry.ts");
			await vi.advanceTimersByTimeAsync(1000);

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch).toHaveBeenNthCalledWith(
				1,
				"https://in.getmilana.ai/session",
				expect.objectContaining({ method: "POST" }),
			);
			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session-456",
					}) as Record<string, string>,
					body: JSON.stringify({
						user: {
							userId: "user-first",
							email: "first@example.com",
						},
					}),
				}),
			);
		});

		test("update queued before init is dispatched once a session exists", async () => {
			setupDocumentedStub();
			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});
			callMilana("update", { session: { metadata: { theme: "dark" } } });

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-789" }),
				} as Response)
				.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session-789"));

			await import("../../src/core/cdn-entry.ts");
			await vi.advanceTimersByTimeAsync(1000);

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					body: JSON.stringify({
						session: { metadata: { theme: "dark" } },
					}),
				}),
			);
		});

		test("queued identify is dropped if the session never opens", async () => {
			setupDocumentedStub();
			callMilana("identify", {
				userId: "user-queued",
				email: "queued@example.com",
			});

			vi.mocked(fetch).mockRejectedValueOnce(new Error("Server error"));

			await import("../../src/core/cdn-entry.ts");
			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});
			await vi.advanceTimersByTimeAsync(1000);

			// Init failed → no session → identify never reaches the network.
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/session",
				expect.any(Object),
			);
		});

		test("the documented stub uses a flat-array shape, not nested arrays", async () => {
			// Guards against accidentally regressing the queue stub format
			// to ["init", [productId, clientKey, {...}]] (nested) — the SDK
			// expects the flat form ["init", productId, clientKey, {...}]
			// produced by `[].slice.call(arguments)`.
			setupDocumentedStub();
			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			expect(window._milanaQueue).toEqual([
				[
					"init",
					productId,
					clientKey,
					{ environment: "test", version: "1.0", metadata: {} },
				],
			]);
		});
	});

	describe("Customer calls Milana(...) after the SDK loads", () => {
		test("window.Milana is a bare callable; no methods are exposed", async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			expect(typeof window.Milana).toBe("function");

			// Direct-method access is intentionally not exposed — script-tag
			// callers must use the string-command form so pre-load and
			// post-load call shapes match.
			const milana = window.Milana as unknown as Record<string, unknown>;
			expect(milana.init).toBeUndefined();
			expect(milana.identify).toBeUndefined();
			expect(milana.update).toBeUndefined();
			expect(milana.trackEvent).toBeUndefined();
			expect(milana.stopRecording).toBeUndefined();
			expect(milana._session).toBeUndefined();
		});

		test('Milana("init", ...) dispatches immediately', async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "test-session-callable",
					}),
			} as Response);

			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Product-Id": productId,
						"X-Milana-Client-Key": clientKey,
					}) as Record<string, string>,
				}),
			);
		});

		test('Milana("identify", ...) is queued internally until init resolves', async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "test-session-mixed",
						}),
				} as Response)
				.mockResolvedValue(makeUpdateSuccessResponse("test-session-mixed"));

			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});
			callMilana("identify", {
				userId: "user-string-call",
				email: "string@example.com",
			});

			await vi.advanceTimersByTimeAsync(1000);

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					body: JSON.stringify({
						user: {
							userId: "user-string-call",
							email: "string@example.com",
						},
					}),
				}),
			);
		});

		test('Milana("trackEvent", ...) reaches the active session', async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "test-session-event",
					}),
			} as Response);

			callMilana("init", productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});
			await vi.advanceTimersByTimeAsync(0);

			const { MilanaSession } = await importSession();
			const trackEventSpy = vi.fn();
			Object.assign(MilanaSession.currentSession ?? {}, {
				trackEvent: trackEventSpy,
			});

			callMilana("trackEvent", "signup_clicked", { plan: "pro" });
			await vi.advanceTimersByTimeAsync(0);

			expect(trackEventSpy).toHaveBeenCalledWith("signup_clicked", {
				plan: "pro",
			});
		});

		test("an unknown command logs a warning instead of throwing", async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			callMilana("notARealCommand", { foo: "bar" });

			expect(console.warn).toHaveBeenCalledWith(
				"Milana: Unknown command: 'notARealCommand'",
			);
		});

		test("a synchronous throw inside dispatch is swallowed, never reaches host page", async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			// Stage a synchronous failure inside the trackEvent path: replace
			// MilanaSession.executeWhenReady with a throwing implementation —
			// this mirrors a sandboxed-iframe `SecurityError` from setInterval.
			const { MilanaSession } = await importSession();
			const original = MilanaSession.executeWhenReady;
			(
				MilanaSession as unknown as { executeWhenReady: unknown }
			).executeWhenReady = () => {
				throw new Error("simulated sandbox SecurityError");
			};

			expect(() => callMilana("trackEvent", "e", {})).not.toThrow();

			expect(console.warn).toHaveBeenCalledWith(
				"Milana: dispatchCommand failed, application will continue unaffected",
				expect.any(Error),
			);

			(
				MilanaSession as unknown as { executeWhenReady: unknown }
			).executeWhenReady = original;
		});

		test("_milanaQueue.push after the SDK loads dispatches immediately", async () => {
			setupDocumentedStub();
			await import("../../src/core/cdn-entry.ts");

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "test-session-late-push",
					}),
			} as Response);

			window._milanaQueue?.push([
				"init",
				productId,
				clientKey,
				{ environment: "test", version: "1.0", metadata: {} },
			]);
			await vi.advanceTimersByTimeAsync(0);

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/session",
				expect.objectContaining({ method: "POST" }),
			);
		});
	});
});
