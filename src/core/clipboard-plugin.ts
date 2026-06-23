import type { RrwebMirror, RrwebPlugin } from "./rrweb-plugin-types";

export const CLIPBOARD_PLUGIN_NAME = "milana/clipboard@1";

export type ClipboardAction = "copy" | "cut" | "paste";

// If this payload type changes, update the server-side event timeline parser to match.
export type ClipboardPayload = {
	action: ClipboardAction;
	// rrweb mirror id of the element the operation acted on — the selection's
	// anchor element for copy/cut, the paste destination for paste — or -1 when
	// it couldn't be resolved.
	nodeId: number;
	// Number of characters copied/cut/pasted; always at least 1. A clip that
	// moves no text — an empty selection, or a non-text image/file paste —
	// emits no event at all, so "nothing was clipped" is conveyed by the
	// absence of an event rather than a length-0 payload.
	length: number;
	// Character offset of the selection start within the field's value, for
	// copy/cut from an <input>/<textarea> only. Omitted for paste and for DOM
	// selections — there a single offset is ambiguous (selections span multiple
	// text nodes), so only `length` is reported. `offset` + `length` describe
	// which substring of the field was clipped, without the data.
	offset?: number;
};

/**
 * Records clipboard copy/cut/paste operations as metadata only — never the
 * content. Each operation reports its action, the element it acted on, how many
 * characters moved, and (for form fields) where in the value the clip started.
 * The copied/pasted text itself is never captured, so the clipboard timeline
 * can't leak a value — masked or not. Whether a node's content is masked is
 * already encoded in the recording, so consumers that care can read it from the
 * referenced `nodeId`; the plugin stays a self-contained DOM observer.
 */
export function getClipboardPlugin(): RrwebPlugin {
	let mirror: RrwebMirror<Node> | null = null;

	return {
		name: CLIPBOARD_PLUGIN_NAME,

		getMirror(mirrors) {
			mirror = mirrors.nodeMirror;
		},

		observer(cb, win) {
			const doc = win.document;

			const resolveElement = (node: Node | null): HTMLElement | null => {
				if (!node) return null;
				if (node instanceof win.HTMLElement) return node;
				// Text nodes (the common case for DOM selections) and other
				// non-HTMLElement nodes resolve to their containing element.
				return node.parentElement;
			};

			const emit = (
				action: ClipboardAction,
				length: number,
				element: HTMLElement | null,
				offset?: number,
			) => {
				// A clip that moves no text emits no event at all (see the `length`
				// contract): an empty selection or a non-text paste is conveyed by
				// the absence of an event, never a length-0 payload.
				if (length === 0) return;

				const payload: ClipboardPayload = {
					action,
					nodeId: element && mirror ? mirror.getId(element) : -1,
					length,
				};
				if (offset !== undefined) {
					payload.offset = offset;
				}
				cb(payload satisfies ClipboardPayload);
			};

			const handleCopyOrCut = (event: ClipboardEvent) => {
				if (!event.isTrusted) return;
				const action: ClipboardAction = event.type === "cut" ? "cut" : "copy";
				const target = event.target;

				// Form fields: getSelection() doesn't expose their selection, so read
				// it from the field directly. selectionStart is an unambiguous index
				// into the field's value, so we report it as `offset`.
				if (
					target instanceof win.HTMLInputElement ||
					target instanceof win.HTMLTextAreaElement
				) {
					const start = target.selectionStart;
					const end = target.selectionEnd;
					if (
						typeof start === "number" &&
						typeof end === "number" &&
						end > start
					) {
						emit(action, end - start, target, start);
						return;
					}
				}

				const selection = win.getSelection ? win.getSelection() : null;
				const length = selection ? selection.toString().length : 0;
				const anchorEl = resolveElement(selection?.anchorNode ?? null);
				// No offset for DOM selections: a single offset can't describe a
				// selection that spans multiple text nodes.
				emit(action, length, anchorEl);
			};

			const handlePaste = (event: ClipboardEvent) => {
				if (!event.isTrusted) return;
				const length = event.clipboardData
					? event.clipboardData.getData("text").length
					: 0;
				let element = resolveElement(
					event.target instanceof win.Node ? event.target : null,
				);
				if (!element) {
					const selection = win.getSelection ? win.getSelection() : null;
					element = resolveElement(selection?.anchorNode ?? null);
				}
				emit("paste", length, element);
			};

			doc.addEventListener("copy", handleCopyOrCut, { capture: true });
			doc.addEventListener("cut", handleCopyOrCut, { capture: true });
			doc.addEventListener("paste", handlePaste, { capture: true });

			return () => {
				doc.removeEventListener("copy", handleCopyOrCut, { capture: true });
				doc.removeEventListener("cut", handleCopyOrCut, { capture: true });
				doc.removeEventListener("paste", handlePaste, { capture: true });
			};
		},

		options: {},
	};
}
