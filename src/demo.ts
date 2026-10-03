import { Service } from "./service.ts";

/**
 * 可复现误判演示：
 * 1) 建一个很小的过滤器（64 位、3 次哈希），插入固定键集；
 * 2) 在固定候选集中找到确定误判的键；
 * 3) 换 4096 位的过滤器装同样的键，对同样的负例重新评估对比误判率。
 */
export async function runDemo(service: Service): Promise<void> {
  const inserted = ["apple", "banana", "cherry", "grape", "lemon", "mango", "peach", "plum"];
  const candidates: string[] = [];
  for (let i = 0; i < 200; i++) candidates.push(`probe-${i}`);
  const negatives = candidates.filter((c) => !inserted.includes(c));

  const suffix = String(process.pid);
  const small = `demo-small-${suffix}`;
  const large = `demo-large-${suffix}`;

  service.createFilter({ name: small, bitSize: 64, hashCount: 3, seed: 42 });
  service.insert(small, inserted);
  service.createFilter({ name: large, bitSize: 4096, hashCount: 3, seed: 42 });
  service.insert(large, inserted);

  const smallReport = service.evaluate(small, { positives: inserted, negatives });
  const largeReport = service.evaluate(large, { positives: inserted, negatives });

  const fpExamples = negatives
    .filter((k) => service.query(small, [k]).results[0].verdict === "possibly_present")
    .slice(0, 5)
    .map((k) => ({ key: k, positions: service.query(small, [k]).results[0].positions }));

  console.log(JSON.stringify({
    note: "possibly_present 只表示可能存在，不代表确认存在",
    inserted,
    negativeSampleCount: negatives.length,
    small: { bitSize: 64, ...smallReport },
    large: { bitSize: 4096, ...largeReport },
    falsePositiveExamplesInSmall: fpExamples,
  }, null, 2));
}
