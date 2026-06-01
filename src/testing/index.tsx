import { type ReactNode, useState } from "react";
import type {
	IdentifyInput,
	PublicInitOptions,
	SessionInfo,
	SessionUpdate,
	TrackEventAttributes,
	UpdatePayload,
	UserUpdate,
} from "../core/types";
import { MilanaContext, type MilanaContextValue } from "../react/index";

// --- Mock session ---

export type MockMilanaCall =
	| {
			method: "init";
			args: {
				productId: string;
				clientKey: string;
				sessionInfo: SessionInfo;
				options?: PublicInitOptions;
			};
	  }
	| { method: "initialize"; args: Record<string, never> }
	| { method: "identify"; args: IdentifyInput }
	| { method: "update"; args: UpdatePayload }
	| { method: "updateUser"; args: UserUpdate }
	| { method: "updateSession"; args: SessionUpdate }
	| { method: "stopRecording"; args: Record<string, never> }
	| {
			method: "trackEvent";
			args: { eventName: string; attributes?: TrackEventAttributes };
	  };

export type MockMilanaInstance = {
	calls: MockMilanaCall[];
	getEventCalls: (eventName?: string) => MockMilanaCall[];
	getUpdateCalls: () => MockMilanaCall[];
	reset: () => void;
};

export function createMockMilana(): MockMilanaInstance {
	const calls: MockMilanaCall[] = [];

	return {
		calls,
		getEventCalls(eventName?: string) {
			return calls.filter(
				(c) =>
					c.method === "trackEvent" &&
					(eventName === undefined || c.args.eventName === eventName),
			);
		},
		getUpdateCalls() {
			return calls.filter((c) => c.method === "update");
		},
		reset() {
			calls.length = 0;
		},
	};
}

// --- Mock provider ---

export type MockMilanaProviderProps = {
	children: ReactNode;
	mock?: MockMilanaInstance;
};

export function MockMilanaProvider({
	children,
	mock,
}: MockMilanaProviderProps) {
	const [mockInstance] = useState(() => mock ?? createMockMilana());
	// Mirror the real provider: isInitialized is true after init and
	// resets to false after stopRecording so consumers can drive the
	// stop → re-initialize flow in tests.
	const [isInitialized, setIsInitialized] = useState(true);

	const value: MilanaContextValue = {
		isInitialized,
		initialize: async () => {
			mockInstance.calls.push({ method: "initialize", args: {} });
			setIsInitialized(true);
			return { success: true };
		},
		identify: async (input: IdentifyInput) => {
			mockInstance.calls.push({ method: "identify", args: input });
			return { success: true };
		},
		update: async (input: UpdatePayload) => {
			mockInstance.calls.push({ method: "update", args: input });
			return { success: true };
		},
		updateUser: async (user: UserUpdate) => {
			mockInstance.calls.push({ method: "updateUser", args: user });
			return { success: true };
		},
		updateSession: async (session: SessionUpdate) => {
			mockInstance.calls.push({ method: "updateSession", args: session });
			return { success: true };
		},
		stopRecording: async () => {
			mockInstance.calls.push({ method: "stopRecording", args: {} });
			setIsInitialized(false);
			return { success: true };
		},
		trackEvent: (eventName: string, attributes?: TrackEventAttributes) => {
			mockInstance.calls.push({
				method: "trackEvent",
				args: { eventName, attributes },
			});
		},
	};

	return (
		<MilanaContext.Provider value={value}>{children}</MilanaContext.Provider>
	);
}
