// Demo: build a tiny filter with a reproducible false positive, then compare with a larger one.
import { Store } from "./store";
import * as fs from "node:fs";

const dir = "data/demo";
fs.rmSync(dir, { recursive: true, force: true });
const store = new Store(`${dir}/bloom.db`);

const positives = ["alpha", "beta", "gamma", "delta", "epsilon"];
// Deterministically find a non-inserted key that collides on the tiny filter.
store.create("tiny", 32, 3, 1);
store.insertBatch("tiny", positives);
const candidates = Array.from({ length: 200 }, (_, i) => `probe-${i}`);
const negatives: string[] = [];
for (const c of candidates) {
  if (store.query("tiny", [c])[0].result === "possibly_present") negatives.push(c);
  if (negatives.length >= 5) break;
}
const trueNegatives = candidates.filter((c) => !negatives.includes(c)).slice(0, 20);
const evalNegatives = [...negatives, ...trueNegatives];

console.log("== tiny filter (m=32, k=3) ==");
console.log("false-positive keys found:", negatives);
console.log(JSON.stringify(store.evaluate("tiny", positives, evalNegatives), null, 2));

store.create("roomy", 1024, 3, 1);
store.insertBatch("roomy", positives);
console.log("== roomy filter (m=1024, k=3), same queries ==");
console.log(JSON.stringify(store.evaluate("roomy", positives, evalNegatives), null, 2));

console.log("== stats ==");
console.log(store.stats("tiny"));
console.log(store.stats("roomy"));
store.close();
