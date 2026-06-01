import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useMilana } from "../../src/react/index";
import { createMockMilana, MockMilanaProvider } from "../../src/testing/index";

function TestConsumer() {
	const milana = useMilana();
	return (
		<div>
			<button
				data-testid="track"
				onClick={() => milana.trackEvent("purchase", { amount: 99 })}>
				Track
			</button>
			<button
				data-testid="update"
				onClick={() => void milana.update({ user: { userId: "u1" } })}>
				Update
			</button>
		</div>
	);
}

describe("createMockMilana", () => {
	test("records calls", () => {
		const mock = createMockMilana();
		expect(mock.calls).toEqual([]);
	});

	test("getEventCalls filters by event name", () => {
		const mock = createMockMilana();
		mock.calls.push(
			{ method: "trackEvent", args: { eventName: "a" } },
			{ method: "trackEvent", args: { eventName: "b" } },
			{ method: "update", args: { user: { userId: "u1" } } },
		);
		expect(mock.getEventCalls("a")).toHaveLength(1);
		expect(mock.getEventCalls()).toHaveLength(2);
	});

	test("getUpdateCalls returns only updates", () => {
		const mock = createMockMilana();
		mock.calls.push(
			{ method: "trackEvent", args: { eventName: "a" } },
			{ method: "update", args: { user: { userId: "u1" } } },
		);
		expect(mock.getUpdateCalls()).toHaveLength(1);
	});

	test("reset clears calls", () => {
		const mock = createMockMilana();
		mock.calls.push({ method: "trackEvent", args: { eventName: "a" } });
		mock.reset();
		expect(mock.calls).toEqual([]);
	});
});

describe("MockMilanaProvider", () => {
	test("provides mock context", async () => {
		const mock = createMockMilana();
		const { getByTestId } = render(
			<MockMilanaProvider mock={mock}>
				<TestConsumer />
			</MockMilanaProvider>,
		);

		await act(() => {
			getByTestId("track").click();
		});

		expect(mock.getEventCalls("purchase")).toHaveLength(1);
		expect(mock.getEventCalls("purchase")[0]).toEqual({
			method: "trackEvent",
			args: { eventName: "purchase", attributes: { amount: 99 } },
		});
	});

	test("records update calls", async () => {
		const mock = createMockMilana();
		const { getByTestId } = render(
			<MockMilanaProvider mock={mock}>
				<TestConsumer />
			</MockMilanaProvider>,
		);

		await act(() => {
			getByTestId("update").click();
		});

		expect(mock.getUpdateCalls()).toHaveLength(1);
	});
});
