import { debounce } from "./debounce";
import { onNavigation } from "./navigation-events";
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

			// Re-check scroll depth on SPA navigations (pushState/replaceState/popstate).
			const removeNavigationListener = onNavigation(checkScrollDepth);
			window.addEventListener("scroll", scrollHandler, { passive: true });

			// Capture initial scroll depth on page load
			checkScrollDepth();

			return () => {
				debouncedEmitPendingDepth.cancel();
				// Flush any remaining pending depth for the current path
				if (pendingThreshold > emittedThreshold) {
					emitPendingDepth();
				}

				removeNavigationListener();
				window.removeEventListener("scroll", scrollHandler);
			};
		},
		options: {},
	};
}
