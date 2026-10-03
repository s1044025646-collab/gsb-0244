// CLI: create | insert | query | stats | list | export | import | merge | evaluate
import { Store } from "./store";
import * as fs from "node:fs";

const [, , cmd, ...args] = process.argv;
const store = new Store(`${process.env.DATA_DIR ?? "data"}/bloom.db`);

function opt(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
function posArgs(): string[] { return args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--file" && !["--m","--k","--seed","--into","--name","--file"].includes(args[i - 1] ?? "")); }
function readKeys(): string[] {
  const f = opt("file");
  if (f) return fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
  return posArgs().slice(1);
}

try {
  switch (cmd) {
    case "create":
      console.log(store.create(args[0], Number(opt("m")), Number(opt("k")), Number(opt("seed", "1"))).params);
      break;
    case "insert":
      console.log(store.insertBatch(args[0], readKeys()));
      break;
    case "query":
      for (const r of store.query(args[0], readKeys()))
        console.log(`${r.key}\t${r.result}\tpositions=${r.positions.join(",")}\tbits=${r.bits.join("")}`);
      break;
    case "stats": console.log(store.stats(args[0])); break;
    case "list": console.log(store.list()); break;
    case "export":
      fs.writeFileSync(opt("file", `${args[0]}.snapshot.json`)!, JSON.stringify(store.exportFilter(args[0]), null, 2));
      console.log("exported");
      break;
    case "import":
      store.importFilter(args[0], JSON.parse(fs.readFileSync(opt("file")!, "utf8")));
      console.log("imported");
      break;
    case "merge":
      store.merge(args[0], args[1], opt("into", `${args[0]}+${args[1]}`)!);
      console.log("merged");
      break;
    case "evaluate": {
      const neg = (opt("file") ? readKeys() : []);
      console.log(JSON.stringify(store.evaluate(args[0], posArgs().slice(1), neg), null, 2));
      break;
    }
    default:
      console.log("usage: cli <create|insert|query|stats|list|export|import|merge|evaluate> ...");
  }
} catch (e: any) {
  console.error(`error ${e.code ?? "INTERNAL"}: ${e.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
