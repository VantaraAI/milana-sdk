import { record } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import { getClickModifierPlugin } from "./click-modifier-plugin";
import { getContentEditablePlugin } from "./contenteditable-plugin";
import { debounce } from "./debounce";
import { getDownloadDetectionPlugin } from "./download-detection-plugin";
import { detectIntegrations } from "./integration-detector";
import { deepEqual } from "./object-utils";
import { getScrollDepthPlugin } from "./scroll-depth-plugin";
import {
	clearSessionId,
	clearSessionState,
	loadSessionState,
	mergeSessionContext,
	mergeUser,
	saveSessionState,
	setSessionId,
} from "./session-store";
import { maskTextValue } from "./text-mask";
import type {
	CallerType,
	IMilanaSessionSingleton,
	InitInternalOptions,
	InitOptions,
	InitPrivacyOptions,
	IntegrationName,
	PublicInitOptions,
	SessionInfo,
	TrackEventAttributes,
	TrackEventAttributeValue,
	UpdatePayloadInternal,
} from "./types";

declare const clientSemVer: string;
declare const clientGitSha: string;

const BASE_HEADERS = {
	"Content-Type": "application/json",
	"X-Milana-Time-Zone": Intl.DateTimeFormat().resolvedOptions().timeZone,
	"X-Milana-Locale": Intl.DateTimeFormat().resolvedOptions().locale,
	"X-Milana-Client-Version": clientSemVer,
	"X-Milana-Client-Git-Hash": clientGitSha,
	"X-Milana-Protocol-Version": "1",
} as const;

const DEFAULT_ENDPOINT = "https://in.getmilana.ai";

export const DEBUG_MODE_STORAGE_KEY = "milana_debug_mode";

function tryReadLocalStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function buildBatchPayloadString(
	events: BufferedEvent[],
	extraJsonFragment?: string,
): string {
	const batchStartedAt = events[0]?.timestamp ?? Date.now();
	const eventsJson = events.map((event) => event.serialized).join(",");
	const extra = extraJsonFragment ? `,${extraJsonFragment}` : "";
	return `{"version":1,"batchStartedAt":${batchStartedAt}${extra},"events":[${eventsJson}]}`;
}

const METRICS_LOG_INTERVAL = 30000;
const BUFFER_FLUSH_INTERVAL_MS = 10000;

// 5s warm-up covers PostHog's lazy `$sesid` persistence: it lands ~50ms
// after the first event capture, but customers that disable
// capture_pageview AND autocapture won't see it land at all without
// something else triggering session-manager evaluation.
const INTEGRATION_WARMUP_DELAY_MS = 5000;
const INTEGRATION_POLL_INTERVAL_MS = 30000;

// we will wait up to this long for the page to be idle before starting recording (on supported browsers)
const RECORDING_IDLE_TIMEOUT_MS = 10000;

// don't wait for BUFFER_FLUSH_INTERVAL_MS if buffer exceeds this char count
const FLUSH_BUFFER_CHAR_COUNT_THRESHOLD = 5 * 1024 * 1024; // ≈10MB assuming 2 bytes per char on average

// never allow buffer to exceed this char count
const MAX_BUFFER_CHAR_COUNT = FLUSH_BUFFER_CHAR_COUNT_THRESHOLD * 4;

// don't allow a single event to exceed this (~10MB)
const MAX_SERIALIZED_EVENT_CHAR_COUNT = FLUSH_BUFFER_CHAR_COUNT_THRESHOLD;

// browser-imposed limit on the combined char count of in-flight keepalive
// request bodies (shared across the document). The visibility-hidden flush
// owns this whole budget; the pagehide close ping is a fixed ~80 bytes so
// it fits regardless of whether the visibility flush is still in flight.
const MAX_KEEPALIVE_PAYLOAD_CHAR_COUNT = 65536;

const MAX_RETRY_COUNT = 5;
const RETRY_DELAY_BASE = 2000;

// Custom backoff with a 5-minute final delay: 5s, 15s, 30s, 60s, 300s
// Cumulative: 5s, 20s, 50s, 110s, 410s
const DELAY_MULTIPLIERS = [2.5, 7.5, 15, 30, 150];
const URL_TRACKING_DEBOUNCE_MS = 100;

/**
 * This is passed into rrweb record as maskInputOptions.
 *
 * Rrweb documents this as only expected to include <input> types (not tags) but the actual code
 * that checks whether maskInputFn is called looks like this:
 *
 * `if (maskInputOptions[tagName.toLowerCase()] || actualType && maskInputOptions[actualType]) {`
 *
 * Therefore, we put tags here since we can more easily exhaustively list tags vs input types and
 * we want rrweb to invoke maskInputFn for all elements that might contain input.
 *
 * We then decide *within* maskInputFn whether to mask the input based on the actual input type
 * but also whether it has (or is a child of) maskInputClass.
 *
 * Other folks have similar confusions/workarounds: https://github.com/rrweb-io/rrweb/issues/874
 */
const TAGS_TO_MASK: Record<string, boolean> = {
	input: true,
	select: true,
	textarea: true,
	option: true,
};

const ALWAYS_MASKED_INPUT_TYPES: ReadonlySet<string> = new Set([
	"password",
	"tel",
	"email",
]);

const DEFAULT_URL_QUERY_PARAM_DENYLIST: RegExp[] = [
	/^jwt$/i,
	/^code$/i,
	/token/i,
	/password/i,
	/secret/i,
	/key/i,
	/auth/i,
	/nonce/i,
	/csrf/i,
];

const MASK_PLACEHOLDER = "*";

function normalizeSelector(
	selector: string | null | undefined,
	optionName: string,
): string | null {
	const trimmed = selector?.trim();
	if (!trimmed) {
		return null;
	}

	try {
		// Throws SyntaxError on an invalid selector without touching the DOM.
		document.createDocumentFragment().querySelector(trimmed);
	} catch {
		console.warn(
			`Milana: Ignoring invalid privacy.${optionName} selector "${trimmed}"`,
		);
		return null;
	}

	return trimmed;
}

// A global (/g) or sticky (/y) regex carries mutable lastIndex state across
// .test() calls. Both this SDK and rrweb test such a matcher against individual
// class tokens and share the same object, so a stateful flag makes matches
// intermittently skip. Return an equivalent matcher with no stateful flags.
//
// Dropping /g is match-preserving (test() searches the whole token either way).
// /y additionally anchors the match at lastIndex — which is always 0 for our
// per-token tests — so we emulate it with a leading ^ to avoid suddenly
// matching mid-token (e.g. "not-secret" under /secret/y).
function withoutStatefulRegexFlags(matcher: string | RegExp): string | RegExp {
	if (!(matcher instanceof RegExp) || (!matcher.global && !matcher.sticky)) {
		return matcher;
	}

	const flags = matcher.flags.replace(/[gy]/g, "");
	const source = matcher.sticky ? `^(?:${matcher.source})` : matcher.source;
	return new RegExp(source, flags);
}

/**
 * Use one tag for all events to avoid namespacing issues
 *
 * This will be repeated in every single event log
 * so it's worth it to save some bytes and keep it short.
 */
export const MILANA_CUSTOM_EVENT_TAG = "V";
const TENANT_PROVIDED_EVENT_TYPE = 1;
const URL_PATH_CHANGE_EVENT_TYPE = 2;
const URL_QUERY_CHANGE_EVENT_TYPE = 3;
const VISIBILITY_CHANGE_EVENT_TYPE = 4;
const WINDOW_FOCUS_CHANGE_EVENT_TYPE = 5;

type MilanaCallback = () => void | Promise<void>;

type QueueItem = {
	method: string;
	callback: MilanaCallback;
};

type BufferedEvent = {
	serialized: string;
	timestamp: number;
};

export enum StateType {
	Initializing = "initializing",
	Recording = "recording",
	SessionNotSampled = "session_not_sampled",
}

export type State =
	| {
			type: StateType.Initializing;
	  }
	| {
			type: StateType.Recording;
			sessionId: string;
	  }
	| {
			type: StateType.SessionNotSampled;
			sessionId: string;
	  };

/**
 * MilanaSession manages the lifecycle of a Milana analytics session,
 * including initialization, event recording, batching, retries, and user identification.
 */
export class MilanaSession implements IMilanaSessionSingleton {
	public static currentSession: MilanaSession | null = null;
	private static queueProcessorInterval: number | null = null;
	private static queue: QueueItem[] = [];

	private productId: string;
	private clientKey: string;
	private sessionInfo: SessionInfo;

	private options: InitOptions;

	public state: State;

	private lastSendTime = Date.now();
	private isSendingEvents = false;
	private inFlightEventsAbortController: AbortController | null = null;

	private retryCount = 0;
	private retryTimeout: number | null = null;
	private lastForcedImmediateRetryAt = 0;

	private flushInterval: number | null = null;

	private events: BufferedEvent[] = [];
	private bufferedCharacters = 0; // cheaper than maintaining buffered bytes

