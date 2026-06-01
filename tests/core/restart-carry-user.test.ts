import { describe, expect, test, vi } from "vitest";
import {
	clientKey,
	getCallsToEndpoint,
	importMilana,
	importSession,
	makeUpdateSuccessResponse,
	mockFetch,
	productId,
	readStoredSessionState,
	setupCoreTestHarness,
} from "./helpers";

// The last identity the server confirmed is saved in the sessionStorage blob
// and replayed onto the new session row after a server-driven restart, so the
// user survives the restart instead of being dropped.

const initOptions = { environment: "test", version: "1.0", metadata: {} };

const makeSessionResponse = (sessionId: string, sampled = true) =>
	({
		ok: true,
		json: () => Promise.resolve({ sampled, sessionId }),
	}) as Response;

const tooOldRestart = () =>
	({
		ok: true,
		json: () =>
			Promise.resolve({
				success: false,
				shouldRestartSession: true,
				errorCode: "SESSION_TOO_OLD_TO_CONTINUE_WITHOUT_RESTART",
			}),
	}) as Response;

const updateCalls = () => getCallsToEndpoint("/update");
const lastUpdateCall = () => {
	const calls = updateCalls();
	return calls[calls.length - 1];
};
const sessionCalls = () => getCallsToEndpoint("/session");
const headersOf = (call: unknown[]) =>
	(call[1] as RequestInit).headers as Record<string, string>;
const bodyOf = (call: unknown[]) =>
	JSON.parse((call[1] as RequestInit).body as string);

describe("Core Library - Restart carries user identity forward", () => {
	setupCoreTestHarness();

	test("replays the last confirmed user onto the new session after a restart", async () => {
		const { init, identify, updateSession } = await importMilana();
		mockFetch({
			"/session": [
				makeSessionResponse("session-1"),
				makeSessionResponse("session-2"),
			],
			// identify confirmed → the updateSession that triggers the restart →
			// the replay of the confirmed user onto session-2.
			"/update": [
				makeUpdateSuccessResponse("session-1"),
				tooOldRestart(),
				makeUpdateSuccessResponse("session-2"),
			],
		});

		await init(productId, clientKey, initOptions);
		// This identify succeeds, so the user is confirmed and saved.
		await identify({ userId: "user-1", email: "user-1@example.com" });
		// A later, changed call gets shouldRestartSession and triggers the restart.
		await updateSession({ metadata: { flag: true } });
		await vi.advanceTimersByTimeAsync(1);

		// init → restart mints session-2.
		expect(sessionCalls()).toHaveLength(2);

		// The replay re-attaches the *confirmed* user to the new session.
		const replay = lastUpdateCall();
		expect(replay).toBeDefined();
		expect(bodyOf(replay!).user).toEqual({
			userId: "user-1",
			email: "user-1@example.com",
		});
		expect(headersOf(replay!)["X-Milana-Session-Id"]).toBe("session-2");

		// The blob points at the new session and keeps the confirmed user. The
		// updateSession that triggered the restart was never confirmed, so its
		// metadata isn't saved or replayed — an accepted loss.
		const stored = readStoredSessionState();
		expect(stored?.sessionId).toBe("session-2");
		expect(stored?.user).toMatchObject({ userId: "user-1" });
		expect(stored?.sessionContext).toBeNull();
	});

	test("does not replay anything on a plain init with no cached identity", async () => {
		const { init } = await importMilana();
		mockFetch({ "/session": [makeSessionResponse("session-1")] });

		await init(productId, clientKey, initOptions);
		await vi.advanceTimersByTimeAsync(1);

		expect(updateCalls()).toHaveLength(0);
	});

	test("coalesces concurrent restarts into a single new session, then replays once", async () => {
		const { init, identify } = await importMilana();
		// Only two /session responses: init + exactly one restart. A second
		// restart issuing its own /session would exhaust the mock and fail.
		mockFetch({
			"/session": [
				makeSessionResponse("session-1"),
				makeSessionResponse("session-2"),
			],
			"/update": [
				makeUpdateSuccessResponse("session-1"),
				makeUpdateSuccessResponse("session-2"),
			],
		});
		const { MilanaSession } = await importSession();

		await init(productId, clientKey, initOptions);
		await identify({ userId: "user-1", email: "user-1@example.com" });

		const session = MilanaSession.currentSession as unknown as {
			restartSession: (cause: "update" | "batch") => void;
		};
		// Two triggers back-to-back before the first /session resolves.
		session.restartSession("update");
		session.restartSession("batch");
		await vi.advanceTimersByTimeAsync(1);

		expect(sessionCalls()).toHaveLength(2);
		// The user is replayed onto the single new session.
		const replay = lastUpdateCall();
		expect(headersOf(replay!)["X-Milana-Session-Id"]).toBe("session-2");
		expect(bodyOf(replay!).user).toMatchObject({ userId: "user-1" });
	});

	test("drops the save when a restart swapped the session out mid-flight", async () => {
		const { init, identify, updateUser } = await importMilana();

		// The racing update's response flips the stored session id to session-2
		// as it resolves — exactly what a restart's clear+mint does to the blob
		// while this request is in flight. sendUpdate captured session-1 before
		// sending, so on success it must notice the mismatch and drop the save
		// rather than write a session-1 confirmation under session-2.
		const racingUpdateResponse = {
			ok: true,
			json: () => {
				const blob = readStoredSessionState();
				window.sessionStorage.setItem(
					"milana_session_state",
					JSON.stringify({ ...blob, sessionId: "session-2" }),
				);
				return Promise.resolve({
					success: true,
					sessionId: "session-1",
					sampled: true,
				});
			},
		} as Response;

		mockFetch({
			"/session": [makeSessionResponse("session-1")],
			"/update": [
				makeUpdateSuccessResponse("session-1"), // identify confirms user-1
				racingUpdateResponse, // the racing update on the now-dead session-1
			],
		});

		await init(productId, clientKey, initOptions);
		await identify({ userId: "user-1", email: "user-1@example.com" });
		expect(readStoredSessionState()).toMatchObject({
			sessionId: "session-1",
			user: { userId: "user-1", email: "user-1@example.com" },
		});

		await updateUser({ userId: "user-1", email: "changed@example.com" });

		const stored = readStoredSessionState();
		expect(stored?.sessionId).toBe("session-2");
		// The racing update was confirmed for the now-dead session-1, so its
		// changed@ email must not overwrite the cached identity under session-2.
		expect(stored?.user).toMatchObject({
			userId: "user-1",
			email: "user-1@example.com",
		});
	});

	test("stop() clears the cached identity blob", async () => {
		const { init, identify, stopRecording } = await importMilana();
		mockFetch({
			"/session": [makeSessionResponse("session-1")],
			"/update": [makeUpdateSuccessResponse("session-1")],
		});

		await init(productId, clientKey, initOptions);
		await identify({ userId: "user-1", email: "user-1@example.com" });
		expect(readStoredSessionState()?.user).toMatchObject({
			userId: "user-1",
		});

		stopRecording();

		expect(readStoredSessionState()).toBeNull();
	});
});
