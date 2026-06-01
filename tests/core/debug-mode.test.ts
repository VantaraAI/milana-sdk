import { describe, expect, test } from "vitest";
import {
	clientKey,
	importMilana,
	importSession,
	makeUpdateSuccessResponse,
	mockFetch,
	productId,
	setupCoreTestHarness,
} from "./helpers";

describe("Debug Mode", () => {
	setupCoreTestHarness();

	test("logs init, update, identify, and trackEvent when debug mode is on", async () => {
		localStorage.setItem("milana_debug_mode", "true");
		const { init, update, identify, trackEvent } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "debug-session" }),
				} as Response,
			],
			"/update": [
				makeUpdateSuccessResponse("debug-session"),
				makeUpdateSuccessResponse("debug-session"),
			],
		});

		const sessionInfo = { environment: "development", version: "1.0" };
		await init(productId, clientKey, sessionInfo);
		expect(console.debug).toHaveBeenCalledWith(
			"Milana [debug]: init",
			expect.objectContaining({ productId, sessionInfo }),
		);

		await update({ user: { userId: "u1" } });
		expect(console.debug).toHaveBeenCalledWith(
			"Milana [debug]: update invoked",
			{ user: { userId: "u1" } },
		);
		expect(console.debug).toHaveBeenCalledWith(
			"Milana [debug]: update executing",
			{ user: { userId: "u1" } },
		);

		await identify({ userId: "u2", email: "a@b.com" });
		expect(console.debug).toHaveBeenCalledWith("Milana [debug]: identify", {
			userId: "u2",
			email: "a@b.com",
		});

		trackEvent("click", { button: "ok" });
		expect(console.debug).toHaveBeenCalledWith(
			"Milana [debug]: trackEvent",
			"click",
			{ button: "ok" },
		);
	});

	test("does not log debug messages when debug mode is off", async () => {
		const { init, update, trackEvent } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "normal-session" }),
				} as Response,
			],
			"/update": [makeUpdateSuccessResponse("normal-session")],
		});

		await init(productId, clientKey, {
			environment: "production",
			version: "1.0",
		});
		await update({ user: { userId: "u1" } });
		trackEvent("click", { button: "ok" });

		const debugLogs = vi
			.mocked(console.debug)
			.mock.calls.filter(
				(args) =>
					typeof args[0] === "string" && args[0].startsWith("Milana [debug]:"),
			);
		expect(debugLogs).toHaveLength(0);
	});

	test("debugMode static getter reflects localStorage state", async () => {
		const { MilanaSession } = await importSession();
		expect(MilanaSession.debugMode).toBe(false);

		localStorage.setItem("milana_debug_mode", "true");
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "debug-session" }),
				} as Response,
			],
		});

		await init(productId, clientKey, { environment: "dev", version: "1.0" });
		expect(MilanaSession.debugMode).toBe(true);
	});
});