	private stopRrwebRecording: (() => void) | null = null;
	private recordingStartIdleCallbackId: number | null = null;
	private isRecordingStartPending = false;
	private visibilityChangeHandler: (() => void) | null = null;
	private windowFocusChangeHandler: (() => void) | null = null;
	private lastEmittedHasFocus: boolean | null = null;
	private pageCloseHandler: ((event: PageTransitionEvent) => void) | null =
		null;
	private hasSentClose = false;

	private urlTrackingCleanup: Array<() => void> = [];

	private recordingStartTime = 0;

	private logMetricsInterval: number | null = null;
	private isSendingMetrics = false;
	private counters: SessionCounters = {
		numSessionsAbortedDueToBufferExceeded: 0,
	};

	// Track worst 10 INP values to approximate P98.
	// Based on https://web.dev/articles/inp#measure-inp-in-javascript
	private worstInpValues: number[] = [];
	private readonly MAX_INP_SAMPLES = 10;
	private totalInpEventCount = 0;
	private longTaskDurationSum = 0;
	private longTaskCount = 0;
	private totalLongTaskBlockingTime = 0;
	private eventObserver: PerformanceObserver | null = null;
	private longTaskObserver: PerformanceObserver | null = null;

	// True while a POST /session is in flight, so a concurrent restart
	// coalesces onto the in-flight start instead of issuing a second /session.
	// Full rationale at the guard in startOrRestartOrResumeSession.
	private isStartingSession = false;

	// Entry URL captured at initialization time
	private entryUrl: string;

	private debugMode: boolean;

	// Vendors whose page-storage state we auto-detect and forward to
	// /update. Resolved once at construction; the rest of the class
	// consults this set rather than re-reading options.
	private readonly enabledIntegrations: ReadonlySet<IntegrationName>;
	private integrationDetectionInterval: number | null = null;
	private integrationWarmupTimeout: number | null = null;

	// Caller type for this session. Pinned at construction time; passed in
	// explicitly by each entry's init wrapper so each session is tagged at
	// its call site rather than via shared mutable state.
	private callerType: CallerType;

	private constructor(
		productId: string,
		clientKey: string,
		sessionInfo: SessionInfo,
		callerType: CallerType,
		state: State,
		options: PublicInitOptions,
	) {
		if (!productId.startsWith("prd_") || productId.length !== 30) {
			throw new Error(
				"Milana: Invalid product ID, product ID must start with 'prd_' and be 30 characters long",
			);
		}

		if (!clientKey.startsWith("key_")) {
			throw new Error(
				"Milana: Invalid client key, client key must start with 'key_'",
			);
		}

		this.productId = productId;
		this.clientKey = clientKey;
		this.sessionInfo = sessionInfo;
		this.state = state;

		const maskingLevel = options.privacy?.maskingLevel ?? "normal";
		const unmaskSelector = normalizeSelector(
			options.privacy?.unmaskSelector,
			"unmaskSelector",
		);
		// unmaskSelector only reveals values that maskingLevel masked, so it does
		// nothing at "normal" (nothing is broadly masked there). Warn rather than
		// silently ignore a misconfiguration.
		if (maskingLevel === "normal" && unmaskSelector) {
			console.warn(
				'Milana: privacy.unmaskSelector is ignored at maskingLevel "normal"; it only reveals values masked by "high" or "xhigh".',
			);
		}
		// Same for unmaskClass — but only when explicitly configured; the default
		// ("milana-unmask") is always present and shouldn't warn.
		if (maskingLevel === "normal" && options.privacy?.unmaskClass?.trim()) {
			console.warn(
				'Milana: privacy.unmaskClass is ignored at maskingLevel "normal"; it only reveals values masked by "high" or "xhigh".',
			);
		}

		const privacyOptions: InitPrivacyOptions = {
			maskingLevel,
			shouldUseLayoutPreservingMasking:
				options.privacy?.shouldUseLayoutPreservingMasking ?? false,
			blockClass: withoutStatefulRegexFlags(
				options.privacy?.blockClass ?? "milana-block",
			),
			blockSelector: normalizeSelector(
				options.privacy?.blockSelector,
				"blockSelector",
			),
			ignoreClass: options.privacy?.ignoreClass ?? "milana-ignore",
			ignoreSelector: normalizeSelector(
				options.privacy?.ignoreSelector,
				"ignoreSelector",
			),
			maskTextClass: options.privacy?.maskTextClass ?? "milana-mask",
			maskInputClass: options.privacy?.maskInputClass ?? "milana-mask",
			maskSelector: normalizeSelector(
				options.privacy?.maskSelector,
				"maskSelector",
			),
			unmaskSelector,
			unmaskClass: options.privacy?.unmaskClass ?? "milana-unmask",
			// Additional always-masked input types, layered on the built-in
			// ALWAYS_MASKED_INPUT_TYPES. The built-ins are handled separately and
			// cannot be disabled, so this defaults to empty.
			maskInputTypes: { ...(options.privacy?.maskInputTypes ?? {}) },
			shouldTrackQueryParams: options.privacy?.shouldTrackQueryParams ?? true,
			queryTrackingParamsDenyList: [
				...DEFAULT_URL_QUERY_PARAM_DENYLIST,
				...(options.privacy?.queryTrackingParamsDenyList ?? []),
			],
		};

		const internalOptions: InitInternalOptions = {
			shouldForceUncompressedPayloads:
				options._internal?.shouldForceUncompressedPayloads ?? false,
			shouldTrackPerformance:
				options._internal?.shouldTrackPerformance ?? false,
		};

		this.options = {
			endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
			shouldRecordCanvas: options.shouldRecordCanvas ?? false,
			shouldRecordCrossOriginIframes:
				options.shouldRecordCrossOriginIframes ?? false,
			disableContentEditableRecording:
				options.disableContentEditableRecording ?? false,
			integrations: options.integrations ?? [],
			privacy: privacyOptions,
			_internal: internalOptions,
		};

		this.enabledIntegrations = new Set(this.options.integrations);

		this.debugMode = tryReadLocalStorage(DEBUG_MODE_STORAGE_KEY) === "true";

		this.callerType = callerType;

		this.entryUrl = this.sanitizeUrl(window.location.href);

		this.debouncedTrackUrlChange = debounce(
			(url: string, changeType: "pushstate" | "replacestate" | "popstate") => {
				try {
					this.trackUrlChange(url, changeType);
				} catch (error) {
					console.debug(
						`Milana: Failed to track URL change to '${url}'`,
						error,
					);
				}
			},
			URL_TRACKING_DEBOUNCE_MS,
			{ trailing: true }, // This is the default, but noting here to be explicit
		);
	}

	/**
	 * Initializes a new Milana session and sets it as the current session.
	 * @returns { success: true } if session is started and sampled, { success: false } otherwise
	 */
	public static async initializeAsync(
		productId: string,
		clientKey: string,
		info: SessionInfo,
		callerType: CallerType,
		options?: PublicInitOptions,
	): Promise<{ success: boolean }> {
		const session = new MilanaSession(
			productId,
			clientKey,
			info,
			callerType,
			{
				type: StateType.Initializing,
			},
			options ?? {},
		);
		MilanaSession.currentSession = session;
		try {
			const result = await session.startOrRestartOrResumeSession();
			// If init failed AND we're still the current session, release
			// the slot so a future init() can try again. If we were
			// superseded mid-init (stopRecording + a new init() ran while
			// this fetch was in flight), leave the replacement alone.
			if (!result.success && MilanaSession.currentSession === session) {
				MilanaSession.currentSession = null;
			}
			return result;
		} catch (error) {
			// Same identity-aware cleanup on throw.
			if (MilanaSession.currentSession === session) {
				MilanaSession.currentSession = null;
			}
			throw error;
		}
	}

	public static get debugMode(): boolean {
		return MilanaSession.currentSession?.debugMode ?? false;
	}

	public static reset() {
		MilanaSession.stopQueueProcessor();
		// Tear down the integration auto-detect timers here (NOT in the
		// instance `stopRecording`) so they survive server-driven session
		// restarts — `startOrRestartOrResumeSession` calls stopRecording
		// defensively at the top, and we don't want that to kill the
		// detection loop mid-restart.
		MilanaSession.currentSession?.stopIntegrationAutoDetection();
		// Drain any callbacks queued via executeWhenReady instead of just
		// dropping them. update()/identify()/updateUser()/updateSession()
		// each return a Promise whose resolve is captured inside the
		// queued callback; clearing the queue without invoking the
		// callbacks would hang those Promises forever. Invoking each
		// callback with currentSession = null causes its
		// `currentSession?.update(...)` to return undefined, which the
		// wrappers handle by resolving `{ success: false }`. Pre-null
		// currentSession so the callbacks see the stopped state rather
		// than racing against the outgoing session.
		const drained = MilanaSession.queue;
		MilanaSession.queue = [];
		MilanaSession.currentSession = null;
		for (const item of drained) {
			try {
				const result = item.callback();
				if (result instanceof Promise) {
					void result.catch(() => {});
				}
			} catch {
				// Best-effort drain.
			}
		}
	}

