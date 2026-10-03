import { BloomFilter, QueryResult } from "./bloom.ts";
import { BitArray } from "./bitarray.ts";
import { FORMAT_VERSION, HASH_ALGO } from "./hash.ts";
import { Store } from "./store.ts";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_KEY_BYTES = 1024;
const MAX_BATCH = 10000;

export function validateKey(key: unknown): string {
  if (typeof key !== "string") throw new ApiError("INVALID_PARAM", "key must be a string");
  if (key.length === 0) throw new ApiError("INVALID_PARAM", "empty string key is not allowed");
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new ApiError("INVALID_PARAM", `key exceeds ${MAX_KEY_BYTES} bytes (UTF-8)`);
  }
  return key;
}

function validateKeys(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0) throw new ApiError("INVALID_PARAM", "keys must be a non-empty array");
  if (keys.length > MAX_BATCH) throw new ApiError("INVALID_PARAM", `batch size exceeds ${MAX_BATCH}`);
  return keys.map(validateKey);
}

export class Service {
  constructor(readonly store: Store) {}

  createFilter(input: { name?: unknown; bitSize?: unknown; hashCount?: unknown; seed?: unknown }) {
    const { name, bitSize, hashCount, seed } = input;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new ApiError("INVALID_PARAM", "name must match [A-Za-z0-9_-]{1,64}");
    }
    if (!Number.isInteger(bitSize) || (bitSize as number) < 8 || (bitSize as number) > 1 << 28) {
      throw new ApiError("INVALID_PARAM", "bitSize must be an integer in [8, 268435456]");
    }
    if (!Number.isInteger(hashCount) || (hashCount as number) < 1 || (hashCount as number) > 64) {
      throw new ApiError("INVALID_PARAM", "hashCount must be an integer in [1, 64]");
    }
    const seedVal = seed === undefined ? 0 : seed;
    if (!Number.isInteger(seedVal) || (seedVal as number) < 0 || (seedVal as number) > 0xffffffff) {
      throw new ApiError("INVALID_PARAM", "seed must be an integer in [0, 4294967295]");
    }
    if (this.store.loadFilter(name)) throw new ApiError("FILTER_EXISTS", `filter '${name}' already exists`, 409);
    const filter = new BloomFilter({ bitSize: bitSize as number, hashCount: hashCount as number, seed: seedVal as number });
    this.store.saveFilter(name, filter, HASH_ALGO, FORMAT_VERSION);
    this.store.log(name, "create", JSON.stringify(filter.params));
    return this.describe(name, filter);
  }

  private load(name: string): BloomFilter {
    const row = this.store.loadFilter(name);
    if (!row) throw new ApiError("FILTER_NOT_FOUND", `filter '${name}' not found`, 404);
    if (row.version !== FORMAT_VERSION) throw new ApiError("VERSION_MISMATCH", `stored version '${row.version}' != '${FORMAT_VERSION}'`, 409);
    if (row.hash_algo !== HASH_ALGO) throw new ApiError("PARAM_MISMATCH", `stored hashAlgo '${row.hash_algo}' unsupported`, 409);
    return new BloomFilter(
      { bitSize: row.bit_size, hashCount: row.hash_count, seed: row.seed },
      new BitArray(row.bit_size, row.bits)
    );
  }

  private persist(name: string, filter: BloomFilter): void {
    this.store.saveFilter(name, filter, HASH_ALGO, FORMAT_VERSION);
  }

  insert(name: string, keysInput: unknown) {
    const keys = validateKeys(keysInput);
    const filter = this.load(name);
    this.store.insertKeys(name, keys, () => {
      for (const k of keys) filter.insert(k);
      this.persist(name, filter);
    });
    return { name, inserted: keys.length, setBits: filter.setBitCount() };
  }

  query(name: string, keysInput: unknown): { name: string; results: QueryResult[] } {
    const keys = validateKeys(keysInput);
    const filter = this.load(name);
    const results = keys.map((k) => filter.query(k));
    this.store.log(name, "query", JSON.stringify({ count: keys.length }));
    return { name, results };
  }

  stats(name: string) {
    return this.describe(name, this.load(name));
  }

  private describe(name: string, filter: BloomFilter) {
    const setBits = filter.setBitCount();
    return {
      name,
      ...filter.params,
      hashAlgo: HASH_ALGO,
      version: FORMAT_VERSION,
      setBits,
      fillRatio: setBits / filter.params.bitSize,
    };
  }

  list() {
    return this.store.listFilters();
  }

  exportSnapshot(name: string) {
    const filter = this.load(name);
    this.store.log(name, "export");
    return { name, ...filter.snapshot() };
  }

  importSnapshot(input: { name?: unknown; snapshot?: unknown }) {
    const s = input.snapshot as any;
    if (!s || typeof s !== "object") throw new ApiError("BAD_SNAPSHOT", "snapshot object required");
    const name = typeof input.name === "string" ? input.name : s.name;
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new ApiError("INVALID_PARAM", "invalid name");
    if (this.store.loadFilter(name)) throw new ApiError("FILTER_EXISTS", `filter '${name}' already exists`, 409);
    for (const f of ["version", "hashAlgo", "bitSize", "hashCount", "seed", "bitsBase64"]) {
      if (!(f in s)) throw new ApiError("BAD_SNAPSHOT", `snapshot missing field '${f}'`);
    }
    let filter: BloomFilter;
    try {
      filter = BloomFilter.fromSnapshot(s);
    } catch (e: any) {
      const code = e.message === "VERSION_MISMATCH" ? "VERSION_MISMATCH" : e.message === "PARAM_MISMATCH" ? "PARAM_MISMATCH" : "BAD_SNAPSHOT";
      throw new ApiError(code, `snapshot rejected: ${e.message}`, 409);
    }
    this.persist(name, filter);
    this.store.log(name, "import", JSON.stringify(filter.params));
    return this.describe(name, filter);
  }

  merge(input: { target?: unknown; sources?: unknown }) {
    const target = input.target;
    if (typeof target !== "string") throw new ApiError("INVALID_PARAM", "target name required");
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new ApiError("INVALID_PARAM", "sources must be a non-empty array of names");
    }
    const dst = this.load(target);
    for (const srcName of input.sources) {
      if (typeof srcName !== "string") throw new ApiError("INVALID_PARAM", "source names must be strings");
      const src = this.load(srcName);
      try {
        dst.mergeFrom(src);
      } catch {
        throw new ApiError("PARAM_MISMATCH", `filter '${srcName}' params differ from '${target}' (bitSize/hashCount/seed)`, 409);
      }
    }
    this.persist(target, dst);
    this.store.log(target, "merge", JSON.stringify({ sources: input.sources }));
    return this.describe(target, dst);
  }

  /** 误判评估：精确集合仅在此使用，业务查询不依赖它。 */
  evaluate(name: string, input: { positives?: unknown; negatives?: unknown }) {
    const filter = this.load(name);
    const positives = Array.isArray(input.positives) ? input.positives.map(validateKey) : [];
    const negatives = Array.isArray(input.negatives) ? input.negatives.map(validateKey) : [];
    const known = new Set(this.store.exactKeys(name));
    let falseNegatives = 0;
    for (const k of positives) {
      if (filter.query(k).verdict === "definitely_absent") falseNegatives++;
    }
    let falsePositives = 0;
    for (const k of negatives) {
      if (known.has(k)) {
        throw new ApiError("INVALID_PARAM", `negative sample '${k}' was actually inserted`);
      }
      if (filter.query(k).verdict === "possibly_present") falsePositives++;
    }
    const report = {
      name,
      positiveCount: positives.length,
      negativeCount: negatives.length,
      falseNegatives,
      falsePositives,
      falsePositiveRate: negatives.length === 0 ? null : falsePositives / negatives.length,
      note: negatives.length === 0 ? "no negative samples; falsePositiveRate is null (no division by zero)" : undefined,
    };
    this.store.log(name, "evaluate", JSON.stringify(report));
    return report;
  }
}
