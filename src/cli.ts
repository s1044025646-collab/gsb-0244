import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./store.ts";
import { Service, ApiError } from "./service.ts";
import { startApi } from "./api.ts";
import { runDemo } from "./demo.ts";

const DATA_DIR = process.env.BLOOM_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = process.env.BLOOM_DB ?? join(DATA_DIR, "bloom.db");

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseKeys(args: string[]): string[] {
  const file = argValue(args, "--file");
  if (file) {
    return readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const rest = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--file" && args[i - 1] !== "--port");
  return rest.slice(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const service = new Service(new Store(DB_PATH));
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "serve": {
      const port = Number(argValue(args, "--port") ?? 0);
      const { port: actual } = await startApi(service, port);
      console.log(`Bloom API listening on http://127.0.0.1:${actual} (db: ${DB_PATH})`);
      return;
    }
    case "create":
      out(service.createFilter({ name: args[0], bitSize: Number(argValue(args, "--bits")), hashCount: Number(argValue(args, "--hashes")), seed: argValue(args, "--seed") !== undefined ? Number(argValue(args, "--seed")) : undefined }));
      break;
    case "insert":
      out(service.insert(args[0], parseKeys(args)));
      break;
    case "query":
      out(service.query(args[0], parseKeys(args)));
      break;
    case "stats":
      out(service.stats(args[0]));
      break;
    case "list":
      out(service.list());
      break;
    case "export": {
      const snap = service.exportSnapshot(args[0]);
      const file = argValue(args, "--out");
      if (file) { writeFileSync(file, JSON.stringify(snap, null, 2)); console.log(`snapshot written to ${file}`); }
      else out(snap);
      break;
    }
    case "import": {
      const snap = JSON.parse(readFileSync(args[0], "utf8"));
      out(service.importSnapshot({ name: argValue(args, "--name"), snapshot: snap }));
      break;
    }
    case "merge":
      out(service.merge({ target: args[0], sources: args.slice(1) }));
      break;
    case "evaluate": {
      const posFile = argValue(args, "--positives");
      const negFile = argValue(args, "--negatives");
      const read = (f?: string) => f ? readFileSync(f, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
      out(service.evaluate(args[0], { positives: read(posFile), negatives: read(negFile) }));
      break;
    }
    case "demo":
      await runDemo(service);
      break;
    default:
      console.log(`Usage: node dist/cli.js <command>
  serve [--port N]            启动 HTTP API（默认自动选空闲端口）
  create <name> --bits N --hashes K [--seed S]
  insert <name> key... | --file keys.txt
  query <name> key... | --file keys.txt
  stats <name> | list
  export <name> [--out file]  | import <file> [--name newName]
  merge <target> <src1> [src2...]
  evaluate <name> --positives p.txt --negatives n.txt
  demo                        可复现误判演示`);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(`error ${e.code}: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
