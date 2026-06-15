# 在 Cloudflare Workers 上实现 Git 服务器（可插拔存储后端）——可行性分析

> 日期：2026-06-15　·　状态：架构可行性评估（未经联网核实，基于 Opus 4.8 训练知识，知识截止 2026-01）
> 关键运行时数字标注 ⚠️verify 的，需在动手前用最新文档复核——它们直接决定结论的量级。

---

## 0. 一句话结论

**可行，且有清晰的边界——但不是"什么都行"。**

- 对**个人/小团队仓库**：读（clone/fetch/ls-remote）**完全可行**，写（push）**可行但必须解决原子性**。
- 对 **Linux 内核级超大仓库 / 高并发写**：**不现实**，受 CPU 与单请求边界约束。
- 想让它"真的能用"，关键不是协议（协议能实现），而是**三选一的取舍**：CPU 预算、子请求上限、原子性方案。
- **强烈建议把 R2 作为主存储**：它走 Workers 原生 binding（大概率不计入 fetch 子请求配额），这是整个方案能否成立的支点。S3/WebDAV 走 `fetch()`，受 50/1000 子请求硬上限约束，必须用"整包预生成"策略才能跑。

---

## 1. 核心矛盾：Git 智能协议到底要服务端干什么

一个能被**标准 `git` 客户端**直接 `clone/pull/push` 的 HTTP 服务器，必须实现 **Smart HTTP**，两条路径截然不同：

### 读路径（`clone`/`fetch` → `upload-pack`）
1. `GET /info/refs?service=git-upload-pack` → 返回 pkt-line 帧的 **ref 广告**（每个 `ref` 一行 `<sha> <name>\0<capabilities>\n`，含 `HEAD` 的 `symref`、能力位 `multi_ack`/`thin-pack`/`side-band-64k`/`ofs-delta`/`object-format=` 等）。
2. `POST /git-upload-pack` → 客户端发 `want`/`have` 协商；服务端**做对象遍历 + delta 编码 + zlib 压缩**，生成一个**新的 packfile**流式回传（`side-band-64k` 多路复用带 progress）。

**难点在两处**：
- (a) **对象遍历需要随机读**：从 want 出发顺着 commit/tree 走，要读每个对象的头部，**每个对象可能就是一次存储读**。
- (b) **生成新 pack = CPU 密集**：deltification（找相似对象做 delta）+ zlib，对象越多 CPU 越重。

### 写路径（`push` → `receive-pack`）
1. `GET /info/refs?service=git-receive-pack` → 广告 ref + 写相关能力（`report-status`/`atomic`/`delete-refs`）。
2. `POST /git-receive-pack` → 客户端推一个 packfile；服务端**解包**（zlib 解压、拆对象、逐个存盘）、**校验连通性**、**原子更新 ref**（每个 ref 是一个只含一个 sha 的文件，更新时要做 compare-and-swap，且多个 ref 在 `--atomic` 下要么全成功要么全失败）。

**难点**：**(3) 原子性 ref 更新**——这是 push 的真正硬骨头，不是 CPU 而是并发安全。

---

## 2. Workers 运行时硬约束（逐条映射到 git）

| 约束 | 量级 ⚠️verify | 对 Git 服务器的直接含义 |
|---|---|---|
| **CPU 时间/请求** | 免费 **10ms**；付费默认 **30s**（可申请调高） | **upload-pack 生成新 pack 的 deltify 是 CPU 杀手**。大仓库增量 fetch 会顶到墙。注意：CPU ≠ wall-clock，等存储 I/O 时不消耗 CPU。 |
| **子请求/请求** | 默认 **50**，可调到 **1000**（`subrequests` outbound 设置）⚠️verify | **若每个 git 对象一次 `fetch()`，几千对象的仓库瞬间打穿**。这是 S3-over-fetch / WebDAV-over-fetch 方案的核心死穴。 |
| **原生 binding 是否计入子请求** | R2/KV/D1/DO 存储等**原生 binding 历史上不计入** 50/1000 fetch 配额 ⚠️verify（Cloudflare 有在调整） | **决定性因素**：若成立，**R2 作为主存储可绕过子请求墙**，瓶颈转到 CPU/延迟。 |
| **内存** | **128 MB** | 持有整个大 pack 需谨慎；用 `TransformStream` 流式输出可避免整包驻留。 |
| **请求/响应体** | 支持流式（`ReadableStream`/`TransformStream` 端到端直通），R2 `.get()` 返回可流式 body | **真流式可行**：可以从存储边读边吐给客户端，不必把整包读进内存。 |
| **无 Node `fs`/`net`/`child_process`，无裸 TCP，无原生 git 二进制** | — | 不能 `spawn('git')`；必须纯 JS（isomorphic-git）或自研。长连接需 WebSocket 或 Durable Object。 |
| **Durable Object** | 单线程 actor = 天然互斥；事务式存储（`ctx.storage.transaction()`）；可休眠+冷启动 | **解决 push 原子性的银弹**：一个仓库一个 DO，push 串行化，ref 多键原子更新。 |
| **Workflows / Queues** | 后台批处理 | 重型 repack / 大 pack 重建可卸到 Workflows，绕开单请求 CPU 墙。 |