	public static executeWhenReady(
		method: string,
		callback: MilanaCallback,
	): void {
		const session = MilanaSession.currentSession;
		if (
			session?.state.type === StateType.Recording ||
			session?.state.type === StateType.SessionNotSampled
		) {
			const fn = async () => {
				try {
					await callback();
				} catch (error) {
					console.debug(
						`Milana: Error executing callback for '${method}'`,
						error,
					);
				}
			};
			void fn();
			return;
		}

		console.debug(`Milana: Queueing call for '${method}'`);
		MilanaSession.queue.push({ method, callback });
		MilanaSession.ensureQueueProcessor();
	}

	private static ensureQueueProcessor(): void {
		if (MilanaSession.queueProcessorInterval !== null) {
			return;
		}
		MilanaSession.queueProcessorInterval = setInterval(() => {
			MilanaSession.processPendingQueue();
		}, 200) as unknown as number;
	}

	private static stopQueueProcessor(): void {
		if (MilanaSession.queueProcessorInterval === null) {
			return;
		}

		clearInterval(MilanaSession.queueProcessorInterval);
		MilanaSession.queueProcessorInterval = null;
	}

	private static processPendingQueue(): void {
		const session = MilanaSession.currentSession;
		if (
			!session ||
			(session.state.type !== StateType.Recording &&
				session.state.type !== StateType.SessionNotSampled)
		) {
			return;
		}

		const executedCallbacks: QueueItem[] = [];
		for (const item of MilanaSession.queue) {
			try {
				const result = item.callback();
				if (result instanceof Promise) {
					void result.catch((error) => {
						console.debug(
							`Milana: Error processing queued '${item.method}'`,
							error,
						);
					});
				}
				executedCallbacks.push(item);
				console.debug(`Milana: Completed '${item.method}'`);
			} catch (error) {
				console.debug(
					`Milana: Error processing queued '${item.method}'`,
					error,
				);
			}
		}

		MilanaSession.queue = MilanaSession.queue.filter(
			(item) => !executedCallbacks.includes(item),
		);

		if (
			MilanaSession.queue.length === 0 &&
			(session.state.type === StateType.Recording ||
				session.state.type === StateType.SessionNotSampled)
		) {
			MilanaSession.stopQueueProcessor();
		}
	}

	private async startOrRestartOrResumeSession(): Promise<{
		success: boolean;
	}> {
		// Serialize session starts so only one POST /session is in flight: a
		// restart is fire-and-forget and both /update and /batch can trigger
		// one, so two arriving together would otherwise mint two sessions. The
		// Initializing check below can't prevent this — state only flips to
		// Recording after /session resolves, so both racing starts pass it.
		if (this.isStartingSession) {
			console.debug(
				"Milana: Session start already in flight, ignoring concurrent restart",
			);
			return { success: false };
		}
		this.isStartingSession = true;
		try {
			return await this.runSessionStart();
		} finally {
			this.isStartingSession = false;
		}
	}

	private async runSessionStart(): Promise<{ success: boolean }> {
		this.stopRecording();

		if (this.state.type !== StateType.Initializing) {
			console.debug(
				`Milana: Skipping initialization, already in state ${this.state.type}`,
			);
			return { success: false };
		}

		const existingSessionId = loadSessionState()?.sessionId ?? null;
		const response = await fetch(`${this.options.endpoint}/session`, {
			method: "POST",
			headers: {
				...BASE_HEADERS,
				"X-Milana-Caller-Type": this.callerType,
				"X-Milana-Product-Id": this.productId,
				"X-Milana-Client-Key": this.clientKey,
				"X-Milana-Referrer": this.entryUrl,
				...(existingSessionId
					? {
							"X-Milana-Session-Id": existingSessionId,
						}
					: {}),
			},
			body: JSON.stringify({
				environment: this.sessionInfo.environment,
				version: this.sessionInfo.version,
				metadata: this.sessionInfo.metadata,
				...(this.sessionInfo.appSessionId !== undefined
					? { appSessionId: this.sessionInfo.appSessionId }
					: {}),
			}),
		});

		if (!response.ok) {
			const failureReason = response.statusText || `${response.status}`;
			console.info(
				`Milana: Failed to initialize session: ${failureReason}, application will continue unaffected`,
			);
			return { success: false };
		}

		let responseJson: unknown;
		try {
			responseJson = await response.json();
		} catch (error) {
			console.debug("Milana: Failed to parse initialize response JSON", error);
			return { success: false };
		}

		const { sampled, sessionId } = responseJson as {
			sampled: boolean;
			sessionId: string;
		};

		if (!sessionId) {
			console.debug("Milana: No session ID received, skipping");
			return { success: false };
		}

		// If stopRecording() ran while the /session request was in flight,
		// MilanaSession.reset() nulled the static currentSession reference.
		// Don't commit state or start recording for a session the caller
		// already asked us to abandon.
		if (MilanaSession.currentSession !== this) {
			console.debug(
				"Milana: Session was stopped during initialization, skipping",
			);
			return { success: false };
		}

		setSessionId(sessionId);

		// Replay the cached identity whenever we landed on a session id different
		// from the one the cache was attached to. The server echoes back the id we
		// send on resume, so this is false on a plain resume and true on a restart
		// (which cleared the id, so the server minted a new one).
		const shouldResendSavedIdentity = existingSessionId !== sessionId;

		if (!sampled) {
			console.debug("Milana: Session not sampled, will not record");
			this.state = {
				type: StateType.SessionNotSampled,
				sessionId,
			};
			if (shouldResendSavedIdentity) await this.resendSavedIdentity();
			MilanaSession.processPendingQueue();
			this.startIntegrationAutoDetection();
			return { success: true };
		}

		this.state = {
			type: StateType.Recording,
			sessionId,
		};

		if (existingSessionId === sessionId) {
			console.debug(`Milana: Resumed session ${sessionId}`);
		} else {
			console.debug(`Milana: Started session ${sessionId}`);
		}

		this.events = [];
		this.bufferedCharacters = 0;

		// Replay before recording starts and before the queue drains, so the
		// first events on the new session carry the restored user and session
		// context.
		if (shouldResendSavedIdentity) await this.resendSavedIdentity();

		// The replay's /update response can carry a fresh sampling decision that
		// flips us to SessionNotSampled (and tears down recording) while we were
		// awaiting it. If that happened, don't start rrweb for a session the
		// server just declined to sample.
		if (this.state.type === StateType.Recording) {
			this.startRecording();
		}
		MilanaSession.processPendingQueue();
		this.startIntegrationAutoDetection();
		return { success: true };
	}

	/**
	 * Programmatically ends the current recording session. Sends a
	 * best-effort abort signal to the server so the session is finalized
	 * immediately, tears down all local recording machinery, and clears
	 * `sessionStorage.sessionId` so a subsequent `init()` starts a brand-
	 * new session rather than resuming the one we just closed.
	 *
	 * Each step runs under its own try/catch so a failure in one doesn't
	 * strand a later one — e.g. an error inside `sendStopRequest()` must
	 * not prevent us from removing rrweb and listeners, and a teardown
	 * error must not prevent the `sessionStorage` cleanup that lets
	 * re-`init()` start fresh.
	 */
	public stop(): void {
		try {
			this.sendStopRequest();
		} catch (error) {
			console.debug("Milana: Error sending stop signal", error);
		}
		try {
			this.stopRecording();
		} catch (error) {
			console.debug("Milana: Error tearing down recording", error);
		}
		// Explicit stop clears the whole blob — session id, cached user, and
		// session metadata die together, so a later init() starts fresh.
		clearSessionState();
	}

	// The actual /update request and response handling, called by sendUpdate and
	// the identity replay. When `allowRestart` is false a `shouldRestartSession`
	// response is reported but doesn't trigger a restart — for session start,
	// where re-entering restart would strand the just-created session.
	private async sendUpdateRequest(
		payload: UpdatePayloadInternal,
		{ allowRestart }: { allowRestart: boolean },
	): Promise<{ success: boolean }> {
		const body: UpdatePayloadInternal = { ...payload };

		let response: Response;
		try {
			response = await fetch(`${this.options.endpoint}/update`, {
				method: "POST",
				headers: this._getPostInitializationHeaders(),
				body: JSON.stringify(body),
			});
		} catch (error) {
			// TODO: Retry failed updates automatically (up to a staleness limit)
			console.debug("Milana: Failed to send update request", error);
			return { success: false };
		}

		let responseJson: unknown;
		try {
			responseJson = await response.json();
		} catch (error) {
			console.debug("Milana: Failed to parse update response JSON", error);
			return { success: false };
		}

		const data = responseJson as
			| {
					success: true;
					sessionId: string;
					sampled: boolean;
			  }
			| {
					success: false;
					shouldRestartSession: boolean;
					errorCode: string;
			  };

		if (!data.success) {
			if (data.shouldRestartSession) {
				// The restart replays the saved user and session context, but the
				// payload that triggered the restart is not itself retried — it's
				// reported as a failure to the caller and dropped.
				if (allowRestart) {
					void this.restartSession("update");
				}
			} else {
				console.info(
					`Milana: Failed to update metadata: ${response.status} ${data.errorCode}`,
				);
			}
			return { success: false };
		}

		// Stop recording and update state if session is not sampled
		if (!data.sampled && this.state.type === StateType.Recording) {
			console.debug(
				"Milana: Session recording stopped based on sampling decision (update)",
			);
			this.state = {
				type: StateType.SessionNotSampled,
				sessionId: data.sessionId,
			};
			this.stopRecording();
		}

		return { success: true };
	}

