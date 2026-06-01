import type { RrwebPlugin } from "./rrweb-plugin-types";

export const DOWNLOAD_PLUGIN_NAME = "milana/download@1";

const MAX_HREF_LENGTH = 2048;

// If this payload type changes, update the server-side event timeline parser to match.
export type DownloadDetectionPayload = {
	href: string;
	downloadFilename: string;
};

/**
 * Strip data URL content to avoid capturing customer file data.
 * blob: URLs are safe (just a short reference like blob:host/uuid).
 * data: URLs embed the full file content and must be truncated.
 */
function sanitizeHref(href: string): string {
	if (href.startsWith("data:")) {
		const commaIndex = href.indexOf(",");
		if (commaIndex !== -1) {
			return `${href.substring(0, commaIndex + 1)}[redacted]`;
		}
	}
	return href.slice(0, MAX_HREF_LENGTH);
}

/**
 * Detects programmatic blob downloads that rrweb misses.
 *
 * The most common JS download pattern (create <a download>, append to DOM, .click(), remove)
 * is not captured by rrweb because the add+remove are optimized away when in the same MutationObserver batch.
 * This plugin observes direct children of document.body for these ephemeral <a download> elements.
 * Scoped to body (no subtree) to avoid firing on every DOM mutation in the page.
 */
export function getDownloadDetectionPlugin(): RrwebPlugin {
	return {
		name: DOWNLOAD_PLUGIN_NAME,

		observer(cb, win) {
			const observer = new win.MutationObserver((mutations) => {
				// Accumulate across all records — appendChild and remove() produce
				// separate MutationRecords even when called synchronously.
				const added = new Set<Node>();
				const removed = new Set<Node>();

				for (const mutation of mutations) {
					for (const node of mutation.addedNodes) added.add(node);
					for (const node of mutation.removedNodes) removed.add(node);
				}

				for (const node of added) {
					if (
						removed.has(node) &&
						node instanceof win.HTMLAnchorElement &&
						node.hasAttribute("download")
					) {
						const href = sanitizeHref(node.getAttribute("href") ?? "");
						cb({
							href,
							downloadFilename:
								node.getAttribute("download") || "(unknown file)",
						} satisfies DownloadDetectionPayload);
					}
				}
			});

			// Observe only direct children of body — programmatic downloads almost
			// always do document.body.appendChild(a). No subtree avoids firing on
			// every DOM mutation in the page (React renders, etc.).
			const target = win.document.body ?? win.document.documentElement;
			observer.observe(target, { childList: true });

			return () => {
				observer.disconnect();
			};
		},

		options: {},
	};
}
