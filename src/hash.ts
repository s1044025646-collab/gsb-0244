import { createHash } from "node:crypto";

/**
 * 哈希规则（格式版本 bloom/1，固定不变）：
 * - 键按 UTF-8 字节处理，区分大小写，空串在入口处被拒绝。
 * - digest = SHA-256( "bloom/1" || 0x00 || seed(uint32 LE) || utf8(key) )
 * - h1 = digest[0..8) 按小端解释为 uint64，h2 = digest[8..16) 小端 uint64
 * - 第 i 个位置 pos_i = (h1 + i * h2) mod m  （Kirsch-Mitzenmacher 双重哈希）
 */
export const FORMAT_VERSION = "bloom/1";
export const HASH_ALGO = "sha256-double";

export function positionsFor(key: string, bitSize: number, hashCount: number, seed: number): number[] {
  const seedBuf = Buffer.alloc(4);
  seedBuf.writeUInt32LE(seed >>> 0);
  const digest = createHash("sha256")
    .update(FORMAT_VERSION)
    .update(Buffer.from([0]))
    .update(seedBuf)
    .update(key, "utf8")
    .digest();
  const h1 = digest.readBigUInt64LE(0);
  const h2 = digest.readBigUInt64LE(8);
  const m = BigInt(bitSize);
  const out: number[] = [];
  for (let i = 0; i < hashCount; i++) {
    out.push(Number((h1 + BigInt(i) * h2) % m));
  }
  return out;
}
