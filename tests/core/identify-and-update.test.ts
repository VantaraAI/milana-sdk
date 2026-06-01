import { describe, expect, test, vi } from "vitest";
import { removeItemMock, setItemMock } from "../setup";
import {
	clientKey,
	importMilana,
	importSession,
	makeUpdateFailureResponse,
	makeUpdateSuccessResponse,
	productId,
	setupCoreTestHarness,
} from "./helpers";

describe("Core Library - Identify and Update", () => {
	setupCoreTestHarness();

	describe("Identify API", () => {
		describe("Success Cases", () => {
			beforeEach(async () => {
				const { init } = await importMilana();

				// Initialize successfully
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

			test("should transform identify call to update call", async () => {
				const { identify } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sessionId: "test-session",
							sampled: true,
						}),
				} as Response);

				await identify({
					userId: "user-123",
					email: "test@example.com",
					name: "Test User",
					metadata: { plan: "premium" },
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({
							"X-Milana-Session-Id": "test-session",
						}) as Record<string, string>,
						body: JSON.stringify({
							user: {
								userId: "user-123",
								email: "test@example.com",
								name: "Test User",
								metadata: { plan: "premium" },
							},
						}),
					}),
				);
			});
		});

		describe("Error Cases", () => {
			beforeEach(async () => {
				const { init } = await importMilana();

				// Initialize successfully
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

			test("should handle HTTP errors", async () => {
				const { identify } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateFailureResponse({
						statusCode: 400,
						errorCode: "BAD_REQUEST",
					}),
				);

				const result = await identify({
					userId: "user-123",
					email: "test@example.com",
				});
				expect(result).toEqual({ success: false });
			});
		});

		describe("Queue Behavior", () => {
			test("should queue identify calls made before init", async () => {
				const { init, identify } = await importMilana();

				// Call identify without any init - should wait
				const identifyPromise = identify({
					userId: "user-123",
					email: "test@example.com",
				});

				// At this point, no network calls yet
				expect(fetch).not.toHaveBeenCalled();

				// Mock successful init and identify
				vi.mocked(fetch)
					.mockResolvedValueOnce({
						ok: true,
						json: () =>
							Promise.resolve({ sampled: true, sessionId: "test-session" }),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () =>
							Promise.resolve({
								success: true,
								sessionId: "test-session",
								sampled: true,
							}),
					} as Response);

				// Now call init - should process the waiting identify
				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				// Allow queue processing
				await vi.advanceTimersByTimeAsync(1000);

				// Identify should now succeed
				await expect(identifyPromise).resolves.toEqual({ success: true });

				// Should have made both calls
				expect(fetch).toHaveBeenCalledTimes(2);
			});

			test("should fail identify when no session exists (failed init)", async () => {
				const { init, identify } = await importMilana();

				// Call identify first - it will hang forever
				const identifyPromise = identify({
					userId: "user-123",
					email: "test@example.com",
				});

				// Mock failed init
				vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

				// Init fails
				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				// Process the queue - identify should hang (not resolve/reject)
				await vi.advanceTimersByTimeAsync(1000);

				// Create a timeout promise to test that identify hangs
				const timeoutPromise = new Promise((resolve) => {
					setTimeout(() => resolve("TIMEOUT"), 100);
				});

				// Advance timers to trigger the timeout
				await vi.advanceTimersByTimeAsync(100);

				// Race between identify and timeout - timeout should win (identify hangs)
				const result = await Promise.race([
					identifyPromise.then(() => "RESOLVED").catch(() => "REJECTED"),
					timeoutPromise,
				]);
				expect(result).toBe("TIMEOUT");

				// Should only have called init, not identify
				expect(fetch).toHaveBeenCalledTimes(1);
			});

			test("should fail identify when session is unsampled", async () => {
				const { init, identify } = await importMilana();

				// Call identify first - it will hang forever
				const identifyPromise = identify({
					userId: "user-123",
					email: "test@example.com",
				});

				// Mock unsampled session response
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: false }),
				} as Response);

				// Init with unsampled session (no sessionId stored)
				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				// Process the queue
				await vi.advanceTimersByTimeAsync(1000);

				// Create a timeout promise to test that identify hangs
				const timeoutPromise = new Promise((resolve) => {
					setTimeout(() => resolve("TIMEOUT"), 100);
				});

				// Advance timers to trigger the timeout
				await vi.advanceTimersByTimeAsync(100);

				// Race between identify and timeout - timeout should win (identify hangs)
				const result = await Promise.race([
					identifyPromise.then(() => "RESOLVED").catch(() => "REJECTED"),
					timeoutPromise,
				]);
				expect(result).toBe("TIMEOUT");

				// Should only have called init, not identify
				expect(fetch).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe("Update API", () => {
		describe("Success Cases", () => {
			beforeEach(async () => {
				const { init } = await importMilana();

				// Initialize successfully
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

			test("should update session metadata", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateSuccessResponse("test-session"),
				);

				await update({
					user: { userId: "user-123" },
					session: {
						metadata: { theme: "dark", language: "en" },
					},
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({
							"X-Milana-Session-Id": "test-session",
						}) as Record<string, string>,
						body: JSON.stringify({
							user: { userId: "user-123" },
							session: {
								metadata: { theme: "dark", language: "en" },
							},
						}),
					}),
				);
			});

			test("should identify user through update", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateSuccessResponse("test-session"),
				);

				await update({
					user: {
						userId: "user-123",
						email: "test@example.com",
						name: "Test User",
						metadata: { plan: "premium", credits: 1000 },
					},
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({
							"X-Milana-Session-Id": "test-session",
						}) as Record<string, string>,
						body: JSON.stringify({
							user: {
								userId: "user-123",
								email: "test@example.com",
								name: "Test User",
								metadata: { plan: "premium", credits: 1000 },
							},
						}),
					}),
				);
			});

			test("should update both session metadata and identify user", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateSuccessResponse("test-session"),
				);

				await update({
					session: {
						metadata: { theme: "dark" },
					},
					user: {
						userId: "user-456",
						email: "enterprise@example.com",
						metadata: { plan: "enterprise" },
					},
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({
							session: {
								metadata: { theme: "dark" },
							},
							user: {
								userId: "user-456",
								email: "enterprise@example.com",
								metadata: { plan: "enterprise" },
							},
						}),
					}),
				);
			});

			test("should handle minimal update gracefully", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateSuccessResponse("test-session"),
				);

				await update({ user: { userId: "user-123" } });

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({ user: { userId: "user-123" } }),
					}),
				);
			});

			test("should deduplicate sequential identical payloads but allow different payloads", async () => {
				const { update } = await importMilana();

				const firstPayload = {
					user: { userId: "user-123" } as const,
					session: {
						metadata: { theme: "dark" },
					},
				};

				const secondPayload = {
					user: { userId: "user-123" } as const,
					session: {
						metadata: { theme: "light" },
					},
				};

				// First update
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sampled: true,
							sessionId: "test-session",
						}),
				} as Response);

				await update(firstPayload);
				expect(fetch).toHaveBeenCalledTimes(1);
				await update(firstPayload);
				expect(fetch).toHaveBeenCalledTimes(1);

				// Second different update should go through
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sampled: true,
							sessionId: "test-session",
						}),
				} as Response);

				await update(secondPayload);
				expect(fetch).toHaveBeenCalledTimes(2);

				// Third update with first payload should go through (it's different from last)
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sampled: true,
							sessionId: "test-session",
						}),
				} as Response);

				await update(firstPayload);
				expect(fetch).toHaveBeenCalledTimes(3);
			});

			test("should retry failed update with identical payload", async () => {
				const { update } = await importMilana();

				const updatePayload = {
					user: { userId: "user-123" } as const,
					session: {
						metadata: { theme: "dark" },
					},
				};

				// First update fails
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: false,
							shouldRestartSession: false,
							errorCode: "INTERNAL_ERROR",
						}),
				} as Response);

				const result = await update(updatePayload);
				expect(result).toEqual({ success: false });
				expect(fetch).toHaveBeenCalledTimes(1);

				// Second update with same payload should be sent (previous failed)
				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sampled: true,
							sessionId: "test-session",
						}),
				} as Response);

				await update(updatePayload);
				expect(fetch).toHaveBeenCalledTimes(2);

				// Third update with same payload should be skipped (previous succeeded)
				await update(updatePayload);
				expect(fetch).toHaveBeenCalledTimes(2);
			});
		});

		describe("Error Cases", () => {
			beforeEach(async () => {
				const { init } = await importMilana();

				// Initialize successfully
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

			test("should handle HTTP errors", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateFailureResponse({
						statusCode: 400,
						errorCode: "BAD_REQUEST",
					}),
				);

				const result = await update({
					user: { userId: "user-123" },
					session: { metadata: { test: "data" } },
				});
				expect(result).toEqual({ success: false });
			});

			test("should handle network failures", async () => {
				const { update } = await importMilana();

				vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

				const result = await update({
					user: { userId: "test-user", metadata: { test: "data" } },
				});
				expect(result).toEqual({ success: false });
			});

			test("should restart session when update response requests it", async () => {
				const { update } = await importMilana();

				const newSessionId = "test-session-restarted";
				vi.mocked(fetch)
					.mockResolvedValueOnce(
						makeUpdateFailureResponse({
							statusCode: 400,
							errorCode: "SESSION_CLOSED",
						}),
					)
					.mockResolvedValueOnce({
						ok: true,
						json: () =>
							Promise.resolve({
								sampled: true,
								sessionId: newSessionId,
							}),
					} as Response);

				const result = await update({
					user: { userId: "user-123" },
					session: { metadata: { trigger: "restart" } },
				});
				expect(result).toEqual({ success: false });

				await vi.waitFor(() => {
					expect(fetch).toHaveBeenCalledTimes(2);
				});

				expect(fetch).toHaveBeenNthCalledWith(
					2,
					"https://in.getmilana.ai/session",
					expect.objectContaining({
						method: "POST",
					}),
				);

				expect(removeItemMock).toHaveBeenCalledWith("milana_session_id");
				await vi.waitFor(() => {
					expect(setItemMock).toHaveBeenCalledWith(
						"milana_session_id",
						newSessionId,
					);
				});

				const { MilanaSession, StateType } = await importSession();
				await vi.waitFor(() => {
					expect(MilanaSession.currentSession?.state.type).toBe(
						StateType.Recording,
					);
				});

				if (MilanaSession.currentSession?.state.type === StateType.Recording) {
					expect(MilanaSession.currentSession.state.sessionId).toBe(
						newSessionId,
					);
				}
			});
		});

		describe("Queue Behavior", () => {
			test("should queue update calls made before init", async () => {
				const { init, update } = await importMilana();

				// Call update without init - should queue
				const updatePromise = update({
					user: { userId: "user-123" },
					session: { metadata: { queued: true } },
				});

				// No network calls yet
				expect(fetch).not.toHaveBeenCalled();

				// Mock successful init and update
				vi.mocked(fetch)
					.mockResolvedValueOnce({
						ok: true,
						json: () =>
							Promise.resolve({ sampled: true, sessionId: "test-session" }),
					} as Response)
					.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session"));

				// Now call init
				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				// Allow queue processing
				await vi.advanceTimersByTimeAsync(1000);

				// Update should succeed
				await expect(updatePromise).resolves.toEqual({ success: true });

				// Should have made both calls
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(fetch).toHaveBeenNthCalledWith(
					2,
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({
							user: { userId: "user-123" },
							session: { metadata: { queued: true } },
						}),
					}),
				);
			});

			test("should process multiple update calls in order", async () => {
				const { init, update } = await importMilana();

				// Queue multiple update calls
				const update1 = update({
					user: { userId: "user-1" },
					session: { metadata: { call: 1 } },
				});
				const update2 = update({
					user: {
						userId: "user-2",
						email: "user2@example.com",
						metadata: { call: 2 },
					},
				});
				const update3 = update({
					user: { userId: "user-3", metadata: { call: 3 } },
					session: { metadata: { call: 3 } },
				});

				// Mock responses
				vi.mocked(fetch)
					.mockResolvedValueOnce({
						ok: true,
						json: () =>
							Promise.resolve({ sampled: true, sessionId: "test-session" }),
					} as Response)
					.mockResolvedValue(makeUpdateSuccessResponse("test-session"));

				// Init
				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				// Process queue
				await vi.advanceTimersByTimeAsync(1000);

				// All should resolve
				await Promise.all([update1, update2, update3]);

				// Should have made 4 calls (1 init + 3 updates)
				expect(fetch).toHaveBeenCalledTimes(4);

				// Verify update calls were made with correct data
				expect(fetch).toHaveBeenNthCalledWith(
					2,
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						body: JSON.stringify({
							user: { userId: "user-1" },
							session: { metadata: { call: 1 } },
						}),
					}),
				);
				expect(fetch).toHaveBeenNthCalledWith(
					3,
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						body: JSON.stringify({
							user: {
								userId: "user-2",
								email: "user2@example.com",
								metadata: { call: 2 },
							},
						}),
					}),
				);
				expect(fetch).toHaveBeenNthCalledWith(
					4,
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						body: JSON.stringify({
							user: { userId: "user-3", metadata: { call: 3 } },
							session: { metadata: { call: 3 } },
						}),
					}),
				);
			});

			test("update calls should hang when session is not ready", async () => {
				const { update } = await importMilana();

				// Call update without init
				const updatePromise = update({
					user: { userId: "user-123" },
					session: { metadata: { test: true } },
				});

				// Create timeout to test hanging
				const timeoutPromise = new Promise((resolve) => {
					setTimeout(() => resolve("TIMEOUT"), 100);
				});

				// Advance timers
				await vi.advanceTimersByTimeAsync(100);

				// Should timeout (update hangs)
				const result = await Promise.race([
					updatePromise.then(() => "RESOLVED").catch(() => "REJECTED"),
					timeoutPromise,
				]);
				expect(result).toBe("TIMEOUT");

				// No network calls made
				expect(fetch).not.toHaveBeenCalled();
			});
		});

		describe("Integration with existing APIs", () => {
			test("should be able to replace identify with update", async () => {
				const { init, update } = await importMilana();

				// Initialize
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

				// Mock successful response
				vi.mocked(fetch).mockResolvedValueOnce(
					makeUpdateSuccessResponse("test-session"),
				);

				// Use update instead of identify
				await update({
					user: {
						userId: "user-123",
						email: "test@example.com",
						name: "Test User",
						metadata: { initialPlan: "free" },
					},
				});

				// Verify it was called correctly
				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/update",
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({
							user: {
								userId: "user-123",
								email: "test@example.com",
								name: "Test User",
								metadata: { initialPlan: "free" },
							},
						}),
					}),
				);
			});

			test("should work alongside identify calls", async () => {
				const { init, identify, update } = await importMilana();

				// Initialize
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

				// Mock successful responses
				vi.mocked(fetch)
					.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session"))
					.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session"));

				// Call identify then update
				await identify({
					userId: "user-123",
					email: "test@example.com",
					metadata: { initialPlan: "free" },
				});

				await update({
					user: { userId: "test-user", metadata: { upgradedPlan: "premium" } },
				});

				// Verify both calls were made
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(fetch).toHaveBeenNthCalledWith(
					1,
					"https://in.getmilana.ai/update",
					expect.any(Object),
				);
				expect(fetch).toHaveBeenNthCalledWith(
					2,
					"https://in.getmilana.ai/update",
					expect.any(Object),
				);
			});
		});
	});

	describe("updateUser API", () => {
		beforeEach(async () => {
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

		test("forwards to /update with a user-only payload", async () => {
			const { updateUser } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce(
				makeUpdateSuccessResponse("test-session"),
			);

			const result = await updateUser({
				userId: "user-123",
				email: "test@example.com",
				name: "Test User",
				metadata: { plan: "premium" },
			});
			expect(result).toEqual({ success: true });

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session",
					}) as Record<string, string>,
					body: JSON.stringify({
						user: {
							userId: "user-123",
							email: "test@example.com",
							name: "Test User",
							metadata: { plan: "premium" },
						},
					}),
				}),
			);
		});
	});

	describe("updateSession API", () => {
		beforeEach(async () => {
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

		test("forwards a session-only payload to /update", async () => {
			const { updateSession } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce(
				makeUpdateSuccessResponse("test-session"),
			);

			const result = await updateSession({
				metadata: { theme: "dark", plan: "premium" },
			});
			expect(result).toEqual({ success: true });

			expect(fetch).toHaveBeenCalledWith(
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						session: { metadata: { theme: "dark", plan: "premium" } },
					}),
				}),
			);
		});
	});
});
