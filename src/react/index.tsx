import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	_initWithCallerType,
	identify,
	stopRecording,
	trackEvent,
	update,
	updateSession,
	updateUser,
} from "../core/index";
import type {
	IdentifyInput,
	PublicInitOptions,
	SessionInfo,
	SessionUpdate,
	TrackEventAttributes,
	UpdatePayload,
	UserUpdate,
} from "../core/types";

export type MilanaContextValue = {
	isInitialized: boolean;
	initialize: () => Promise<{ success: boolean }>;
	/** See `identify` on the core API. */
	identify: (input: IdentifyInput) => Promise<{ success: boolean }>;
	/** See `update` on the core API. */
	update: (payload: UpdatePayload) => Promise<{ success: boolean }>;
	/** See `updateUser` on the core API. */
	updateUser: (user: UserUpdate) => Promise<{ success: boolean }>;
	/** See `updateSession` on the core API. */
	updateSession: (session: SessionUpdate) => Promise<{ success: boolean }>;
	/** See `stopRecording` on the core API. */
	stopRecording: () => Promise<{ success: boolean }>;
	trackEvent: (eventName: string, attributes?: TrackEventAttributes) => void;
};

export const MilanaContext = createContext<MilanaContextValue | null>(null);

export function useMilana(): MilanaContextValue {
	const context = useContext(MilanaContext);
	if (!context) {
		throw new Error("useMilana must be used within a MilanaProvider");
	}
	return context;
}

export function useMilanaOptional(): MilanaContextValue | null {
	return useContext(MilanaContext);
}

export type MilanaProviderProps = {
	shouldDeferInitialization?: boolean;
	productId: string;
	clientKey: string;
	sessionInfo: SessionInfo;
	options?: PublicInitOptions;
	children: ReactNode;
};

/**
 * Initializes Milana on mount using the provided props.
 * Initialization happens only once — changing props after mount has no effect.
 *
 * Set `shouldDeferInitialization` to skip auto-init on mount. Call
 * `milana.initialize()` later (e.g., after a feature flag resolves) to trigger
 * initialization. `trackEvent` and `update` calls queue normally and flush
 * once initialization completes.
 */
export function MilanaProvider({
	shouldDeferInitialization = false,
	productId,
	clientKey,
	sessionInfo,
	options,
	children,
}: MilanaProviderProps) {
	const [isInitialized, setIsInitialized] = useState(false);
	const initRef = useRef(false);
	const initialPropsRef = useRef({
		productId,
		clientKey,
		sessionInfo,
		options,
	});

	const initialize = useCallback(async () => {
		if (initRef.current) return { success: false };
		initRef.current = true;

		const { productId, clientKey, sessionInfo, options } =
			initialPropsRef.current;
		const result = await _initWithCallerType(
			productId,
			clientKey,
			sessionInfo,
			"react",
			options,
		);
		setIsInitialized(result.success);
		return result;
	}, []);

	// Wrap core stopRecording so provider-level state (isInitialized,
	// initRef) matches the torn-down core state. Without this, consumers
	// see isInitialized === true after stop, and initialize() short-
	// circuits with { success: false } — blocking the stop → re-init flow.
	const stop = useCallback(async () => {
		const result = await stopRecording();
		setIsInitialized(false);
		initRef.current = false;
		return result;
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: init is one-shot; prop changes after mount are intentionally ignored
	useEffect(() => {
		if (!shouldDeferInitialization) {
			void initialize();
		}
	}, []);

	useEffect(() => {
		if (
			productId !== initialPropsRef.current.productId ||
			clientKey !== initialPropsRef.current.clientKey
		) {
			console.warn(
				"Milana: MilanaProvider props changed after mount. This has no effect — Milana only initializes once.",
			);
		}
	}, [productId, clientKey]);

	const value: MilanaContextValue = useMemo(
		() => ({
			isInitialized,
			initialize,
			identify,
			update,
			updateUser,
			updateSession,
			stopRecording: stop,
			trackEvent,
		}),
		[isInitialized, initialize, stop],
	);

	return (
		<MilanaContext.Provider value={value}>{children}</MilanaContext.Provider>
	);
}
