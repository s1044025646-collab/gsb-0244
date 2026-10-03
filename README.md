# bloom-lab：本地 Bloom 过滤器实验服务

一个纯本地运行的 Bloom 过滤器成员查询与误判观察后端：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无网络请求）。只提供 HTTP API 与 CLI，无前端。

## 结果语义（重要）

查询结果只有两种标准措辞：

- `definitely_absent`：**确定不存在**（至少一个哈希位为 0）。
- `possibly_present`：**可能存在**（全部哈希位为 1）。这不等于确认存在——可能是其他键置位造成的误判。

普通 Bloom 过滤器**不支持删除**：一个键的位可能与其他键共享，清零会破坏其他键（产生假阴性），因此本服务不提供删除键的接口。

## 哈希与输入规则（格式版本 `bloom/1`）

- 键按 **UTF-8 字节**处理，**区分大小写**（`Apple` ≠ `apple`），**空串被拒绝**（`INVALID_PARAM`），单键最长 1024 字节。
- `digest = SHA-256("bloom/1" || 0x00 || seed(uint32 LE) || utf8(key))`
- `h1 = digest[0..8)` 小端 uint64，`h2 = digest[8..16)` 小端 uint64
- 第 `i` 个位位置 `pos_i = (h1 + i·h2) mod m`（Kirsch–Mitzenmacher 双重哈希）
- 位序：字节内 LSB-first；版本、哈希算法（`sha256-double`）、种子随快照一起保存与校验。

## 快速开始

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API，默认自动选择空闲端口（--port 指定固定端口）
npm run demo       # 可复现误判演示
```

数据保存在项目内 `data/bloom.db`（可用环境变量 `BLOOM_DATA_DIR` / `BLOOM_DB` 覆盖），重启后结果保留。

## CLI 示例

```powershell
node dist/cli.js create f1 --bits 64 --hashes 3 --seed 42
node dist/cli.js insert f1 apple banana cherry
node dist/cli.js query f1 apple not-a-key     # 输出每个键的位位置与判定
node dist/cli.js stats f1                      # 置位数量与填充率
node dist/cli.js export f1 --out snap.json
node dist/cli.js import snap.json --name f1-copy
node dist/cli.js create f2 --bits 64 --hashes 3 --seed 42
node dist/cli.js insert f2 grape lemon
node dist/cli.js merge f1 f2                   # 逐位或合并；参数不同会被拒绝
node dist/cli.js evaluate f1 --positives p.txt --negatives n.txt
```

## HTTP API

`npm start` 后（默认 `127.0.0.1` + 空闲端口）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/filters` | 创建 `{name, bitSize, hashCount, seed?}` |
| GET | `/filters` | 列出全部过滤器 |
| GET | `/filters/:name` | 参数、置位数量、填充率 |
| POST | `/filters/:name/insert` | 批量插入 `{keys:[...]}`（事务，失败整体回滚） |
| POST | `/filters/:name/query` | 查询 `{keys:[...]}`，返回位位置、各位值与判定 |
| GET | `/filters/:name/export` | 导出快照 JSON |
| POST | `/filters/import` | 导入快照（核对版本/位长/算法/种子） |
| POST | `/filters/merge` | 合并 `{target, sources:[...]}`，逐位或 |
| POST | `/filters/:name/evaluate` | 误判评估 `{positives:[...], negatives:[...]}` |

错误统一为 `{ "error": { "code", "message" } }`，错误码：`INVALID_PARAM`、`FILTER_EXISTS`(409)、`FILTER_NOT_FOUND`(404)、`PARAM_MISMATCH`(409)、`VERSION_MISMATCH`(409)、`BAD_SNAPSHOT`、`NOT_FOUND`(404)。

## 误判演示

`npm run demo` 用固定数据演示：8 个键装入 **64 位**过滤器（3 次哈希，种子 42），在 200 个固定负例 `probe-0..199` 上得到确定可复现的误判（实测 4 个，误判率 2%）；同一批键装入 **4096 位**过滤器后同样负例误判为 0。输出会列出误判键及其位位置。

评估报告字段：`positiveCount` / `negativeCount` / `falseNegatives` / `falsePositives` / `falsePositiveRate`。误判率**只用负例作分母**；没有负例时 `falsePositiveRate = null`（不除零）。演示用的精确集合（SQLite `exact_keys` 表）仅用于评估与校验负例样本，业务查询路径只读位数组。

## 设计限制

- 单进程本地服务，不处理并发集群、不自动优化容量、不做分布式缓存。
- 不支持删除键（见上文“结果语义”）。
- 合并要求 `bitSize` / `hashCount` / `seed` / 哈希算法完全一致，否则 `PARAM_MISMATCH`。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常提示。
