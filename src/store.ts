import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** SQLite 持久层：过滤器快照、演示用精确集合（仅用于误判评估）、操作记录。 */
export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS filters (
        name TEXT PRIMARY KEY,
        bit_size INTEGER NOT NULL,
        hash_count INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        hash_algo TEXT NOT NULL,
        version TEXT NOT NULL,
        bits BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS exact_keys (
        filter_name TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (filter_name, key)
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filter_name TEXT NOT NULL,
        op TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  saveFilter(name: string, f: { params: { bitSize: number; hashCount: number; seed: number }; bits: { toBuffer(): Buffer } }, hashAlgo: string, version: string): void {
    this.db.prepare(
      `INSERT INTO filters (name, bit_size, hash_count, seed, hash_algo, version, bits)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET bits = excluded.bits`
    ).run(name, f.params.bitSize, f.params.hashCount, f.params.seed, hashAlgo, version, f.bits.toBuffer());
  }

  loadFilter(name: string): { bit_size: number; hash_count: number; seed: number; hash_algo: string; version: string; bits: Buffer } | undefined {
    return this.db.prepare(`SELECT * FROM filters WHERE name = ?`).get(name) as any;
  }

  listFilters(): Array<{ name: string; bit_size: number; hash_count: number; seed: number; created_at: string }> {
    return this.db.prepare(`SELECT name, bit_size, hash_count, seed, created_at FROM filters ORDER BY name`).all() as any;
  }

  deleteFilter(name: string): void {
    this.db.prepare(`DELETE FROM filters WHERE name = ?`).run(name);
    this.db.prepare(`DELETE FROM exact_keys WHERE filter_name = ?`).run(name);
  }

  /** 事务性批量插入：位数组与精确集合一起提交，失败整体回滚。 */
  insertKeys(name: string, keys: string[], mutate: () => void): void {
    this.db.exec("BEGIN");
    try {
      mutate();
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO exact_keys (filter_name, key) VALUES (?, ?)`);
      for (const k of keys) stmt.run(name, k);
      this.log(name, "insert", JSON.stringify({ count: keys.length }));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  exactKeys(name: string): string[] {
    return (this.db.prepare(`SELECT key FROM exact_keys WHERE filter_name = ?`).all(name) as any[]).map((r) => r.key);
  }

  log(filterName: string, op: string, detail?: string): void {
    this.db.prepare(`INSERT INTO ops (filter_name, op, detail) VALUES (?, ?, ?)`).run(filterName, op, detail ?? null);
  }

  close(): void {
    this.db.close();
  }
}
