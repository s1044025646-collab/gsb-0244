import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { BloomFilter, positionsFor, exportSnapshot, importSnapshot, BloomError } from "../src/core";
import { Store } from "../src/store";

let seq = 0;
function freshStore(): Store {
  return new Store(`data/test/t${process.pid}-${seq++}/bloom.db`);
}

test("hash positions are deterministic and in range", () => {
  const p = { m: 128, k: 4, seed: 7 };
  const a = positionsFor("hello", p);
  assert.deepEqual(a, positionsFor("hello", p));
  assert.equal(a.length, 4);
  assert.ok(a.every((i) => i >= 0 && i < 128));
  assert.notDeepEqual(positionsFor("hello", p), positionsFor("Hello", p)); // case-sensitive
  assert.equal(positionsFor("", p).length, 4); // empty string is a valid key
});

test("repeat insert of same key is idempotent", () => {
  const f = new BloomFilter({ m: 64, k: 3, seed: 1 });
  f.insert("x");
  const before = Buffer.from(f.bits.bytes);
  f.insert("x");
  assert.deepEqual(f.bits.bytes, before);
});

test("inserted keys never produce false negatives", () => {
  const s = freshStore();
  s.create("f", 256, 3, 1);
  const keys = Array.from({ length: 30 }, (_, i) => `key-${i}`);
  s.insertBatch("f", keys);
  for (const r of s.query("f", keys)) assert.equal(r.result, "possibly_present");
  s.close();
});

test("non-inserted key may be a false positive but never reported as confirmed", () => {
  const s = freshStore();
  s.create("tiny", 16, 3, 1);
  s.insertBatch("tiny", ["a", "b", "c", "d"]);
  const results = s.query("tiny", Array.from({ length: 100 }, (_, i) => `zz-${i}`));
  assert.ok(results.every((r) => r.result === "possibly_present" || r.result === "definitely_absent"));
  assert.ok(results.some((r) => r.result === "possibly_present")); // reproducible FP on tiny filter
  s.close();
});

test("merged filter covers both sources (superset of bits)", () => {
  const s = freshStore();
  s.create("a", 128, 3, 1);
  s.create("b", 128, 3, 1);
  s.insertBatch("a", ["k1", "k2"]);
  s.insertBatch("b", ["k3"]);
  s.merge("a", "b", "ab");
  for (const r of s.query("ab", ["k1", "k2", "k3"])) assert.equal(r.result, "possibly_present");
  const stA = s.stats("a"), stB = s.stats("b"), stAB = s.stats("ab");
  assert.ok(stAB.setBits >= Math.max(stA.setBits, stB.setBits));
  s.close();
});

test("merge rejects incompatible params", () => {
  const s = freshStore();
  s.create("a", 128, 3, 1);
  s.create("b", 256, 3, 1);
  s.create("c", 128, 3, 2);
  assert.throws(() => s.merge("a", "b", "x"), (e: any) => e.code === "MERGE_INCOMPATIBLE");
  assert.throws(() => s.merge("a", "c", "x"), (e: any) => e.code === "MERGE_INCOMPATIBLE");
  s.close();
});

test("snapshot round-trip preserves bits and results", () => {
  const f = new BloomFilter({ m: 200, k: 5, seed: 9 });
  ["one", "two", "three"].forEach((k) => f.insert(k));
  const g = importSnapshot(exportSnapshot(f));
  assert.deepEqual(g.bits.bytes, f.bits.bytes);
  assert.equal(g.query("one").result, "possibly_present");
  assert.equal(g.query("absent-key").result, f.query("absent-key").result);
});

test("snapshot import validates version and params", () => {
  const f = new BloomFilter({ m: 64, k: 2, seed: 1 });
  const snap = exportSnapshot(f);
  assert.throws(() => importSnapshot({ ...snap, version: 99 }), (e: any) => e.code === "SNAPSHOT_VERSION_MISMATCH");
  assert.throws(() => importSnapshot({ ...snap, bitsHex: "aabb" }), (e: any) => e.code === "SNAPSHOT_PARAM_MISMATCH");
});

test("store import/export round-trip and persistence across reopen", () => {
  const db = `data/test/t${process.pid}-reopen/bloom.db`;
  let s = new Store(db);
  s.create("p", 128, 3, 1);
  s.insertBatch("p", ["persist-me"]);
  s.close();
  s = new Store(db); // reopen
  assert.equal(s.query("p", ["persist-me"])[0].result, "possibly_present");
  const snap = s.exportFilter("p");
  s.importFilter("p2", snap);
  assert.equal(s.query("p2", ["persist-me"])[0].result, "possibly_present");
  s.close();
});

test("evaluate uses negatives as denominator, no divide-by-zero", () => {
  const s = freshStore();
  s.create("e", 64, 3, 1);
  s.insertBatch("e", ["p1", "p2"]);
  const r1 = s.evaluate("e", ["p1", "p2"], ["n1", "n2", "n3", "n4"]);
  assert.equal(r1.positives.total, 2);
  assert.equal(r1.negatives.total, 4);
  assert.equal(r1.falsePositiveRate, r1.negatives.falsePositives / 4);
  const r2 = s.evaluate("e", ["p1"], []);
  assert.equal(r2.falsePositiveRate, null);
  s.close();
});

test("duplicate filter name and invalid params rejected", () => {
  const s = freshStore();
  s.create("d", 64, 2, 1);
  assert.throws(() => s.create("d", 64, 2, 1), (e: any) => e.code === "FILTER_EXISTS");
  assert.throws(() => s.create("bad", 3, 2, 1), (e: any) => e.code === "INVALID_PARAM");
  assert.throws(() => s.query("nope", ["x"]), (e: any) => e.code === "FILTER_NOT_FOUND");
  s.close();
});
