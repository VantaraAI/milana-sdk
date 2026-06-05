// @vitest-environment node

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import packageJson from "../package.json";

const projectRoot = resolve(import.meta.dirname, "..");
const execMaxBuffer = 10 * 1024 * 1024;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function expectNoDevLeaks(contents: string, label: string): void {
	expect(contents, `${label} contains React dev JSX`).not.toMatch(
		/jsxDEV|jsx-dev-runtime/,
	);
	expect(contents, `${label} contains an absolute user path`).not.toMatch(
		/\/Users\/|\\Users\\|conductor\/workspaces/,
	);
	expect(contents, `${label} contains process.env`).not.toContain(
		"process.env",
	);
}

describe("packed package consumption", () => {
	let consumerDir: string;
	let packDir: string;
	let tarball: string;

	beforeAll(() => {
		packDir = mkdtempSync(join(tmpdir(), "milana-pack-"));
		const packOut = execSync(
			`npm pack --pack-destination "${packDir}" --silent`,
			{ cwd: projectRoot, encoding: "utf8" },
		);
		const tarballName = packOut.trim().split("\n").filter(Boolean).pop();
		if (!tarballName) {
			throw new Error("npm pack produced no tarball path on stdout");
		}
		tarball = join(packDir, tarballName);

		consumerDir = mkdtempSync(join(tmpdir(), "milana-consume-"));
		writeFileSync(
			join(consumerDir, "package.json"),
			JSON.stringify({
				name: "consumer",
				private: true,
				version: "0.0.0",
				type: "module",
				dependencies: { "milana-js": `file:${tarball}` },
			}),
		);
		execSync("npm install --no-audit --no-fund --silent", {
			cwd: consumerDir,
			stdio: "pipe",
		});
	}, 120_000);

	afterAll(() => {
		if (consumerDir) rmSync(consumerDir, { recursive: true, force: true });
		if (packDir) rmSync(packDir, { recursive: true, force: true });
	});

	test("ESM consumer can import named exports", () => {
		writeFileSync(
			join(consumerDir, "check.mjs"),
			`import { init, identify, trackEvent } from "milana-js";
for (const [name, fn] of Object.entries({ init, identify, trackEvent })) {
	if (typeof fn !== "function") throw new Error(name + " is not a function");
}
console.log("ok");
`,
		);
		const out = execSync("node check.mjs", {
			cwd: consumerDir,
			encoding: "utf8",
		});
		expect(out.trim()).toBe("ok");
	}, 10_000);

	test("CJS consumer can resolve the package path", () => {
		writeFileSync(
			join(consumerDir, "check.cjs"),
			`const path = require("node:path");
const p = require.resolve("milana-js");
const expected = path.sep + path.join("dist", "esm", "core", "index.js");
if (!p.endsWith(expected)) {
	throw new Error("unexpected resolution: " + p);
}
console.log("ok");
`,
		);
		const out = execSync("node check.cjs", {
			cwd: consumerDir,
			encoding: "utf8",
		});
		expect(out.trim()).toBe("ok");
	}, 10_000);

	test("tarball includes notices and no dev-build leaks", () => {
		const files = execSync(`tar -tf ${shellQuote(tarball)}`, {
			encoding: "utf8",
			maxBuffer: execMaxBuffer,
		})
			.trim()
			.split("\n");

		expect(files).toContain("package/LICENSE");
		expect(files).toContain("package/THIRD_PARTY_NOTICES.md");
		expect(files).toContain("package/dist/esm/THIRD_PARTY_NOTICES.md");
		expect(files.some((file) => file.startsWith("package/dist/cdn/"))).toBe(
			false,
		);
		expect(files).not.toContain("package/dist/esm/tsconfig.tsbuildinfo");
		expect(files.some((file) => file.endsWith(".d.ts.map"))).toBe(false);

		const notices = execSync(
			`tar -xOf ${shellQuote(tarball)} ${shellQuote("package/THIRD_PARTY_NOTICES.md")}`,
			{ encoding: "utf8" },
		);
		expect(notices).toContain("@rrweb/record 2.0.0-alpha.20");
		expect(notices).toContain("es-toolkit 1.44.0");
		expect(notices).toContain("source-map-js 1.2.1");
		expect(notices).toContain("BSD-3-Clause");

		const jsFiles = files.filter(
			(file) =>
				file.startsWith("package/dist/") && /\.(?:cjs|js|mjs)$/.test(file),
		);
		expect(jsFiles.length).toBeGreaterThan(0);

		for (const file of jsFiles) {
			const contents = execSync(
				`tar -xOf ${shellQuote(tarball)} ${shellQuote(file)}`,
				{
					encoding: "utf8",
					maxBuffer: execMaxBuffer,
				},
			);
			expectNoDevLeaks(contents, file);
		}
	}, 10_000);

	test("published runtime dependency surface stays narrow", () => {
		expect(packageJson.dependencies).toEqual({
			// Pinned exactly: alpha.20 carries rrweb's splitCssText/CSS fix that
			// alpha.18 lacks, and we ship no patch, so we must not float.
			"@rrweb/record": "2.0.0-alpha.20",
		});
		expect(packageJson.devDependencies).toHaveProperty("@rrweb/types");
	});

	test("CDN bundle embeds notices and no dev-build leaks", () => {
		execSync("pnpm build:cdn", {
			cwd: projectRoot,
			stdio: "pipe",
		});

		const bundlePath = join(projectRoot, "dist/cdn/milana.js");
		const bundle = readFileSync(bundlePath, "utf8");

		expect(bundle).toContain("# Third-Party Notices");
		expect(bundle).toContain("@rrweb/record 2.0.0-alpha.20");
		expect(bundle).toContain("es-toolkit 1.44.0");
		expect(bundle).toContain("source-map-js 1.2.1");
		expectNoDevLeaks(bundle, "CDN bundle");
		expect(
			existsSync(join(projectRoot, "dist/cdn/THIRD_PARTY_NOTICES.md")),
		).toBe(false);
	}, 30_000);
});
