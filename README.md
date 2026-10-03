# bloom-lab：本地 Bloom 过滤器成员查询与误判观察后端

纯本地实验服务：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`，无原生依赖、无外部网络请求）。提供 HTTP API 与 CLI，管理命名过滤器、批量插入、成员查询、位位置解释、置位统计、快照导出/导入与同参数过滤器合并。

## 结果语义（重要）

查询结果只有两种：

- `definitely_absent`：**确定不存在**（至少一个要求的位为 0）。
- `possibly_present`：**可能存在**（所有要求的位都为 1，可能是误判，绝不能当作"已确认存在"）。

普通 Bloom 过滤器**不支持删除**：一个键的位可能被其他键共享，清零会破坏其他键（本服务不提供删除接口）。

## 哈希与编码规则（格式版本 v1，随快照持久化）

- 键按 **UTF-8 字节**处理，**区分大小写**，**空串是合法键**，不做任何归一化。
- 哈希：`SHA-256("bloom:v1:" + seed + ":" + key)`，取前 8 字节得 `h1`、`h2`（`h2` 调整为奇数）。
- 第 i 个位位置：`(h1 + i * h2) mod m`（双重哈希，i = 0..k-1）。
- 位序 `msb0`：位 0 是第 0 字节的最高位。`hashAlgo`、`bitOrder`、`seed`、`version` 均存入 SQLite 与快照，导入时严格核对。

## 命令

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 运行全部测试
npm start         # 启动 API（默认端口 0 = 自动选空闲端口；PORT=8080 可指定）
npm run demo      # 小过滤器制造可复现误判，再与大过滤器对比
```

数据保存在项目内 `data/` 目录（可用 `DATA_DIR` 环境变量覆盖），重启后结果保留。

## CLI

```powershell
npm run cli -- create tiny --m 32 --k 3 --seed 1
npm run cli -- insert tiny alpha beta gamma
npm run cli -- query tiny alpha missing     # 输出每个键的结果与位位置、各位值
npm run cli -- stats tiny                   # 置位数量、填充率等
npm run cli -- export tiny --file tiny.json
npm run cli -- import tiny2 --file tiny.json
npm run cli -- merge a b --into ab          # 逐位 OR；m/k/seed 不同则拒绝
npm run cli -- evaluate tiny pos1 pos2 --file negatives.txt
```

## HTTP API（JSON，错误形如 `{"error":{"code":"...","message":"..."}}`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/filters` | 列出过滤器 |
| POST | `/filters` | 创建 `{name,m,k,seed?}` |
| GET | `/filters/:name` | 统计（setBits、fillRatio…） |
| POST | `/filters/:name/insert` | 批量插入 `{keys:[]}`（事务，失败不部分置位） |
| POST | `/filters/:name/query` | 查询 `{keys:[]}`，返回结果+位位置+各位值 |
| GET | `/filters/:name/export` | 导出快照 |
| POST | `/filters/import` | 导入 `{name,snapshot}`（核对版本/参数/位数组长度） |
| POST | `/filters/merge` | 合并 `{a,b,into}`（逐位 OR） |
| POST | `/filters/:name/evaluate` | 误判评估 `{positives:[],negatives:[]}` |

错误码：`INVALID_PARAM`、`FILTER_EXISTS`、`FILTER_NOT_FOUND`、`MERGE_INCOMPATIBLE`、`SNAPSHOT_VERSION_MISMATCH`、`SNAPSHOT_PARAM_MISMATCH`。

## 误判评估

`evaluate` 报告中明确区分已知正例与负例数量；`falsePositiveRate = falsePositives / negatives.total`，**分母只用负例**；负例为空时返回 `null`（不除零）。已知键清单仅用于评估时打标签，业务查询只读位数组，绝不查原始字符串表。

## 演示输出示例

`npm run demo` 在 m=32、k=3 的小过滤器上插入 5 个键，确定性找到 `probe-3` 等 5 个可复现误判（误判率 5/25 = 0.2）；同样的查询在 m=1024 的过滤器上误判率为 0。

## 限制

- 单进程本地服务，不支持并发集群、不自动优化容量。
- 不支持删除键（Bloom 过滤器固有限制）。
- 误判率仅为样本观察值，非概率证明。