	// Sends a user / session-context update, then — only on success — saves the
	// merged result as what the server has confirmed. Skips the request entirely
	// when merging the payload in wouldn't change the saved state (an identical
	// call isn't re-sent); any real change is sent. The verbatim payload goes on
	// the wire; the merged value is what we save and later replay.
	private async sendUpdate(
		payload: UpdatePayloadInternal,
		{ allowRestart }: { allowRestart: boolean },
	): Promise<{ success: boolean }> {
		if (
			this.state.type !== StateType.Recording &&
			this.state.type !== StateType.SessionNotSampled
		) {
			return { success: false };
		}
		const confirmed = loadSessionState();
		const sessionIdAtSend = confirmed?.sessionId ?? null;
		const prevUser = confirmed?.user ?? null;
		const prevSessionContext = confirmed?.sessionContext ?? null;
		// The merge here only decides whether anything changed; the value we
		// actually persist is re-merged against the latest saved state on success
		// below, so a concurrent write can't be clobbered. (Only identity /update
		// is deduped this way — events and batches always send.)
		const didUserChange =
			payload.user !== undefined &&
			!deepEqual(mergeUser(prevUser, payload.user), prevUser);
		const didSessionContextChange =
			payload.session !== undefined &&
			!deepEqual(
				mergeSessionContext(prevSessionContext, payload.session),
				prevSessionContext,
			);
		if (!didUserChange && !didSessionContextChange) return { success: true };

		const toSend: UpdatePayloadInternal = {};
		if (didUserChange) toSend.user = payload.user;
		if (didSessionContextChange) toSend.session = payload.session;

		const result = await this.sendUpdateRequest(toSend, { allowRestart });
		if (result.success) {
			const latest = loadSessionState();
			// If a restart swapped the session out while this update was in flight,
			// the server confirmed this payload for the old (now-dead) session, not
			// the current one. Don't write it back as the current session's
			// identity — drop the save and let the next changed call resend, rather
			// than claiming the new session has an identity it never received.
			if ((latest?.sessionId ?? null) !== sessionIdAtSend) {
				return result;
			}
			// Re-merge onto the latest saved state, leaving whichever of user /
			// session context this call didn't touch alone, so a user-only update
			// can't clobber a session context a concurrent same-session call just
			// saved (or vice versa).
			saveSessionState({
				sessionId: latest?.sessionId ?? null,
				user:
					didUserChange && payload.user
						? mergeUser(latest?.user ?? null, payload.user)
						: (latest?.user ?? null),
				sessionContext:
					didSessionContextChange && payload.session
						? mergeSessionContext(
								latest?.sessionContext ?? null,
								payload.session,
							)
						: (latest?.sessionContext ?? null),
			});
		}
		return result;
	}

	// Replays the confirmed identity onto the new session after a restart. Only
	// the restart path runs this (fresh init / resume don't). Sends directly,
	// bypassing the dedup check (the saved value equals itself, so sendUpdate
	// would skip it), with allowRestart: false so a shouldRestartSession here
	// can't re-enter the in-flight start and strand it.
	//
	// Fails open and does not retry: a failed replay leaves the new session
	// unattributed until the next changed identity call — an accepted loss of
	// the write-on-success model.
	private async resendSavedIdentity(): Promise<void> {
		const confirmed = loadSessionState();
		if (!confirmed) return;
		const payload: UpdatePayloadInternal = {};
		if (confirmed.user) payload.user = confirmed.user;
		if (
			confirmed.sessionContext &&
			Object.keys(confirmed.sessionContext).length > 0
		) {
			payload.session = confirmed.sessionContext;
		}
		if (!payload.user && !payload.session) return;
		try {
			await this.sendUpdateRequest(payload, { allowRestart: false });
		} catch (error) {
			console.debug("Milana: Failed to replay identity after restart", error);
		}
	}

	// Sends an identity update once the session is ready (running it immediately
	// if it already is, queueing otherwise), returning the result to the caller.
	public static sendUpdateWhenReady(
		method: string,
		payload: UpdatePayloadInternal,
	): Promise<{ success: boolean }> {
		return new Promise((resolve) => {
			MilanaSession.executeWhenReady(method, async () => {
				const result = await MilanaSession.currentSession?.sendUpdate(payload, {
					allowRestart: true,
				});
				resolve(result ?? { success: false });
			});
		});
	}

	private startIntegrationAutoDetection(): void {
		if (this.enabledIntegrations.size === 0) return;
		if (this.integrationDetectionInterval !== null) return;

		void this.runIntegrationDetection();

		this.integrationWarmupTimeout = window.setTimeout(() => {
			this.integrationWarmupTimeout = null;
			void this.runIntegrationDetection();
		}, INTEGRATION_WARMUP_DELAY_MS);

		this.integrationDetectionInterval = window.setInterval(() => {
			void this.runIntegrationDetection();
		}, INTEGRATION_POLL_INTERVAL_MS);
	}

	private stopIntegrationAutoDetection(): void {
		if (this.integrationWarmupTimeout !== null) {
			clearTimeout(this.integrationWarmupTimeout);
			this.integrationWarmupTimeout = null;
		}
		if (this.integrationDetectionInterval !== null) {
			clearInterval(this.integrationDetectionInterval);
			this.integrationDetectionInterval = null;
		}
	}

	private async runIntegrationDetection(): Promise<void> {
		// Invoked via `void` from setInterval/setTimeout, so any unhandled
		// rejection here would surface as an `unhandledrejection` on the
		// customer's page. Wrap the body to match the defensive pattern in
		// `sendEvents`/`logMetrics`.
		try {
			// A parallel `init()` may have replaced us mid-flight
			// (`currentSession` reassignment). Refuse to send updates as an
			// orphaned instance.
			if (MilanaSession.currentSession !== this) return;
			if (
				this.state.type !== StateType.Recording &&
				this.state.type !== StateType.SessionNotSampled
			) {
				return;
			}
			const integrations = detectIntegrations(this.enabledIntegrations);
			if (Object.keys(integrations).length === 0) return;
			await this.sendUpdate(
				{ session: { integrations } },
				{ allowRestart: true },
			);
		} catch (error) {
			console.debug("Milana: integration detection failed", error);
		}
	}

	public trackEvent(
		eventName: string,
		attributes: TrackEventAttributes = {},
	): void {
		if (typeof eventName !== "string" || eventName.trim().length === 0) {
			console.warn("Milana: trackEvent event name must be a non-empty string");
			return;
		}

		if (eventName.length > 255) {
			console.warn(
				`Milana: trackEvent event name must be 255 characters or less, got ${eventName.length} characters`,
			);
			return;
		}

		if (this.state.type !== StateType.Recording) {
			// TODO:Stop this 'trackEvent' call from being silently dropped
			// by queuing retries when the session is starting/restarting
			return;
		}

		const sanitizedAttributes: TrackEventAttributes = {};
		for (const [key, value] of Object.entries(
			attributes as Record<string, unknown>,
		)) {
			if (typeof key !== "string" || key.length === 0 || key.length > 255) {
				console.warn(
					`Milana: Ignoring attribute with invalid key (must be 1-255 characters) for event '${eventName}'`,
				);
				continue;
			}

			if (value === null) {
				sanitizedAttributes[key] = null;
			} else if (typeof value === "string") {
				if (value.length === 0 || value.length > 2048) {
					console.warn(
						`Milana: Ignoring string attribute '${key}' with invalid length (must be 1-2048 characters) for event '${eventName}'`,
					);
					continue;
				}
				sanitizedAttributes[key] = value;
			} else if (typeof value === "number" || typeof value === "boolean") {
				sanitizedAttributes[key] = value as TrackEventAttributeValue;
			} else if (value === undefined) {
				console.warn(
					`Milana: Ignoring attribute '${key}' with undefined value for event '${eventName}'`,
				);
			} else {
				console.warn(
					`Milana: Ignoring attribute '${key}' with non-primitive value for event '${eventName}'`,
				);
			}
		}

		try {
			const payload = {
				type: TENANT_PROVIDED_EVENT_TYPE,
				name: eventName,
				attributes: sanitizedAttributes,
			};
			record.addCustomEvent(MILANA_CUSTOM_EVENT_TAG, payload);
		} catch (error) {
			console.info(`Milana: Failed to track event '${eventName}'`, error);
		}
	}

