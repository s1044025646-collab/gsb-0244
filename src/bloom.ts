import { BitArray } from "./bitarray.ts";
import { positionsFor, FORMAT_VERSION, HASH_ALGO } from "./hash.ts";

export interface BloomParams {
  bitSize: number;
  hashCount: number;
  seed: number;
}

export interface QueryResult {
  key: string;
  positions: number[];
  bitsSet: boolean[];
  /** "definitely_absent" = 确定不存在；"possibly_present" = 可能存在（未确认） */
  verdict: "definitely_absent" | "possibly_present";
}

export class BloomFilter {
  readonly params: BloomParams;
  readonly bits: BitArray;

  constructor(params: BloomParams, bits?: BitArray) {
    this.params = params;
    this.bits = bits ?? new BitArray(params.bitSize);
  }

  positionsOf(key: string): number[] {
    return positionsFor(key, this.params.bitSize, this.params.hashCount, this.params.seed);
  }

  insert(key: string): void {
    for (const p of this.positionsOf(key)) this.bits.set(p);
  }

  query(key: string): QueryResult {
    const positions = this.positionsOf(key);
    const bitsSet = positions.map((p) => this.bits.get(p));
    return {
      key,
      positions,
      bitsSet,
      verdict: bitsSet.every(Boolean) ? "possibly_present" : "definitely_absent",
    };
  }

  setBitCount(): number {
    return this.bits.countSet();
  }

  /** 逐位或合并；参数必须完全一致。 */
  mergeFrom(other: BloomFilter): void {
    const a = this.params, b = other.params;
    if (a.bitSize !== b.bitSize || a.hashCount !== b.hashCount || a.seed !== b.seed) {
      throw new Error("PARAM_MISMATCH");
    }
    this.bits.orInPlace(other.bits);
  }

  snapshot() {
    return {
      version: FORMAT_VERSION,
      hashAlgo: HASH_ALGO,
      bitSize: this.params.bitSize,
      hashCount: this.params.hashCount,
      seed: this.params.seed,
      bitsBase64: this.bits.toBuffer().toString("base64"),
    };
  }

  static fromSnapshot(s: {
    version: string; hashAlgo: string; bitSize: number; hashCount: number; seed: number; bitsBase64: string;
  }): BloomFilter {
    if (s.version !== FORMAT_VERSION) throw new Error("VERSION_MISMATCH");
    if (s.hashAlgo !== HASH_ALGO) throw new Error("PARAM_MISMATCH");
    const bits = new BitArray(s.bitSize, Buffer.from(s.bitsBase64, "base64"));
    return new BloomFilter({ bitSize: s.bitSize, hashCount: s.hashCount, seed: s.seed }, bits);
  }
}
