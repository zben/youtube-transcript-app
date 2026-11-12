# YouTube 对话深度总结与章节 5W1H 精读

输入一条 YouTube 链接，服务端抓取官方简介/时间戳与全文字幕，用 Gemini **流式**生成结构化中文深度总结；总结落库后，每个章节可按需点击 `[5W1H]` 提取 Who/What/When/Where/Why/How 并持久化。

一套 Hono 路由，两个运行时：本地 Node + `better-sqlite3`，云端 Cloudflare Workers + D1。存储层是同一个 `VideoRepository` 接口的两份实现（`src/repositories/sqlite.ts`、`src/repositories/d1.ts`），API 与前端完全复用。表结构见 `migrations/0001_init.sql`（`videos` / `transcripts` / `summaries` / `chapter_5w1h`）。

---

## 1. 本地运行

```bash
npm install
npm run dev               # tsx watch src/node-main.ts → http://localhost:3030
```

`.env`（自行创建，已 gitignore）关键变量：`PORT`（默认 3030）、`GEMINI_API_KEY`、`HTTPS_PROXY`/`HTTP_PROXY`（可选，`node-main.ts` 会用 `undici` 的 `EnvHttpProxyAgent` 接管全局请求，并显式放宽 10s 默认连接超时）。数据写入 `data/app.db`。

### 1.1 运行测试

```bash
npm test              # 15 个用例，约 0.3s
npm run test:watch    # 改动文件即时重跑
npm run typecheck     # tsconfig 已包含 test/，测试代码本身也受类型检查
```

零额外依赖：Node 内置 `node:test` + 项目已有的 `tsx` 作为加载器，**不需要网络、不需要 API Key、不碰 `data/app.db`**：

- `test/api.test.ts`——用 `test/helpers/fake-repo.ts` 这份内存仓储直接驱动 `createApp()` 路由契约：缓存命中必须不回读总结、参数校验必须先于 SSE 建流、清除接口要报出删掉的行数且可重复调用、以及「视频存在但没有总结」这条 5W1H 失败路径的完整响应体。
- `test/parsing.test.ts`——纯函数：链接形态识别（含 `shorts`/`live`/`embed`/带 `list=` 的乱序 query）、HTML 实体还原、模型返回 JSON 的容错解析与「该重试 vs 该兜底」的分界、章节标题归一化匹配。

故意没覆盖的部分见 7.8。

## 2. 在 Cloudflare 上测试与部署

本仓库以 **Workers + Static Assets** 形态部署（`wrangler.toml` 的 `[assets]` + `run_worker_first`），不是 Pages：静态文件与 API 同源，`/api/*`、`/summary/*`、`/video/*` 优先打到 Worker。

```bash
npx wrangler login
npx wrangler d1 create youtube-transcript-d1     # 把返回的 database_id 写进 wrangler.toml

npm run db:migrate:local                         # 本地预览用的 D1（.wrangler/state）
cp .dev.vars.example .dev.vars                   # GEMINI_API_KEY
npm run dev:worker                               # http://127.0.0.1:8787，真实 Worker 运行时 + 本地 D1

npm run deploy                                   # 线上
npx wrangler secret put GEMINI_API_KEY
npm run db:migrate:remote
```

把本机已有数据带上云端（源库只读，超长字幕按 <90KB 自动分块）：

```bash
npm run d1:export && npm run d1:seed:remote
```

部署后的冒烟测试（不消耗 Gemini 配额，只读库；生成过的视频可离线验证）：

```bash
# 你的 Worker 访问地址由 `npm run deploy` 输出（形如 https://<name>.<你的账号前缀>.workers.dev）
BASE="<https://...workers.dev>"                                # 不要把这个地址写进仓库
curl -s "$BASE/api/summary/<videoId>" | head -c 300
curl -s -X POST "$BASE/api/5w1h" -H 'Content-Type: application/json' \
  -d '{"videoId":"<videoId>","sectionHeading":"<某个已生成总结的章节标题>"}'
npx wrangler tail                                               # 实时日志（含 requestId / stage）
npx wrangler d1 execute youtube-transcript-d1 --remote \
  --command "SELECT youtube_id FROM videos;"                    # 直接查库
```

