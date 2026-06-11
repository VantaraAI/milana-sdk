import type { record as rrwebRecord } from "@rrweb/record";
import { describe, expect, test, vi } from "vitest";
import type { SessionPerfMetrics } from "@/core/session.ts";
import { MILANA_CUSTOM_EVENT_TAG } from "../../src/core/session.ts";
// Masked values are asserted via staticMaskText: jsdom has no canvas 2d
// context, so the layout-preserving masker always takes its static fallback
// here. These tests cover mask-vs-reveal routing; the mask algorithm itself
// is covered in text-mask.test.ts.
import { staticMaskText } from "../../src/core/text-mask.ts";
import { setItemMock } from "../setup";
import {
	clientKey,
	getUrlString,
	importMilana,
	importSession,
	logMetricsIntervalDuration,
	mockFetch,
	productId,
	readStoredSessionId,
	setupCoreTestHarness,
	type TestSessionInternals,
} from "./helpers";

type RrwebRecordOptions = {
	maskTextSelector?: string;
	blockClass?: string | RegExp;
	maskInputFn?: (value: string, el: HTMLElement) => string;
	maskTextFn?: (value: string, el: HTMLElement | null) => string;
};

function mockSampledSession(sessionId: string): void {
	vi.mocked(fetch).mockResolvedValueOnce({
		ok: true,
		json: () => Promise.resolve({ sampled: true, sessionId }),
	} as Response);
}

function getRrwebOptions(recordFn: typeof rrwebRecord): RrwebRecordOptions {
	return vi.mocked(recordFn).mock.calls[0]?.[0] as RrwebRecordOptions;
}

// Nests `el` several levels below an ancestor carrying `className`, with plain
// intermediate wrappers in between. Masking must then resolve through the
// ancestor walk (element.closest / parentElement) rather than matching the
// element itself. Returns the outermost ancestor so callers can nest further.
function nestUnder(className: string, el: HTMLElement, depth = 2): HTMLElement {
	const root = document.createElement("div");
	root.className = className;
	let parent: HTMLElement = root;
	for (let i = 0; i < depth; i++) {
		const mid = document.createElement("div");
		parent.appendChild(mid);
		parent = mid;
	}
	parent.appendChild(el);
	return root;
}

