import { act, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import {
	MilanaProvider,
	useMilana,
	useMilanaOptional,
} from "../../src/react/index";

// Mock the core module
vi.mock("../../src/core/index", () => ({
	_initWithCallerType: vi.fn().mockResolvedValue({ success: true }),
	identify: vi.fn().mockResolvedValue({ success: true }),
	update: vi.fn().mockResolvedValue({ success: true }),
	updateUser: vi.fn().mockResolvedValue({ success: true }),
	updateSession: vi.fn().mockResolvedValue({ success: true }),
	stopRecording: vi.fn().mockResolvedValue({ success: true }),
	trackEvent: vi.fn(),
}));

function TestConsumer() {
	const milana = useMilana();
	return (
		<div>
			<span data-testid="initialized">{String(milana.isInitialized)}</span>
			<button
				data-testid="track"
				onClick={() => milana.trackEvent("test_event")}>
				Track
			</button>
			<button data-testid="initialize" onClick={() => void milana.initialize()}>
				Initialize
			</button>
		</div>
	);
}

function TestOptionalConsumer() {
	const milana = useMilanaOptional();
	return (
		<div>
			<span data-testid="has-context">{String(milana !== null)}</span>
		</div>
	);
}

describe("MilanaProvider", () => {
	test("renders children", async () => {
		const { getByText } = render(
			<MilanaProvider
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<div>Hello</div>
			</MilanaProvider>,
		);
		expect(getByText("Hello")).toBeDefined();
	});

	test("calls init with 'react' caller type on mount", async () => {
		const { _initWithCallerType } = await import("../../src/core/index");
		render(
			<MilanaProvider
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<div />
			</MilanaProvider>,
		);
		expect(_initWithCallerType).toHaveBeenCalledWith(
			"prd_000000000000000000000000test",
			"key_test",
			{ environment: "test", version: "1.0.0" },
			"react",
			undefined,
		);
	});
});

describe("MilanaProvider with shouldDeferInitialization", () => {
	test("renders children when deferred", () => {
		const { getByText } = render(
			<MilanaProvider
				shouldDeferInitialization
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<div>Hello</div>
			</MilanaProvider>,
		);
		expect(getByText("Hello")).toBeDefined();
	});

	test("does not call init when deferred", async () => {
		const { _initWithCallerType } = await import("../../src/core/index");
		(_initWithCallerType as ReturnType<typeof vi.fn>).mockClear();

		render(
			<MilanaProvider
				shouldDeferInitialization
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<div />
			</MilanaProvider>,
		);
		expect(_initWithCallerType).not.toHaveBeenCalled();
	});

	test("initialize() triggers init when called", async () => {
		const { _initWithCallerType } = await import("../../src/core/index");
		(_initWithCallerType as ReturnType<typeof vi.fn>).mockClear();

		let initializeFn: () => Promise<{ success: boolean }>;
		function CaptureInitialize() {
			const milana = useMilana();
			initializeFn = milana.initialize;
			return null;
		}

		render(
			<MilanaProvider
				shouldDeferInitialization
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<CaptureInitialize />
			</MilanaProvider>,
		);

		expect(_initWithCallerType).not.toHaveBeenCalled();

		await act(async () => {
			const result = await initializeFn!();
			expect(result).toEqual({ success: true });
		});

		expect(_initWithCallerType).toHaveBeenCalledWith(
			"prd_000000000000000000000000test",
			"key_test",
			{ environment: "test", version: "1.0.0" },
			"react",
			undefined,
		);
	});

	test("initialize() is idempotent", async () => {
		const { _initWithCallerType } = await import("../../src/core/index");
		(_initWithCallerType as ReturnType<typeof vi.fn>).mockClear();

		let initializeFn: () => Promise<{ success: boolean }>;
		function CaptureInitialize() {
			const milana = useMilana();
			initializeFn = milana.initialize;
			return null;
		}

		render(
			<MilanaProvider
				shouldDeferInitialization
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<CaptureInitialize />
			</MilanaProvider>,
		);

		await act(async () => {
			await initializeFn!();
		});

		const secondResult = await initializeFn!();
		expect(secondResult).toEqual({ success: false });
		expect(_initWithCallerType).toHaveBeenCalledTimes(1);
	});
});

describe("MilanaProvider stopRecording", () => {
	test("resets isInitialized to false after stopRecording", async () => {
		let milanaApi: {
			isInitialized: boolean;
			stopRecording: () => Promise<{ success: boolean }>;
		};
		function Capture() {
			milanaApi = useMilana();
			return <span data-testid="init">{String(milanaApi.isInitialized)}</span>;
		}

		const { getByTestId } = render(
			<MilanaProvider
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<Capture />
			</MilanaProvider>,
		);

		// Wait for auto-init to flip isInitialized to true.
		await act(async () => {});
		expect(getByTestId("init").textContent).toBe("true");

		await act(async () => {
			await milanaApi!.stopRecording();
		});

		expect(getByTestId("init").textContent).toBe("false");
	});

	test("unblocks a subsequent initialize() call", async () => {
		const { _initWithCallerType } = await import("../../src/core/index");

		let milanaApi: {
			initialize: () => Promise<{ success: boolean }>;
			stopRecording: () => Promise<{ success: boolean }>;
		};
		function Capture() {
			milanaApi = useMilana();
			return null;
		}

		render(
			<MilanaProvider
				shouldDeferInitialization
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<Capture />
			</MilanaProvider>,
		);

		(_initWithCallerType as ReturnType<typeof vi.fn>).mockClear();

		await act(async () => {
			const first = await milanaApi!.initialize();
			expect(first).toEqual({ success: true });
		});

		await act(async () => {
			await milanaApi!.stopRecording();
		});

		// Second initialize() should now run (not short-circuit), mirroring
		// the core SDK's stop → re-init support.
		await act(async () => {
			const second = await milanaApi!.initialize();
			expect(second).toEqual({ success: true });
		});

		expect(_initWithCallerType).toHaveBeenCalledTimes(2);
	});
});

describe("useMilana", () => {
	test("throws when used outside provider", () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		expect(() => render(<TestConsumer />)).toThrow(
			"useMilana must be used within a MilanaProvider",
		);
		consoleError.mockRestore();
	});

	test("provides context values", async () => {
		const { getByTestId } = render(
			<MilanaProvider
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<TestConsumer />
			</MilanaProvider>,
		);

		const trackButton = getByTestId("track");
		await act(() => {
			trackButton.click();
		});

		const { trackEvent } = await import("../../src/core/index");
		expect(trackEvent).toHaveBeenCalledWith("test_event");
	});
});

describe("useMilanaOptional", () => {
	test("returns null outside any provider", () => {
		const { getByTestId } = render(<TestOptionalConsumer />);
		expect(getByTestId("has-context").textContent).toBe("false");
	});

	test("returns context inside provider", () => {
		const { getByTestId } = render(
			<MilanaProvider
				productId="prd_000000000000000000000000test"
				clientKey="key_test"
				sessionInfo={{ environment: "test", version: "1.0.0" }}>
				<TestOptionalConsumer />
			</MilanaProvider>,
		);
		expect(getByTestId("has-context").textContent).toBe("true");
	});
});