> ⚠️ `*.workers.dev` 域名没有访问控制，知道链接的人可读取甚至清除数据行；对外分享前请先给 `/api/*` 加鉴权。

---

## 3. 如何获取和处理 YouTube 字幕

`src/utils/youtube.ts`，两条独立通道，都包在 `retryWithBackoff`（指数退避 + jitter）里：

1. **官方元数据**：直接 `fetch` watch page HTML，正则取 `<title>`、`"shortDescription"`（JSON 反转义，保留嘉宾名单与时间戳原文）、`"author"`。12s `AbortController` 超时、2 次重试，**失败降级为空元数据而非报错**——字幕比简介重要。
2. **字幕轨道**：`youtube-transcript` 包，先试 `lang: 'en'`，失败回落到视频原语种；3 次重试，但对 `transcript is disabled` / `video is unavailable` 这类**确定性错误直接放弃**，不浪费退避时间。

处理：逐段 `trim` 去空后 `join(' ')` 成一整块纯文本（不保留逐句时间戳，交给 Prompt 里的官方时间戳去对齐章节），长度 <10 字符按 `NO_TRANSCRIPT` 报 422。

纯文本进 `transcripts` 表缓存，同一视频再次生成**完全不碰 YouTube**（`src/app.ts:213`）。

**Workers 上的关键坑**：平台 `fetch` 的出口 IP 段被 YouTube 判为低信誉（watch page 429、innertube `LOGIN_REQUIRED`），而 `cloudflare:sockets` 的 TCP 出口是另一个前缀，仍能拿到 ASR 自动字幕轨道。`src/utils/socket-fetch.ts` 因此用 `connect({hostname, port:443}, {secureTransport:'on'})` 手写 HTTP/1.1（直连真实域名所以 SNI 正确；workerd 的 `startTls()` 无法覆盖 SNI，代理隧道方案走不通），自行处理 chunked / gzip / 重定向 / `content-length`。`worker-main.ts` 用 `withSocketEgress(fetch)` **只把 youtube.com / youtu.be 改道**，Gemini 仍走平台 `fetch`，socket 出错自动回落。

## 4. 如何调用 Gemini 并实现流式输出

`@google/genai/web` + `gemini-3.8-flash`（`src/app.ts:142` 起，`hono/streaming` 的 `streamSSE`）：

- `generateContentStream` 的**发起**阶段包 3 次重试（429/5xx/网络抖动可重试）；一旦开始吐字就不重连，因为半路重放会重复内容。
- `for await (const chunk of responseStream)`：`chunk.text` 一路累加进 `fullMarkdown`，同时以 `data: {"text":"..."}` 逐块推给前端；前置 `connected` / `fetching_transcript` / `ready` 状态事件，最后 `data: [DONE]`。
- 前端 `public/app.js` 用 `fetch` + `ReadableStream` 读取 SSE（EventSource 不支持 POST），边收边 `marked` 渲染。
- **客户端提前断连**：`stream.onAbort()` 置位后立即停止读流，但把已累加内容用 `ctx.waitUntil(saveSummary)` 写库——用户关掉页面也不白跑一次生成。
- **落库门槛**：无自定义要求且正文 >50 字符才写 `summaries`；流中途异常时 >100 字符的**半成品也会存**，并在错误事件里带 `partialAvailable`。
- 二次请求同一视频直接走缓存命中路径，把库里的 Markdown 原样流回（<10ms 首包）。

## 5. 如何根据用户生成要求影响输出结果

前端可选输入框（≤1000 字符，`public/index.html`）→ `POST /api/summarize-stream` 的 `instruction` 字段 → `normalizeInstruction()` 截断 → `buildSummaryPrompt()`（`src/prompts.ts:36`）。