describe("Core Library - Init and Metrics", () => {
	setupCoreTestHarness();

	describe("Init API", () => {
		describe("Success Cases", () => {
			test("should initialize with valid parameters", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "direct-session" }),
						} as Response,
					],
				});

				await init(productId, clientKey, {
					environment: "production",
					version: "2.0",
					metadata: { userId: "user-123" },
				});

				expect(fetch).toHaveBeenCalledWith(
					"https://in.getmilana.ai/session",
					expect.objectContaining({
						method: "POST",
						headers: expect.objectContaining({
							"X-Milana-Product-Id": productId,
							"X-Milana-Client-Key": clientKey,
							"X-Milana-Caller-Type": "core",
						}) as Record<string, string>,
						body: JSON.stringify({
							environment: "production",
							version: "2.0",
							metadata: { userId: "user-123" },
						}),
					}),
				);
			});

			test("should store session ID when sampled", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session-123" }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(readStoredSessionId()).toBe("test-session-123");
			});

			test("should use custom endpoint when provided", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session" }),
				} as Response);

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					{ endpoint: "https://custom.example.com" },
				);

				expect(fetch).toHaveBeenCalledWith(
					"https://custom.example.com/session",
					expect.any(Object),
				);
			});

			describe("Privacy masking presets", () => {
				test("normal preserves current input and text masking behavior", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("normal-privacy-session");

					await init(productId, clientKey, {
						environment: "test",
						version: "1.0",
						metadata: {},
					});

					const rrwebOptions = getRrwebOptions(record);
					expect(rrwebOptions.maskTextSelector).toBeUndefined();

					const textInput = document.createElement("input");
					textInput.type = "text";
					expect(rrwebOptions.maskInputFn?.("customer data", textInput)).toBe(
						"customer data",
					);

					const emailInput = document.createElement("input");
					emailInput.type = "email";
					const email = "jane@example.com";
					expect(rrwebOptions.maskInputFn?.(email, emailInput)).toBe(
						staticMaskText(email),
					);

					// Text and inputs nested below a maskTextClass/maskInputClass
					// (.milana-mask) ancestor are masked via the class ancestor walk,
					// even though the class is not on the element itself.
					const maskedText = document.createElement("span");
					nestUnder("milana-mask", maskedText);
					expect(rrwebOptions.maskTextFn?.("Secret", maskedText)).toBe(
						staticMaskText("Secret"),
					);

					const nestedInput = document.createElement("input");
					nestedInput.type = "text";
					nestUnder("milana-mask", nestedInput);
					expect(rrwebOptions.maskInputFn?.("customer data", nestedInput)).toBe(
						staticMaskText("customer data"),
					);
				});

				test("high masks all inputs without globally masking text", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("high-privacy-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "high" } },
					);

					const rrwebOptions = getRrwebOptions(record);
					expect(rrwebOptions.maskTextSelector).toBeUndefined();

					const input = document.createElement("input");
					input.type = "text";
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						staticMaskText("customer data"),
					);
				});

				test("xhigh masks all inputs and all DOM text", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("xhigh-privacy-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "xhigh" } },
					);

					const rrwebOptions = getRrwebOptions(record);
					expect(rrwebOptions.maskTextSelector).toBe("*");

					const textElement = document.createElement("p");
					expect(rrwebOptions.maskTextFn?.("Secret text", textElement)).toBe(
						staticMaskText("Secret text"),
					);

					const input = document.createElement("input");
					input.type = "text";
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						staticMaskText("customer data"),
					);
				});

				test("maskSelector masks text and inputs in matching subtrees", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("mask-selector-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskSelector: ".sensitive" } },
					);

					const rrwebOptions = getRrwebOptions(record);
					expect(rrwebOptions.maskTextSelector).toBe(".sensitive");

					// The selector sits on an ancestor and the masked nodes are nested
					// below it, so masking resolves through element.closest(".sensitive").
					const textElement = document.createElement("span");
					nestUnder("sensitive", textElement);
					expect(rrwebOptions.maskTextFn?.("Secret", textElement)).toBe(
						staticMaskText("Secret"),
					);

					const input = document.createElement("input");
					input.type = "text";
					nestUnder("sensitive", input);
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						staticMaskText("customer data"),
					);
				});

				test("unmaskSelector reveals preset-masked text and inputs", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("unmask-selector-session");

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
								maskingLevel: "xhigh",
								unmaskSelector: ".public",
							},
						},
					);

					const rrwebOptions = getRrwebOptions(record);

					// unmaskSelector is on an ancestor; nested nodes inherit the reveal
					// through the ancestor walk (closest, and the block check inside it).
					const textElement = document.createElement("span");
					nestUnder("public", textElement);
					expect(rrwebOptions.maskTextFn?.("Public text", textElement)).toBe(
						"Public text",
					);

					const input = document.createElement("input");
					input.type = "text";
					nestUnder("public", input);
					expect(rrwebOptions.maskInputFn?.("public data", input)).toBe(
						"public data",
					);
				});

				test("unmaskSelector at maskingLevel normal logs a warning", async () => {
					const { init } = await importMilana();
					mockSampledSession("unmask-normal-warning-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						// No maskingLevel -> defaults to "normal", where unmaskSelector
						// has nothing to reveal.
						{ privacy: { unmaskSelector: ".public" } },
					);

					expect(console.warn).toHaveBeenCalledWith(
						expect.stringContaining("privacy.unmaskSelector is ignored"),
					);
				});

				test("unmaskSelector at maskingLevel high does not warn", async () => {
					const { init } = await importMilana();
					mockSampledSession("unmask-high-no-warning-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "high", unmaskSelector: ".public" } },
					);

					expect(console.warn).not.toHaveBeenCalledWith(
						expect.stringContaining("privacy.unmaskSelector is ignored"),
					);
				});

				test("explicit mask wins over unmaskSelector", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("explicit-mask-session");

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
								maskingLevel: "xhigh",
								maskSelector: ".sensitive",
								unmaskSelector: ".public",
							},
						},
					);

					const rrwebOptions = getRrwebOptions(record);

					// Nodes live below a .sensitive (mask) ancestor that is itself below
					// a .public (unmask) ancestor. Both selectors match via the ancestor
					// walk, and the explicit mask must still win over the unmask.
					const textElement = document.createElement("span");
					const maskedSubtree = nestUnder("sensitive", textElement);
					nestUnder("public", maskedSubtree);
					expect(rrwebOptions.maskTextFn?.("Secret", textElement)).toBe(
						staticMaskText("Secret"),
					);

					const input = document.createElement("input");
					input.type = "text";
					const maskedInputSubtree = nestUnder("sensitive", input);
					nestUnder("public", maskedInputSubtree);
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						staticMaskText("customer data"),
					);
				});

				test("password inputs remain masked under unmaskSelector", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("password-unmask-session");

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
								maskingLevel: "high",
								unmaskSelector: ".public",
							},
						},
					);

					const rrwebOptions = getRrwebOptions(record);
					const input = document.createElement("input");
					input.type = "password";
					input.className = "public";
					// Passwords get a length-preserving mask (one * per char), not
					// the layout-preserving one: the field renders bullets per char.
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						"*************",
					);
				});

				test("tel and email inputs are always masked, even under unmaskSelector", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("always-masked-types-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						// Default ("normal") level plus a broad unmaskSelector: the
						// always-masked types must still not be revealed.
						{ privacy: { unmaskSelector: ".public" } },
					);

					const rrwebOptions = getRrwebOptions(record);

					const email = document.createElement("input");
					email.type = "email";
					email.className = "public";
					const emailValue = "jane@example.com";
					expect(rrwebOptions.maskInputFn?.(emailValue, email)).toBe(
						staticMaskText(emailValue),
					);

					const tel = document.createElement("input");
					tel.type = "tel";
					tel.className = "public";
					const telValue = "5551234567";
					expect(rrwebOptions.maskInputFn?.(telValue, tel)).toBe(
						staticMaskText(telValue),
					);
				});

				test("default milana-unmask class reveals preset-masked text and inputs", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("unmask-class-default-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						// No unmaskClass / unmaskSelector configured: the built-in
						// "milana-unmask" convention must work on its own.
						{ privacy: { maskingLevel: "xhigh" } },
					);

					const rrwebOptions = getRrwebOptions(record);

					const textElement = document.createElement("span");
					nestUnder("milana-unmask", textElement);
					expect(rrwebOptions.maskTextFn?.("Public text", textElement)).toBe(
						"Public text",
					);

					const input = document.createElement("input");
					input.type = "text";
					nestUnder("milana-unmask", input);
					expect(rrwebOptions.maskInputFn?.("public data", input)).toBe(
						"public data",
					);

					// Password is an always-masked type; the class must not reveal it.
					const password = document.createElement("input");
					password.type = "password";
					nestUnder("milana-unmask", password);
					expect(rrwebOptions.maskInputFn?.("hunter2", password)).toBe(
						"*******",
					);
				});

				test("custom unmaskClass replaces the default", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("unmask-class-custom-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "xhigh", unmaskClass: "copy-ok" } },
					);

					const rrwebOptions = getRrwebOptions(record);

					const revealed = document.createElement("span");
					nestUnder("copy-ok", revealed);
					expect(rrwebOptions.maskTextFn?.("Public text", revealed)).toBe(
						"Public text",
					);

					// The default class no longer reveals once overridden.
					const stillMasked = document.createElement("span");
					nestUnder("milana-unmask", stillMasked);
					expect(rrwebOptions.maskTextFn?.("Secret", stillMasked)).toBe(
						"******",
					);
				});

				test("unmaskClass set to empty string disables class-based unmasking", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("unmask-class-disabled-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "xhigh", unmaskClass: "" } },
					);

					const rrwebOptions = getRrwebOptions(record);

					const textElement = document.createElement("span");
					nestUnder("milana-unmask", textElement);
					expect(rrwebOptions.maskTextFn?.("Secret", textElement)).toBe(
						"******",
					);
				});

				test("explicit mask wins over unmaskClass", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("explicit-mask-over-class-session");

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
								maskingLevel: "xhigh",
								maskSelector: ".sensitive",
							},
						},
					);

					const rrwebOptions = getRrwebOptions(record);

					// .sensitive (mask) ancestor below a milana-unmask ancestor: the
					// explicit mask must win regardless of nesting order.
					const textElement = document.createElement("span");
					const maskedSubtree = nestUnder("sensitive", textElement);
					nestUnder("milana-unmask", maskedSubtree);
					expect(rrwebOptions.maskTextFn?.("Secret", textElement)).toBe(
						"******",
					);

					const input = document.createElement("input");
					input.type = "text";
					const maskedInputSubtree = nestUnder("sensitive", input);
					nestUnder("milana-unmask", maskedInputSubtree);
					expect(rrwebOptions.maskInputFn?.("customer data", input)).toBe(
						"*************",
					);
				});

				test("explicitly set unmaskClass at maskingLevel normal logs a warning", async () => {
					const { init } = await importMilana();
					mockSampledSession("unmask-class-normal-warning-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						// No maskingLevel -> defaults to "normal", where unmaskClass has
						// nothing to reveal.
						{ privacy: { unmaskClass: "copy-ok" } },
					);

					expect(console.warn).toHaveBeenCalledWith(
						expect.stringContaining("privacy.unmaskClass is ignored"),
					);
				});

				test("default unmaskClass at maskingLevel normal does not warn", async () => {
					const { init } = await importMilana();
					mockSampledSession("unmask-class-default-no-warning-session");

					await init(productId, clientKey, {
						environment: "test",
						version: "1.0",
						metadata: {},
					});

					expect(console.warn).not.toHaveBeenCalledWith(
						expect.stringContaining("privacy.unmaskClass is ignored"),
					);
				});

				test("maskInputTypes masks additional input types and cannot be unmasked", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("custom-mask-input-types-session");

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
								maskInputTypes: { url: true },
								unmaskSelector: ".public",
							},
						},
					);

					const rrwebOptions = getRrwebOptions(record);

					// A custom type stays masked even inside an unmasked subtree.
					const url = document.createElement("input");
					url.type = "url";
					url.className = "public";
					const urlValue = "https://example.com";
					expect(rrwebOptions.maskInputFn?.(urlValue, url)).toBe(
						staticMaskText(urlValue),
					);

					// A type not listed remains unmasked in normal mode.
					const text = document.createElement("input");
					text.type = "text";
					expect(rrwebOptions.maskInputFn?.("plain text", text)).toBe(
						"plain text",
					);
				});

				test("invalid privacy selectors are dropped with a warning", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("invalid-selector-session");

					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { maskingLevel: "xhigh", maskSelector: "[" } },
					);

					expect(console.warn).toHaveBeenCalledWith(
						expect.stringContaining("invalid privacy.maskSelector"),
					);

					// The invalid selector is dropped; xhigh still masks via "*".
					const rrwebOptions = getRrwebOptions(record);
					expect(rrwebOptions.maskTextSelector).toBe("*");
				});

				test("a global RegExp blockClass blocks consistently instead of skipping every other element", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("regex-blockclass-session");

					// Passing a global regex is an easy, natural mistake.
					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { blockClass: /secret/g } },
					);

					// rrweb (and this SDK) call .test() on the SAME blockClass object
					// once per class token of every element, never resetting lastIndex.
					// A raw /secret/g is stateful: it matches, advances lastIndex past
					// the match, then fails on the next identical token — so every other
					// element with class "secret" would silently escape blocking.
					const raw = /secret/g;
					expect([
						raw.test("secret"),
						raw.test("secret"),
						raw.test("secret"),
					]).toEqual([true, false, true]);

					// The matcher we hand to rrweb must instead match the same token
					// every time, regardless of how many elements precede it.
					const { blockClass } = getRrwebOptions(record);
					const blocked = blockClass as RegExp;
					expect([0, 1, 2, 3, 4].map(() => blocked.test("secret"))).toEqual([
						true,
						true,
						true,
						true,
						true,
					]);
				});

				test("a sticky RegExp blockClass keeps its start-anchored match semantics", async () => {
					const { init } = await importMilana();
					const { record } = await import("@rrweb/record");
					mockSampledSession("sticky-blockclass-session");

					// /secret/y anchors at the start of the class token.
					await init(
						productId,
						clientKey,
						{
							environment: "test",
							version: "1.0",
							metadata: {},
						},
						{ privacy: { blockClass: /secret/y } },
					);

					const { blockClass } = getRrwebOptions(record);
					const blocked = blockClass as RegExp;

					// Anchoring is preserved: "secret" matches, "not-secret" does not.
					// Naively dropping /y would start matching "not-secret" mid-token.
					expect(blocked.test("secret")).toBe(true);
					expect(blocked.test("not-secret")).toBe(false);
					// ...and it is no longer stateful, so the result is stable.
					expect(blocked.test("secret")).toBe(true);
					expect(blocked.test("not-secret")).toBe(false);
				});
			});
		});

		describe("Error Cases", () => {
			test("should handle network failures gracefully", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockRejectedValueOnce(
					new Error("Network disconnected"),
				);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize, application will continue unaffected",
					expect.any(Error),
				);
			});

			test("should handle HTTP errors from server", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: false,
					statusText: "Internal Server Error",
					json: () => Promise.resolve({}),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize session",
				);
			});

			test("should validate required parameters", async () => {
				const { init } = await importMilana();

				await init("", clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(console.info).toHaveBeenCalledWith(
					"Milana: Failed to initialize, application will continue unaffected",
					expect.objectContaining({
						message:
							"Milana: Invalid product ID, product ID must start with 'prd_' and be 30 characters long",
					}),
				);
				expect(fetch).not.toHaveBeenCalled();
			});
		});

		describe("Edge Cases", () => {
			test("should handle unsampled sessions (no recording)", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: false }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(setItemMock).not.toHaveBeenCalledWith(
					"milana_session_id",
					expect.anything(),
				);
			});

			test("should prevent multiple initialization", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValue({
					ok: true,
					json: () =>
						Promise.resolve({ sampled: true, sessionId: "test-session" }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(fetch).toHaveBeenCalledTimes(1);
				expect(console.info).toHaveBeenCalledWith(
					"Milana: Already initializing or initialized",
				);
			});

			test("should result in multiple network requests with same sessionId after reset", async () => {
				const { init } = await importMilana();

				const sessionId = "consistent-session-id";

				// Seed an existing session in the blob so both inits resume it.
				window.sessionStorage.setItem(
					"milana_session_state",
					JSON.stringify({ sessionId, user: null, sessionContext: null }),
				);

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: false,
					status: 500,
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: true, sessionId }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(fetch).toHaveBeenCalledTimes(2);

				const firstCall = vi.mocked(fetch).mock.calls[0];
				const secondCall = vi.mocked(fetch).mock.calls[1];

				expect(firstCall[1]?.headers).toEqual(
					expect.objectContaining({
						"X-Milana-Session-Id": sessionId,
					}),
				);
				expect(secondCall[1]?.headers).toEqual(
					expect.objectContaining({
						"X-Milana-Session-Id": sessionId,
					}),
				);
			});

			test("should handle response with missing sessionId", async () => {
				const { init } = await importMilana();

				vi.mocked(fetch).mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ sampled: true }),
				} as Response);

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				expect(setItemMock).not.toHaveBeenCalledWith(
					"milana_session_id",
					expect.anything(),
				);
			});
		});
	});

	describe("Metrics API", () => {
		const metricsEnabledInternalOptions = {
			_internal: {
				shouldTrackPerformance: true,
				shouldForceUncompressedPayloads: false,
			},
		};

		describe("Default Behavior", () => {
			test("should send buffer metrics by default when no _internal options provided", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "default-metrics-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(productId, clientKey, {
					environment: "test",
					version: "1.0",
					metadata: {},
				});

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");

				expect(metricsBody.histograms.inpP98Ms).toBeUndefined();
				expect(
					metricsBody.histograms.averageLongTaskDurationMs,
				).toBeUndefined();
				expect(metricsBody.histograms.blockedTimePerSecondMs).toBeUndefined();
			});
		});

		describe("Success Cases", () => {
			test("should send metrics automatically after initialization", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "metrics-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();
				expect(metricsCall?.[0]).toBe("https://in.getmilana.ai/metrics");
				expect(metricsCall?.[1]?.method).toBe("POST");

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;
				expect(metricsBody.version).toBe(1);
				expect(typeof metricsBody.clientTimestamp).toBe("number");
				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");
			});

			test("should calculate inpP98Ms correctly with worst-10 tracking", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "inp-calc-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Test Case 1: <50 interactions - should NOT report inpP98Ms
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).worstInpValues = [500, 450, 400, 380, 350, 320, 300, 280, 260, 240];
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalInpEventCount = 20;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall1 = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall1).toBeDefined();

				const body1 = JSON.parse(
					metricsCall1?.[1]?.body as string,
				) as SessionPerfMetrics;

				// For <50 interactions, should NOT report inpP98Ms
				expect(body1.histograms.inpP98Ms).toBeUndefined();

				// Test Case 2: >=50 interactions - should use 2nd worst (p98 approximation)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalInpEventCount = 100;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				const metricsCall2 = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall2).toBeDefined();

				const body2 = JSON.parse(
					metricsCall2?.[1]?.body as string,
				) as SessionPerfMetrics;

				// For >=50 interactions, should report 2nd worst (p98)
				expect(body2.histograms.inpP98Ms).toBe(450);
			});

			test("should calculate long task metrics correctly", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "longtask-calc-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Simulate long tasks: 3 tasks with durations 200ms, 150ms, 250ms
				// Average duration: 600/3 = 200ms
				// Blocking time: (200-50) + (150-50) + (250-50) = 150 + 100 + 200 = 450ms
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).longTaskDurationSum = 600;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).longTaskCount = 3;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).totalLongTaskBlockingTime = 450;

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(logMetricsIntervalDuration);

				// Set recordingStartTime to 30 seconds ago (matching the time we advanced)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).recordingStartTime = Date.now() - logMetricsIntervalDuration;

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const body = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				// Average duration: 600ms / 3 tasks = 200ms
				expect(body.histograms.averageLongTaskDurationMs).toBe(200);

				// Blocking rate: (450ms / 30000ms) * 1000 = 15ms/sec
				expect(body.histograms.blockedTimePerSecondMs).toBeCloseTo(15, 1);
			});

			test("should send metrics at 30-second intervals", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "interval-test" }),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				vi.clearAllMocks();

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(1);

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(2);

				await vi.advanceTimersByTimeAsync(30000);
				expect(fetch).toHaveBeenCalledTimes(3);

				const allMetricsCalls = vi
					.mocked(fetch)
					.mock.calls.every((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);
				expect(allMetricsCalls).toBe(true);
			});
		});

		describe("Error Cases", () => {
			test("should silently fail when metrics endpoint returns error", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({ sampled: true, sessionId: "error-test" }),
						} as Response,
					],
					"/metrics": [new Error("Network timeout")],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(30000);

				expect(console.debug).toHaveBeenCalledWith(
					"Milana: Failed to send metrics",
					expect.any(Error),
				);
			});

			test("should handle HTTP errors from metrics endpoint", async () => {
				const { init } = await importMilana();

				let metricsCallCount = 0;
				vi.mocked(fetch).mockImplementation((url: RequestInfo | URL) => {
					const urlStr = getUrlString(url);
					if (urlStr.endsWith("/session")) {
						return Promise.resolve({
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "http-error-test",
								}),
						} as Response);
					}
					if (urlStr.endsWith("/metrics")) {
						metricsCallCount++;
						return Promise.reject(new Error("Internal Server Error"));
					}
					return Promise.reject(new Error("Unexpected URL"));
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				await vi.advanceTimersByTimeAsync(30000);

				expect(metricsCallCount).toBe(1);
				expect(console.debug).toHaveBeenCalledWith(
					"Milana: Failed to send metrics",
					expect.any(Error),
				);
			});
		});

		describe("Counter Metrics", () => {
			test("should track aborted sessions when buffer exceeds hard limit", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "buffer-test-session",
								}),
						} as Response,
					],
					"/batch": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Keep the event size below the single-event cap (~2.6MB) but large enough to overflow the buffer quickly
				const largePayloadSize = Math.floor(1.5 * 1024 * 1024); // ~1.5MB per event
				const largePayload = "x".repeat(largePayloadSize);
				const session =
					MilanaSession.currentSession as unknown as TestSessionInternals;
				session.tryToSendEvents = vi.fn(); // avoid actual network attempts

				for (let i = 0; i < 16; i++) {
					session.pushEvent({
						type: 5,
						data: {
							tag: MILANA_CUSTOM_EVENT_TAG,
							payload: {
								name: "ManualBufferOverflowTest",
								index: i,
								data: largePayload,
							},
						},
						timestamp: Date.now() + i,
					});
				}

				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(1);

				// Manually send metrics to observe the counter
				await session.logMetrics();
				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(0);

				const metricsCall = vi
					.mocked(fetch)
					.mock.calls.find((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCall).toBeDefined();

				const metricsBody = JSON.parse(
					metricsCall?.[1]?.body as string,
				) as SessionPerfMetrics;

				// Verify aborted session counter was reported and reset
				expect(metricsBody.counters.numSessionsAbortedDueToBufferExceeded).toBe(
					1,
				);
			});

			test("should track single-event aborts when payload exceeds per-event limit", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "single-event-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				const session =
					MilanaSession.currentSession as unknown as TestSessionInternals;
				session.tryToSendEvents = vi.fn();

				const oversizedPayload = "x".repeat(6 * 1024 * 1024); // ~6MB, exceeds per-event limit

				session.pushEvent({
					type: 5,
					data: {
						tag: MILANA_CUSTOM_EVENT_TAG,
						payload: {
							name: "ManualHugeEvent",
							data: oversizedPayload,
						},
					},
					timestamp: Date.now(),
				});

				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(1);
				expect(session.events.length).toBe(0);

				await session.logMetrics();
				expect(session.counters.numSessionsAbortedDueToBufferExceeded).toBe(0);
			});

			test("should prevent concurrent metrics logging", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "concurrent-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set counter to track
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 5;

				vi.clearAllMocks();

				// Create a slow metrics response
				let resolveMetrics: () => void;
				const metricsPromise = new Promise<Response>((resolve) => {
					resolveMetrics = () =>
						resolve({
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response);
				});

				vi.mocked(fetch).mockReturnValueOnce(metricsPromise);

				// Start first logMetrics call
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				const firstCall = (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Verify guard flag is set
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.isSendingMetrics,
				).toBe(true);

				// Try to call logMetrics again while first is in progress
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Should only have made 1 fetch call (second was skipped)
				expect(fetch).toHaveBeenCalledTimes(1);

				// Complete the first call
				resolveMetrics!();
				await firstCall;

				// Guard flag should be reset
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.isSendingMetrics,
				).toBe(false);
			});

			test("should accumulate counters when metrics request fails", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "accumulate-test-session",
								}),
						} as Response,
					],
					"/metrics": [
						new Error("Network error"),
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set counter to 3
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 3;

				vi.clearAllMocks();

				// First call fails
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Counter should still be 3 (not lost due to failure)
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(3);

				// Second call succeeds
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				await (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// Counter should now be 0 (3 - 3)
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(0);

				// Verify both calls were made
				expect(fetch).toHaveBeenCalledTimes(2);
			});

			test("should preserve counter increments during in-flight request", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "race-test-session",
								}),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				const { MilanaSession } = await importSession();

				// Set initial counter to 3
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).counters.numSessionsAbortedDueToBufferExceeded = 3;

				vi.clearAllMocks();

				// Create a delayed metrics response
				let resolveMetrics: () => void;
				const metricsPromise = new Promise<Response>((resolve) => {
					resolveMetrics = () =>
						resolve({
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response);
				});

				vi.mocked(fetch).mockReturnValueOnce(metricsPromise);

				// Start logMetrics (snapshots counter = 3)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				const metricsCall = (
					MilanaSession.currentSession as unknown as TestSessionInternals
				).logMetrics();

				// While request is in flight, increment counter twice (3 -> 4 -> 5)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.counters.numSessionsAbortedDueToBufferExceeded++;
				// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(MilanaSession.currentSession as unknown as TestSessionInternals)
					.counters.numSessionsAbortedDueToBufferExceeded++;

				// Verify counter is now 5
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(5);

				// Complete the request
				resolveMetrics!();
				await metricsCall;

				// Counter should be 2 (5 - 3), proving increments during request were preserved
				expect(
					// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
					(MilanaSession.currentSession as unknown as TestSessionInternals)
						.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe(2);
			});
		});

		describe("Metrics on Session End", () => {
			test("should send final metrics when stopRecording is called", async () => {
				const { init } = await importMilana();

				mockFetch({
					"/session": [
						{
							ok: true,
							json: () =>
								Promise.resolve({
									sampled: true,
									sessionId: "normal-stop-session",
								}),
						} as Response,
					],
					"/metrics": [
						{
							ok: true,
							json: () => Promise.resolve({ success: true }),
						} as Response,
					],
				});

				await init(
					productId,
					clientKey,
					{
						environment: "test",
						version: "1.0",
						metadata: {},
					},
					metricsEnabledInternalOptions,
				);

				vi.clearAllMocks();

				const { MilanaSession } = await importSession();

				// Mock metrics to succeed
				vi.mocked(fetch).mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ success: true }),
				} as Response);

				// Manually stop recording (simulating session end)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
				(
					MilanaSession.currentSession as unknown as TestSessionInternals
				).stopRecording();

				// Allow async operations to complete
				await vi.advanceTimersByTimeAsync(100);

				// Verify metrics were sent
				const metricsCalls = vi
					.mocked(fetch)
					.mock.calls.filter((call) =>
						getUrlString(call[0]).endsWith("/metrics"),
					);

				expect(metricsCalls.length).toBeGreaterThan(0);

				// Verify metrics structure
				const metricsBody = JSON.parse(
					metricsCalls[0][1]?.body as string,
				) as SessionPerfMetrics;

				expect(metricsBody.version).toBe(1);
				expect(typeof metricsBody.histograms.numEventsInBuffer).toBe("number");
				expect(
					typeof metricsBody.counters.numSessionsAbortedDueToBufferExceeded,
				).toBe("number");
			});
		});
	});

	describe("Caller-Type Pinning", () => {
		test("a prior wrapper init does not bleed into a later direct core init", async () => {
			const { _initWithCallerType, init, stopRecording } = await importMilana();

			// First session: simulate a wrapper (React provider) initializing
			// with caller type "react".
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "react-session" }),
			} as Response);

			await _initWithCallerType(
				productId,
				clientKey,
				{ environment: "test", version: "1.0", metadata: {} },
				"react",
				undefined,
			);

			await stopRecording();

			// Second session: direct core init via the public API. Must tag
			// as "core" — wrapper attribution must not leak across sessions.
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({ sampled: true, sessionId: "core-session" }),
			} as Response);

			await init(productId, clientKey, {
				environment: "test",
				version: "1.0",
				metadata: {},
			});

			expect(fetch).toHaveBeenLastCalledWith(
				"https://in.getmilana.ai/session",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Milana-Caller-Type": "core",
					}) as Record<string, string>,
				}),
			);
		});
	});
});
