import { record } from "@rrweb/record";
import { MilanaSession } from "./session";
import type {
	CallerType,
	IdentifyInput,
	PublicInitOptions,
	SessionInfo,
	SessionUpdate,
	TrackEventAttributes,
	UpdatePayload,
	UserUpdate,
} from "./types";

export enum Commands {
	Init = "init",
	Identify = "identify",
	Update = "update",
	UpdateUser = "updateUser",
	UpdateSession = "updateSession",
	StopRecording = "stopRecording",
	InitCrossOriginIframe = "initCrossOriginIframe",
	TrackEvent = "trackEvent",
}

/**
 * Initializes a Milana recording session. Call this once, as early in the
 * page lifecycle as you can. Only one session can be active at a time —
 * subsequent `init()` calls while a session is active are rejected with
 * `{ success: false }`. After a `stopRecording()`, a fresh `init()` is
 * supported and starts a brand-new session.
 *
 * @param productId - Your Milana product ID (starts with `prd_`).
 * @param clientKey - Your Milana client key (starts with `key_`).
 * @param info - Session metadata (environment, version, optional metadata).
 * @param options - Optional recording/privacy overrides.
 * @returns `{ success: true }` if the session started and is sampled,
 *          `{ success: false }` if initialization failed or the session was
 *          not sampled.
 */
export const init = async (
	productId: string,
	clientKey: string,
	info: SessionInfo,
	options?: PublicInitOptions,
): Promise<{ success: boolean }> =>
	_initWithCallerType(productId, clientKey, info, "core", options);

// Internal init shared by all entries. The public `init` above defaults
// the caller type to "core"; the CDN dispatcher and React provider call
// this directly with their own value so each session is tagged at the
// call site rather than via shared mutable state.
export const _initWithCallerType = async (
	productId: string,
	clientKey: string,
	info: SessionInfo,
	callerType: CallerType,
	options?: PublicInitOptions,
): Promise<{ success: boolean }> => {
	if (MilanaSession.currentSession?.state?.type) {
		console.info("Milana: Already initializing or initialized");
		return { success: false };
	}

	console.debug("Milana: Initializing session..");

	try {
		const result = await MilanaSession.initializeAsync(
			productId,
			clientKey,
			info,
			callerType,
			options,
		);

		if (MilanaSession.debugMode) {
			console.debug("Milana [debug]: init", {
				productId,
				clientKey,
				sessionInfo: info,
				options,
				result,
			});
		}

		if (!result.success) {
			console.info("Milana: Failed to initialize session");
		} else {
			console.debug("Milana: Initialized session");
		}

		return result;
	} catch (e) {
		console.info(
			"Milana: Failed to initialize, application will continue unaffected",
			e,
		);
		return { success: false };
	}
};

/**
 * Associates the current session with a known user — typically right
 * after sign-in. Requires `userId` and `email`; additional profile
 * fields (`name`, `metadata`) are optional.
 *
 * For partial user updates later in the session (e.g. plan changes) use
 * `updateUser`, which makes `email` optional.
 */
export const identify = async (
	input: IdentifyInput,
): Promise<{ success: boolean }> => {
	const user = {
		userId: input.userId,
		email: input.email,
		name: input.name,
		metadata: input.metadata,
	};
	if (MilanaSession.debugMode) {
		console.debug("Milana [debug]: identify", input);
	}
	return MilanaSession.sendUpdateWhenReady(Commands.Identify, { user });
};

/**
 * @deprecated Prefer the granular entry points: `identify` for initial
 * user identification, `updateUser` for partial user updates, and
 * `updateSession` for session-level metadata. `update` remains for
 * backward compatibility but is no longer the recommended API.
 */
export const update = async (
	input: UpdatePayload,
): Promise<{ success: boolean }> => {
	if (MilanaSession.debugMode) {
		console.debug("Milana [debug]: update invoked", input);
	}
	return MilanaSession.sendUpdateWhenReady(Commands.Update, input);
};