设计上把用户要求定位为**范围约束（scope），而不是追加格式规则**：

- Prompt 里列出四个维度（任务类型 / 输出风格 / 目标受众 / 约束条件），并明确「与默认结构规范冲突时一律以用户要求为准，可以完全改变结构形态」。
- 「不得超出用户设定的范围」——不加用户排除的内容，不在要求之外自行扩写章节或附录。
- 未提及的维度沿用金标准默认规范（`#` 总标题 / `##` 大主题 / `###` 子议题、问答颗粒度、对齐官方时间戳）。
- 两条不可覆盖的质量底线：不虚构事实、发言人必须用官方简介里的真实姓名。
- 要求原文用 `"""` 包裹并声明为「数据」，降低 Prompt 注入面；输出不得复述或评价要求本身。

**要求生成的结果不写库**（`src/app.ts:290`），一次性产物不污染该视频的权威总结，后续 5W1H 仍基于默认总结。

## 6. 如何实现章节级 5W1H 总结

`POST /api/5w1h { videoId, sectionHeading }`，三层递进：

1. **先查库**：`repo.get5W1H()` 命中就直接返回。因为章节标题在流式渲染时可能带 `一、`/`1.` 前缀或标点差异，`src/repositories/heading.ts` 做归一化（去前缀、去 `：: -_—·`、小写）后先精确再互相 `includes` 模糊匹配，SQLite 与 D1 共用同一份逻辑。
2. **再取服务端总结**：`repo.getSummary(video.id)`；**没有总结就报 404「该视频尚未生成完整总结」**——5W1H 只信任已落库的总结，不重新拉字幕。
3. **精准 Prompt**：`extractSectionFromSummary()` 用正则从 `## <标题>` 截到下一个 `##`，把「目标章节 + 完整总结 + 官方背景」三段一起交给模型（章节提供焦点，全文提供上下文与真实人名）；`responseMimeType: 'application/json'`；`parse5W1HJson()` 容错剥 code fence、取最外层 `{}`、去尾逗号、字段缺失 >2 项才判失败并触发重试。
4. 结果 `ON CONFLICT(video_id, chapter_heading)` 落 `chapter_5w1h`；`GET /api/summary/:videoId` 会连同 `fiveWoneHList` 一起返回，刷新页面后按钮自动变回 `5W1H ✓`。

按需生成而非一次生成全部章节：一次总结十几章，多数章节用户并不会看，逐章点击省掉了成倍的输出 token。

---

## 7. 主要工程取舍与亮点

### 7.1 可移植性：把「运行时差异」压缩进一层接口

- 业务代码只依赖异步 `VideoRepository`，Node 侧用 `better-sqlite3` 的**同步** API 再包成 Promise，Workers 侧用 D1 的 `bind().all()`。两条实现共享同一份路由、同一份 Prompt、同一份错误分类，迁移云端时**没有一行 endpoint 被改写**。
- DDL 只有一份语义：SQLite 与 D1 同为 SQLite 方言，`migrations/0001_init.sql` 与 `sqlite.ts` 的建表语句逐字段对齐，因此不存在「本地能跑、线上少列」这一类最难查的偏差。
- 章节标题归一化（`heading.ts`）抽成两份实现共用，避免本地命中缓存而线上重复调用模型。
- 代价：接口是异步的，本地多了一次无谓的微任务；换来的是单一代码路径，测试面减半。
- 前端**零构建**：原生 HTML/CSS/JS + 随仓库分发的 `marked.min.js`，无依赖树、无打包步骤，静态目录直接作为 assets bundle 上传。对一个单人维护的工具，省掉的构建链就是省掉的未来维护成本。

### 7.2 数据搬迁的正确性优先于便利性

`scripts/export-sqlite-to-d1.mjs` 把本地库导入 D1 时，处理的不是「拷数据」而是三个会静默丢数据的边界：

