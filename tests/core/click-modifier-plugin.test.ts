import { describe, expect, test, vi } from "vitest";
import {
	type ClickModifierPayload,
	getClickModifierPlugin,
} from "../../src/core/click-modifier-plugin.ts";

function createMockMirror(idMap: Map<EventTarget, number>) {
	return {
		nodeMirror: {
			getId: (node: Node) => idMap.get(node) ?? -1,
			getNode: () => null,
			removeNodeFromMap: () => {},
			has: () => false,
			reset: () => {},
		},
	};
}

/**
 * Capture the click handler registered by the plugin so we can invoke it
 * directly with mock events. jsdom's dispatchEvent always sets isTrusted=false,
 * making it impossible to test trusted-event logic via real dispatches.
 */
function setupPlugin(nodeIdMap: Map<EventTarget, number>) {
	const plugin = getClickModifierPlugin();
	const cb = vi.fn();

	const mirror = createMockMirror(nodeIdMap);
	plugin.getMirror!(mirror as never);

	let capturedHandler: ((event: MouseEvent) => void) | null = null;
	const mockDoc = {
		addEventListener: (_type: string, handler: (event: MouseEvent) => void) => {
			capturedHandler = handler;
		},
		removeEventListener: vi.fn(),
	};
	const mockWin = { document: mockDoc, Node } as never;

	const cleanup = plugin.observer!(cb, mockWin, {});

	return { cb, handler: capturedHandler!, cleanup };
}

function mockClickEvent(
	target: EventTarget,
	overrides: Partial<MouseEvent> = {},
): MouseEvent {
	return {
		isTrusted: true,
		target,
		button: 0,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...overrides,
	} as unknown as MouseEvent;
}

describe("Click Modifier Plugin", () => {
	test("does not emit for a plain left-click without modifiers", () => {
		const button = document.createElement("button");
		const { cb, handler } = setupPlugin(new Map([[button, 42]]));

		handler(mockClickEvent(button));

		expect(cb).not.toHaveBeenCalled();
	});

	test("emits for a modifier click", () => {
		const button = document.createElement("button");
		const { cb, handler } = setupPlugin(new Map([[button, 42]]));

		handler(mockClickEvent(button, { metaKey: true }));

		expect(cb).toHaveBeenCalledTimes(1);
		const payload = cb.mock.calls[0][0] as ClickModifierPayload;
		expect(payload.nodeId).toBe(42);
		expect(payload.metaKey).toBe(true);
		expect(payload.ctrlKey).toBe(false);
		expect(payload.shiftKey).toBe(false);
		expect(payload.altKey).toBe(false);
	});

	test("skips untrusted (synthetic) events", () => {
		const button = document.createElement("button");
		const { cb, handler } = setupPlugin(new Map([[button, 42]]));

		handler(mockClickEvent(button, { isTrusted: false, metaKey: true }));

		expect(cb).not.toHaveBeenCalled();
	});
});
