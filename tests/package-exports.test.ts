import { exports as resolveExports } from "resolve.exports";
import { describe, expect, test } from "vitest";
import packageJson from "../package.json";

const subpaths = [".", "./react", "./testing"] as const;

const scenarios = [
	{
		name: "node ESM",
		options: { conditions: ["node", "import", "default"], unsafe: true },
	},
	{
		name: "node CJS (v1.0.6 failure mode without default)",
		options: { conditions: ["node", "require", "default"], unsafe: true },
	},
	{
		name: "browser bundler",
		options: {
			conditions: ["browser", "module", "import", "default"],
			unsafe: true,
		},
	},
];

describe("exports resolution", () => {
	for (const { name, options } of scenarios) {
		describe(name, () => {
			for (const sub of subpaths) {
				test(`resolves "${sub}" to a built ESM file`, () => {
					const result = resolveExports(packageJson, sub, options);
					expect(result).toBeDefined();
					expect(result?.[0]).toMatch(/^\.\/dist\/esm\/.+\.js$/);
				});
			}
		});
	}
});
