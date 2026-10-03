import { test } from "node:test";
import assert from "node:assert/strict";
import { BloomFilter } from "../dist/bloom.js";
import { positionsFor } from "../dist/hash.js";
import { Store } from "../dist/store.js";
import { Service, ApiError } from "../dist/service.js";

function makeService(): Service {
  return new Service(new Store(":memory:"));
}

test("固定字符串的哈希位置是确定且可复现的", () => {
  const p1 = positionsFor("hello", 128, 4, 7);
  const p2 = positionsFor("hello", 128, 4, 7);
  assert.deepEqual(p1, p2);
  assert.equal(p1.length, 4);
  for (const p of p1) assert.ok(p >= 0 && p < 128);
  assert.notDeepEqual(positionsFor("hello", 128, 4, 8), p1);
  assert.notDeepEqual(positionsFor("Hello", 128, 4, 7), p1);
});

test("同一键重复插入幂等，置位数不增加", () => {
  const f = new BloomFilter({ bitSize: 256, hashCount: 3, seed: 0 });
  f.insert("dup");
  const n1 = f.setBitCount();
  f.insert("dup");
  assert.equal(f.setBitCount(), n1);
});

test("已插入键不出现假阴性", () => {
  const f = new BloomFilter({ bitSize: 512, hashCount: 5, seed: 1 });
  const keys = Array.from({ length: 50 }, (_, i) => `key-${i}`);
  for (const k of keys) f.insert(k);
  for (const k of keys) assert.equal(f.query(k).verdict, "possibly_present");
});

test("未插入键可能误判，且结果只能是两种标准措辞", () => {
  const f = new BloomFilter({ bitSize: 32, hashCount: 3, seed: 42 });
  for (let i = 0; i < 10; i++) f.insert(`in-${i}`);
  let sawFp = false;
  for (let i = 0; i < 500; i++) {
    const r = f.query(`out-${i}`);
    assert.ok(r.verdict === "possibly_present" || r.verdict === "definitely_absent");
    if (r.verdict === "possibly_present") {
      sawFp = true;
      assert.ok(r.bitsSet.every(Boolean));
    } else {
      assert.ok(r.bitsSet.some((b) => !b));
    }
  }
  assert.ok(sawFp, "32-bit filter with 10 keys should produce false positives");
});

test("合并是逐位或，合并后覆盖两个过滤器的全部键", () => {
  const params = { bitSize: 256, hashCount: 3, seed: 9 };
  const a = new BloomFilter(params);
  const b = new BloomFilter(params);
  a.insert("alpha"); a.insert("beta");
  b.insert("gamma");
  const beforeA = a.setBitCount();
  const beforeB = b.setBitCount();
  a.mergeFrom(b);
  for (const k of ["alpha", "beta", "gamma"]) {
    assert.equal(a.query(k).verdict, "possibly_present");
  }
  assert.ok(a.setBitCount() >= Math.max(beforeA, beforeB));
});

test("参数不同拒绝合并", () => {
  const a = new BloomFilter({ bitSize: 256, hashCount: 3, seed: 0 });
  const b = new BloomFilter({ bitSize: 512, hashCount: 3, seed: 0 });
  const c = new BloomFilter({ bitSize: 256, hashCount: 4, seed: 0 });
  const d = new BloomFilter({ bitSize: 256, hashCount: 3, seed: 1 });
  assert.throws(() => a.mergeFrom(b), /PARAM_MISMATCH/);
  assert.throws(() => a.mergeFrom(c), /PARAM_MISMATCH/);
  assert.throws(() => a.mergeFrom(d), /PARAM_MISMATCH/);
});

test("快照往返保持位数组与查询结果", () => {
  const f = new BloomFilter({ bitSize: 200, hashCount: 4, seed: 3 });
  for (const k of ["x", "y", "z"]) f.insert(k);
  const g = BloomFilter.fromSnapshot(f.snapshot());
  assert.equal(g.setBitCount(), f.setBitCount());
  for (const k of ["x", "y", "z", "absent-1", "absent-2"]) {
    assert.deepEqual(g.query(k), f.query(k));
  }
});

