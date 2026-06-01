import { describe, expect, test, vi } from "vitest";
import { MILANA_CUSTOM_EVENT_TAG } from "../../src/core/session.ts";
import {
	addCustomEventMock,
	clientKey,
	importMilana,
	mockFetch,
	productId,
	setupCoreTestHarness,
} from "./helpers";

describe("Core Library - Window Focus Change Events", () => {
	setupCoreTestHarness();

	test.each([
		{ eventName: "blur", hasFocus: false },
		{ eventName: "focus", hasFocus: true },
	])("emits custom event on window $eventName during recording", async ({
		eventName,
		hasFocus,
	}) => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "focus-test-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		addCustomEventMock.mockClear();

		const hasFocusSpy = vi
			.spyOn(document, "hasFocus")
			.mockReturnValue(hasFocus);
		window.dispatchEvent(new Event(eventName));

		expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
			type: 5,
			hasFocus,
		});

		hasFocusSpy.mockRestore();
	});

	test("dedupes consecutive events with the same focus state", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "focus-test-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		addCustomEventMock.mockClear();

		const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		window.dispatchEvent(new Event("blur"));
		window.dispatchEvent(new Event("blur"));
		window.dispatchEvent(new Event("blur"));

		expect(addCustomEventMock).toHaveBeenCalledTimes(1);

		hasFocusSpy.mockRestore();
	});

	test("does not emit when session is not sampled", async () => {
		const { init } = await importMilana();

		mockFetch({
			"/session": [
				{
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: false,
							sessionId: "unsampled-focus-session",
						}),
				} as Response,
			],
		});

		await init(productId, clientKey, {
			environment: "test",
			version: "1.0",
			metadata: {},
		});

		addCustomEventMock.mockClear();

		window.dispatchEvent(new Event("blur"));
		window.dispatchEvent(new Event("focus"));

		expect(addCustomEventMock).not.toHaveBeenCalled();
	});
});
