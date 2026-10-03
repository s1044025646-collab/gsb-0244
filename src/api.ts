import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Service, ApiError } from "./service.ts";

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError("INVALID_PARAM", "request body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

export function createApiServer(service: Service) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (method === "GET" && url.pathname === "/filters") return send(res, 200, { filters: service.list() });
      if (method === "POST" && url.pathname === "/filters") return send(res, 201, service.createFilter(await readBody(req)));
      if (method === "POST" && url.pathname === "/filters/import") return send(res, 201, service.importSnapshot(await readBody(req)));
      if (method === "POST" && url.pathname === "/filters/merge") return send(res, 200, service.merge(await readBody(req)));

      if (parts[0] === "filters" && parts.length >= 2) {
        const name = decodeURIComponent(parts[1]);
        const sub = parts[2];
        if (method === "GET" && !sub) return send(res, 200, service.stats(name));
        if (method === "POST" && sub === "insert") return send(res, 200, service.insert(name, (await readBody(req)).keys));
        if (method === "POST" && sub === "query") return send(res, 200, service.query(name, (await readBody(req)).keys));
        if (method === "GET" && sub === "export") return send(res, 200, service.exportSnapshot(name));
        if (method === "POST" && sub === "evaluate") return send(res, 200, service.evaluate(name, await readBody(req)));
      }
      throw new ApiError("NOT_FOUND", `no route for ${method} ${url.pathname}`, 404);
    } catch (e: any) {
      if (e instanceof ApiError) return send(res, e.status, { error: { code: e.code, message: e.message } });
      send(res, 500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
    }
  });
}

/** 默认端口 0 = 让系统分配空闲端口；也可用 --port 指定。 */
export async function startApi(service: Service, port = 0): Promise<{ port: number; close: () => void }> {
  const server = createApiServer(service);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return { port: actual, close: () => server.close() };
}