	private lastUrl: string | null = null;
	private debouncedTrackUrlChange: ReturnType<typeof debounce>;

	private sanitizeUrl(url: string): string {
		const urlObj = new URL(url);
		const denyList = this.options.privacy.queryTrackingParamsDenyList;
		const allowTracking = this.options.privacy.shouldTrackQueryParams;

		// Storing sensitive data in the hash is not a good practice,
		// but it's not clear that there's a benefit to tracking it, so we strip it by default.
		urlObj.hash = "";

		if (!allowTracking) {
			urlObj.search = "";
			return urlObj.toString();
		}

		if (!denyList || denyList.length === 0) {
			return urlObj.toString();
		}

		const queryParams = new URLSearchParams(urlObj.search);
		for (const key of Array.from(queryParams.keys())) {
			if (this.shouldSanitizeParameter(key, denyList)) {
				queryParams.set(key, "--redacted--");
			}
		}

		urlObj.search = queryParams.toString();
		return urlObj.toString();
	}

	private shouldSanitizeParameter(
		paramName: string,
		denyList: RegExp[],
	): boolean {
		return denyList.some((pattern) => pattern.test(paramName));
	}

	private trackUrlChange(
		newUrl: string,
		changeType: "load" | "pushstate" | "replacestate" | "popstate",
	): void {
		if (this.state.type !== StateType.Recording) {
			return;
		}

		const sanitizedUrl = this.sanitizeUrl(newUrl);

		let didPathChange = true;
		let didQueryChange = true;

		// Compute what changed if we have a previous URL
		if (this.lastUrl) {
			const oldSanitizedObj = new URL(this.lastUrl);
			const newSanitizedObj = new URL(sanitizedUrl);

			didPathChange = oldSanitizedObj.pathname !== newSanitizedObj.pathname;
			didQueryChange = oldSanitizedObj.search !== newSanitizedObj.search;
		}

		// Determine which event type to emit
		// If path changed, emit UrlPathChange (regardless of query params)
		// Otherwise, if query params changed, emit UrlQueryChange
		// It might make sense to track hash changes as well, but it's not clear that
		// the potential benefit is worth the bloat of tracking it.
		if (!didPathChange && !didQueryChange) {
			// Nothing relevant changed, don't emit an event
			this.lastUrl = sanitizedUrl;
			return;
		}

		const eventType = didPathChange
			? URL_PATH_CHANGE_EVENT_TYPE
			: URL_QUERY_CHANGE_EVENT_TYPE;

		if (
			!this.options.privacy.shouldTrackQueryParams &&
			eventType === URL_QUERY_CHANGE_EVENT_TYPE
		) {
			this.lastUrl = sanitizedUrl;
			return;
		}

		// Get navigationType from Performance API for "load" events
		let navigationType: NavigationTimingType | undefined;
		if (changeType === "load") {
			// There will only ever be one PerformanceNavigationTiming entry in the timeline
			// https://developer.mozilla.org/en-US/docs/Web/API/PerformanceNavigationTiming
			const navEntry = performance.getEntriesByType("navigation")[0] as
				| PerformanceNavigationTiming
				| undefined;
			if (navEntry) {
				navigationType = navEntry.type;
			}
		}

		// Only include the title for path changes, not query-only changes
		const title = didPathChange ? document.title?.trim() : undefined;

		const payload = {
			type: eventType,
			name: changeType,
			attributes: {
				url: sanitizedUrl,
				...(navigationType ? { navigationType } : {}),
				...(title ? { title } : {}),
			},
		};
		record.addCustomEvent(MILANA_CUSTOM_EVENT_TAG, payload);

		this.lastUrl = sanitizedUrl;
	}

	private setupUrlTracking(): void {
		const originalPushState = history.pushState.bind(history);
		history.pushState = (...args) => {
			originalPushState(...args);
			this.debouncedTrackUrlChange(window.location.href, "pushstate");
		};
		this.urlTrackingCleanup.push(() => {
			history.pushState = originalPushState;
		});

		const originalReplaceState = history.replaceState.bind(history);
		history.replaceState = (...args) => {
			originalReplaceState(...args);
			this.debouncedTrackUrlChange(window.location.href, "replacestate");
		};
		this.urlTrackingCleanup.push(() => {
			history.replaceState = originalReplaceState;
		});

		// Listen for popstate (back/forward buttons)
		const popstateHandler = () => {
			this.debouncedTrackUrlChange(window.location.href, "popstate");
		};
		window.addEventListener("popstate", popstateHandler);
		this.urlTrackingCleanup.push(() => {
			window.removeEventListener("popstate", popstateHandler);
		});
	}

	private restartSession(cause: "update" | "batch") {
		// Clear only the session id, keeping the cached user/session. The next
		// session start gets a fresh id from the server (we send none) and replays
		// the cached identity onto it.
		clearSessionId();
		this.state = {
			type: StateType.Initializing,
		};
		console.info(`Milana: Restarting session (cause: ${cause})`);
		void this.startOrRestartOrResumeSession();
	}

	private async sendEvents(eventsToSend: BufferedEvent[]) {
		const abortController = new AbortController();
		this.inFlightEventsAbortController = abortController;

		try {
			if (eventsToSend.length === 0) {
				return true;
			}

			const headers = this._getPostInitializationHeaders();
			const payload = buildBatchPayloadString(eventsToSend);

			let body: string | Blob = payload;

			if (
				isCompressionSupported() &&
				!this.options._internal.shouldForceUncompressedPayloads
			) {
				const compressionResult = await compressDataAsync(payload);
				if (compressionResult.success) {
					headers["Content-Encoding"] = "gzip";
					body = compressionResult.blob;
				}
			}

			const response = await fetch(`${this.options.endpoint}/batch`, {
				method: "POST",
				headers,
				body,
				signal: abortController.signal,
			});

			if (!response.ok) {
				throw new Error(
					`Milana: Got non-OK events response: ${response.statusText}`,
				);
			}

			let responseJson: unknown;
			try {
				responseJson = await response.json();
			} catch (_error) {
				console.debug("Milana: Failed to parse response JSON", responseJson);
				throw new Error("Milana: Failed to parse response JSON");
			}

			const data = responseJson as {
				sessionId: string;
				shouldRestartSession: boolean;
			} & (
				| {
						success: true;
						messageId: string;
				  }
				| {
						success: false;
						errorCode: string;
						error: string;
				  }
			);

			if (data.success) {
				return true;
			}

			if (data.shouldRestartSession) {
				this.restartSession("batch");
			}

			if (data.errorCode === "SESSION_NOT_IDENTIFIED") {
				this.state = {
					type: StateType.SessionNotSampled,
					sessionId: data.sessionId,
				};
			}
			return false;
		} catch (error) {
			if (abortController.signal.aborted) {
				// Aborted by the visibility-hidden flush; events are
				// reclaimed onto its keepalive request — don't retry.
				return false;
			}
			console.debug(
				"Milana: Failed to send events, will retry automatically",
				error,
			);
			return false;
		} finally {
			if (this.inFlightEventsAbortController === abortController) {
				this.inFlightEventsAbortController = null;
			}
		}
	}

	private _getPostInitializationHeaders(): Record<string, string> {
		if (this.state.type === StateType.Initializing) {
			throw new Error(
				"Milana: Library initialization not started. Call init() first.",
			);
		}

		const headers: Record<string, string> = {
			...BASE_HEADERS,
			"X-Milana-Caller-Type": this.callerType,
			"X-Milana-Product-Id": this.productId,
			"X-Milana-Client-Key": this.clientKey,
			"X-Milana-Session-Id": this.state.sessionId,
		};

		return headers;
	}

	/**
	 * Fixed-size close ping fired from `pagehide`. Event delivery belongs
	 * to the visibility-hidden flush, so this is always ~80 bytes — fits
	 * inside the keepalive budget even when the visibility flush filled
	 * it to the brim.
	 *
	 * The URL matches the regular /batch endpoint so the CORS preflight
	 * cache warmed by earlier batches still applies — a query-string
	 * variant would key a different cache entry and likely fail to
	 * complete a fresh OPTIONS during unload.
	 */
	private sendCloseRequest() {
		this.hasSentClose = true;

		const payload = `{"version":1,"batchStartedAt":${Date.now()},"isPageClose":true,"events":[]}`;

		try {
			void fetch(`${this.options.endpoint}/batch`, {
				method: "POST",
				headers: this._getPostInitializationHeaders(),
				body: payload,
				keepalive: true,
			}).catch(() => {});
		} catch (_error) {
			// Best-effort flush; nothing to do if it fails on the unload path.
		}
	}