> **三条最可能卡死的硬骨头**（也是后面架构要重点对付的）：
> 1. **子请求上限**（针对 S3/WebDAV）
> 2. **CPU 时间**（针对 upload-pack 的 deltify）
> 3. **push 原子性**（针对所有非 CAS 后端）

---

## 3. Git 对象存储模型：为什么对象存储后端不是天然适配

Git 仓库的物理形态有两种对象存在方式：

- **Loose object**：`objects/ab/cdef...`，一个 zlib 压缩的对象一个文件。
- **Packfile**：`objects/pack/<sha>.pack` + `objects/pack/<sha>.idx`。pack 内多对象 + delta 压缩；`.idx` 是随机访问索引（按 sha 二分查 offset）。

服务一个 fetch 的访问模式是：
- **要么**逐个 loose 对象读（→ 每对象一次 I/O，受子请求上限毒打）；
- **要么**读 `.pack` + `.idx` 做**随机读**：在 `.idx` 二分定位 → 用 **Range 请求**只读 `.pack` 中那段字节 → 处理 `OFS_DELTA`/`REF_DELTA` 基对象链。

**关键洞察（让方案从"不可行"变"可行"的那一条）**：

> 客户端期望收到一个**合法的 packfile**（有 `PACK` 头 + 对象数、有尾部 SHA-1 校验、内部 delta 引用自洽）。你不能随便切片拼接。但——**全量 clone（客户端无 have）时，`upload-pack` 本来就要产出"所有可达对象"的 pack**。如果你**预先把一个完整可达对象集存成一个 pack**，那么全量 clone 直接流式吐这个整包，字节数与 `upload-pack` 理论输出等价（客户端会忽略它不需要的，对全量 clone 就是全部）。

这就是高效的 **clone 快路径**：**clone ≈ 读一个预生成 pack + 广告 ref**，几乎零 CPU。GitHub 的"offload scaling"镜像就是这个思路。

代价：**增量 fetch（客户端有部分历史）** 必须逐对象组装新 pack，CPU/I/O 随新增对象增长——但这比全量 clone 少得多，且可接受。

**推论**：一个可插拔存储后端，最小必须提供：
- **随机读**（Range）——读 pack 切片、读 loose 对象；
- **原子 CAS / 锁**——更新 ref；
- **列举**（list）——枚举 `objects/pack/*`、`refs/*`。

---

## 4. 三个存储后端的语义对照（决定能否插得进来）

| 能力 | S3 兼容（含 R2 S3 API） | Cloudflare R2 原生 binding | WebDAV |
|---|---|---|---|
| **Range 随机读** | ✅ `Range:` | ✅ `range:` 选项 | ✅ `Range:` |
| **大对象写入** | ✅ Multipart | ✅ Multipart（>5GB 必须） | ✅ PUT（部分支持分段） |
| **条件写（CAS）** | ✅ `If-Match`/`If-None-Match`（S3 自 2020 强一致+条件写；R2 已支持）⚠️verify 时间线 | ✅ `onlyIf` / 条件 ⚠️verify | ⚠️ `If-Match` ETag（**ETag 一致性看实现**）；`LOCK`/`UNLOCK`（**支持极不一致**：Nextcloud 有，很多没有） |
| **列举** | ✅ `ListObjectsV2` | ✅ `list()` | ✅ `PROPFIND` |
| **是否计 fetch 子请求配额** | ✅ 计（走 `fetch()`）→ **50/1000 硬墙** | ❌ 原生 binding，**大概率不计** ⚠️verify → **绕过子请求墙** | ✅ 计（走 `fetch()`）→ **硬墙** |
| **多对象原子事务** | ❌ 无 | ❌ 无（但 DO 存储有） | ❌ 无（LOCK 是文件级） |
| **read-after-write 一致性** | ✅ 强一致（现代 S3/R2） | ✅ 强一致 | ⚠️ 看服务端 |

