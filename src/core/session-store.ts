import { isRecord } from "./object-utils";
import type { SessionIntegrations, SessionUpdate, UserUpdate } from "./types";

// Session id, user, and session context live in one record so they're written
// and cleared together.
const SESSION_STATE_KEY = "milana_session_state";

// The latest user the server has confirmed — structurally just the user update
// we sent, merged across calls (last value wins per field, metadata keys merge).
export type SavedUser = UserUpdate;

// The latest session-level data the server has confirmed — feature flags
// (`metadata`), the customer's own session id (`appSessionId`), and links to
// third-party sessions (`integrations`).
export type SavedSessionContext = SessionUpdate;

// What we keep in sessionStorage: the last identity the server confirmed.
// `user` / `sessionContext` are written only after a successful /update, so
// they always reflect what the server has — which is both what we replay onto
// the new session after a restart and what we dedup against (a call that
// wouldn't change them isn't sent).
export type StoredSession = {
	sessionId: string | null;
	user: SavedUser | null;
	sessionContext: SavedSessionContext | null;
};

function emptyState(): StoredSession {
	return { sessionId: null, user: null, sessionContext: null };
}

function parseSavedUser(raw: unknown): SavedUser | null {
	if (!isRecord(raw) || typeof raw.userId !== "string") return null;
	const user: SavedUser = { userId: raw.userId };
	if (typeof raw.email === "string") user.email = raw.email;
	if (typeof raw.name === "string") user.name = raw.name;
	if (isRecord(raw.metadata)) user.metadata = raw.metadata;
	return user;
}

function parseSavedSessionContext(raw: unknown): SavedSessionContext | null {
	if (!isRecord(raw)) return null;
	const context: SavedSessionContext = {};
	if (isRecord(raw.metadata)) context.metadata = raw.metadata;
	if (typeof raw.appSessionId === "string")
		context.appSessionId = raw.appSessionId;
	if (isRecord(raw.integrations)) {
		context.integrations = raw.integrations as SessionIntegrations;
	}
	return context;
}

// Structural validation stands in for a version field: a blob that doesn't
// parse to the expected shape is treated as no blob, so the session starts
// fresh rather than throwing on a corrupt or foreign value.
function parseStoredSession(raw: string): StoredSession | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	const state: StoredSession = {
		sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
		user: parseSavedUser(parsed.user),
		sessionContext: parseSavedSessionContext(parsed.sessionContext),
	};
	if (
		state.sessionId === null &&
		state.user === null &&
		state.sessionContext === null
	) {
		return null;
	}
	return state;
}

// sessionStorage can throw (sandboxed iframe, quota, storage disabled). When it
// does we just skip persistence — identity won't carry across a restart in that
// context, but the SDK keeps working.
export function loadSessionState(): StoredSession | null {
	try {
		const raw = sessionStorage.getItem(SESSION_STATE_KEY);
		return raw !== null ? parseStoredSession(raw) : null;
	} catch {
		return null;
	}
}

export function saveSessionState(state: StoredSession): void {
	try {
		sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(state));
	} catch {
		// Storage unavailable — skip persistence for this write.
	}
}

export function clearSessionState(): void {
	try {
		sessionStorage.removeItem(SESSION_STATE_KEY);
	} catch {
		// Storage unavailable — nothing to clear.
	}
}

// Shallow per-key merge, last write wins. Used for user/session metadata and
// the per-vendor integrations map (an absent key leaves the previous value).
function shallowMerge<T extends object>(
	prev: T | undefined,
	next: T | undefined,
): T | undefined {
	if (prev === undefined && next === undefined) return undefined;
	return { ...prev, ...next } as T;
}

// Merge a user update onto the previous saved user (last value wins per field,
// undefined never clobbers a previously saved field). Pure — the caller saves
// the result only after the server confirms it.
export function mergeUser(
	prev: SavedUser | null,
	input: UserUpdate,
): SavedUser {
	const user: SavedUser = { userId: input.userId };
	const email = input.email ?? prev?.email;
	if (email !== undefined) user.email = email;
	const name = input.name ?? prev?.name;
	if (name !== undefined) user.name = name;
	const metadata = shallowMerge(prev?.metadata, input.metadata);
	if (metadata !== undefined) user.metadata = metadata;
	return user;
}

// Merge a session update onto the previous saved context. Pure.
export function mergeSessionContext(
	prev: SavedSessionContext | null,
	input: SessionUpdate,
): SavedSessionContext {
	const context: SavedSessionContext = {};
	const metadata = shallowMerge(prev?.metadata, input.metadata);
	if (metadata !== undefined) context.metadata = metadata;
	const appSessionId = input.appSessionId ?? prev?.appSessionId;
	if (appSessionId !== undefined) context.appSessionId = appSessionId;
	const integrations = shallowMerge(prev?.integrations, input.integrations);
	if (integrations !== undefined) context.integrations = integrations;
	return context;
}

export function setSessionId(sessionId: string): void {
	const state = loadSessionState() ?? emptyState();
	state.sessionId = sessionId;
	saveSessionState(state);
}

// Restart clears only the session id, keeping the saved user/sessionContext so
// the next session start replays them onto the new session row.
export function clearSessionId(): void {
	const state = loadSessionState();
	if (!state) return;
	state.sessionId = null;
	saveSessionState(state);
}