	/**
	 * Issues a POST /batch for a programmatic `stopRecording()` call using
	 * the ingest client-abort schema (`isClientAbort: true` +
	 * `clientAbortReason: "CLIENT_STOPPED"`). Not on the unload path, so
	 * no `keepalive: true` and no 64KB cap is needed — the full buffer
	 * fits in a normal fetch.
	 *
	 * No-op when there is no recording to close (either we never reached
	 * `Recording` or a close already fired via `pagehide`). Owning the
	 * guard here lets callers invoke this unconditionally.
	 */
	private sendStopRequest() {
		if (this.hasSentClose) return;
		if (this.state.type !== StateType.Recording) return;
		this.hasSentClose = true;

		// If a periodic batch is still in flight, it will deliver `this.events`
		// when it resolves. Re-sending here would duplicate them server-side.
		const events = this.isSendingEvents ? [] : this.events;
		const payload = buildBatchPayloadString(
			events,
			'"isClientAbort":true,"clientAbortReason":"CLIENT_STOPPED"',
		);

		try {
			void fetch(`${this.options.endpoint}/batch`, {
				method: "POST",
				headers: this._getPostInitializationHeaders(),
				body: payload,
			}).catch(() => {});
		} catch (_error) {
			// Best-effort; nothing to do if the fetch synchronously throws.
		}
		this.events = [];
		this.bufferedCharacters = 0;
	}

	private clearRetryTimeout() {
		if (this.retryTimeout !== null) {
			clearTimeout(this.retryTimeout);
			this.retryTimeout = null;
		}
	}

	/**
	 * Schedules a retry for sending events, with exponential backoff.
	 */
	private scheduleRetry() {
		this.clearRetryTimeout();

		if (this.retryCount < MAX_RETRY_COUNT) {
			const delay = RETRY_DELAY_BASE * DELAY_MULTIPLIERS[this.retryCount];
			this.retryCount++;

			this.retryTimeout = window.setTimeout(() => {
				void this.tryToSendEvents();
			}, delay);
		} else {
			// If max retries reached, stop recording and drop events
			console.info(
				"Milana: Max retry count reached for sending events. Stopping session.",
			);
			this.stopRecording();
		}
	}

	private scheduleSendIfNecessary() {
		if (!this.isSendingEvents && this.events.length > 0) {
			setTimeout(() => void this.tryToSendEvents(), 0);
		}
	}

	private async tryToSendEvents() {
		if (this.state.type === StateType.SessionNotSampled) {
			this.events = [];
			this.bufferedCharacters = 0;
			return;
		}

		this.clearRetryTimeout();

		if (this.isSendingEvents || this.events.length === 0) return;

		this.isSendingEvents = true;

		// Create a copy of the current buffer snapshot
		const eventsToSend = this.events.slice();

		// Attempt to send events - note the async gap!
		const success = await this.sendEvents(eventsToSend);

		// Only remove events from buffer if send was successful
		if (success) {
			this.events.splice(0, eventsToSend.length);
			const sentCharacters = eventsToSend.reduce(
				(total, event) => total + event.serialized.length,
				0,
			);
			this.bufferedCharacters = Math.max(
				0,
				this.bufferedCharacters - sentCharacters,
			);
			this.lastSendTime = Date.now();
			this.retryCount = 0;

			this.scheduleSendIfNecessary();
		} else {
			// Two failure shapes share `success === false`:
			//   1. The visibility-hidden flush aborted us mid-send and
			//      reclaimed `this.events` onto its keepalive request.
			//      The buffer is now empty — there is nothing to retry.
			//   2. A real network/server failure. The buffer still holds
			//      the unsent events (we only splice on success), so we
			//      schedule a retry with backoff.
			const bufferReclaimedByKeepaliveFlush = this.events.length === 0;
			if (!bufferReclaimedByKeepaliveFlush) {
				this.scheduleRetry();
			}
		}

		this.isSendingEvents = false;
	}

	private async logMetrics() {
		if (this.state.type !== StateType.Recording || this.isSendingMetrics) {
			return;
		}

		this.isSendingMetrics = true;

		const countersToSend = { ...this.counters };

		const histograms: SessionHistograms = {
			numEventsInBuffer: this.events.length,
		};

		if (this.options._internal.shouldTrackPerformance) {
			// Only log INP if we have enough events to approximate a p98
			if (this.worstInpValues.length > 1 && this.totalInpEventCount >= 50) {
				// For ≥50 interactions, p98 ≈ 2nd worst value
				const p98Index = 1;
				histograms.inpP98Ms = this.worstInpValues[p98Index];
			}

			if (this.longTaskCount > 0) {
				// Pre-aggregating like this for a histogram is not standard,
				// but this is our current best approach to be able to have a
				// value that's useful to compare across sessions.
				histograms.averageLongTaskDurationMs =
					this.longTaskDurationSum / this.longTaskCount;
			}

			const recordingDurationMs = Date.now() - this.recordingStartTime;
			if (recordingDurationMs > 0) {
				histograms.blockedTimePerSecondMs =
					(this.totalLongTaskBlockingTime / recordingDurationMs) * 1000;
			}
		}

		const metrics: SessionPerfMetrics = {
			version: 1,
			clientTimestamp: Date.now(),
			histograms,
			counters: countersToSend,
		};

		try {
			const response = await fetch(`${this.options.endpoint}/metrics`, {
				method: "POST",
				headers: this._getPostInitializationHeaders(),
				body: JSON.stringify(metrics),
			});

			if (!response.ok) {
				console.debug("Milana: Failed to send metrics", response);
			} else {
				this.counters.numSessionsAbortedDueToBufferExceeded -=
					countersToSend.numSessionsAbortedDueToBufferExceeded;
			}
		} catch (error) {
			console.debug("Milana: Failed to send metrics", error);
		}

		this.isSendingMetrics = false;
	}

	/**
	 * Adds an event to the buffer and triggers sending if needed.
	 */
	private pushEvent(event: eventWithTime) {
		if (this.state.type === StateType.SessionNotSampled) {
			this.events = [];
			this.bufferedCharacters = 0;
			return;
		}

		const serializedEvent = JSON.stringify(event);
		if (serializedEvent.length > MAX_SERIALIZED_EVENT_CHAR_COUNT) {
			console.warn(
				`Milana: Event type ${event.type} exceeds max size, aborting. Application will continue unaffected`,
			);
			this.counters.numSessionsAbortedDueToBufferExceeded++;
			this.stopRecording();
			return;
		}

		this.events.push({
			serialized: serializedEvent,
			timestamp: event.timestamp,
		});
		this.bufferedCharacters += serializedEvent.length;

		if (this.bufferedCharacters > MAX_BUFFER_CHAR_COUNT) {
			console.warn(
				"Milana: Buffer exceeded limit, aborting to prevent application impact",
			);
			this.counters.numSessionsAbortedDueToBufferExceeded++;
			this.stopRecording();
		}

		if (this.bufferedCharacters >= FLUSH_BUFFER_CHAR_COUNT_THRESHOLD) {
			if (Date.now() - this.lastForcedImmediateRetryAt >= RETRY_DELAY_BASE) {
				this.lastForcedImmediateRetryAt = Date.now();
				this.clearRetryTimeout();
			}

			this.scheduleSendIfNecessary();
		}
	}

	/**
	 * Starts rrweb recording and sets up periodic flushing.
	 */
	private startRecording() {
		if (this.stopRrwebRecording || this.isRecordingStartPending) {
			console.debug(
				"Milana: Recording already scheduled or in progress, skipping duplicate start",
			);
			return;
		}

		// Use requestIdleCallback if available to minimize page load hit
		if (
			typeof window !== "undefined" &&
			typeof window.requestIdleCallback === "function"
		) {
			this.isRecordingStartPending = true;
			this.recordingStartIdleCallbackId = window.requestIdleCallback(
				() => {
					this.startRecordingAfterIdleCallback();
				},
				{ timeout: RECORDING_IDLE_TIMEOUT_MS },
			);
			return;
		}

		this.startRecordingAfterIdleCallback();
	}

