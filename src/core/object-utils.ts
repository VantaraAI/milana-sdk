/**
 * True for a non-null, non-array object — enough to validate `JSON.parse`
 * output before reading fields off it.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural deep equality for JSON-shaped values (primitives, plain objects,
 * arrays). Sufficient for comparing identity payloads, which are always
 * round-tripped through the persisted blob — no Dates, Maps, Sets, etc.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	) {
		return false;
	}

	const aIsArray = Array.isArray(a);
	if (aIsArray !== Array.isArray(b)) return false;
	if (aIsArray) {
		const arrA = a as unknown[];
		const arrB = b as unknown[];
		if (arrA.length !== arrB.length) return false;
		return arrA.every((item, i) => deepEqual(item, arrB[i]));
	}

	const objA = a as Record<string, unknown>;
	const objB = b as Record<string, unknown>;
	const keysA = Object.keys(objA);
	const keysB = Object.keys(objB);
	if (keysA.length !== keysB.length) return false;
	const bKeys = new Set(keysB);
	return keysA.every(
		(key) => bKeys.has(key) && deepEqual(objA[key], objB[key]),
	);
}
