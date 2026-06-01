import { afterEach, describe, expect, test, vi } from "vitest";
import {
	clientKey,
	dispatchPageHide,
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

function getAbortCalls() {
	return vi.mocked(fetch).mock.calls.filter((call) => {
		const init = call[1] as RequestInit | undefined;
		const body = init?.body;
		if (typeof body !== "string") return false;
		try {
			const parsed = JSON.parse(body);
			return (
				parsed.isClientAbort === true &&
				parsed.clientAbortReason === "CLIENT_STOPPED"
			);
		} catch {
			return false;
		}
	});
}

describe("Core Library - stopRecording", () => {
	setupCoreTestHarness();

	afterEach(teardownLingeringSession);

	test("posts /batch with isClientAbort + clientAbortReason and clears currentSession", async () => {
		const { init, stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "stop-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("stop-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		const result = await stopRecording();
		expect(result).toEqual({ success: true });

		const abortCalls = getAbortCalls();
		expect(abortCalls).toHaveLength(1);

		const [url, init_] = abortCalls[0];
		expect(getUrlString(url)).toBe("https://in.getmilana.ai/batch");
		expect(init_).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				"X-Milana-Product-Id": productId,
				"X-Milana-Client-Key": clientKey,
				"X-Milana-Session-Id": "stop-session",
			}) as Record<string, string>,
		});
		// Keepalive is only needed for the unload path; a programmatic stop
		// runs while the page is alive.
		expect(init_?.keepalive).toBeUndefined();

		const body = JSON.parse(init_?.body as string);
		expect(body).toMatchObject({
			version: 1,
			isClientAbort: true,
			clientAbortReason: "CLIENT_STOPPED",
			events: [],
		});
		expect(typeof body.batchStartedAt).toBe("number");

		// Singleton cleared so a subsequent init() is permitted.
		expect(MilanaSession.currentSession).toBeNull();
	});

	test("allows a fresh session to start after stopRecording", async () => {
		const { init, stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "first-session",
						}),
				} as Response,
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "second-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("first-session")],
		});

		// First session records normally.
		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});
		expect(
			(MilanaSession.currentSession?.state as { sessionId?: string })
				?.sessionId,
		).toBe("first-session");

		// Stop ends the first session.
		await stopRecording();
		expect(MilanaSession.currentSession).toBeNull();

		// Second init yields a brand-new session — the SDK doesn't resume
		// the one we just asked to close.
		const second = await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});
		expect(second).toEqual({ success: true });
		expect(
			(MilanaSession.currentSession?.state as { sessionId?: string })
				?.sessionId,
		).toBe("second-session");
	});

	test("returns success=false as a no-op when no session is active", async () => {
		const { stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		expect(MilanaSession.currentSession).toBeNull();

		const result = await stopRecording();
		expect(result).toEqual({ success: false });
		expect(getAbortCalls()).toHaveLength(0);
	});

	test("does not double-fire if pagehide runs after stopRecording", async () => {
		const { init, stopRecording } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "idempotent-stop",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("idempotent-stop")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		await stopRecording();
		// stopRecording tears down the pagehide listener via the private
		// stopRecording teardown, so dispatching pagehide should be a no-op.
		dispatchPageHide({ persisted: false });

		expect(getAbortCalls()).toHaveLength(1);
		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("superseding init during stopRecording race doesn't get clobbered by the losing init's cleanup", async () => {
		const { init, stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		// Hold the first /session response so we can stop + reinit while
		// it's still in flight.
		let resolveFirstSession: (value: Response) => void = () => {};
		const firstSessionResponse = new Promise<Response>((resolve) => {
			resolveFirstSession = resolve;
		});
		vi.mocked(fetch)
			.mockImplementationOnce(() => firstSessionResponse)
			.mockImplementationOnce(
				() =>
					Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								sampled: true,
								sessionId: "winning-session",
							}),
					}) as Promise<Response>,
			);

		const firstInit = init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});
		await Promise.resolve();

		// Stop the in-flight first init and immediately start a second one.
		await stopRecording();

		const secondInit = init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Now let the first init's fetch resolve. Its race guard should fire
		// (currentSession is now the second session), and its cleanup must
		// NOT null out the second session.
		resolveFirstSession({
			ok: true,
			json: () =>
				Promise.resolve({
					sampled: true,
					sessionId: "losing-session",
				}),
		} as Response);

		const [firstResult, secondResult] = await Promise.all([
			firstInit,
			secondInit,
		]);
		expect(firstResult).toEqual({ success: false });
		expect(secondResult).toEqual({ success: true });
		expect(
			(MilanaSession.currentSession?.state as { sessionId?: string })
				?.sessionId,
		).toBe("winning-session");
	});

	test("drains queued update/identify Promises when stopRecording runs mid-init", async () => {
		const { init, stopRecording, update, identify } = await importMilana();

		// Hold /session open so update/identify calls queue via
		// executeWhenReady instead of firing through.
		let resolveSession: (value: Response) => void = () => {};
		vi.mocked(fetch).mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					resolveSession = resolve;
				}),
		);

		const initPromise = init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});
		await Promise.resolve();

		// Session is Initializing — these queue.
		const updatePromise = update({ user: { userId: "u-1" } });
		const identifyPromise = identify({
			userId: "u-1",
			email: "u-1@example.com",
		});

		// Stop drains the queue; queued Promises must resolve, not hang.
		await stopRecording();

		// Unblock init so the test teardown can complete.
		resolveSession({
			ok: true,
			json: () => Promise.resolve({ sampled: true, sessionId: "raced" }),
		} as Response);
		await initPromise;

		await expect(updatePromise).resolves.toEqual({ success: false });
		await expect(identifyPromise).resolves.toEqual({ success: false });
	});

	test("does not send abort when called before init completes", async () => {
		const { init, stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		// Hold the /session response open so we can fire stopRecording while
		// init is mid-flight.
		let resolveSession: (value: Response) => void = () => {};
		const sessionResponse = new Promise<Response>((resolve) => {
			resolveSession = resolve;
		});

		vi.mocked(fetch).mockImplementationOnce(() => sessionResponse);

		const initPromise = init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Flush microtasks so init gets into the awaited fetch.
		await Promise.resolve();

		// Stop while the session is still Initializing — no close request
		// should fire (we aren't Recording yet), and the in-flight init
		// should return { success: false } thanks to the race guard.
		const stopResult = await stopRecording();
		expect(stopResult).toEqual({ success: true });

		resolveSession({
			ok: true,
			json: () =>
				Promise.resolve({ sampled: true, sessionId: "raced-session" }),
		} as Response);

		const initResult = await initPromise;
		expect(initResult).toEqual({ success: false });

		// No close signal (we weren't Recording), and no lingering singleton.
		expect(getAbortCalls()).toHaveLength(0);
		expect(MilanaSession.currentSession).toBeNull();
	});

	test("omits buffered events from the stop request when a /batch is in flight", async () => {
		const { init, stopRecording } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "inflight-stop-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("inflight-stop-session")],
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
		// Simulate the in-flight regular /batch. When it resolves, it will
		// deliver these events; the stop request must not re-send them.
		session.isSendingEvents = true;

		await stopRecording();

		const abortCalls = getAbortCalls();
		expect(abortCalls).toHaveLength(1);
		const body = JSON.parse(abortCalls[0][1]?.body as string);
		expect(body).toMatchObject({
			isClientAbort: true,
			clientAbortReason: "CLIENT_STOPPED",
			events: [],
		});
	});
});