- **主键不通用**：两边各自生成 UUID，所以子表按 `youtube_id` 反查目标库已有的 `videos.id` 重新键定；若按本地 UUID 导入，行会变成孤儿，API 仍报「未处理」。
- **D1 单条语句 100 KB 上限**（`SQLITE_TOOBIG`）：超长字幕拆成一条 `INSERT` 首块 + 多条 `UPDATE` 追加块，每条都以「该列此刻应有的精确字符长度」作为守卫条件——重复导入时自动变 no-op，不会二次追加。
- **不可覆盖已生成的资产**：源库只读打开，视频行用 `COALESCE` 保留目标库更完整的标题/简介，子表 `INSERT OR IGNORE`。线上后来生成的总结永远不会被本地旧数据回退掉。

### 7.3 传输、成本与失败模式：按「外部依赖的脆弱程度」分层

`transcripts`（最容易失败）→ `summaries`（最贵）→ `chapter_5w1h`（按点击懒生成）。

- 传输选 SSE 而非 WebSocket：需求是单向逐块输出，`text/event-stream` 就够，省掉握手、心跳与升级链路，在 Workers 与本地代理下的兼容性也更稳。前端因此不能用 `EventSource`（只支持 GET），改用 `fetch` + `ReadableStream` 手动按 `\n\n` 切帧，并保留最后半帧在 buffer 里等下一个 chunk——**跨 TCP 分片的边界自己处理**。
- 重试策略按错误性质分流：`transcript is disabled`、无效 Key、模型 404 这类**确定性错误立即失败**，不烧退避时间；429/5xx/socket 抖动才指数退避，jitter 取 0.5–1.5 倍延迟避免同账号并发请求同时醒来。
- Gemini 流只对**发起阶段**重试：半路重放会让用户读到重复段落，宁可不重试也不破坏输出幂等性。
- 落库门槛 >50 字符挡住退化输出；流异常时 >100 字符的半成品照样入库并在事件里带 `partialAvailable`，前端把已收到内容渲染出来而不是扔掉——**失败也要留下可用产物**。
- 客户端提前关页面时停止读流但仍用 `ctx.waitUntil()` 落库：一次生成的 token 已经花了，没理由因为浏览器断开而作废。

### 7.4 事实来源与幂等

- 5W1H **只信任已落库的总结**（几千字）而不回读字幕（五万字）：输入规模下降一个量级，幻觉面收窄，且归纳结论与用户当时看到的正文严格一致。缺总结时抛显式 404 文案，而不是偷偷重新抓取——让不一致变成可见的前置条件。
- `ON CONFLICT(video_id, chapter_heading) DO UPDATE` 让重复点击天然幂等；`/api/summary/:videoId` 一次带回总结与全部已存 5W1H，刷新即恢复现场。
- 自定义要求产出的结果**不落库**：一次性视图与权威总结分开，避免用户随手一句「只要要点」把某视频的永久总结覆盖掉。

### 7.5 约束模型输入，而不是指望模型自觉

- 用户要求被定义为**范围约束**而非追加格式规则：允许完全改写结构，但未提及的维度沿用金标准默认；明确禁止扩写用户未要求的章节/附录，堵住「顺便多写点」这一类越界。
- 输入框 `maxlength=1000`，服务端再 `slice(0, 1000)` 截断——前端限制只是体验优化，**边界一律在服务端强制**。
- 要求原文用 `"""` 包裹并声明为待执行数据，配两条不可覆盖的底线（不虚构、发言人名必须来自官方简介），降低 Prompt 注入与「瞎猜嘉宾」两类失败。
- LLM 返回的 JSON 走容错解析：剥 code fence、取最外层 `{}`、去尾逗号、缺字段 ≤2 才判可用，否则触发重试——把模型输出当不可信输入处理。

### 7.6 非常规手段，但被严格限制在最小爆炸半径内

