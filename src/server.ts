import { pathToFileURL } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PayPalClient, handlePayPalWebhook, loadPayPalConfigFromEnv, type PayPalConfig } from "./paypal/index.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface AppDeps {
  paypal: PayPalClient;
  config: PayPalConfig;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Minimal HTTP app on node:http. Routes are placeholders until the project is chosen. */
export function createApp(deps: AppDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, paypalEnv: deps.config.env });
      }
      if (req.method === "POST" && url.pathname === "/webhooks/paypal") {
        const rawBody = await readBody(req);
        const result = await handlePayPalWebhook(
          { headers: req.headers, rawBody },
          { webhookId: deps.config.webhookId, verify: (r) => deps.paypal.verifyWebhookSignature(r) },
        );
        return sendJson(res, result.status, result.body);
      }
      // TODO: order routes (create / capture) and AI routes go here.
      return sendJson(res, 404, { ok: false, error: "not found" });
    } catch {
      return sendJson(res, 500, { ok: false, error: "internal error" });
    }
  });
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadPayPalConfigFromEnv();
  const app = createApp({ config, paypal: new PayPalClient({ config }) });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Listening on http://localhost:${port} (PayPal ${config.env})`);
  });
}
