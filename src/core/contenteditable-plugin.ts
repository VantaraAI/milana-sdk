import { debounce } from "./debounce";
import type { RrwebMirror, RrwebPlugin } from "./rrweb-plugin-types";

// Keep short to avoid event ordering issues (e.g., a click 500ms after typing would appear before the edit if debounce were 1s)
const DEBOUNCE_MS = 120;
// Keep in sync with the server-side event timeline parser.
const MAX_HOST_DEPTH = 3;
// Keep in sync with the server-side event timeline parser.
const INLINE_TAGS_TO_IGNORE_FOR_MAX_DEPTH_CALCULATIONS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"del",
	"span",
]);

export const CONTENTEDITABLE_PLUGIN_NAME = "milana/contenteditable@1";

// If this payload type changes, update the server-side event timeline parser to match.
export type ContentEditablePayload = {
	hostId: number;
};

type HostState = {
	lastEditedNode: Node | null;
	pendingFlush: {
		invoke: () => void;
		cancel: () => void;
	} | null;
};

export function getContentEditablePlugin(): RrwebPlugin {
	let mirror: RrwebMirror<Node> | null = null;
	// WeakMap allows garbage collection when DOM elements are removed. Using a regular
	// Map would cause memory leaks since we'd hold strong references to elements that
	// are no longer in the document (e.g., dynamically created/destroyed editors).
	const hostStates = new WeakMap<HTMLElement, HostState>();
	// Track cancel functions separately since WeakMap can't be iterated for cleanup
	const pendingFlushes = new Set<() => void>();

	const getOrCreateHostState = (host: HTMLElement): HostState => {
		let state = hostStates.get(host);
		if (!state) {
			state = { lastEditedNode: null, pendingFlush: null };
			hostStates.set(host, state);
		}
		return state;
	};

	return {
		name: CONTENTEDITABLE_PLUGIN_NAME,

		getMirror(mirrors) {
			mirror = mirrors.nodeMirror;
		},

		observer(cb, win) {
			const doc = win.document;

			/**
			 * Find contenteditable host within MAX_HOST_DEPTH levels up from target.
			 * Returns null if no host found within depth limit (likely a complex editor).
			 */
			const findHostWithinDepth = (target: Node | null): HTMLElement | null => {
				if (!target) return null;

				let current: Node | null = target;
				let depth = 0;

				while (current && depth <= MAX_HOST_DEPTH) {
					if (current instanceof HTMLElement && current.isContentEditable) {
						// Host contenteditable attribute can be defined without a value (e.g., <div contenteditable>),
						// with a value of "true", or a value of "plaintext-only".
						const attr = current.getAttribute("contenteditable");
						if (attr !== null && attr.toLowerCase() !== "false") {
							return current;
						}
					}
					current = current.parentNode;

					if (current instanceof HTMLElement) {
						const tag = current.tagName.toLowerCase();
						if (INLINE_TAGS_TO_IGNORE_FOR_MAX_DEPTH_CALCULATIONS.has(tag)) {
							continue;
						}
					}

					depth++;
				}
				return null;
			};

			/**
			 * Get the edited node from the event using lastEditedNode from beforeinput.
			 * Only falls back to composedPath if we had a valid node that got detached
			 * (e.g., select-all + delete). Returns null if no valid node was captured,
			 * which means the edit was in a complex editor and should be skipped.
			 */
			const getEditedNode = (event: Event, state: HostState): Node | null => {
				if (state.lastEditedNode) {
					const node = state.lastEditedNode;
					state.lastEditedNode = null;

					if (node.isConnected) {
						return node;
					}

					// Node was valid when captured but is now detached (e.g., deleted).
					if ("composedPath" in event) {
						const path = event.composedPath();
						if (path[0] instanceof Node) return path[0];
					}
				}

				// No lastEditedNode means beforeinput didn't capture a valid node
				// (either depth check failed or targetRanges was empty). Skip this event.
				return null;
			};

			const emitChange = (host: HTMLElement) => {
				if (!mirror) return;
				const hostId = mirror.getId(host);
				if (hostId === -1) return;
				cb({ hostId } satisfies ContentEditablePayload);
			};

			const scheduleFlush = (host: HTMLElement) => {
				const state = getOrCreateHostState(host);

				if (!state.pendingFlush) {
					const debouncedFn = debounce(
						() => {
							if (state.pendingFlush) {
								pendingFlushes.delete(state.pendingFlush.cancel);
								state.pendingFlush = null;
							}
							emitChange(host);
						},
						DEBOUNCE_MS,
						{ trailing: true },
					);

					state.pendingFlush = {
						invoke: () => debouncedFn(),
						cancel: () => debouncedFn.cancel(),
					};

					pendingFlushes.add(state.pendingFlush.cancel);
				}

				state.pendingFlush.invoke();
			};

			const flushImmediate = (host: HTMLElement) => {
				const state = getOrCreateHostState(host);
				if (state.pendingFlush) {
					pendingFlushes.delete(state.pendingFlush.cancel);
					state.pendingFlush.cancel();
					state.pendingFlush = null;
				}
				emitChange(host);
			};

			const handleBeforeInput = (event: InputEvent) => {
				if (!event.isTrusted) return;
				const target = event.target;
				if (!(target instanceof Element)) return;

				const host = findHostWithinDepth(target);
				if (!host) return;

				const state = getOrCreateHostState(host);

				// Capture targetRanges while available (only works in beforeinput).
				// Only store if the edited node passes the depth check - this ensures
				// we don't capture events from complex editors like ProseMirror.
				if ("getTargetRanges" in event) {
					const ranges = event.getTargetRanges();
					if (ranges.length > 0) {
						const editedNode = ranges[0].startContainer;
						const hostFromEditedNode = findHostWithinDepth(editedNode);
						if (hostFromEditedNode) {
							state.lastEditedNode = editedNode;
						}
					}
				}
			};

			const handleInput = (event: Event) => {
				if (!event.isTrusted) return;
				const target = event.target;
				if (!(target instanceof HTMLElement)) return;
				if (!target.isContentEditable) return;

				const host = findHostWithinDepth(target);
				if (!host) return;

				const state = getOrCreateHostState(host);
				const editedNode = getEditedNode(event, state);
				if (!editedNode) return;

				const hostFromEditedNode = findHostWithinDepth(editedNode);
				if (!hostFromEditedNode) return;

				// Flush immediately for paste/cut
				if (event instanceof InputEvent) {
					const inputType = event.inputType;
					if (inputType === "insertFromPaste" || inputType === "deleteByCut") {
						flushImmediate(hostFromEditedNode);
						return;
					}
				}

				scheduleFlush(hostFromEditedNode);
			};

			doc.addEventListener("beforeinput", handleBeforeInput, { capture: true });
			doc.addEventListener("input", handleInput, { capture: true });

			return () => {
				doc.removeEventListener("beforeinput", handleBeforeInput, {
					capture: true,
				});
				doc.removeEventListener("input", handleInput, { capture: true });

				for (const cancel of pendingFlushes) {
					cancel();
				}
				pendingFlushes.clear();
			};
		},

		options: {},
	};
}