Workers 平台 `fetch` 的出口 IP 段已被 YouTube 判为低信誉（watch page 429、innertube `LOGIN_REQUIRED`），而 `cloudflare:sockets` 的 TCP 出口仍能拿到 ASR 字幕轨道。`socket-fetch.ts` 因此手写 HTTP/1.1 over TLS：

- 直连真实域名使 SNI 正确（workerd 的 `startTls()` 无法覆盖 SNI，代理隧道方案因此不可行）；`Connection: close` 下必须自己补 `content-length`，否则 innertube POST 会到达时为空。
- 自己处理 chunked 分帧、gzip（`DecompressionStream`）、重定向、8 MB 响应上限，并剥掉已失效的 hop-by-hop 头。
- **改道范围只有 youtube.com / youtu.be**，Gemini 仍走平台 `fetch`；socket 任何异常自动回落，包装层而非替换层——退化成「今天的坏行为」而不是「全线不可用」。
- 明确写清这依赖的是 YouTube 对该 IP 段的信誉判定，随时可能变；失效时的预案是本地生成后 `d1:export` + `d1:seed:remote`，而已缓存视频读写不依赖外网。

### 7.7 可观测性与安全边界

- 前端每次请求带 `X-Request-Id`，服务端透传进所有日志前缀（`[时间] [级别] [Req] [Video] [stage]`）与响应体的 `debug` 字段。用户截图里的 requestId 能直接在 `wrangler tail` / `node-dev.log` 里定位到同一次请求，**把「用户报障」变成可检索事件**；堆栈只留 4 行，日志量与可读性折中。
- 错误对用户说人话、对开发者留结构：`AppError` 携带 `code / statusCode / retryable / debug`，`classifyError()` 把 YouTube、GenAI、SQLite、网络四路异常归一。
- 所有 SQL 走参数绑定，无字符串拼接；`/api/summary/:videoId`、清除接口、SPA 深链都先校验 11 位 ID 正则；本地静态服务对 `..` 越界做前缀判定后才读文件。
- 静态资源与 API 同源部署，`run_worker_first` 用显式白名单，其余路径直接命中 assets bundle——不写转发规则，也就不出错。
- 测试打在**接缝**上而不是打在实现上：路由只认 `VideoRepository`，所以一份内存假仓储就足以锁死 HTTP 契约、缓存优先级和失败路径，不需要 mock 框架，也不需要密钥与网络。代价是外部服务链路无覆盖（见 7.8）；宁可接受这个缺口，也不写那种一旦断网就变噪音、最终被人顺手跳过的测试。

### 7.8 已知局限（有意为之的欠账）

- **无鉴权、无配额**：`*.workers.dev` 任何人可读可删；免费档最简路径，对外分享前必须补 `/api/*` 校验。
- **生成跑在请求内**：没有 Queues/Durable Objects，长视频受 Worker CPU 与 SSE 时长上限约束；同一视频双击会触发两次生成（D1 写入覆盖，不产生脏数据，但白花一次 token）。
- **章节以标题文本为键**：模型换措辞起标题会让旧 5W1H 成为孤儿记录，目前靠归一化 + 互相包含匹配缓解；彻底解法是引入稳定的章节 ID，代价是总结结构要带隐藏锚点，本次选择不做。
- **只缓存纯文本字幕**：丢弃了逐句时间戳与轨道语言信息，因此无法做「点击跳到视频对应位置」这类功能。
- **自定义要求的结果不可恢复**：不落库意味着刷新即失，这是为防止污染权威总结而接受的取舍。
- **测试覆盖的是契约，不是外部服务**：15 个用例全部离线（内存仓储 + 纯函数），因此 SSE 生成主链路、YouTube 抓取、socket 出口（依赖 `cloudflare:sockets`，Node 侧无法导入）与真实 D1 行为都不在覆盖范围内，仍需靠 requestId 日志与 `wrangler d1 execute --remote` 直查验证；测试清单见 1.1。

更详细的架构笔记、数据库 DDL、API 契约与历史 Bug 复盘见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