**风险点（必须处理）**：**clone 读到"半个 pack"**——若并发 push 正在重写 pack，reader 可能读到上传到一半的对象。缓解：pack 写到临时名 `.pack.tmp`，写完 + 校验后再 `rename`（对象存储无真 rename，用 **copy+delete** 或 **写 `.pack.<newsha>` + 更新索引原子指向**）。R2/S3 强一致 read-after-write 保证了"索引指向新 pack 后立即可见整包"。

---

## 5. 四个架构方案（每个都做了对抗性审视）

### 方案 A：isomorphic-git 作为引擎
纯 JS git，有可插拔 `backend`/`fs` 接口，可在 Worker 里跑（无 Node fs）。Worker HTTP handler 把 smart-http 端点翻译成 isomorphic-git 调用，存储经 backend 适配。
- ✅ 协议正确性"白送"（库已实现 pkt-line/upload-pack/receive-pack 的核心逻辑）。
- ⚠️ 它做**逐对象 I/O 经 backend**——子请求问题仍在（除非 backend 是 R2 原生 binding）。
- ⚠️ 服务端 server 模式的成熟度 < 客户端模式；大仓库性能未经大规模验证。
- 判定：**作为引擎可用，但要么配 R2 binding 要么配预生成 pack，否则子请求墙过不去。**

### 方案 B：自研最小 smart-http（不依赖完整 git 库）
自己实现 pkt-line 帧 + ref 广告 + upload-pack 协商 + 复用已有 pack 的对象抽取，存储直读。
- ✅ 完全掌控 CPU/子请求预算，能精确做"整包快路径"。
- ⚠️ 协议细节极易出错（flush/delim/response-end pkt、side-band 多路复用、thin-pack delta 基链）。
- 判定：**MVP 优先只做读路径（clone/fetch/ls-remote），把 push 留到后期。复杂度"高"。**

### 方案 C：纯 Dumb HTTP 协议
只按静态文件提供：`HEAD`/`info/refs`/`objects/<sha2>/<sha38>`/`objects/info/packs`/`objects/pack/*.pack|idx`/`objects/info/alternates`。无协商，客户端可能多拉对象，但**极简单、CDN 友好**。
- ✅ Worker 几乎只是路径改写 + Range 代理到 S3/R2；CPU 接近 0；最适合**公开只读镜像**。
- ❌ **Dumb 协议不支持 push**。要支持写，得另开一个自定义端点跑 receive-pack，或走带外 push 再同步——半残。
- 判定：**读为主场景的最省事方案；纯只读镜像的最佳选择。**

### 方案 D：Durable Object 做仓库级引擎 + 外部可插拔存储
**每仓库一个 DO**：DO 是单线程 actor = 天然互斥 = push 串行化 + ref 多键原子更新（`ctx.storage.transaction()`）。refs/锁/`packed-refs` 放 DO 存储；loose object/pack 放外部存储（R2/S3/WebDAV）。
- ✅ **干净解决 push 原子性**——这是纯 S3/WebDAV 最头疼的点。
- ✅ 读路径可绕开 DO：clone/fetch 直接走"读路径 Worker + R2"，DO 只在 push/写 ref 时介入，避免 DO 单 actor 成为读瓶颈。
- ⚠️ DO 冷启动 / 休眠唤醒有延迟；高频读需旁路。
- ⚠️ DO 存储有自身容量/计费，超大仓库 metadata 全塞 DO 不划算——只放 refs/索引。
- 判定：**生产可写的正确架构。**

### 对抗性综合（每方案的残留风险）

| 方案 | runtime-limits | protocol-correctness | concurrency-atomicity |
|---|---|---|---|
| A isomorphic-git | risky（子请求/CPU，除非配 R2+预生成pack） | feasible（库兜底） | risky（push 原子性需补） |
| B 自研 | risky（CPU on deltify） | risky（自研易错） | risky（同上） |
| C Dumb | **feasible**（几乎零 CPU/子请求） | feasible（协议极简） | blocked（无 push） |
| D Durable Object | feasible（DO 内 CPU 限制更宽）⚠️verify | 视引擎 | **feasible**（事务兜底） |

---

## 6. 推荐架构（组合，不是单选）

> **Durable Object（每仓库：锁 + ref 权威）+ 引擎（isomorphic-git 或自研）+ R2 为主存储 + S3/WebDAV 可插拔 + 预生成 pack 的 clone 快路径。**

