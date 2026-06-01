// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, test } from "vitest";
import packageJson from "../package.json";

const projectRoot = resolve(import.meta.dirname, "..");

// Extract the package name from a module specifier. Returns null for
// relative imports, absolute paths, and Node built-ins.
//   "react"                    -> "react"
//   "react/jsx-runtime"        -> "react"
//   "@rrweb/types"             -> "@rrweb/types"
//   "@rrweb/types/foo/bar"     -> "@rrweb/types"
//   "./foo", "../bar", "node:fs" -> null
function packageNameFromSpecifier(spec: string): string | null {
	if (spec.startsWith(".") || spec.startsWith("/")) return null;
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
	}
	return spec.split("/")[0];
}

// DefinitelyTyped naming convention:
//   foo         -> @types/foo
//   @scope/name -> @types/scope__name
function typesTwinName(pkg: string): string {
	if (pkg.startsWith("@")) {
		const [scope, name] = pkg.slice(1).split("/");
		return `@types/${scope}__${name}`;
	}
	return `@types/${pkg}`;
}

// A package "ships its own types" if any of these are true:
//   - package.json has a top-level "types" or "typings" field
//   - package.json "exports" has a "types" condition anywhere
//   - there's a root-level index.d.ts
function packageShipsOwnTypes(pkgRoot: string): boolean {
	const pkgJsonPath = join(pkgRoot, "package.json");
	if (!existsSync(pkgJsonPath)) return false;
	const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
		types?: string;
		typings?: string;
		exports?: unknown;
	};
	if (pkg.types || pkg.typings) return true;
	if (pkg.exports && JSON.stringify(pkg.exports).includes('"types"'))
		return true;
	if (existsSync(join(pkgRoot, "index.d.ts"))) return true;
	return false;
}

function findDtsFiles(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) findDtsFiles(full, out);
		else if (entry.name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

describe("emitted .d.ts imports are declared and their types are reachable", () => {
	const deps = new Set(Object.keys(packageJson.dependencies ?? {}));
	const peers = new Set(Object.keys(packageJson.peerDependencies ?? {}));
	// package name -> set of .d.ts files (repo-relative) that reference it
	const imports = new Map<string, Set<string>>();

	beforeAll(() => {
		const distDir = join(projectRoot, "dist");
		const dtsFiles = findDtsFiles(distDir);
		expect(
			dtsFiles.length,
			`No .d.ts files found under ${distDir} — did 'pnpm build' fail?`,
		).toBeGreaterThan(0);

		for (const file of dtsFiles) {
			const src = readFileSync(file, "utf8");
			const info = ts.preProcessFile(src, true, true);
			const specs = [
				...info.importedFiles.map((f) => f.fileName),
				...info.typeReferenceDirectives.map((f) => f.fileName),
			];
			for (const spec of specs) {
				const pkg = packageNameFromSpecifier(spec);
				if (!pkg) continue;
				let set = imports.get(pkg);
				if (!set) {
					set = new Set();
					imports.set(pkg, set);
				}
				set.add(relative(projectRoot, file));
			}
		}
	});

	test("every bare specifier is in dependencies or peerDependencies", () => {
		const undeclared: string[] = [];
		for (const [pkg, files] of imports) {
			if (deps.has(pkg) || peers.has(pkg)) continue;
			const fileList = [...files].slice(0, 3).join(", ");
			undeclared.push(`  "${pkg}" — referenced in ${fileList}`);
		}
		expect(
			undeclared,
			`Emitted .d.ts files reference packages that are NOT in dependencies or peerDependencies:\n${undeclared.join("\n")}\n\nAdd each to the correct section of package.json (dependencies for runtime-controlled versions, peerDependencies for consumer-controlled versions).`,
		).toEqual([]);
	});

	test("every declared import ships types or has its @types/<name> twin declared", () => {
		const gaps: string[] = [];
		for (const [pkg, files] of imports) {
			const isPeer = peers.has(pkg);
			const isDep = deps.has(pkg);
			if (!isPeer && !isDep) continue; // prior test owns the undeclared case

			const pkgRoot = join(projectRoot, "node_modules", pkg);
			if (!existsSync(pkgRoot)) {
				gaps.push(
					`  "${pkg}" is declared but not installed at ${pkgRoot} — run 'pnpm install'.`,
				);
				continue;
			}
			if (packageShipsOwnTypes(pkgRoot)) continue;

			const twin = typesTwinName(pkg);
			const isTwinDeclared = isPeer ? peers.has(twin) : deps.has(twin);
			if (isTwinDeclared) continue;

			const fileList = [...files].slice(0, 3).join(", ");
			const section = isPeer
				? "peerDependencies (and mark optional in peerDependenciesMeta)"
				: "dependencies";
			gaps.push(
				`  "${pkg}" — referenced in emitted .d.ts (${fileList}), ships no own types, but "${twin}" is NOT in ${section}.\n    Fix: add "${twin}" to ${section} in package.json.`,
			);
		}
		expect(
			gaps,
			`Type-resolution gaps in emitted .d.ts — consumers using strict package layouts (e.g. pnpm's isolated node-linker) will fail to resolve types. This is the v1.0.8 → v1.0.9 regression class (see commit 2acfa55).\n\n${gaps.join("\n\n")}`,
		).toEqual([]);
	});
});
