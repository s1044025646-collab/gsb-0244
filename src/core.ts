// Core Bloom filter: bit array, deterministic double hashing, insert/query.
// Format rules (must stay stable, persisted in snapshots):
//   FORMAT_VERSION = 1
//   HASH_ALGO      = "sha256-double"  (h1,h2 from SHA-256, positions = (h1 + i*h2) mod m)
//   BIT_ORDER      = "msb0"           (bit 0 = most significant bit of byte 0)
//   Encoding       = UTF-8 bytes of the key string, no normalization, case-sensitive.
//   Empty string is a valid key (hashed like any other byte sequence).
import { createHash } from "node:crypto";

export const FORMAT_VERSION = 1;
export const HASH_ALGO = "sha256-double";
export const BIT_ORDER = "msb0";

export class BloomError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface BloomParams {
  m: number; // bit array length
  k: number; // hash count
  seed: number;
}

export function validateParams(p: BloomParams): void {
  if (!Number.isInteger(p.m) || p.m < 8 || p.m > 1 << 24)
    throw new BloomError("INVALID_PARAM", "m must be an integer in [8, 16777216]");
  if (!Number.isInteger(p.k) || p.k < 1 || p.k > 32)
    throw new BloomError("INVALID_PARAM", "k must be an integer in [1, 32]");
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff)
    throw new BloomError("INVALID_PARAM", "seed must be an integer in [0, 4294967295]");
}

/** k deterministic bit positions for a key (UTF-8 bytes, case-sensitive, empty allowed). */
export function positionsFor(key: string, p: BloomParams): number[] {
  const data = Buffer.from(key, "utf8");
  const digest = createHash("sha256")
    .update("bloom:v1:")
    .update(String(p.seed))
    .update(":")
    .update(data)
    .digest();
  const h1 = digest.readUInt32BE(0);
  const h2raw = digest.readUInt32BE(4);
  const h2 = h2raw % 2 === 1 ? h2raw : h2raw + 1; // odd, never zero (no bitwise ops: they would go negative)
  const out: number[] = [];
  for (let i = 0; i < p.k; i++) out.push(Number((BigInt(h1) + BigInt(i) * BigInt(h2)) % BigInt(p.m)));
  return out;
}

export class BitArray {
  readonly bytes: Buffer;
  constructor(readonly m: number, bytes?: Buffer) {
    const need = Math.ceil(m / 8);
    this.bytes = bytes ? Buffer.from(bytes) : Buffer.alloc(need);
    if (this.bytes.length !== need)
      throw new BloomError("SNAPSHOT_PARAM_MISMATCH", `bit array byte length ${this.bytes.length} != expected ${need}`);
  }
  get(i: number): boolean {
    return (this.bytes[i >> 3] & (0x80 >> (i & 7))) !== 0; // msb0
  }
  set(i: number): void {
    this.bytes[i >> 3] |= 0x80 >> (i & 7);
  }
  countSet(): number {
    let n = 0;
    for (const b of this.bytes) {
      let v = b;
      while (v) { v &= v - 1; n++; }
    }
    return n;
  }
  /** Bitwise OR merge; requires identical length. */
  or(other: BitArray): void {
    if (other.m !== this.m) throw new BloomError("MERGE_INCOMPATIBLE", "bit array length differs");
    for (let i = 0; i < this.bytes.length; i++) this.bytes[i] |= other.bytes[i];
  }
}

export class BloomFilter {
  readonly bits: BitArray;
  constructor(readonly params: BloomParams, bits?: BitArray) {
    validateParams(params);
    this.bits = bits ?? new BitArray(params.m);
    if (this.bits.m !== params.m)
      throw new BloomError("SNAPSHOT_PARAM_MISMATCH", "bit array length does not match m");
  }
  insert(key: string): number[] {
    const pos = positionsFor(key, this.params);
    for (const i of pos) this.bits.set(i);
    return pos;
  }
  /** All required bits set => possibly present; any zero => definitely absent. */
  query(key: string): { result: "possibly_present" | "definitely_absent"; positions: number[]; bits: number[] } {
    const positions = positionsFor(key, this.params);
    const bits = positions.map((i) => (this.bits.get(i) ? 1 : 0));
    return { result: bits.every((b) => b === 1) ? "possibly_present" : "definitely_absent", positions, bits };
  }
  canMergeWith(other: BloomFilter): boolean {
    return (
      this.params.m === other.params.m &&
      this.params.k === other.params.k &&
      this.params.seed === other.params.seed
    );
  }
}

export interface Snapshot {
  version: number;
  hashAlgo: string;
  bitOrder: string;
  m: number;
  k: number;
  seed: number;
  bitsHex: string;
}

export function exportSnapshot(f: BloomFilter): Snapshot {
  return {
    version: FORMAT_VERSION,
    hashAlgo: HASH_ALGO,
    bitOrder: BIT_ORDER,
    m: f.params.m,
    k: f.params.k,
    seed: f.params.seed,
    bitsHex: f.bits.bytes.toString("hex"),
  };
}

export function importSnapshot(s: Snapshot): BloomFilter {
  if (s.version !== FORMAT_VERSION)
    throw new BloomError("SNAPSHOT_VERSION_MISMATCH", `unsupported snapshot version ${s.version}`);
  if (s.hashAlgo !== HASH_ALGO || s.bitOrder !== BIT_ORDER)
    throw new BloomError("SNAPSHOT_PARAM_MISMATCH", "hash algorithm or bit order differs");
  const bits = new BitArray(s.m, Buffer.from(s.bitsHex, "hex"));
  return new BloomFilter({ m: s.m, k: s.k, seed: s.seed }, bits);
}
