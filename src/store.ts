// SQLite persistence: filter snapshots + operation log. Batch inserts are transactional.
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BloomError, BloomFilter, Snapshot, exportSnapshot, importSnapshot,
  FORMAT_VERSION, HASH_ALGO, BIT_ORDER,
} from "./core";

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS filters (
        name TEXT PRIMARY KEY,
        m INTEGER NOT NULL, k INTEGER NOT NULL, seed INTEGER NOT NULL,
        hash_algo TEXT NOT NULL, bit_order TEXT NOT NULL, version INTEGER NOT NULL,
        bits BLOB NOT NULL,
        inserted_keys INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filter_name TEXT NOT NULL, op TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        ts TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
  close(): void { this.db.close(); }

  private log(filter: string, op: string, detail: object): void {
    this.db.prepare("INSERT INTO ops (filter_name, op, detail) VALUES (?,?,?)")
      .run(filter, op, JSON.stringify(detail));
  }

  create(name: string, m: number, k: number, seed: number): BloomFilter {
    if (this.db.prepare("SELECT 1 FROM filters WHERE name=?").get(name))
      throw new BloomError("FILTER_EXISTS", `filter '${name}' already exists`);
    const f = new BloomFilter({ m, k, seed });
    this.persist(name, f, 0);
    this.log(name, "create", { m, k, seed });
    return f;
  }

  private persist(name: string, f: BloomFilter, insertedKeys: number): void {
    this.db.prepare(
      `INSERT INTO filters (name,m,k,seed,hash_algo,bit_order,version,bits,inserted_keys)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET bits=excluded.bits, inserted_keys=excluded.inserted_keys`
    ).run(name, f.params.m, f.params.k, f.params.seed, HASH_ALGO, BIT_ORDER, FORMAT_VERSION,
      f.bits.bytes, insertedKeys);
  }

  load(name: string): { filter: BloomFilter; insertedKeys: number } {
    const row = this.db.prepare("SELECT * FROM filters WHERE name=?").get(name) as any;
    if (!row) throw new BloomError("FILTER_NOT_FOUND", `filter '${name}' not found`);
    const snap: Snapshot = {
      version: row.version, hashAlgo: row.hash_algo, bitOrder: row.bit_order,
      m: row.m, k: row.k, seed: row.seed,
      bitsHex: Buffer.from(row.bits).toString("hex"),
    };
    return { filter: importSnapshot(snap), insertedKeys: row.inserted_keys };
  }

  list(): object[] {
    return this.db.prepare("SELECT name,m,k,seed,inserted_keys,created_at FROM filters ORDER BY name")
      .all() as object[];
  }

  /** Atomic batch insert: all keys set or none. */
  insertBatch(name: string, keys: string[]): { inserted: number; setBits: number } {
    const { filter, insertedKeys } = this.load(name);
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 4096)
        throw new BloomError("INVALID_PARAM", "keys must be strings of length <= 4096");
    }
    this.db.exec("BEGIN");
    try {
      for (const key of keys) filter.insert(key);
      this.persist(name, filter, insertedKeys + keys.length);
      this.log(name, "insert", { count: keys.length });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { inserted: keys.length, setBits: filter.bits.countSet() };
  }

  query(name: string, keys: string[]) {
    const { filter } = this.load(name);
    return keys.map((key) => ({ key, ...filter.query(key) }));
  }

  stats(name: string) {
    const { filter, insertedKeys } = this.load(name);
    const setBits = filter.bits.countSet();
    return {
      name, ...filter.params, setBits, fillRatio: setBits / filter.params.m,
      insertedKeys, version: FORMAT_VERSION, hashAlgo: HASH_ALGO, bitOrder: BIT_ORDER,
    };
  }

  exportFilter(name: string): Snapshot {
    const { filter } = this.load(name);
    return exportSnapshot(filter);
  }

  importFilter(name: string, snap: Snapshot): void {
    if (this.db.prepare("SELECT 1 FROM filters WHERE name=?").get(name))
      throw new BloomError("FILTER_EXISTS", `filter '${name}' already exists`);
    const filter = importSnapshot(snap); // validates version/params/length
    this.persist(name, filter, 0);
    this.log(name, "import", { m: snap.m, k: snap.k, seed: snap.seed });
  }

  /** Bitwise-OR merge; rejects differing m/k/seed. Result stored into `into`. */
  merge(a: string, b: string, into: string): void {
    const fa = this.load(a).filter;
    const fb = this.load(b).filter;
    if (!fa.canMergeWith(fb))
      throw new BloomError("MERGE_INCOMPATIBLE", "m, k and seed must be identical to merge");
    if (this.db.prepare("SELECT 1 FROM filters WHERE name=?").get(into))
      throw new BloomError("FILTER_EXISTS", `filter '${into}' already exists`);
    fa.bits.or(fb.bits);
    this.persist(into, fa, 0);
    this.log(into, "merge", { a, b });
  }

  /**
   * False-positive evaluation. The exact key list (knownInserted) is used ONLY
   * here to label negatives; membership answers always come from the Bloom filter.
   */
  evaluate(name: string, positives: string[], negatives: string[]) {
    const { filter } = this.load(name);
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (const key of positives)
      filter.query(key).result === "possibly_present" ? tp++ : fn++;
    for (const key of negatives)
      filter.query(key).result === "possibly_present" ? fp++ : tn++;
    return {
      filter: name,
      positives: { total: positives.length, possiblyPresent: tp, falseNegatives: fn },
      negatives: { total: negatives.length, falsePositives: fp, trueNegatives: tn },
      // Denominator is negatives only; null when there are no negatives (no division by zero).
      falsePositiveRate: negatives.length === 0 ? null : fp / negatives.length,
    };
  }
}
