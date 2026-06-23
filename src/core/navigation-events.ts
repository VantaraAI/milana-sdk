export type NavigationSource = "pushstate" | "replacestate" | "popstate";

const subscribers = new Set<(source: NavigationSource) => void>();
let instrumented = false;

function ensureInstrumented(): void {
	if (instrumented) return;
	instrumented = true;

	const emit = (source: NavigationSource) => {
		// Snapshot so a handler that (un)subscribes during dispatch can't change
		// who is notified for the in-flight navigation.
		for (const handler of [...subscribers]) {
			handler(source);
		}
	};

	for (const name of ["pushState", "replaceState"] as const) {
		const original = history[name];
		history[name] = function (
			this: History,
			...args: Parameters<typeof original>
		) {
			const result = original.apply(this, args); // native runs first, always
			emit(name === "pushState" ? "pushstate" : "replacestate");
			return result;
		};
	}

	// popstate (back/forward) doesn't pass through pushState/replaceState.
	window.addEventListener("popstate", () => emit("popstate"));
}

/**
 * Subscribe to SPA navigations (pushState / replaceState / back-forward).
 * Instruments history on first use; the instrumentation is intentionally permanent.
 *
 * @returns an unsubscribe function that removes this handler.
 */
export function onNavigation(
	handler: (source: NavigationSource) => void,
): () => void {
	ensureInstrumented();
	subscribers.add(handler);
	return () => {
		subscribers.delete(handler);
	};
}
