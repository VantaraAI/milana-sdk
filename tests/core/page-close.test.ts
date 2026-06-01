import { afterEach, describe, expect, test } from "vitest";
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

describe("Core Library - Page Close Events", () => {
	setupCoreTestHarness();

	afterEach(teardownLingeringSession);

	test("fires POST /batch with isPageClose on pagehide with persisted=false (empty buffer)", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "page-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("page-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);

		const [url, init_] = closeCalls[0];
		// URL is identical to regular /batch — same preflight cache entry.
		expect(getUrlString(url)).toBe("https://in.getmilana.ai/batch");
		expect(init_).toMatchObject({
			method: "POST",
			keepalive: true,
			headers: expect.objectContaining({
				"X-Milana-Product-Id": productId,
				"X-Milana-Client-Key": clientKey,
				"X-Milana-Session-Id": "page-close-session",
			}) as Record<string, string>,
		});

		const body = JSON.parse(init_?.body as string);
		expect(body).toMatchObject({ version: 1, isPageClose: true, events: [] });
		expect(body.isTruncated).toBeUndefined();
		expect(typeof body.batchStartedAt).toBe("number");
	});

	test("close ping ignores buffered events — visibility-hidden owns delivery", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "page-close-with-events",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("page-close-with-events")],
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

		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);

		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({
			version: 1,
			isPageClose: true,
			events: [],
		});
		expect(body.isTruncated).toBeUndefined();
		expect(typeof body.batchStartedAt).toBe("number");
	});

	test("does not fire when pagehide has persisted=true (bfcache freeze)", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "bfcache-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: true });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("does not fire for unsampled sessions", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: false,
							sessionId: "unsampled-close-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("sends close exactly once even if pagehide fires multiple times", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "idempotent-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("idempotent-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		dispatchPageHide({ persisted: false });
		dispatchPageHide({ persisted: false });
		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(1);
	});

	test("removes the pagehide listener after stopRecording", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "stop-recording-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Force stopRecording by driving the session into a terminal state. We
		// invoke the private method directly rather than replay a sampling
		// downgrade on /update because this test only cares about listener
		// cleanup, not the upstream trigger.
		const session = MilanaSession.currentSession as unknown as {
			stopRecording: () => void;
			pageCloseHandler: unknown;
		};
		session.stopRecording();

		expect(session.pageCloseHandler).toBeNull();

		dispatchPageHide({ persisted: false });

		expect(getPageCloseCalls()).toHaveLength(0);
	});

	test("close ping is fixed-size regardless of buffer state", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "fixed-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("fixed-close-session")],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		// Seed a buffer larger than the keepalive budget to verify the
		// close ping is unaffected by buffer state.
		const session = MilanaSession.currentSession as unknown as {
			events: Array<{ serialized: string; timestamp: number }>;
			bufferedCharacters: number;
		};
		session.events = [
			{ serialized: `"${"x".repeat(70_000)}"`, timestamp: 1000 },
		];
		session.bufferedCharacters = 70_000;

		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);
		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({
			version: 1,
			isPageClose: true,
			events: [],
		});
		expect(body.isTruncated).toBeUndefined();
		// Sanity-check the budget headroom claim: well under the 65,536-byte
		// per-document keepalive limit.
		expect((closeCalls[0][1]?.body as string).length).toBeLessThan(200);
	});

	test("close ping ignores in-flight regular batches (visibility-hidden aborts them)", async () => {
		const { init } = await importMilana();
		const { MilanaSession } = await importSession();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "inflight-close-session",
						}),
				} as Response,
			],
			"/batch": [makeUpdateSuccessResponse("inflight-close-session")],
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
		// Exercise pagehide in isolation. Aborting + reclaiming an
		// in-flight batch is tested in visibility-change.test.ts.
		session.isSendingEvents = true;

		dispatchPageHide({ persisted: false });

		const closeCalls = getPageCloseCalls();
		expect(closeCalls).toHaveLength(1);
		const body = JSON.parse(closeCalls[0][1]?.body as string);
		expect(body).toMatchObject({ isPageClose: true, events: [] });
		expect(body.isTruncated).toBeUndefined();
	});
});