```
                    ┌─────────────────────────────────────────┐
   git client ──►   │  Worker (fetch entry, routing by /<repo>) │
                    │  读路径：直连存储（clone 快路径吐预生成pack）│
                    │  写路径：路由到该仓库的 Durable Object       │
                    └───────────┬─────────────────────────────┬──┘
                                │ ref CAS / 串行化 push         │ 流式读
                                ▼                               ▼
                  ┌──────────────────────┐       ┌──────────────────────────┐
                  │ Durable Object /repo │       │ StorageBackend (可插拔)   │
                  │  · refs/packed-refs   │       │  · R2Backend (原生, 默认) │
                  │    in tx storage      │       │  · S3Backend (fetch)      │
                  │  · 串行 receive-pack  │◄──────│  · WebDavBackend (fetch)  │
                  │  · 引擎组装 pack       │  I/O  └──────────────────────────┘
                  └──────────────────────┘
```

**职责切分**：
- **Worker**：路由 + smart-http 端点骨架 + **读快路径**（clone 直接流式吐 R2 里的预生成 pack，不经 DO，零互斥开销）。
- **Durable Object**：`refs`/`packed-refs`/锁放事务存储；**所有写（push）经此串行化**；hold ref 权威，引擎向它查/改 ref。
- **引擎**：pkt-line/upload-pack/receive-pack 的协议实现（isomorphic-git 起步，性能热点处自研替换）。
- **StorageBackend**：下面第 7 节定义的接口；R2/S3/WebDAV 三实现。

**为什么是这个组合**：
- DO 解决唯一真正的并发硬骨头（原子 push），对应方案 D 的"feasible"。
- 读快路径 + R2 原生 binding 解决子请求与 CPU（全量 clone 近乎零 CPU、不计子请求），对应方案 C 的"feasible"。
- isomorphic-git 起步省协议坑，对应方案 A 的"feasible"。
- 比纯 A/B 多了原子性；比纯 C 多了 push；比纯 D 多了读路径可扩展性。是各方案长处的并集。

---

## 7. 存储后端抽象接口（可直接实现）

```ts
interface StorageBackend {
  /** 读对象/pack/refs 字节；range 用于对 .pack 做随机切片 */
  get(path: string, range?: { start: number; endExclusive?: number }):
    Promise<ReadableStream | Uint8Array | null>;

  /** 写字节（对象/pack/临时文件）；ifMatch / ifNoneMatch 提供原子 CAS（ref 用） */
  put(
    path: string,
    body: ReadableStream | Uint8Array,
    opts?: { ifMatch?: string; ifNoneMatch?: string; contentType?: string },
  ): Promise<{ etag: string }>;

  /** ref 专用 CAS：仅当当前内容等于 expected（null=不存在）才写成 desired */
  cas(path: string, expected: string | null, desired: string): Promise<boolean>;

  /** 枚举前缀下子项（objects/pack/*、refs/*、objects/??/*） */
  list(prefix: string): Promise<{ name: string; size: number; etag?: string }[]>;

  /** 取元信息（HEAD/refs 枚举、ETag） */
  head(path: string): Promise<{ etag: string; size: number } | null>;

  /** 可选：对无 CAS 的后端（弱 WebDAV）提供咨询锁；或委托给 DO */
  lock?(key: string, ttlMs: number): Promise<{ token: string } | null>;
  unlock?(key: string, token: string): Promise<void>;
}
```

三个实现 + 一个锁权威：
- `R2Backend`：原生 binding，`onlyIf`/`range`；**默认后端**。
- `S3Backend`：`fetch()` 造 SigV4 签名，`If-Match` 做 CAS，`ListObjectsV2`。⚠️受子请求配额约束 → **仅与"整包预生成"策略兼容**。
- `WebDavBackend`：`fetch()` + `PROPFIND`/`PUT`/`If-Match`/`LOCK`（LOCK 支持与否探测，不支持则报错或降级）。
- `DurableObjectLockAuthority`：包装任意上述后端，用 DO 事务把 ref 更新提升为真原子；当后端 CAS 不可靠（弱 WebDAV）时启用。

---

## 8. 各 Git 操作可行性一览

| 操作 | 判定 | 说明 |
|---|---|---|
| `git ls-remote` | ✅ 轻松 | 仅读 ref，几次读 |
| `git clone`（全量） | ✅ 可行 | 读预生成 pack + ref 广告；R2 下近乎原生 |
| `git fetch`（增量） | ⚠️ 可行、较贵 | 逐对象组装 delta；CPU/IO 随新增对象涨 |
| `git pull` | 同 fetch | working-tree 在客户端 |
| `git push` | ⚠️ 需 DO | 收包→解包→原子更新 ref；DO 或后端 CAS |
| `push` 到无 CAS 的 WebDAV | ❌/⚠️ 阻塞 | 无 LOCK 又无可用 ETag → 需外部锁权威（DO）兜底 |
| shallow clone（`--depth`） | ⚠️ 部分 | shallow cut 逻辑复杂；MVP 跳过 |
| protocol v2（`ls-refs`/`fetch`） | ⚠️ 可选 | 更干净但实现更多；先做 v0/v1 |
| LFS | 🔵 正交 | LFS 本质就是 HTTP Range 取大对象，易做，独立模块 |

