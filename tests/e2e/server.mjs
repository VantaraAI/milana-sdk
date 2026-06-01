#!/usr/bin/env node

// Generic two-origin SDK loopback for browser-level investigation. Stubs
// /session, /batch, /update, /metrics so the SDK can run end-to-end
// without a real backend, and serves the built CDN bundle from
// dist/cdn/. Every request body is captured to .captures/ and a one-line
// JSON summary is written to stdout (seq, path, eventCount, isPageClose,
// bodyLen), so it's easy to grep for specific traffic patterns.
//
// Useful for reproducing bug reports, diffing payloads across SDK
// versions, inspecting compression / cookies / CORS, and exercising
// cross-origin scenarios (the two ports give you two real origins).
// `POST /__userlog` is an ad-hoc beacon endpoint test pages can use to
// signal browser-side events like `visibilitychange` / `pagehide`.
//
// Build first: pnpm build:cdn
// Usage: PORT_A=4321 PORT_B=4322 node tests/e2e/server.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CAPTURE_DIR = join(__dirname, ".captures");
await mkdir(CAPTURE_DIR, { recursive: true });
let captureCounter = 0;

const PORT_A = Number(process.env.PORT_A ?? 4321);
const PORT_B = Number(process.env.PORT_B ?? 4322);

const PAGE_A_HTML = `<!doctype html>
<html><head><title>Page A</title></head><body>
<h1>Page A</h1>
<a id="cross" href="http://127.0.0.1:${PORT_B}/page-b.html">Go to Page B (different origin)</a>
<button id="emit">Emit a custom event</button>
<button id="hide">Force visibilitychange hidden</button>
<script type="module" src="/milana.js"></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    window.Milana(
      "init",
      "prd_00000000000000000000000000",
      "key_THIS_IS_A_FAKE_TEST_KEY_NOT_A_REAL_CREDENTIAL",
      { environment: "test", version: "e2e", metadata: {} },
      { endpoint: location.origin }
    );
    console.log("[e2e] milana init queued");
    document.getElementById("emit").addEventListener("click", () => {
      window.Milana("trackEvent", "manual_click", { at: Date.now() });
    });
    document.getElementById("hide").addEventListener("click", () => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  });
</script>
</body></html>`;

const PAGE_B_HTML = `<!doctype html>
<html><head><title>Page B</title></head><body>
<h1>Page B (cross-origin)</h1>
<a href="http://localhost:${PORT_A}/">Back to Page A</a>
</body></html>`;

function makeHandler(label) {
	return async (req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Headers", "*");
		res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");

		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}

		if (
			req.url === "/batch" ||
			req.url === "/session" ||
			req.url === "/update" ||
			req.url === "/metrics" ||
			req.url === "/__userlog"
		) {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = Buffer.concat(chunks).toString("utf8");
			const seq = ++captureCounter;
			let isPageClose = false;
			let eventCount = 0;
			let batchStartedAt = null;
			try {
				const parsed = JSON.parse(body);
				isPageClose = parsed.isPageClose === true;
				eventCount = Array.isArray(parsed.events) ? parsed.events.length : 0;
				batchStartedAt = parsed.batchStartedAt ?? null;
			} catch {}
			const captureFile = join(
				CAPTURE_DIR,
				`req-${String(seq).padStart(4, "0")}-${label}-${req.url.slice(1)}.json`,
			);
			await writeFile(captureFile, body);
			const entry = {
				seq,
				ts: Date.now(),
				label,
				path: req.url,
				bodyLen: body.length,
				eventCount,
				isPageClose,
				batchStartedAt,
				capture: captureFile,
			};
			console.log(JSON.stringify(entry));

			if (req.url === "/session") {
				res.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						sampled: true,
						sessionId: `e2e-${label}-${Date.now()}`,
					}),
				);
				return;
			}
			if (req.url === "/batch") {
				res.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						success: true,
						sessionId: "e2e-session",
						messageId: `m-${Date.now()}`,
					}),
				);
				return;
			}
			if (req.url === "/__userlog") {
				res.writeHead(204).end();
				return;
			}
			res
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ success: true }));
			return;
		}

		if (req.url === "/" || req.url === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE_A_HTML);
			return;
		}
		if (req.url === "/page-b.html") {
			res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE_B_HTML);
			return;
		}
		if (req.url === "/milana.js") {
			try {
				const file = await readFile(join(ROOT, "dist/cdn", req.url.slice(1)));
				res
					.writeHead(200, { "Content-Type": "application/javascript" })
					.end(file);
			} catch {
				res.writeHead(404).end("not built — run `pnpm build:cdn`");
			}
			return;
		}
		res.writeHead(404).end("not found");
	};
}

createServer(makeHandler("A")).listen(PORT_A, () =>
	console.log(`[e2e] page A on http://localhost:${PORT_A}/`),
);
createServer(makeHandler("B")).listen(PORT_B, () =>
	console.log(`[e2e] page B on http://127.0.0.1:${PORT_B}/page-b.html`),
);
