import type { RrwebMirror, RrwebPlugin } from "./rrweb-plugin-types";

export const CLICK_MODIFIER_PLUGIN_NAME = "milana/click-modifier@1";

// If this payload type changes, update the server-side event timeline parser to match.
export type ClickModifierPayload = {
	nodeId: number;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
};

export function getClickModifierPlugin(): RrwebPlugin {
	let mirror: RrwebMirror<Node> | null = null;

	return {
		name: CLICK_MODIFIER_PLUGIN_NAME,

		getMirror(mirrors) {
			mirror = mirrors.nodeMirror;
		},

		observer(cb, win) {
			const handler = (event: MouseEvent) => {
				if (!event.isTrusted) return;

				if (
					!event.ctrlKey &&
					!event.metaKey &&
					!event.shiftKey &&
					!event.altKey
				) {
					return;
				}

				const target = event.target;
				if (!(target instanceof win.Node)) return;

				const nodeId = mirror ? mirror.getId(target) : -1;

				cb({
					nodeId,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					shiftKey: event.shiftKey,
					altKey: event.altKey,
				} satisfies ClickModifierPayload);
			};

			win.document.addEventListener("click", handler, { capture: true });

			return () => {
				win.document.removeEventListener("click", handler, {
					capture: true,
				});
			};
		},

		options: {},
	};
}