---

## 9. 现实边界（哪里会撑爆）

- **仓库大小**：R2 里 ~500MB–1GB pack 舒适；再大走预生成 pack + Workflows 异步 repack。
- **全量 clone** ~100MB 仓库（预生成 pack）：CPU 几乎为 0（基本只是流式转发），**轻松**。
- **增量 fetch/push** 触及数千对象的 deltify：可能顶到付费 **30s CPU**；缓解 = 分块、卸到 Workflows、或预先 repack。
- **子请求**：经 R2 原生 binding **大概率不受 50/1000 限制**（⚠️verify）；经 S3/WebDAV `fetch()` **必受限制** → 必须整包策略。
- **push 并发**：每仓库由 DO 串行化 → 小团队够用，**不是高吞吐写分片**。

---

## 10. 硬阻塞（真正做不了的）

1. **无原生 git 二进制 / 无 fork**：不能 `spawn('git')`，必须纯 JS。（约束，非阻塞——isomorphic-git/自研可解。）
2. **弱 WebDAV 的并发 push**：服务端既无 LOCK 又无稳定 ETag 时，**没有原生 CAS** → 并发 push 有丢失更新风险，必须上外部锁权威（DO）。这是唯一"特定后端阻塞"场景。
3. **超大仓库的增量 fetch CPU**：Linux 内核级，单请求内 deltify 不现实 → 需 Workflows 异步重建 + 只走整包路径。能做但不是"开箱即用"。

---

## 11. MVP（最紧、但真能用、标准 git 客户端能连）

> **只读 smart-http clone（仓库预置在 R2）+ ls-remote。**

1. 在 R2 里放一个真实仓库（loose objects 或一个 `.pack`+`.idx`，加 `refs/*` 与 `HEAD`）。
2. Worker 实现：`GET /<repo>/info/refs?service=git-upload-pack`（pkt-line ref 广告）+ `POST /<repo>/git-upload-pack`（全量 clone → 直接流式吐 pack）。
3. `git clone https://<worker>/<repo>` 能成。
4. 成功后再加：增量 fetch → push（DO + CAS）→ S3/WebDAV adapter → shallow/v2。

---

## 12. 实施路线图

1. **P0 探针（先验证支点）**：① 确认 R2 原生 binding **不计** fetch 子请求配额（写个小 Worker 做 2000 次 `env.R2.get()` 看是否触发 1000 上限）；② 确认 R2 条件写 `onlyIf`/`If-Match` 的可用性与语义；③ 确认付费 CPU 是否可调高到你需要的天花板。**这三项任一翻车都会改方案。**
2. **MVP 读路径**：如上第 11 节，跑通全量 clone + ls-remote（R2）。
3. **增量 fetch**：在引擎里实现 want/have + 逐对象组装（先 loose，后 pack Range 读）。
4. **push + DO**：建 Durable Object，receive-pack 解包 + 事务式 ref 更新；先 R2 CAS，再抽象。
5. **抽 StorageBackend 接口**：把 R2 实现重构为 `R2Backend`，加 `S3Backend`/`WebDavBackend`。
6. **预生成 pack 快路径**：push 后异步（Workflows）repack，clone 直读整包。
7. **健壮性**：临时名写 pack + 原子切换（防半包读）；shallow；protocol v2；LFS。

---

## 13. 待原型验证的开放问题

- R2 原生 binding 到底计不计子请求？（决定 R2 是否"无限对象读"）
- isomorphic-git 在 Worker 里 server 模式的真实性能/内存占用？（决定要不要替换为自研引擎）
- 全量 clone 直接吐"预生成整包"时，标准 git 客户端是否完美接受（含 pack 内含客户端 want 之外对象的情况）？
- 弱 WebDAV 服务端的 LOCK/ETag 实际行为矩阵？（决定 WebDAV 是否需要强制 DO 锁）
- 单请求 CPU 调高的实际上限与计费？（决定大 fetch 是否必须卸到 Workflows）

---

## 附：先验直觉 vs 本报告结论的修正

我开跑前的直觉判断（"部分可行、R2 优先、DO 解决原子性、子请求是 S3/WebDAV 的死穴"）**经分析全部成立，未需修正**。报告把它们落实成了可实现的接口、MVP 与路线图，并补全了"全量 clone 吐预生成整包"这条让 CPU 归零的关键快路径。
