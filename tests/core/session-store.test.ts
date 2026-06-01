import { beforeEach, describe, expect, test, vi } from "vitest";

// Fresh module per test so storage state doesn't leak between cases
// (setup.ts also resets modules and clears storage).
async function importSessionStore() {
	return import("../../src/core/session-store.ts");
}

beforeEach(() => {
	vi.resetModules();
	window.sessionStorage.clear();
});

describe("session-store", () => {
	describe("load / save / clear", () => {
		test("round-trips a stored session", async () => {
			const { saveSessionState, loadSessionState } = await importSessionStore();
			const state = {
				sessionId: "s1",
				user: { userId: "u1", email: "a@b.com" },
				sessionContext: { metadata: { theme: "dark" } },
			};
			saveSessionState(state);
			expect(loadSessionState()).toEqual(state);
		});

		test("clearSessionState removes everything", async () => {
			const { saveSessionState, clearSessionState, loadSessionState } =
				await importSessionStore();
			saveSessionState({
				sessionId: "s1",
				user: { userId: "u1" },
				sessionContext: null,
			});
			clearSessionState();
			expect(loadSessionState()).toBeNull();
		});
	});

	describe("read / parse", () => {
		test("treats a malformed blob as no state", async () => {
			window.sessionStorage.setItem("milana_session_state", "{not json");
			const { loadSessionState } = await importSessionStore();
			expect(loadSessionState()).toBeNull();
		});

		test("treats a structurally invalid user blob as no user", async () => {
			window.sessionStorage.setItem(
				"milana_session_state",
				JSON.stringify({ sessionId: "s1", user: { noUserId: 1 } }),
			);
			const { loadSessionState } = await importSessionStore();
			expect(loadSessionState()).toEqual({
				sessionId: "s1",
				user: null,
				sessionContext: null,
			});
		});
	});

	describe("mergeUser", () => {
		test("merges fields, last value wins, undefined does not clobber", async () => {
			const { mergeUser } = await importSessionStore();
			const first = mergeUser(null, {
				userId: "u1",
				email: "a@b.com",
				metadata: { plan: "free", a: 1 },
			});
			// Partial update: keeps email, overrides plan, adds b.
			const merged = mergeUser(first, {
				userId: "u1",
				metadata: { plan: "pro", b: 2 },
			});
			expect(merged).toEqual({
				userId: "u1",
				email: "a@b.com",
				metadata: { plan: "pro", a: 1, b: 2 },
			});
		});

		test("drops undefined fields so the result equals an omitted-field call", async () => {
			const { mergeUser } = await importSessionStore();
			// identify() passes name/metadata as undefined when omitted.
			expect(
				mergeUser(null, {
					userId: "u1",
					email: "a@b.com",
					name: undefined,
					metadata: undefined,
				}),
			).toEqual(mergeUser(null, { userId: "u1", email: "a@b.com" }));
		});
	});

	describe("mergeSessionContext", () => {
		test("keeps metadata, appSessionId, and integrations together", async () => {
			const { mergeSessionContext } = await importSessionStore();
			expect(
				mergeSessionContext(null, {
					metadata: { theme: "dark" },
					integrations: { posthog: { sessionId: "ph-1" } },
				}),
			).toEqual({
				metadata: { theme: "dark" },
				integrations: { posthog: { sessionId: "ph-1" } },
			});
		});

		test("merges integrations per vendor across calls", async () => {
			const { mergeSessionContext } = await importSessionStore();
			const first = mergeSessionContext(null, {
				integrations: { posthog: { sessionId: "ph-1" } },
			});
			const merged = mergeSessionContext(first, {
				integrations: { sentry: { replayId: "sn-1" } },
			});
			expect(merged).toEqual({
				integrations: {
					posthog: { sessionId: "ph-1" },
					sentry: { replayId: "sn-1" },
				},
			});
		});
	});

	describe("session id", () => {
		test("clearing the session id keeps the saved user", async () => {
			const { saveSessionState, clearSessionId, loadSessionState } =
				await importSessionStore();
			saveSessionState({
				sessionId: "s1",
				user: { userId: "u1" },
				sessionContext: null,
			});
			clearSessionId();
			const stored = loadSessionState();
			expect(stored?.sessionId).toBeNull();
			expect(stored?.user).toEqual({ userId: "u1" });
		});

		test("saving a session id preserves saved identity", async () => {
			const { saveSessionState, setSessionId, loadSessionState } =
				await importSessionStore();
			saveSessionState({
				sessionId: null,
				user: { userId: "u1" },
				sessionContext: null,
			});
			setSessionId("s2");
			expect(loadSessionState()).toEqual({
				sessionId: "s2",
				user: { userId: "u1" },
				sessionContext: null,
			});
		});
	});
});
