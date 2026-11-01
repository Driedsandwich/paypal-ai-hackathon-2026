import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Okuri</title>
<body style="font-family:sans-serif;max-width:40rem;margin:3rem auto">
<h1>Okuri API is running</h1><p>The web UI has not been built. Run <code>npm run build</code> and restart,
or see <a href="/api/health">/api/health</a>.</p></body></html>`;

/**
 * Serves the built single-page UI from `root`. Unknown paths without a file
 * extension fall back to index.html (client-side views). Paths are resolved and
 * checked to stay inside `root` (no traversal).
 */
export function serveStatic(root: string | undefined, pathname: string, res: ServerResponse): void {
  const index = root ? path.join(root, "index.html") : undefined;
  if (!root || !index || !existsSync(index)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(NOT_BUILT);
    return;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("bad path");
    return;
  }
  const base = path.resolve(root);
  const target = path.resolve(base, `.${path.posix.normalize(`/${decoded}`)}`);
  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
    return;
  }
  let file = target;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (path.extname(decoded)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
      return;
    }
    file = index;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": file === index ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(file).pipe(res);
}

/** Page PayPal sends the buyer to after approving or cancelling a payment link. */
export function paypalReturnPage(kind: "return" | "cancel"): string {
  const msg =
    kind === "return"
      ? "Thank you! Your payment was approved in PayPal. The seller will confirm it and ship your item."
      : "The payment was cancelled. No money was taken. You can use the link again if you change your mind.";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Okuri</title>
<body style="font-family:sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem"><h1>${kind === "return" ? "Payment approved" : "Payment cancelled"}</h1><p>${msg}</p></body></html>`;
}
