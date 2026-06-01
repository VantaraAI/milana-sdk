import { debounce } from "./debounce";
import type { RrwebPlugin } from "./rrweb-plugin-types";

const SCROLL_DEPTH_DEBOUNCE_MS = 250;

export function getScrollDepthPlugin(): RrwebPlugin {
	return {
		name: "milana/scroll-depth@1",
		observer(cb) {
			let currentPath: string | null = null;
			let emittedThreshold = 0;
			let pendingThreshold = 0;

			const emitPendingDepth = () => {
				if (currentPath !== null && pendingThreshold > emittedThreshold) {
					emittedThreshold = pendingThreshold;
					cb({
						depthPercentage: emittedThreshold,
						path: currentPath,
					});
					pendingThreshold = emittedThreshold;
				}
			};

			const debouncedEmitPendingDepth = debounce(
				emitPendingDepth,
				SCROLL_DEPTH_DEBOUNCE_MS,
				{ trailing: true },
			);

			const resetForPath = (pathname: string) => {
				// Flush any pending depth for the previous path before resetting.
				if (pendingThreshold > emittedThreshold) {
					emitPendingDepth();
				}
				currentPath = pathname;
				emittedThreshold = 0;
				pendingThreshold = 0;
			};

			const checkScrollDepth = () => {
				const pathname = window.location.pathname;

				// Reset tracking if path changed
				if (pathname !== currentPath) {
					resetForPath(pathname);
				}

				const scrollY = window.scrollY;
				const viewportHeight = window.innerHeight;
				const documentHeight = document.documentElement.scrollHeight;

				let depthPercent: number;
				if (documentHeight <= viewportHeight) {
					depthPercent = 100;
				} else {
					depthPercent = ((scrollY + viewportHeight) / documentHeight) * 100;
				}

				// Round down to nearest 10%
				const currentThreshold = Math.min(
					100,
					Math.floor(depthPercent / 10) * 10,
				);

				if (currentThreshold > emittedThreshold) {
					pendingThreshold = Math.max(pendingThreshold, currentThreshold);
					debouncedEmitPendingDepth();
				}
			};

			const scrollHandler = () => {
				checkScrollDepth();
			};

			// TODO: Both this plugin and session.ts independently monkey-patch
			// history.pushState/replaceState, which is fragile if teardown order
			// changes. A cleaner approach: session.ts (which already patches history
			// for URL tracking) could dispatch a custom "milana:navigation" event,
			// and this plugin would listen for that event instead of patching history
			// itself.
			// Detect pushState, replaceState, and popstate changes for SPAs to ensure we track scroll depth at the new paths
			const originalPushState = history.pushState.bind(history);
			const originalReplaceState = history.replaceState.bind(history);

			history.pushState = (...args) => {
				originalPushState(...args);
				checkScrollDepth();
			};
			history.replaceState = (...args) => {
				originalReplaceState(...args);
				checkScrollDepth();
			};

			window.addEventListener("popstate", checkScrollDepth);
			window.addEventListener("scroll", scrollHandler, { passive: true });

			// Capture initial scroll depth on page load
			checkScrollDepth();

			return () => {
				debouncedEmitPendingDepth.cancel();
				// Flush any remaining pending depth for the current path
				if (pendingThreshold > emittedThreshold) {
					emitPendingDepth();
				}

				window.removeEventListener("popstate", checkScrollDepth);
				window.removeEventListener("scroll", scrollHandler);
				history.pushState = originalPushState;
				history.replaceState = originalReplaceState;
			};
		},
		options: {},
	};
}
