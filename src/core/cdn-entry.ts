import {
	_initWithCallerType,
	Commands,
	identify,
	init,
	initCrossOriginIframe,
	stopRecording,
	trackEvent,
	update,
	updateSession,
	updateUser,
} from "./index";
import type {
	IdentifyInput,
	MilanaWindow,
	MilanaWindowApi,
	PublicInitOptions,
	SessionInfo,
	SessionUpdate,
	TrackEventAttributes,
	UpdatePayload,
	UserUpdate,
} from "./types";

type QueueCommand = [Commands, ...unknown[]];

declare global {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface Window extends MilanaWindow {}
}

function dispatchCommand(args: unknown[]): void {
	try {
		const [command, ...params] = args;
		switch (command) {
			case Commands.Init:
				if (params.length >= 3) {
					const productId = params[0] as string;
					const clientKey = params[1] as string;
					const info = params[2] as SessionInfo;
					void _initWithCallerType(
						productId,
						clientKey,
						info,
						"cdn",
						params[3] as PublicInitOptions | undefined,
					);
				}
				break;
			case Commands.Identify:
				if (params.length >= 1) {
					void identify(params[0] as IdentifyInput);
				}
				break;
			case Commands.Update:
				if (params.length >= 1) {
					void update(params[0] as UpdatePayload);
				}
				break;
			case Commands.UpdateUser:
				if (params.length >= 1) {
					void updateUser(params[0] as UserUpdate);
				}
				break;
			case Commands.UpdateSession:
				if (params.length >= 1) {
					void updateSession(params[0] as SessionUpdate);
				}
				break;
			case Commands.StopRecording:
				void stopRecording();
				break;
			case Commands.InitCrossOriginIframe:
				initCrossOriginIframe();
				break;
			case Commands.TrackEvent:
				if (params.length >= 1) {
					trackEvent(
						params[0] as string,
						(params[1] as TrackEventAttributes) ?? {},
					);
				}
				break;
			default:
				console.warn(`Milana: Unknown command: '${String(command)}'`);
		}
	} catch (error) {
		console.warn(
			"Milana: dispatchCommand failed, application will continue unaffected",
			error,
		);
	}
}

if (typeof window !== "undefined") {
	const milanaApi = function Milana(...args: unknown[]) {
		dispatchCommand(args);
	} as MilanaWindowApi;

	window.Milana = milanaApi;

	const existingQueue = Array.isArray(window._milanaQueue)
		? [...window._milanaQueue]
		: [];

	// Keep window._milanaQueue.push working after load so any straggler
	// stub-snippet calls dispatch immediately instead of accumulating.
	window._milanaQueue = {
		push(args: QueueCommand) {
			dispatchCommand(args);
		},
	} as unknown as Array<QueueCommand>;

	for (const args of existingQueue) {
		dispatchCommand(args as QueueCommand);
	}

	console.debug("Milana: Ready");
} else {
	console.warn("Milana: 'window' object not found. Skipping Milana assignment");
}

export {
	identify,
	init,
	initCrossOriginIframe,
	stopRecording,
	trackEvent,
	update,
	updateSession,
	updateUser,
};
