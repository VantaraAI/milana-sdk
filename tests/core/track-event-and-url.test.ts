import { describe, expect, test, vi } from "vitest";
import type { TrackEventAttributes } from "@/core/types.ts";
import { MILANA_CUSTOM_EVENT_TAG } from "../../src/core/session.ts";
import {
	addCustomEventMock,
	clientKey,
	importMilana,
	productId,
	setupCoreTestHarness,
} from "./helpers";

describe("Core Library - TrackEvent and URL Tracking", () => {
	setupCoreTestHarness();

	describe("trackEvent API", () => {
		test("should emit rrweb custom event when session is recording", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "log-session-1" }),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			trackEvent("custom_event", {
				strAttr: "value",
				numAttr: 42,
				boolAttr: true,
				nullAttr: null,
			});

			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
				type: 1,
				name: "custom_event",
				attributes: {
					strAttr: "value",
					numAttr: 42,
					boolAttr: true,
					nullAttr: null,
				},
			});
		});

		test("should warn and drop non-primitive attributes", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "log-session-2" }),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			trackEvent("invalid_attributes_event", {
				stringAttr: "ok",
				objectAttr: { nested: true },
				arrayAttr: ["bad"],
				functionAttr: () => "bad",
				numberAttr: 5,
				booleanAttr: false,
				nullAttr: null,
				undefinedAttr: undefined,
			} as unknown as TrackEventAttributes);

			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
				type: 1,
				name: "invalid_attributes_event",
				attributes: {
					stringAttr: "ok",
					numberAttr: 5,
					booleanAttr: false,
					nullAttr: null,
				},
			});
		});

		test("should queue trackEvent calls made before init completes", async () => {
			const { init, trackEvent } = await importMilana();

			trackEvent("queued_event", { queued: true });

			expect(addCustomEventMock).not.toHaveBeenCalled();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "log-session-queued",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			// Init tracks initial URL, so we expect 2 calls: initial URL + queued event
			expect(addCustomEventMock).toHaveBeenCalledTimes(2);

			// First call should be initial URL tracking (type 2 = path change)
			expect(addCustomEventMock).toHaveBeenNthCalledWith(
				1,
				MILANA_CUSTOM_EVENT_TAG,
				expect.objectContaining({
					type: 2,
					name: "load",
				}),
			);

			// Second call should be the queued trackEvent
			expect(addCustomEventMock).toHaveBeenNthCalledWith(
				2,
				MILANA_CUSTOM_EVENT_TAG,
				{
					type: 1,
					name: "queued_event",
					attributes: {
						queued: true,
					},
				},
			);
		});

		test("should skip tracking when session is not sampled", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: false,
						sessionId: "unsampled-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			trackEvent("ignored_event", { foo: "bar" });

			expect(addCustomEventMock).not.toHaveBeenCalled();
		});

		test("should reject event name longer than 255 characters", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "length-test-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			const longEventName = "a".repeat(256);
			trackEvent(longEventName, { foo: "bar" });

			expect(addCustomEventMock).not.toHaveBeenCalled();
		});

		test("should filter out attribute keys with invalid length", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "key-length-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			trackEvent("event_with_invalid_keys", {
				"": "empty key",
				["a".repeat(256) as unknown as string]: "too long key",
				validKey: "valid value",
			} as unknown as TrackEventAttributes);

			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
				type: 1,
				name: "event_with_invalid_keys",
				attributes: {
					validKey: "valid value",
				},
			});
		});

		test("should filter out string attribute values with invalid length", async () => {
			const { init, trackEvent } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "value-length-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			trackEvent("event_with_invalid_values", {
				emptyString: "",
				tooLongString: "a".repeat(2049),
				validString: "valid",
				validNumber: 123,
				validBoolean: true,
				validNull: null,
			});

			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			expect(addCustomEventMock).toHaveBeenCalledWith(MILANA_CUSTOM_EVENT_TAG, {
				type: 1,
				name: "event_with_invalid_values",
				attributes: {
					validString: "valid",
					validNumber: 123,
					validBoolean: true,
					validNull: null,
				},
			});
		});
	});

	describe("URL Tracking", () => {
		test("should track initial URL on session start", async () => {
			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "url-init-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			// Should have at least one call for initial URL
			expect(addCustomEventMock).toHaveBeenCalled();

			// First call should be initial URL tracking
			const firstCall = addCustomEventMock.mock.calls[0];
			expect(firstCall[0]).toBe(MILANA_CUSTOM_EVENT_TAG);
			expect(firstCall[1]).toMatchObject({
				type: 2, // URL_PATH_CHANGE_EVENT_TYPE
				name: "load",
			});
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			expect(firstCall[1].attributes).toHaveProperty("url");
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			expect(typeof firstCall[1].attributes.url).toBe("string");
		});

		test("should emit path change event when pathname changes", async () => {
			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "path-change-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			// Simulate path change via pushState
			window.history.pushState({}, "", "/new-path");

			// Wait for debounce
			await vi.advanceTimersByTimeAsync(150);

			// Should emit path change event
			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			const pathCall = addCustomEventMock.mock.calls[0];
			expect(pathCall[0]).toBe(MILANA_CUSTOM_EVENT_TAG);
			expect(pathCall[1]).toMatchObject({
				type: 2, // URL_PATH_CHANGE_EVENT_TYPE
				name: "pushstate",
			});
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			expect(pathCall[1].attributes.url).toContain("/new-path");
		});

		test("should emit query change event when only query params change", async () => {
			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "query-change-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			// Get current path
			const currentPath = window.location.pathname;

			addCustomEventMock.mockClear();

			// Simulate query change via pushState (same path, different query)
			window.history.pushState({}, "", `${currentPath}?foo=bar`);

			// Wait for debounce
			await vi.advanceTimersByTimeAsync(150);

			// Should emit query change event (type 3)
			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			const queryCall = addCustomEventMock.mock.calls[0];
			expect(queryCall[0]).toBe(MILANA_CUSTOM_EVENT_TAG);
			expect(queryCall[1]).toMatchObject({
				type: 3, // URL_QUERY_CHANGE_EVENT_TYPE
				name: "pushstate",
			});
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			expect(queryCall[1].attributes.url).toContain("?foo=bar");
		});

		test("should debounce rapid navigation changes and only track the last one", async () => {
			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: true,
						sessionId: "debounce-test-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			addCustomEventMock.mockClear();

			// Simulate rapid navigation changes within the debounce window (100ms)
			window.history.pushState({}, "", "/path-1");
			await vi.advanceTimersByTimeAsync(50); // Half the debounce time
			window.history.pushState({}, "", "/path-2");
			await vi.advanceTimersByTimeAsync(50); // Another half
			window.history.pushState({}, "", "/path-3");

			// Wait for debounce to complete
			await vi.advanceTimersByTimeAsync(150);

			// Should only emit one event for the last navigation
			expect(addCustomEventMock).toHaveBeenCalledTimes(1);
			const call = addCustomEventMock.mock.calls[0];
			expect(call[0]).toBe(MILANA_CUSTOM_EVENT_TAG);
			expect(call[1]).toMatchObject({
				type: 2, // URL_PATH_CHANGE_EVENT_TYPE
				name: "pushstate",
			});
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			expect(call[1].attributes.url).toContain("/path-3");
		});

		test("should not track URLs when session is not sampled", async () => {
			const { init } = await importMilana();

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sampled: false,
						sessionId: "unsampled-session",
					}),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			// No URL tracking events should be emitted for unsampled sessions
			expect(addCustomEventMock).not.toHaveBeenCalled();

			// Simulate path change
			window.history.pushState({}, "", "/another-path");

			// Wait for debounce
			await vi.advanceTimersByTimeAsync(150);

			// Still no events
			expect(addCustomEventMock).not.toHaveBeenCalled();
		});

		describe("URL Query Parameter Sanitization", () => {
			test("should redact query params in default denylist", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "sanitize-session",
						}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				const currentPath = window.location.pathname;
				addCustomEventMock.mockClear();

				window.history.pushState(
					{},
					"",
					`${currentPath}?token=secret123&foo=bar&code=xyz`,
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("token=--redacted--");
				expect(url).toContain("code=--redacted--");
				expect(url).toContain("foo=bar");
				expect(url).not.toContain("secret123");
				expect(url).not.toContain("xyz");
			});

			test("should handle case-insensitive query param matching", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "case-insensitive-session",
						}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				const currentPath = window.location.pathname;
				addCustomEventMock.mockClear();

				window.history.pushState(
					{},
					"",
					`${currentPath}?TOKEN=secret&my_password=xyz&JWT=test123`,
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("TOKEN=--redacted--");
				expect(url).toContain("my_password=--redacted--");
				expect(url).toContain("JWT=--redacted--");
				expect(url).not.toContain("secret");
				expect(url).not.toContain("xyz");
				expect(url).not.toContain("test123");
			});

			test("should use custom denylist when provided", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "custom-denylist-session",
						}),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{
						privacy: {
							blockClass: "milana-block",
							blockSelector: null,
							ignoreClass: "milana-ignore",
							ignoreSelector: null,
							maskTextClass: "milana-mask",
							maskInputClass: "milana-mask",
							shouldTrackQueryParams: true,
							queryTrackingParamsDenyList: [
								/^custom_secret$/i,
								/^internal_id$/i,
							],
						},
					},
				);

				const currentPath = window.location.pathname;
				addCustomEventMock.mockClear();

				window.history.pushState(
					{},
					"",
					`${currentPath}?custom_secret=abc&user_token=xyz&internal_id=123&foo=bar`,
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				// Custom patterns should redact these
				expect(url).toContain("custom_secret=--redacted--");
				expect(url).toContain("internal_id=--redacted--");
				// Default pattern /token/i should also redact user_token
				expect(url).toContain("user_token=--redacted--");
				// foo should not be redacted by any pattern
				expect(url).toContain("foo=bar");
			});

			test("should not track query param changes when shouldTrackQueryParams is false", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "no-query-tracking-session",
						}),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{
						privacy: {
							blockClass: "milana-block",
							blockSelector: null,
							ignoreClass: "milana-ignore",
							ignoreSelector: null,
							maskTextClass: "milana-mask",
							maskInputClass: "milana-mask",
							shouldTrackQueryParams: false,
							queryTrackingParamsDenyList: [
								/^jwt$/i,
								/^code$/i,
								/token/i,
								/password/i,
								/secret/i,
								/key/i,
								/auth/i,
								/nonce/i,
								/csrf/i,
							],
						},
					},
				);

				const currentPath = window.location.pathname;
				addCustomEventMock.mockClear();

				window.history.pushState({}, "", `${currentPath}?foo=bar&baz=qux`);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).not.toHaveBeenCalled();
			});

			test("should strip query params from path change events when shouldTrackQueryParams is false", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "path-no-query-session",
						}),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{
						privacy: {
							blockClass: "milana-block",
							blockSelector: null,
							ignoreClass: "milana-ignore",
							ignoreSelector: null,
							maskTextClass: "milana-mask",
							maskInputClass: "milana-mask",
							shouldTrackQueryParams: false,
							queryTrackingParamsDenyList: [
								/^jwt$/i,
								/^code$/i,
								/token/i,
								/password/i,
								/secret/i,
								/key/i,
								/auth/i,
								/nonce/i,
								/csrf/i,
							],
						},
					},
				);

				addCustomEventMock.mockClear();

				window.history.pushState({}, "", "/new-path?token=secret&api_key=xyz");

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				expect(call[1]).toMatchObject({
					type: 2,
					name: "pushstate",
				});
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("/new-path");
				expect(url).not.toContain("token");
				expect(url).not.toContain("api_key");
				expect(url).not.toContain("?");
			});

			test("should sanitize query params in path change events", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "path-with-sanitize-session",
						}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				addCustomEventMock.mockClear();

				window.history.pushState({}, "", "/initial-path");
				await vi.advanceTimersByTimeAsync(150);

				addCustomEventMock.mockClear();

				window.history.pushState(
					{},
					"",
					"/new-path?token=secret&foo=bar&jwt=xyz123",
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				expect(call[1]).toMatchObject({
					type: 2,
					name: "pushstate",
				});
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("/new-path");
				expect(url).toContain("token=--redacted--");
				expect(url).toContain("jwt=--redacted--");
				expect(url).toContain("foo=bar");
				expect(url).not.toContain("secret");
				expect(url).not.toContain("xyz123");
			});

			test("should support fuzzy matching with contains", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "fuzzy-match-session",
						}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				const currentPath = window.location.pathname;
				addCustomEventMock.mockClear();

				window.history.pushState(
					{},
					"",
					`${currentPath}?user_token=abc&my_password=xyz&secret_value=123&safe=ok`,
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("user_token=--redacted--");
				expect(url).toContain("my_password=--redacted--");
				expect(url).toContain("secret_value=--redacted--");
				expect(url).toContain("safe=ok");
			});

			test("should strip all params when shouldTrackQueryParams is false", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							sampled: true,
							sessionId: "no-param-tracking-session",
						}),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{
						privacy: {
							blockClass: "milana-block",
							blockSelector: null,
							ignoreClass: "milana-ignore",
							ignoreSelector: null,
							maskTextClass: "milana-mask",
							maskInputClass: "milana-mask",
							shouldTrackQueryParams: false,
							queryTrackingParamsDenyList: [
								/^jwt$/i,
								/^code$/i,
								/token/i,
								/password/i,
								/secret/i,
								/key/i,
								/auth/i,
								/nonce/i,
								/csrf/i,
							],
						},
					},
				);

				addCustomEventMock.mockClear();

				// First navigate to an initial path
				window.history.pushState({}, "", "/initial-path");
				await vi.advanceTimersByTimeAsync(150);

				addCustomEventMock.mockClear();

				// Then navigate to new path with params
				window.history.pushState(
					{},
					"",
					"/new-path?foo=bar&baz=qux#param1=val1&param2=val2",
				);

				await vi.advanceTimersByTimeAsync(150);

				expect(addCustomEventMock).toHaveBeenCalledTimes(1);
				const call = addCustomEventMock.mock.calls[0];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
				const url = call[1].attributes.url as string;
				expect(url).toContain("/new-path");
				expect(url).not.toContain("?");
				expect(url).not.toContain("#");
				expect(url).not.toContain("foo");
				expect(url).not.toContain("param1");
			});
		});
	});
});