	private startRecordingAfterIdleCallback() {
		this.isRecordingStartPending = false;
		this.recordingStartIdleCallbackId = null;

		const plugins = [
			getScrollDepthPlugin(),
			getDownloadDetectionPlugin(),
			getClickModifierPlugin(),
		];

		if (!this.options.disableContentEditableRecording) {
			plugins.push(getContentEditablePlugin());
		}

		const rrwebRecordArgs = {
			emit: (event: eventWithTime) => this.pushEvent(event),
			maskTextClass: this.options.privacy.maskTextClass,
			// "xhigh" masks all DOM text (rrweb has no maskAllText option, so "*"
			// is how we select everything); otherwise only maskSelector subtrees
			// are routed through maskTextFn.
			maskTextSelector:
				this.options.privacy.maskingLevel === "xhigh"
					? "*"
					: (this.options.privacy.maskSelector ?? undefined),
			blockClass: this.options.privacy.blockClass,
			blockSelector: this.options.privacy.blockSelector ?? undefined,
			ignoreClass: this.options.privacy.ignoreClass,
			ignoreSelector: this.options.privacy.ignoreSelector ?? undefined,
			recordCanvas: this.options.shouldRecordCanvas,
			recordCrossOriginIframes: this.options.shouldRecordCrossOriginIframes,
			// NOTE: This forces rrweb to invoke maskInputFn for all tags listed in TAGS_TO_MASK
			maskInputOptions: TAGS_TO_MASK,
			maskInputFn: (value: string, el: HTMLElement) =>
				this.maskInputValue(value, el),
			maskTextFn: (value: string, el: HTMLElement | null) =>
				this.maskText(value, el),
			userTriggeredOnInput: true,
			// Periodic full snapshot so the server can split long sessions
			// into encoder-sized windows.
			checkoutEveryNms: 10 * 60 * 1000,
			plugins,
		};

		this.stopRrwebRecording = record(rrwebRecordArgs) ?? null;
		if (!this.stopRrwebRecording) {
			console.warn(
				"Milana: Failed to start recording, application will continue unaffected",
			);
			return;
		}

		this.recordingStartTime = Date.now();
		this.lastSendTime = Date.now();

		this.setupUrlTracking();

		// Track initial URL
		try {
			this.trackUrlChange(window.location.href, "load");
		} catch (error) {
			console.debug(
				`Milana: Failed to track initial URL '${window.location.href}'`,
				error,
			);
		}

		if (this.flushInterval === null) {
			this.flushInterval = window.setInterval(() => {
				if (Date.now() - this.lastSendTime >= BUFFER_FLUSH_INTERVAL_MS) {
					void this.tryToSendEvents();
				}
			}, BUFFER_FLUSH_INTERVAL_MS);
		}

		// Visibility-hidden owns end-of-session event delivery via
		// fetch+keepalive. Any in-flight non-keepalive batch is aborted
		// and its events reclaimed onto the keepalive request so a
		// following navigation can't cancel them. pagehide only sends
		// the tiny close ping.
		if (this.visibilityChangeHandler === null) {
			this.visibilityChangeHandler = () => {
				// Emit visibility change as a recordable event (before flush so it's included in the batch)
				if (this.state.type === StateType.Recording) {
					try {
						record.addCustomEvent(MILANA_CUSTOM_EVENT_TAG, {
							type: VISIBILITY_CHANGE_EVENT_TYPE,
							visibilityState: document.visibilityState,
						});
					} catch (_error) {
						// Best-effort; don't break the flush path
					}
				}

				if (
					document.visibilityState !== "hidden" ||
					this.state.type !== StateType.Recording ||
					this.events.length === 0
				) {
					return;
				}

				// `bufferedCharacters` is a lower bound on payload size — if
				// already over budget, skip the build. Cheap short-circuit
				// that avoids the map+join when the buffer is clearly too
				// large (e.g. the rrweb full snapshot still in the buffer).
				if (this.bufferedCharacters > MAX_KEEPALIVE_PAYLOAD_CHAR_COUNT) {
					return;
				}

				// Build the payload first so we can tell whether it fits
				// before we abort the in-flight batch. The envelope adds
				// ~30 bytes + commas on top of `bufferedCharacters`, so a
				// just-under-budget buffer can still push the final string
				// over the limit. Aborting in that case would lose events.
				const payload = buildBatchPayloadString(this.events);
				if (payload.length > MAX_KEEPALIVE_PAYLOAD_CHAR_COUNT) return;

				// Now safe to take over: abort any non-keepalive batch in
				// flight (a navigation would cancel it and lose its events)
				// and reclaim its snapshot onto the keepalive request.
				this.inFlightEventsAbortController?.abort();
				try {
					void fetch(`${this.options.endpoint}/batch`, {
						method: "POST",
						headers: this._getPostInitializationHeaders(),
						body: payload,
						keepalive: true,
					}).catch(() => {});
				} catch (_error) {
					// Best-effort flush; nothing to do if it fails
				}
				this.events = [];
				this.bufferedCharacters = 0;
			};
			document.addEventListener(
				"visibilitychange",
				this.visibilityChangeHandler,
			);
		}

		// Window focus/blur fires when the window itself gains/loses focus,
		// independently of `visibilitychange`.
		if (this.windowFocusChangeHandler === null) {
			this.windowFocusChangeHandler = () => {
				if (this.state.type !== StateType.Recording) return;
				const hasFocus = document.hasFocus();
				// Browsers can fire focus/blur in rapid pairs (iframes, native
				// dialogs, devtools). Dedupe by last emitted state.
				if (hasFocus === this.lastEmittedHasFocus) return;
				try {
					record.addCustomEvent(MILANA_CUSTOM_EVENT_TAG, {
						type: WINDOW_FOCUS_CHANGE_EVENT_TYPE,
						hasFocus,
					});
					this.lastEmittedHasFocus = hasFocus;
				} catch (_error) {
					// Best-effort; leave lastEmittedHasFocus unchanged so a
					// retry on the next event isn't deduped away.
				}
			};
			window.addEventListener("focus", this.windowFocusChangeHandler);
			window.addEventListener("blur", this.windowFocusChangeHandler);
		}

		// Subscribes to `pagehide` but only acts when persisted=false, i.e. the
		// page is actually being torn down (not bfcache-frozen). Signals to the
		// server that this session can be closed immediately, short-circuiting
		// the backend's ~30min inactivity window.
		//
		// Cross-browser bfcache landscape this design handles:
		//   - Chrome: aggressive bfcache including cross-origin navigations;
		//     fires `pagehide` with persisted=true. We skip the close so the
		//     session can resume via Back.
		//   - Safari (desktop): even more aggressive bfcache, including
		//     same-origin nav. Same handling — skip close on persisted=true.
		//   - Mobile Safari: backgrounding the tab (app switcher, home) fires
		//     `visibilitychange → hidden` reliably, which is where event
		//     delivery happens. `pagehide` with persisted=true follows when
		//     the page is frozen. We do not lose buffered events.
		//   - Firefox: bfcache only for in-history (back/forward) navigations;
		//     forward nav and tab close fire `pagehide` with persisted=false,
		//     where we do send the close ping.
		//
		// Across all four, `visibilitychange → hidden` precedes `pagehide`
		// on tab close and on backgrounding, so the visibility-hidden flush
		// owns event delivery and `pagehide` is just the close signal.
		// Buffered events are already delivered by the visibility-hidden
		// flush above either way.
		if (this.pageCloseHandler === null) {
			this.pageCloseHandler = (event: PageTransitionEvent) => {
				if (event.persisted) return;
				if (this.state.type !== StateType.Recording) return;
				if (this.hasSentClose) return;
				this.sendCloseRequest();
			};
			window.addEventListener("pagehide", this.pageCloseHandler);
		}

		if (this.logMetricsInterval === null) {
			this.logMetricsInterval = window.setInterval(() => {
				void this.logMetrics();
			}, METRICS_LOG_INTERVAL);

			if (this.options._internal.shouldTrackPerformance) {
				this.initializePerformanceObservers();
			}
		}
	}

	private maskInputValue(value: string, element: HTMLElement): string {
		const type = this.getInputType(element as HTMLInputElement);
		if (this.shouldMaskInputValue(element, type)) {
			// Passwords are masked as plain asterisks: the field renders
			// bullets regardless of content, so layout-preserving
			// placeholders buy nothing here.
			if (type === "password") {
				return MASK_PLACEHOLDER.repeat(value.length);
			}
			return this.maskValue(value, element);
		}

		return value;
	}

	// Masks a value with the configured strategy: width-matched placeholders
	// (see text-mask.ts) behind privacy.shouldUseLayoutPreservingMasking,
	// otherwise every non-whitespace character becomes "*".
	private maskValue(value: string, element: HTMLElement | null): string {
		if (this.options.privacy.shouldUseLayoutPreservingMasking) {
			return maskTextValue(value, element);
		}
		return value.replace(/\S/g, MASK_PLACEHOLDER);
	}

	private shouldMaskInputValue(
		element: HTMLElement,
		type: string | null,
	): boolean {
		// Sensitive input types are always masked, before any unmask check below.
		// password/tel/email are built in; maskInputTypes can add more. None of
		// these can be revealed by unmaskSelector.
		if (type && this.isAlwaysMaskedInputType(type)) {
			return true;
		}

		if (this.elementOrAncestorIsExplicitlyMaskedForInput(element)) {
			return true;
		}

		// "high"/"xhigh" mask every other input, but an unmasked subtree
		// (unmaskSelector) reveals them.
		const level = this.options.privacy.maskingLevel;
		if (level === "high" || level === "xhigh") {
			return !this.elementOrAncestorCanBeUnmasked(element);
		}

		return false;
	}

	private maskText(value: string, element: HTMLElement | null): string {
		// Text is revealed only when it sits in an unmasked subtree and is not
		// explicitly masked. Everything else — no element, an explicit mask, or
		// not unmaskable — stays masked.
		const reveal =
			element !== null &&
			this.elementOrAncestorCanBeUnmasked(element) &&
			!this.elementOrAncestorIsExplicitlyMaskedForText(element);

		return reveal ? value : this.maskValue(value, element);
	}

