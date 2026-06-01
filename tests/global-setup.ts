import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Runs once before any test worker starts. Clears stale ESM build output, then
// builds the package so tests that read from dist/esm (package-consume,
// package-types) don't race each other under vitest's default fileParallelism.
export default function setup(): void {
	const projectRoot = resolve(import.meta.dirname, "..");
	rmSync(resolve(projectRoot, "dist/esm"), { recursive: true, force: true });
	execSync("pnpm build", { cwd: projectRoot, stdio: "pipe" });
}
