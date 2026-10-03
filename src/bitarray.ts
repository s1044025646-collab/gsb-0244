/** 位数组：基于 Buffer 的紧凑位存储，LSB-first 位序（格式版本 bloom/1）。 */
export class BitArray {
  readonly bitSize: number;
  private readonly bytes: Buffer;

  constructor(bitSize: number, bytes?: Buffer) {
    if (!Number.isInteger(bitSize) || bitSize <= 0) {
      throw new Error(`bitSize must be a positive integer, got ${bitSize}`);
    }
    this.bitSize = bitSize;
    const expected = Math.ceil(bitSize / 8);
    if (bytes !== undefined) {
      if (bytes.length !== expected) {
        throw new Error(`bytes length ${bytes.length} != expected ${expected}`);
      }
      this.bytes = Buffer.from(bytes);
    } else {
      this.bytes = Buffer.alloc(expected);
    }
  }

  get(index: number): boolean {
    this.check(index);
    return (this.bytes[index >> 3] & (1 << (index & 7))) !== 0;
  }

  set(index: number): void {
    this.check(index);
    this.bytes[index >> 3] |= 1 << (index & 7);
  }

  /** 逐位或（要求长度一致，否则抛错）。 */
  orInPlace(other: BitArray): void {
    if (other.bitSize !== this.bitSize) {
      throw new Error("bit size mismatch");
    }
    for (let i = 0; i < this.bytes.length; i++) {
      this.bytes[i] |= other.bytes[i];
    }
  }

  countSet(): number {
    let n = 0;
    for (const b of this.bytes) {
      let v = b;
      while (v) { v &= v - 1; n++; }
    }
    return n;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.bitSize) {
      throw new Error(`bit index ${index} out of range [0, ${this.bitSize})`);
    }
  }
}