/**
 * Updates profile fields (name, email, metadata) for the user identified
 * by `userId`. User metadata has upsert semantics across the user's
 * lifetime: any fields you provide are merged with previously set values.
 *
 * Does not change the session's identity: once a session has been
 * attached to a user (via the first `identify` or `updateUser` call),
 * subsequent `updateUser` calls with a different `userId` will not
 * re-attribute the session.
 *
 * For the initial "user just signed in" flow with a known email,
 * `identify` is the more focused entry point.
 */
export const updateUser = async (
	user: UserUpdate,
): Promise<{ success: boolean }> => {
	if (MilanaSession.debugMode) {
		console.debug("Milana [debug]: updateUser invoked", user);
	}
	return MilanaSession.sendUpdateWhenReady(Commands.UpdateUser, { user });
};

/**
 * Attaches or refreshes session-level metadata on the active session —
 * feature flags, traffic origin, experiment variant, current workflow,
 * etc. Session metadata has upsert semantics within the session: any
 * fields you provide are merged with previously set values.
 */
export const updateSession = async (
	session: SessionUpdate,
): Promise<{ success: boolean }> => {
	if (MilanaSession.debugMode) {
		console.debug("Milana [debug]: updateSession invoked", session);
	}
	return MilanaSession.sendUpdateWhenReady(Commands.UpdateSession, { session });
};

/**
 * Stops the active recording session. Sends a best-effort close signal to
 * the server (so the session is finalized immediately, not after the
 * backend inactivity timeout), tears down local listeners and buffers, and
 * clears the persisted session id so a subsequent `init()` starts a
 * brand-new session rather than resuming the one we just closed.
 *
 * No-op if no session is active. Returns `{ success: true }` when a session
 * was torn down, `{ success: false }` otherwise.
 */
export const stopRecording = async (): Promise<{ success: boolean }> => {
	if (MilanaSession.debugMode) {
		console.debug("Milana [debug]: stopRecording invoked");
	}
	const session = MilanaSession.currentSession;
	if (!session) return { success: false };
	// Capture debugMode before reset() nulls currentSession — the getter
	// reads currentSession?.debugMode and would otherwise return false.
	const isDebug = MilanaSession.debugMode;
	session.stop();
	MilanaSession.reset();
	if (isDebug) {
		console.debug("Milana [debug]: stopRecording complete");
	}
	return { success: true };
};

/**
 * Initializes rrweb cross-origin iframe recording. Call this from within
 * the iframe itself (not the parent page) when the iframe is hosted on a
 * different origin than the main document.
 */
export const initCrossOriginIframe = (): void => {
	try {
		record({
			emit: () => {},
			recordCrossOriginIframes: true,
		});
		console.info("Milana: iframe recording initialized");
	} catch (error) {
		console.warn(
			"Milana: Failed to initialize iframe recording, application will continue unaffected",
			error,
		);
	}
};

/**
 * Records a named event with optional attributes on the active session.
 * Attributes are limited to JSON-scalar values (`string | number | boolean
 * | null`). Calls made before `init()` completes are queued.
 */
export const trackEvent = (
	eventName: string,
	attributes: TrackEventAttributes = {},
): void => {
	MilanaSession.executeWhenReady(Commands.TrackEvent, () => {
		if (MilanaSession.debugMode) {
			console.debug("Milana [debug]: trackEvent", eventName, attributes);
		}
		MilanaSession.currentSession?.trackEvent(eventName, attributes);
	});
};

// Re-export public types so consumers can import from "milana-js" directly
// rather than reaching into "milana-js/core/types"
export type {
	IdentifyInput,
	InitPrivacyOptions,
	IntegrationName,
	PostHogIntegrationState,
	PrivacyMaskingLevel,
	PublicInitOptions,
	SentryIntegrationState,
	SessionInfo,
	SessionIntegrations,
	SessionUpdate,
	TrackEventAttributes,
	TrackEventAttributeValue,
	UpdatePayload,
	UserUpdate,
} from "./types";
