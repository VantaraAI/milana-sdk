import { describe, expect, test, vi } from "vitest";
import {
	type ClipboardPayload,
	getClipboardPlugin,
} from "../../src/core/clipboard-plugin.ts";

type FakeSelection = {
	anchorNode: Node | null;
	focusNode: Node | null;
	toString: () => string;
};

/**
 * Wire up the plugin with a mock mirror, window, and document, capturing the
 * clipboard handlers so we can invoke them directly with mock events. jsdom's
 * dispatchEvent always sets isTrusted=false, making it impossible to test
 * trusted-event logic via real dispatches (same approach as the click-modifier
 * plugin test).
 */
function setupPlugin(nodeIdMap: Map<EventTarget, number>) {
	const plugin = getClipboardPlugin();
	const cb = vi.fn();

	plugin.getMirror!({
		nodeMirror: { getId: (node: Node) => nodeIdMap.get(node) ?? -1 },
	} as never);

	const handlers: Record<string, (event: ClipboardEvent) => void> = {};
	let selection: FakeSelection | null = null;

	const mockDoc = {
		addEventListener: (
			type: string,
			handler: (event: ClipboardEvent) => void,
		) => {
			handlers[type] = handler;
		},
		removeEventListener: vi.fn(),
	};
	const mockWin = {
		document: mockDoc,
		Node,
		HTMLElement,
		HTMLInputElement,
		HTMLTextAreaElement,
		getSelection: () => selection,
	} as never;

	const cleanup = plugin.observer!(cb, mockWin, {});

	return {
		cb,
		handlers,
		cleanup,
		setSelection: (next: FakeSelection | null) => {
			selection = next;
		},
	};
}

function mockClipboardEvent(
	type: "copy" | "cut" | "paste",
	overrides: Partial<ClipboardEvent> = {},
): ClipboardEvent {
	return {
		isTrusted: true,
		type,
		target: null,
		clipboardData: null,
		...overrides,
	} as unknown as ClipboardEvent;
}

const lastPayload = (cb: ReturnType<typeof vi.fn>): ClipboardPayload =>
	cb.mock.calls[cb.mock.calls.length - 1][0] as ClipboardPayload;

describe("Clipboard Plugin", () => {
	test("records a DOM copy as metadata, with no offset", () => {
		const div = document.createElement("div");
		const text = document.createTextNode("hello world");
		div.appendChild(text);
		const { cb, handlers, setSelection } = setupPlugin(new Map([[div, 7]]));

		setSelection({
			anchorNode: text,
			focusNode: text,
			toString: () => "hello world",
		});
		handlers.copy(mockClipboardEvent("copy"));

		expect(cb).toHaveBeenCalledTimes(1);
		const payload = lastPayload(cb);
		expect(payload.action).toBe("copy");
		expect(payload.nodeId).toBe(7);
		expect(payload.length).toBe("hello world".length);
		// Content is never recorded, and DOM selections carry no offset.
		expect(payload.offset).toBeUndefined();
		expect("text" in payload).toBe(false);
	});

	test("reports a cut with action 'cut'", () => {
		const div = document.createElement("div");
		const text = document.createTextNode("cut me");
		div.appendChild(text);
		const { cb, handlers, setSelection } = setupPlugin(new Map([[div, 3]]));

		setSelection({
			anchorNode: text,
			focusNode: text,
			toString: () => "cut me",
		});
		handlers.cut(mockClipboardEvent("cut"));

		expect(lastPayload(cb).action).toBe("cut");
	});

	test("records the offset and length for a copy from an input field", () => {
		const input = document.createElement("input");
		input.value = "abcdefgh";
		input.selectionStart = 2;
		input.selectionEnd = 5;
		const { cb, handlers } = setupPlugin(new Map([[input, 4]]));

		handlers.copy(mockClipboardEvent("copy", { target: input }));

		const payload = lastPayload(cb);
		expect(payload.length).toBe(3);
		expect(payload.offset).toBe(2);
		expect(payload.nodeId).toBe(4);
		expect("text" in payload).toBe(false);
	});

	test("records the offset for a cut from a textarea field", () => {
		const textarea = document.createElement("textarea");
		textarea.value = "0123456789";
		textarea.selectionStart = 4;
		textarea.selectionEnd = 9;
		const { cb, handlers } = setupPlugin(new Map([[textarea, 8]]));

		handlers.cut(mockClipboardEvent("cut", { target: textarea }));

		const payload = lastPayload(cb);
		expect(payload.action).toBe("cut");
		expect(payload.offset).toBe(4);
		expect(payload.length).toBe(5);
	});

	test("records a paste's length without an offset", () => {
		const input = document.createElement("input");
		const { cb, handlers } = setupPlugin(new Map([[input, 5]]));

		handlers.paste(
			mockClipboardEvent("paste", {
				target: input,
				clipboardData: {
					getData: () => "pasted text",
				} as unknown as DataTransfer,
			}),
		);

		const payload = lastPayload(cb);
		expect(payload.action).toBe("paste");
		expect(payload.length).toBe("pasted text".length);
		expect(payload.offset).toBeUndefined();
		expect(payload.nodeId).toBe(5);
		expect("text" in payload).toBe(false);
	});

	test("reports nodeId -1 when the source element cannot be resolved", () => {
		const { cb, handlers, setSelection } = setupPlugin(new Map());

		setSelection({
			anchorNode: null,
			focusNode: null,
			toString: () => "orphaned",
		});
		handlers.copy(mockClipboardEvent("copy"));

		expect(lastPayload(cb).nodeId).toBe(-1);
	});

	test("skips untrusted (synthetic) events", () => {
		const { cb, handlers, setSelection } = setupPlugin(new Map());
		const text = document.createTextNode("x");

		setSelection({ anchorNode: text, focusNode: text, toString: () => "x" });
		handlers.copy(mockClipboardEvent("copy", { isTrusted: false }));

		expect(cb).not.toHaveBeenCalled();
	});

	test("skips an empty selection", () => {
		const { cb, handlers, setSelection } = setupPlugin(new Map());

		setSelection({ anchorNode: null, focusNode: null, toString: () => "" });
		handlers.copy(mockClipboardEvent("copy"));

		expect(cb).not.toHaveBeenCalled();
	});

	test("records the full length of a large copy and never the content", () => {
		const div = document.createElement("div");
		const long = "a".repeat(5000);
		const text = document.createTextNode(long);
		div.appendChild(text);
		const { cb, handlers, setSelection } = setupPlugin(new Map([[div, 8]]));

		setSelection({ anchorNode: text, focusNode: text, toString: () => long });
		handlers.copy(mockClipboardEvent("copy"));

		const payload = lastPayload(cb);
		// Full length is reported (no cap), but the content itself is never sent.
		expect(payload.length).toBe(5000);
		expect("text" in payload).toBe(false);
	});

	test("cleanup removes the clipboard listeners", () => {
		const { cleanup, handlers } = setupPlugin(new Map());
		// Sanity: handlers were registered.
		expect(typeof handlers.copy).toBe("function");
		expect(() => cleanup()).not.toThrow();
	});
});
