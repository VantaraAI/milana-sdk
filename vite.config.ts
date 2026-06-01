import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import packageJson from "./package.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const thirdPartyNotices = readFileSync(
	resolve(__dirname, "THIRD_PARTY_NOTICES.md"),
	"utf8",
);
const thirdPartyNoticeBanner = [
	"/*!",
	...thirdPartyNotices
		.trimEnd()
		.replaceAll("*/", "* /")
		.split("\n")
		.map((line) => ` * ${line}`),
	" */",
	"",
].join("\n");

const productionDefines = {
	"process.env.NODE_ENV": JSON.stringify("production"),
	// Bundled PostCSS warning code probes this Node env var. Replace it so
	// browser artifacts do not ship a `process.env` reference.
	"process.env.LANG": JSON.stringify(""),
};

export default defineConfig(({ command, mode }) => ({
	define: {
		clientSemVer: JSON.stringify(packageJson.version),
		clientGitSha: JSON.stringify(process.env.VITE_APP_VERSION ?? "unknown"),
		...(command === "build" ? productionDefines : {}),
	},
	esbuild: command === "build" ? { jsxDev: false } : {},
	plugins: [
		{
			name: "milana-third-party-notices",
			generateBundle(_, bundle) {
				if (mode === "cdn") {
					for (const file of Object.values(bundle)) {
						if (file.type === "chunk") {
							file.code = thirdPartyNoticeBanner + file.code;
						}
					}
					return;
				}
				this.emitFile({
					type: "asset",
					fileName: "THIRD_PARTY_NOTICES.md",
					source: thirdPartyNotices,
				});
			},
		},
	],
	build:
		mode === "cdn"
			? {
					outDir: resolve(__dirname, "dist/cdn"),
					lib: {
						entry: resolve(__dirname, "src/core/cdn-entry.ts"),
						name: "MilanaSdk",
						fileName: "milana",
					},
				}
			: {
					outDir: resolve(__dirname, "dist/esm"),
					lib: {
						entry: {
							"core/index": resolve(__dirname, "src/core/index.ts"),
							"react/index": resolve(__dirname, "src/react/index.tsx"),
							"testing/index": resolve(__dirname, "src/testing/index.tsx"),
						},
						formats: ["es"],
					},
					rollupOptions: {
						external: ["react", "react-dom", "react/jsx-runtime"],
					},
				},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		globalSetup: ["./tests/global-setup.ts"],
	},
}));