test("快照版本或参数不兼容被拒绝", () => {
  const f = new BloomFilter({ bitSize: 64, hashCount: 2, seed: 0 });
  const s = f.snapshot();
  assert.throws(() => BloomFilter.fromSnapshot({ ...s, version: "bloom/999" }), /VERSION_MISMATCH/);
  assert.throws(() => BloomFilter.fromSnapshot({ ...s, hashAlgo: "md5" }), /PARAM_MISMATCH/);
  assert.throws(() => BloomFilter.fromSnapshot({ ...s, bitsBase64: Buffer.alloc(3).toString("base64") }));
});

test("service: 参数校验与错误码", () => {
  const svc = makeService();
  assert.throws(() => svc.createFilter({ name: "bad name!", bitSize: 64, hashCount: 3 }), (e) => e instanceof ApiError && e.code === "INVALID_PARAM");
  assert.throws(() => svc.createFilter({ name: "ok", bitSize: 3, hashCount: 3 }), (e) => (e as ApiError).code === "INVALID_PARAM");
  svc.createFilter({ name: "ok", bitSize: 64, hashCount: 3 });
  assert.throws(() => svc.createFilter({ name: "ok", bitSize: 64, hashCount: 3 }), (e) => (e as ApiError).code === "FILTER_EXISTS");
  assert.throws(() => svc.query("nope", ["a"]), (e) => (e as ApiError).code === "FILTER_NOT_FOUND");
  assert.throws(() => svc.insert("ok", [""]), (e) => (e as ApiError).code === "INVALID_PARAM");
  assert.throws(() => svc.insert("ok", []), (e) => (e as ApiError).code === "INVALID_PARAM");
});

test("service: 重启（重新打开存储）后结果保留", () => {
  const svc = makeService();
  svc.createFilter({ name: "persist", bitSize: 128, hashCount: 3, seed: 5 });
  svc.insert("persist", ["keep-me"]);
  const before = svc.query("persist", ["keep-me"]).results[0];
  const svc2 = new Service(svc.store); // 模拟重启后从 SQLite 重新加载
  const after = svc2.query("persist", ["keep-me"]).results[0];
  assert.deepEqual(after, before);
  assert.equal(after.verdict, "possibly_present");
});

test("service: 合并参数不同返回 PARAM_MISMATCH", () => {
  const svc = makeService();
  svc.createFilter({ name: "m1", bitSize: 128, hashCount: 3 });
  svc.createFilter({ name: "m2", bitSize: 256, hashCount: 3 });
  assert.throws(() => svc.merge({ target: "m1", sources: ["m2"] }), (e) => (e as ApiError).code === "PARAM_MISMATCH");
});

test("service: 评估报告只在负例上分母，无负例不除零", () => {
  const svc = makeService();
  svc.createFilter({ name: "ev", bitSize: 64, hashCount: 3, seed: 42 });
  svc.insert("ev", ["a", "b", "c"]);
  const r1 = svc.evaluate("ev", { positives: ["a", "b", "c"], negatives: [] });
  assert.equal(r1.falsePositiveRate, null);
  assert.equal(r1.positiveCount, 3);
  assert.equal(r1.negativeCount, 0);
  assert.equal(r1.falseNegatives, 0);
  const r2 = svc.evaluate("ev", { positives: ["a"], negatives: ["x", "y", "z", "w"] });
  assert.equal(r2.negativeCount, 4);
  assert.ok(r2.falsePositiveRate === null || (r2.falsePositiveRate >= 0 && r2.falsePositiveRate <= 1));
  assert.throws(() => svc.evaluate("ev", { negatives: ["a"] }), (e) => (e as ApiError).code === "INVALID_PARAM");
});

test("service: 快照导出/导入往返，导入核对参数", () => {
  const svc = makeService();
  svc.createFilter({ name: "snap", bitSize: 96, hashCount: 2, seed: 11 });
  svc.insert("snap", ["one", "two"]);
  const snap = svc.exportSnapshot("snap");
  const svc2 = makeService();
  svc2.importSnapshot({ snapshot: snap });
  assert.equal(svc2.query("snap", ["one"]).results[0].verdict, "possibly_present");
  const bad = { ...snap, bitSize: 128 };
  assert.throws(() => svc2.importSnapshot({ name: "other", snapshot: bad }), (e) => (e as ApiError).code === "BAD_SNAPSHOT");
});