	// True for the built-in PII types plus any the customer added via
	// maskInputTypes. `=== true` avoids matching inherited Object.prototype
	// members for arbitrary type strings.
	private isAlwaysMaskedInputType(type: string): boolean {
		return (
			ALWAYS_MASKED_INPUT_TYPES.has(type) ||
			this.options.privacy.maskInputTypes[type] === true
		);
	}

	private getInputType(element: HTMLInputElement) {
		const type = element.type;
		// duplicated from rrweb/record.js
		return element.hasAttribute("data-rr-is-password")
			? "password"
			: type
				? type.toLowerCase()
				: null;
	}

	private elementOrAncestorIsExplicitlyMaskedForInput(
		element: HTMLElement,
	): boolean {
		return (
			this.elementOrAncestorHasClass(
				element,
				this.options.privacy.maskInputClass,
			) ||
			this.elementOrAncestorMatchesSelector(
				element,
				this.options.privacy.maskSelector,
			)
		);
	}

	private elementOrAncestorIsExplicitlyMaskedForText(
		element: HTMLElement,
	): boolean {
		return (
			this.elementOrAncestorHasClass(
				element,
				this.options.privacy.maskTextClass,
			) ||
			this.elementOrAncestorMatchesSelector(
				element,
				this.options.privacy.maskSelector,
			)
		);
	}

	private elementOrAncestorCanBeUnmasked(element: HTMLElement): boolean {
		// A subtree is revealed by either the unmask class (default
		// "milana-unmask") or an unmaskSelector — unless it sits under a
		// blocked ancestor, which always wins.
		return (
			!this.elementOrAncestorIsBlocked(element) &&
			(this.elementOrAncestorHasClass(
				element,
				this.options.privacy.unmaskClass,
			) ||
				this.elementOrAncestorMatchesSelector(
					element,
					this.options.privacy.unmaskSelector,
				))
		);
	}

	private elementOrAncestorIsBlocked(element: HTMLElement): boolean {
		return (
			this.elementOrAncestorHasClass(
				element,
				this.options.privacy.blockClass,
			) ||
			this.elementOrAncestorMatchesSelector(
				element,
				this.options.privacy.blockSelector,
			)
		);
	}

	private elementOrAncestorHasClass(
		element: HTMLElement,
		classMatcher: string | RegExp,
	): boolean {
		if (typeof classMatcher === "string" && classMatcher.trim().length === 0) {
			return false;
		}

		let current: HTMLElement | null = element;
		while (current) {
			for (const className of current.classList) {
				if (typeof classMatcher === "string") {
					if (className === classMatcher) return true;
					// RegExp matchers are normalized to be non-stateful at
					// construction (withoutStatefulRegexFlags), so .test() is pure.
				} else if (classMatcher.test(className)) {
					return true;
				}
			}
			current = current.parentElement;
		}

		return false;
	}

	private elementOrAncestorMatchesSelector(
		element: HTMLElement,
		selector: string | null,
	): boolean {
		if (!selector) return false;

		try {
			return element.closest(selector) !== null;
		} catch {
			return false;
		}
	}

	/**
	 * Initializes performance observers for event and longtask entries.
	 */
	private initializePerformanceObservers() {
		if (!this.options._internal.shouldTrackPerformance) {
			return;
		}

		if (
			typeof PerformanceObserver === "undefined" ||
			!PerformanceObserver.supportedEntryTypes
		) {
			return;
		}

		const supportedTypes = PerformanceObserver.supportedEntryTypes;

		if (supportedTypes.includes("event")) {
			try {
				this.eventObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						if (entry.duration) {
							this.totalInpEventCount++;

							// Insert into worst-N list if it qualifies
							if (this.worstInpValues.length < this.MAX_INP_SAMPLES) {
								this.worstInpValues.push(entry.duration);
								this.worstInpValues.sort((a, b) => b - a);
							} else if (
								entry.duration > this.worstInpValues[this.MAX_INP_SAMPLES - 1]
							) {
								// Replace smallest of the worst-10 if this is worse
								this.worstInpValues[this.MAX_INP_SAMPLES - 1] = entry.duration;
								this.worstInpValues.sort((a, b) => b - a);
							}
						}
					}
				});
				// By default, this will only fire for user interaction events that take > 104ms to be handled
				// See https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming for more details
				this.eventObserver.observe({
					type: "event",
					buffered: true,
				} as PerformanceObserverInit);
			} catch (error) {
				console.debug("Milana: Failed to initialize event observer", error);
			}
		}

		if (supportedTypes.includes("longtask")) {
			try {
				this.longTaskObserver = new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) {
						const duration = entry.duration;
						this.longTaskDurationSum += duration;
						this.longTaskCount++;
						const blockingTime = Math.max(0, duration - 50);
						this.totalLongTaskBlockingTime += blockingTime;
					}
				});
				this.longTaskObserver.observe({
					type: "longtask",
					buffered: true,
				} as PerformanceObserverInit);
			} catch (error) {
				console.debug("Milana: Failed to initialize longtask observer", error);
			}
		}
	}

	/**
	 * Stops rrweb recording and flushes or drops events as needed.
	 */
	private stopRecording() {
		this.clearRetryTimeout();

		if (this.recordingStartIdleCallbackId !== null) {
			if (
				typeof window !== "undefined" &&
				typeof window.cancelIdleCallback === "function"
			) {
				window.cancelIdleCallback(this.recordingStartIdleCallbackId);
			}
			this.recordingStartIdleCallbackId = null;
		}
		this.isRecordingStartPending = false;

		if (this.stopRrwebRecording) {
			this.stopRrwebRecording();
			this.stopRrwebRecording = null;
		}

		if (this.flushInterval !== null) {
			clearInterval(this.flushInterval);
			this.flushInterval = null;
		}

		if (this.logMetricsInterval !== null) {
			clearInterval(this.logMetricsInterval);
			this.logMetricsInterval = null;
		}

		if (this.eventObserver) {
			this.eventObserver.disconnect();
			this.eventObserver = null;
		}

		if (this.longTaskObserver) {
			this.longTaskObserver.disconnect();
			this.longTaskObserver = null;
		}

		if (this.visibilityChangeHandler !== null) {
			document.removeEventListener(
				"visibilitychange",
				this.visibilityChangeHandler,
			);
			this.visibilityChangeHandler = null;
		}

		if (this.windowFocusChangeHandler !== null) {
			window.removeEventListener("focus", this.windowFocusChangeHandler);
			window.removeEventListener("blur", this.windowFocusChangeHandler);
			this.windowFocusChangeHandler = null;
		}
		this.lastEmittedHasFocus = null;

		if (this.pageCloseHandler !== null) {
			window.removeEventListener("pagehide", this.pageCloseHandler);
			this.pageCloseHandler = null;
		}

		this.events = [];
		this.bufferedCharacters = 0;
		// Clean up URL tracking hooks
		for (const cleanup of this.urlTrackingCleanup) {
			cleanup();
		}
		this.urlTrackingCleanup = [];
		this.lastUrl = null;

		this.debouncedTrackUrlChange.cancel();

		// last ditch effort to send metrics
		void this.logMetrics();
	}
}

function isCompressionSupported(): boolean {
	if (typeof window === "undefined") {
		return false;
	}

	const protocol = window.location?.protocol ?? null;

	return (
		protocol === "https:" &&
		typeof CompressionStream !== "undefined" &&
		typeof ReadableStream !== "undefined"
	);
}

async function compressDataAsync(
	data: string,
): Promise<{ success: true; blob: Blob } | { success: false }> {
	const textEncoder = new TextEncoder();
	try {
		const inputStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(textEncoder.encode(data));
				controller.close();
			},
		});

		const compressedStream = inputStream.pipeThrough(
			new CompressionStream(
				"gzip",
			) as unknown as ReadableWritablePair<Uint8Array>,
		);

		const blob = await new Response(compressedStream).blob();
		return { success: true, blob };
	} catch (error) {
		console.debug(
			"Milana: Compression failed, falling back to uncompressed payload",
			error,
		);
		return { success: false };
	}
}

/*
 * Types for session performance metrics. These must be kept in sync with
 * the metrics schema the ingest server expects.
 */
export type SessionHistograms = {
	/** The number of events in the event buffer. */
	numEventsInBuffer: number;
	/** The 98th percentile of INP values. */
	inpP98Ms?: number;
	/** The ratio of long tasks blocking the main thread. Measured as the number of milliseconds of blocking time per second of recording duration. */
	blockedTimePerSecondMs?: number;
	averageLongTaskDurationMs?: number;
};

export type SessionCounters = {
	numSessionsAbortedDueToBufferExceeded: number;
};

export type SessionPerfMetrics = {
	version: 1;
	clientTimestamp: number;
	histograms: SessionHistograms;
	counters: SessionCounters;
};
