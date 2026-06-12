/**
 * The Milana API exposed on `window.Milana` by the CDN bundle.
 *
 * Callable as a function with a string command — e.g.
 * `Milana("identify", { ... })`. The same call shape works whether
 * customer code runs before or after the CDN script loads: pre-load
 * calls go through the `_milanaQueue` stub and are drained once the
 * SDK initializes; post-load calls dispatch immediately.
 */
export interface MilanaWindowApi {
	(
		command: "init",
		productId: string,
		clientKey: string,
		info: SessionInfo,
		options?: PublicInitOptions,
	): void;
	(command: "identify", input: IdentifyInput): void;
	(command: "update", payload: UpdatePayload): void;
	(command: "updateUser", user: UserUpdate): void;
	(command: "updateSession", session: SessionUpdate): void;
	(command: "stopRecording"): void;
	(command: "initCrossOriginIframe"): void;
	(
		command: "trackEvent",
		eventName: string,
		attributes?: TrackEventAttributes,
	): void;
}

/**
 * Interface for a MilanaSession instance
 */
export interface IMilanaSessionSingleton {
	state: {
		type: string;
		sessionId?: string; // Because state is a discriminated union
	};
}

/**
 * Global window interface extensions for Milana
 */
export interface MilanaWindow {
	Milana?: MilanaWindowApi;
	_milanaQueue?: Array<[string, ...unknown[]]>;
}

export type PrivacyMaskingLevel = "normal" | "high" | "xhigh";

export type InitPrivacyOptions = {
	// "normal" preserves the current defaults. "high" masks all input-like
	// values. "xhigh" masks all input-like values and all DOM text.
	maskingLevel: PrivacyMaskingLevel;

	blockClass: string | RegExp; // default: milana-block
	blockSelector: string | null;

	// NOTE: rrweb documentation claims that ignoreClass supports RegExp but
	// the type definition is just 'string?'. We should re-evaluate this when
	// we upgrade from v2.0.0-alpha.18
	ignoreClass: string; // default: milana-ignore
	ignoreSelector: string | null;

	// Ideally we'd expose a single 'maskClass'/'maskSelector' that applies to
	// both text and input elements; today these are configured separately.
	maskTextClass: string; // default: milana-mask
	maskInputClass: string; // default: milana-mask
	// Masks text and input values in matching subtrees. Explicit masks win over
	// unmaskSelector.
	maskSelector: string | null;
	// Reveals values masked by maskingLevel — input values under "high"/"xhigh"
	// and DOM text under "xhigh". Has no effect at "normal" (nothing is broadly
	// masked there to reveal) and a warning is logged if set. Does not override
	// explicit masks (maskSelector / maskTextClass), blocked elements, or the
	// always-masked input types (password/tel/email plus maskInputTypes).
	unmaskSelector: string | null;
	// Class-based counterpart to unmaskSelector, so host apps can mark known-safe
	// product copy at render time (e.g. in their i18n component's wrapper).
	// Same semantics and precedence as unmaskSelector. Set to "" to disable.
	unmaskClass: string; // default: milana-unmask

	// Additional input types to always mask, on top of the built-in
	// always-masked types (password, tel, email). Like the built-ins, values
	// matching these types are always masked and cannot be revealed by
	// unmaskSelector. Keys are lowercase input `type` values, e.g.
	// { url: true, number: true }.
	maskInputTypes: Record<string, boolean>;

	shouldTrackQueryParams: boolean;
	// Custom patterns provided here extend (not replace) the default patterns.
	// defaults: /^jwt$/i, /^code$/i, /token/i, /password/i, /secret/i, /key/i, /auth/i, /nonce/i, /csrf/i
	queryTrackingParamsDenyList: RegExp[];
};

export type InitInternalOptions = {
	shouldTrackPerformance: boolean;
	shouldForceUncompressedPayloads: boolean;
};

export type CallerType = "cdn" | "react" | "core";

/**
 * Names of third-party SDKs Milana can auto-detect on the host page and
 * cross-link to from the session details UI. Extending this list is just
 * a new arm here plus a parser branch in `integration-detector.ts`.
 */
export type IntegrationName = "sentry" | "posthog";

export type SentryIntegrationState = {
	// Sentry's canonical name for this id (matches `getReplay().getReplayId()`
	// and the `/replays/<id>/` URL pattern). It functions as the session
	// identifier — stable for the user's interaction span and used by
	// Sentry to group related events.
	replayId: string;
};

export type PostHogIntegrationState = {
	sessionId: string;
	distinctId?: string;
	userId?: string;
};

/**
 * Snapshot of detected (or customer-supplied) third-party session state.
 * Per-integration entries replace atomically on each update; absent
 * integration keys leave the previous server-side value untouched.
 */
export type SessionIntegrations = {
	sentry?: SentryIntegrationState;
	posthog?: PostHogIntegrationState;
};

/**
 * Internal options object
 */
export type InitOptions = {
	endpoint: string;
	shouldRecordCanvas: boolean;
	shouldRecordCrossOriginIframes: boolean;
	disableContentEditableRecording: boolean;
	// Vendors whose session state Milana should auto-detect from page
	// storage and post to /update. Defaults to `[]` (no auto-detection)
	// unless the customer explicitly opts in. Storage reads happen only
	// for the listed vendors.
	integrations: IntegrationName[];
	privacy: InitPrivacyOptions;
	_internal: InitInternalOptions;
};

/**
 * Options argument to Milana.init
 */
export type PublicInitOptions = Partial<
	Omit<InitOptions, "privacy" | "_internal">
> & {
	privacy?: Partial<InitPrivacyOptions>;
	_internal?: Partial<InitInternalOptions>;
};

export type SessionInfo = {
	environment: string;
	version: string;
	metadata?: Record<string, unknown>;
	// Customer's own session-id concept (auth session, workflow id,
	// etc.) — not Milana's session id and not any vendor's session id.
	// Surfaced verbatim in the session details UI for cross-referencing
	// with the customer's own admin tooling. Last-write-wins on update.
	appSessionId?: string;
};

export type TrackEventAttributeValue = string | number | boolean | null;
export type TrackEventAttributes = Record<string, TrackEventAttributeValue>;

export type IdentifyInput = {
	userId: string;
	email: string;
	name?: string;
	metadata?: Record<string, unknown>;
};

export type SessionUpdate = {
	metadata?: Record<string, unknown>;
	appSessionId?: string;
	// Per-integration entries replace atomically; absent keys leave
	// previous server-side state alone. There is no `null`-clear convention.
	integrations?: SessionIntegrations;
};

export type UserUpdate = {
	userId: string;
	email?: string;
	name?: string;
	metadata?: Record<string, unknown>;
};

export type UpdatePayload = {
	user?: UserUpdate;
	session?: SessionUpdate;
};

// Internal shape sent to /update — `user` is optional here so a
// session-only payload can be sent. The public UpdatePayload keeps `user`
// required to preserve the legacy shape.
export type UpdatePayloadInternal = {
	user?: UserUpdate;
	session?: SessionUpdate;
};
