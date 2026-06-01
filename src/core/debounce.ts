// biome-ignore-all lint/suspicious/noExplicitAny: vendored verbatim from es-toolkit
// biome-ignore-all lint/complexity/useOptionalChain: vendored verbatim from es-toolkit
//
// Vendored from es-toolkit@1.44.0 (MIT License, © Viva Republica, Inc.) to drop
// the runtime dependency. This combines es-toolkit's core `debounce`
// (src/function/debounce.ts) and the lodash-compatible wrapper
// (src/compat/function/debounce.ts). Behavior is intentionally identical to
// importing `{ debounce } from "es-toolkit/compat"`.
//
// Source: https://github.com/toss/es-toolkit/tree/v1.44.0

interface DebounceOptions {
	/**
	 * An optional AbortSignal to cancel the debounced function.
	 */
	signal?: AbortSignal;

	/**
	 * An optional array specifying whether the function should be invoked on the
	 * leading edge, trailing edge, or both. Defaults to `["trailing"]`.
	 */
	edges?: Array<"leading" | "trailing">;
}

interface CoreDebouncedFunction<F extends (...args: any[]) => void> {
	(...args: Parameters<F>): void;
	schedule: () => void;
	cancel: () => void;
	flush: () => void;
}

/**
 * Core debounce implementation (es-toolkit `src/function/debounce.ts`).
 */
function debounceCore<F extends (...args: any[]) => void>(
	func: F,
	debounceMs: number,
	{ signal, edges }: DebounceOptions = {},
): CoreDebouncedFunction<F> {
	let pendingThis: any;
	let pendingArgs: Parameters<F> | null = null;

	const leading = edges != null && edges.includes("leading");
	const trailing = edges == null || edges.includes("trailing");

	const invoke = () => {
		if (pendingArgs !== null) {
			func.apply(pendingThis, pendingArgs);
			pendingThis = undefined;
			pendingArgs = null;
		}
	};

	const onTimerEnd = () => {
		if (trailing) {
			invoke();
		}

		cancel();
	};

	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	const schedule = () => {
		if (timeoutId != null) {
			clearTimeout(timeoutId);
		}

		timeoutId = setTimeout(() => {
			timeoutId = null;

			onTimerEnd();
		}, debounceMs);
	};

	const cancelTimer = () => {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	};

	const cancel = () => {
		cancelTimer();
		pendingThis = undefined;
		pendingArgs = null;
	};

	const flush = () => {
		invoke();
	};

	const debounced = function (this: any, ...args: Parameters<F>) {
		if (signal?.aborted) {
			return;
		}

		pendingThis = this;
		pendingArgs = args;

		const isFirstCall = timeoutId == null;

		schedule();

		if (leading && isFirstCall) {
			invoke();
		}
	};

	debounced.schedule = schedule;
	debounced.cancel = cancel;
	debounced.flush = flush;

	signal?.addEventListener("abort", cancel, { once: true });

	return debounced;
}

interface DebounceSettings {
	/**
	 * If `true`, the function will be invoked on the leading edge of the timeout.
	 * @default false
	 */
	leading?: boolean | undefined;
	/**
	 * The maximum time `func` is allowed to be delayed before it's invoked.
	 * @default Infinity
	 */
	maxWait?: number | undefined;
	/**
	 * If `true`, the function will be invoked on the trailing edge of the timeout.
	 * @default true
	 */
	trailing?: boolean | undefined;
}

interface DebounceSettingsLeading extends DebounceSettings {
	leading: true;
}

export interface DebouncedFunc<T extends (...args: any[]) => any> {
	/**
	 * Call the original function, but applying the debounce rules.
	 */
	(...args: Parameters<T>): ReturnType<T> | undefined;

	/**
	 * Throw away any pending invocation of the debounced function.
	 */
	cancel(): void;

	/**
	 * If there is a pending invocation of the debounced function, invoke it
	 * immediately and return its return value.
	 */
	flush(): ReturnType<T> | undefined;
}

export interface DebouncedFuncLeading<T extends (...args: any[]) => any>
	extends DebouncedFunc<T> {
	(...args: Parameters<T>): ReturnType<T>;
	flush(): ReturnType<T>;
}

/**
 * Creates a debounced function that delays invoking `func` until after
 * `debounceMs` milliseconds have elapsed since the last time it was invoked.
 *
 * Lodash-compatible wrapper (es-toolkit `src/compat/function/debounce.ts`),
 * supporting `leading`, `trailing`, and `maxWait` options.
 */
export function debounce<T extends (...args: any) => any>(
	func: T,
	wait: number | undefined,
	options: DebounceSettingsLeading,
): DebouncedFuncLeading<T>;
export function debounce<T extends (...args: any) => any>(
	func: T,
	wait?: number,
	options?: DebounceSettings,
): DebouncedFunc<T>;
export function debounce<F extends (...args: any[]) => any>(
	func: F,
	debounceMs = 0,
	options: DebounceSettings = {},
): DebouncedFunc<F> {
	if (typeof options !== "object") {
		options = {};
	}

	const { leading = false, trailing = true, maxWait } = options;

	const edges = Array(2);

	if (leading) {
		edges[0] = "leading";
	}

	if (trailing) {
		edges[1] = "trailing";
	}

	let result: ReturnType<F> | undefined;
	let pendingAt: number | null = null;

	const _debounced = debounceCore(
		function (this: any, ...args: Parameters<F>) {
			result = func.apply(this, args);
			pendingAt = null;
		},
		debounceMs,
		{ edges },
	);

	const debounced = function (this: any, ...args: Parameters<F>) {
		if (maxWait != null) {
			if (pendingAt === null) {
				pendingAt = Date.now();
			}

			if (Date.now() - pendingAt >= maxWait) {
				result = func.apply(this, args);
				pendingAt = Date.now();

				_debounced.cancel();
				_debounced.schedule();

				return result;
			}
		}

		_debounced.apply(this, args);
		return result;
	};

	const flush = () => {
		_debounced.flush();
		return result;
	};

	debounced.cancel = _debounced.cancel;
	debounced.flush = flush;

	return debounced;
}
