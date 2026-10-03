// HTTP API (node:http, no external deps). JSON in/out, error codes in `error.code`.
import * as http from "node:http";
import { Store } from "./store";
import { BloomError } from "./core";

const DATA_DIR = process.env.DATA_DIR ?? "data";
const store = new Store(`${DATA_DIR}/bloom.db`);

function send(res: http.ServerResponse, status: number, body: object): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const b = req.method === "POST" ? await body(req) : {};

    if (req.method === "GET" && url.pathname === "/filters")
      return send(res, 200, { filters: store.list() });

    if (req.method === "POST" && url.pathname === "/filters")
      return send(res, 201, { created: b.name, ...store.create(b.name, b.m, b.k, b.seed ?? 1).params });

    if (req.method === "POST" && url.pathname === "/filters/import") {
      store.importFilter(b.name, b.snapshot);
      return send(res, 201, { imported: b.name });
    }

    if (req.method === "POST" && url.pathname === "/filters/merge") {
      store.merge(b.a, b.b, b.into);
      return send(res, 200, { merged: b.into });
    }

    if (parts[0] === "filters" && parts[1]) {
      const name = decodeURIComponent(parts[1]);
      if (req.method === "GET" && parts.length === 2) return send(res, 200, store.stats(name));
      if (req.method === "POST" && parts[2] === "insert") return send(res, 200, store.insertBatch(name, b.keys ?? []));
      if (req.method === "POST" && parts[2] === "query") return send(res, 200, { results: store.query(name, b.keys ?? []) });
      if (req.method === "GET" && parts[2] === "export") return send(res, 200, store.exportFilter(name));
      if (req.method === "POST" && parts[2] === "evaluate")
        return send(res, 200, store.evaluate(name, b.positives ?? [], b.negatives ?? []));
    }
    return send(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
  } catch (e) {
    if (e instanceof BloomError) return send(res, 400, { error: { code: e.code, message: e.message } });
    return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
});

// Default: port 0 => OS picks a free port. Override with PORT.
const port = Number(process.env.PORT ?? 0);
server.listen(port, () => {
  const addr = server.address() as any;
  console.log(`bloom-lab API listening on http://127.0.0.1:${addr.port} (data dir: ${DATA_DIR})`);
});
