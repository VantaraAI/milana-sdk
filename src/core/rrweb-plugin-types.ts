export type RrwebMirror<TNode> = {
	getId(n: TNode | undefined | null): number;
};

export type RrwebPlugin<TOptions = unknown> = {
	name: string;
	getMirror?: (mirrors: { nodeMirror: RrwebMirror<Node> }) => void;
	observer?: (
		cb: (...args: Array<unknown>) => void,
		win: Window & typeof globalThis,
		options: TOptions,
	) => () => void;
	options: TOptions;
};
