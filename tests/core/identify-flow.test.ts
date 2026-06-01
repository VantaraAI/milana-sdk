import { describe, expect, test, vi } from "vitest";
import {
	clientKey,
	importMilana,
	makeUpdateSuccessResponse,
	productId,
	setupCoreTestHarness,
} from "./helpers";

describe("init → identify → update flow", () => {
	setupCoreTestHarness();

	describe("Identify queueing when init has not yet resolved", () => {
		test("identify() called with no init in flight hangs indefinitely", async () => {
			const { identify } = await importMilana();

			const identifyPromise = identify({
				userId: "user-123",
				email: "test@example.com",
			});

			const timeoutPromise = new Promise((_, reject) => {
				setTimeout(
					() => reject(new Error("TIMEOUT: identify() hung for 100ms")),
					100,
				);
			});

			await vi.advanceTimersByTimeAsync(100);

			await expect(
				Promise.race([identifyPromise, timeoutPromise]),
			).rejects.toThrow("TIMEOUT: identify() hung for 100ms");

			expect(fetch).not.toHaveBeenCalled();
		}, 1000);

		test("identify() called before init() is dispatched once init resolves", async () => {
			const { init, identify } = await importMilana();

			const identifyPromise = identify({
				userId: "user-before-init",
				email: "before@example.com",
			});

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-123" }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sessionId: "test-session-123",
							sampled: true,
						}),
				} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			await vi.advanceTimersByTimeAsync(1000);
			await identifyPromise;

			expect(fetch).toHaveBeenCalledTimes(2);
			expect(fetch).toHaveBeenNthCalledWith(
				1,
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Product-Id": productId,
						"X-Milana-Client-Key": clientKey,
					}) as Record<string, string>,
				}),
			);
			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session-123",
					}) as Record<string, string>,
					body: JSON.stringify({
						user: {
							userId: "user-before-init",
							email: "before@example.com",
						},
					}),
				}),
			);
		});

		test("multiple identify() calls before init() are all dispatched in order", async () => {
			const { init, identify } = await importMilana();

			const identify1 = identify({
				userId: "user-1",
				email: "user1@example.com",
			});
			const identify2 = identify({
				userId: "user-2",
				email: "user2@example.com",
			});
			const identify3 = identify({
				userId: "user-3",
				email: "user3@example.com",
			});

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-456" }),
				} as Response)
				.mockResolvedValue({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sessionId: "test-session-456",
							sampled: true,
						}),
				} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			await vi.advanceTimersByTimeAsync(1000);
			await Promise.all([identify1, identify2, identify3]);

			expect(fetch).toHaveBeenCalledTimes(4);

			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					body: JSON.stringify({
						user: { userId: "user-1", email: "user1@example.com" },
					}),
				}),
			);
			expect(fetch).toHaveBeenNthCalledWith(
				3,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					body: JSON.stringify({
						user: { userId: "user-2", email: "user2@example.com" },
					}),
				}),
			);
			expect(fetch).toHaveBeenNthCalledWith(
				4,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					body: JSON.stringify({
						user: { userId: "user-3", email: "user3@example.com" },
					}),
				}),
			);
		});
	});

	describe("Metadata merging across init / identify / update", () => {
		test("session metadata and user metadata merge independently", async () => {
			const { init, identify, update } = await importMilana();

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-flow" }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							sessionId: "test-session-flow",
							sampled: true,
						}),
				} as Response)
				.mockResolvedValueOnce(makeUpdateSuccessResponse("test-session-flow"));

			await init(productId, clientKey, {
				environment: "production",
				version: "2.0.0",
				metadata: {
					app: "myapp",
					feature: "dashboard",
					sessionProp1: "initial",
				},
			});

			expect(fetch).toHaveBeenNthCalledWith(
				1,
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Product-Id": productId,
						"X-Milana-Client-Key": clientKey,
					}) as Record<string, string>,
					body: JSON.stringify({
						environment: "production",
						version: "2.0.0",
						metadata: {
							app: "myapp",
							feature: "dashboard",
							sessionProp1: "initial",
						},
					}),
				}),
			);

			await identify({
				userId: "user-123",
				email: "user@example.com",
				name: "Test User",
				metadata: {
					plan: "premium",
					userProp1: "value1",
					sharedProp: "userValue",
				},
			});

			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session-flow",
					}) as Record<string, string>,
					body: JSON.stringify({
						user: {
							userId: "user-123",
							email: "user@example.com",
							name: "Test User",
							metadata: {
								plan: "premium",
								userProp1: "value1",
								sharedProp: "userValue",
							},
						},
					}),
				}),
			);

			await update({
				session: {
					metadata: {
						feature: "settings",
						sessionProp2: "new",
						sharedProp: "sessionValue",
					},
				},
				user: {
					userId: "user-123",
					metadata: {
						plan: "enterprise",
						userProp2: "value2",
						sharedProp: "updatedUserValue",
					},
				},
			});

			expect(fetch).toHaveBeenNthCalledWith(
				3,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session-flow",
					}) as Record<string, string>,
					body: JSON.stringify({
						session: {
							metadata: {
								feature: "settings",
								sessionProp2: "new",
								sharedProp: "sessionValue",
							},
						},
						user: {
							userId: "user-123",
							metadata: {
								plan: "enterprise",
								userProp2: "value2",
								sharedProp: "updatedUserValue",
							},
						},
					}),
				}),
			);

			expect(fetch).toHaveBeenCalledTimes(3);
		});

		test("update() can identify a fresh user end-to-end", async () => {
			const { init, update } = await importMilana();

			vi.mocked(fetch)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "test-session-newuser",
						}),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ success: true }),
				} as Response);

			await init(productId, clientKey, {
				environment: "staging",
				version: "3.0.0",
			});

			await update({
				user: {
					userId: "new-user-456",
					email: "newuser@example.com",
					name: "New User",
					metadata: {
						source: "organic",
						role: "admin",
					},
				},
			});

			expect(fetch).toHaveBeenNthCalledWith(
				2,
				"https://in.getmilana.ai/update",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({
						"X-Milana-Session-Id": "test-session-newuser",
					}) as Record<string, string>,
					body: JSON.stringify({
						user: {
							userId: "new-user-456",
							email: "newuser@example.com",
							name: "New User",
							metadata: {
								source: "organic",
								role: "admin",
							},
						},
					}),
				}),
			);

			expect(fetch).toHaveBeenCalledTimes(2);
		});
	});
});
