import { beforeEach, vi } from "vitest";

const hasWindow = typeof window !== "undefined";

// Mock fetch globally
global.fetch = vi.fn();

// Suppress unhandled rejection warnings in tests
// These occur when we test promise rejections that happen asynchronously
if (typeof process !== "undefined") {
	const originalEmit = process.emit.bind(process) as (
		event: string,
		...args: unknown[]
	) => boolean;
	process.emit = function (event: string, ...args: unknown[]) {
		if (
			event === "warning" &&
			(args[0] as { name?: string } | undefined)?.name ===
				"PromiseRejectionHandledWarning"
		) {
			// Suppress these warnings during tests
			return false;
		}
		return originalEmit(event, ...args);
	} as typeof process.emit;
}

// Mock sessionStorage
const storage = new Map<string, string>();

const setItemMock = vi.fn((key: string, value: string) => {
	storage.set(key, value);
});

const getItemMock = vi.fn((key: string) => storage.get(key) ?? null);

const removeItemMock = vi.fn((key: string) => {
	storage.delete(key);
});

const clearMock = vi.fn(() => {
	storage.clear();
});

const keyMock = vi.fn((index: number) => {
	const keys = Array.from(storage.keys());
	return keys[index] ?? null;
});

const mockStorage = {
	storage,
	get length() {
		return storage.size;
	},
	getItem: getItemMock,
	setItem: setItemMock,
	removeItem: removeItemMock,
	clear: clearMock,
	key: keyMock,
};

if (hasWindow) {
	Object.defineProperty(window, "sessionStorage", {
		value: mockStorage,
		writable: false, // Prevent accidental overwrites
		configurable: true, // Allow vitest to clean up
	});
}

export { clearMock, getItemMock, keyMock, removeItemMock, setItemMock };

// Mock localStorage
const localStorageMap = new Map<string, string>();

const localStorageMock = {
	get length() {
		return localStorageMap.size;
	},
	getItem: vi.fn((key: string) => localStorageMap.get(key) ?? null),
	setItem: vi.fn((key: string, value: string) => {
		localStorageMap.set(key, value);
	}),
	removeItem: vi.fn((key: string) => {
		localStorageMap.delete(key);
	}),
	clear: vi.fn(() => {
		localStorageMap.clear();
	}),
	key: vi.fn((index: number) => {
		const keys = Array.from(localStorageMap.keys());
		return keys[index] ?? null;
	}),
};

if (hasWindow) {
	Object.defineProperty(window, "localStorage", {
		value: localStorageMock,
		writable: false,
		configurable: true,
	});
}

export { localStorageMock };

// Mock console methods - preserve originals for debugging
const originalConsole = { ...console };
global.console = {
	...originalConsole,
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	log: vi.fn(),
};

// Reset all mocks before each test
beforeEach(() => {
	vi.clearAllMocks();
	vi.clearAllTimers();
	storage.clear();
	localStorageMap.clear();

	if (hasWindow) {
		// Reset window properties
		(window as unknown as Record<string, unknown>).Milana = undefined;
		(window as unknown as Record<string, unknown>)._milanaQueue = undefined;
	}

	// Reset modules - this ensures clean slate for each test
	vi.resetModules();
});
