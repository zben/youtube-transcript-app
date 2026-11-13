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

故意没覆盖的部分见 9.2。

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

**带要求的产物一般不写库**（`src/app.ts:179` 的 `persistResult`），一次性视图不污染该视频的权威总结。**唯一例外**：该视频从来没有默认总结时，这一份会被采纳为默认总结——否则章节 5W1H 没有任何依据可用（见 6）。已有总结的视频，其总结永远不会被要求版覆盖。

## 6. 如何实现章节级 5W1H 总结

`POST /api/5w1h { videoId, sectionHeading, sourceMarkdown? }`，三层递进：

1. **先查库**：`repo.get5W1H()` 命中就直接返回。因为章节标题在流式渲染时可能带 `一、`/`1.` 前缀或标点差异，`src/repositories/heading.ts` 做归一化（去前缀、去 `：: -_—·`、小写）后先精确再互相 `includes` 模糊匹配，SQLite 与 D1 共用同一份逻辑。
2. **再定基准**：**屏幕上显示哪一版，就以哪一版为准**。默认视图交给 `repo.getSummary(video.id)`（**没有总结就报 404「该视频尚未生成完整总结」**）；如果用户正在看的是不落库的要求版，前端会把它的正文随请求带上（`sourceMarkdown`，服务端截到 200k 字符），此时跳过行缓存、也不写行缓存——变体推导出的答案若按普通章节标题入库，默认视图就会继承它。字幕始终不回读：归纳结论必须与用户看到的正文一致，而不是与五万字原始字幕一致。
3. **精准 Prompt**：`extractSectionFromSummary()` 用正则从 `## <标题>` 截到下一个 `##`（含其中的 `###` 子议题），把「目标章节 + 完整总结 + 官方背景」三段一起交给模型（章节提供焦点，全文提供上下文与真实人名）。这里踩过一个隐蔽的坑：正则的尾部原本写成 `(?=(?:^##\s+)|$)` 配 `m` 标志，`$` 会在**标题行行尾**就成立，惰性量符于是只截到标题一行——章节焦点事实上是空的，而且报错也看不出来。改成 `(?=\n\s*##\s|(?![\s\S]))`，并由 `test/parsing.test.ts` 锁住「正文要被带上、要在下一个 `##` 前停住」。`responseMimeType: 'application/json'`；`parse5W1HJson()` 容错剥 code fence、取最外层 `{}`、去尾逗号、字段缺失 >2 项才判失败并触发重试。
4. 默认视图的结果 `ON CONFLICT(video_id, chapter_heading)` 落 `chapter_5w1h`；`GET /api/summary/:videoId` 会连同 `fiveWoneHList` 一起返回，刷新页面后按钮自动变回 `5W1H ✓`。要求版的归纳是一次性的，刷新即失。

按需生成而非一次生成全部章节：一次总结十几章，多数章节用户并不会看，逐章点击省掉了成倍的输出 token。

---

## 7. 工程取舍

### 7.1 速度与效果：为了最佳效果，第一次生成刻意不是最快的

生成总结之前，服务端要先做两件「看起来只是在拖延」的事（`src/app.ts:186-224`）：

1. **抓官方元数据**：直接请求 watch page，取标题、频道/发布者与 `shortDescription`——简介里通常有主持人、嘉宾及其角色，还有创作者自己写的时间戳章节。12s 超时、2 次重试。
2. **抓全文字幕**：先试 `lang: 'en'`，失败回落视频原语种；3 次重试、指数退避。

- **两步串行是有意的**：元数据拿到后先 `upsertVideo` 落库，再去取字幕。这样即使字幕抓取最终失败，标题与简介也不会丢，下次重试不必再打一次 YouTube。代价很明确：首字延迟多出一次完整的 YouTube 往返。
- **不做分段摘要**：整块纯文本一次性进模型（`src/app.ts:254`）。切成小请求看起来能并行、能提速，但章节论点会跨段断裂，长视频很容易出现「每段都对、整体没主线」的输出。这里用一次调用的低首包速度换全局连贯。
- **元数据失败降级而非报错**（`src/utils/youtube.ts` 的 `fetchYoutubeMetadata` 兜底返回 `{title:'',description:'',author:''}`）：简介只是加分项，字幕才是硬前置，不让次要依赖拖死主流程。
- **5W1H 反过来选「小而准」**：只喂已落库的总结（几千字）+ 官方简介，不回读五万字字幕（`src/app.ts:382`）。输入规模降一个量级，既快又收窄了幻觉面，且归纳结论与用户当时看到的正文严格一致。
- 慢只发生在第一次：命中缓存时把库里的 Markdown 原样流回（<10ms 首包，`src/app.ts:164`），且字幕已缓存的重复生成**完全不碰 YouTube**（`src/app.ts:213`）。

**换来的效果**：发言人归属正确（ASR 字幕本身不带「这句是谁说的」）、章节与视频作者的划分对齐、全文逻辑连贯。**付出的速度**：全新视频要走完「元数据 → 字幕 → 模型」，明显慢于「把链接直接丢给模型」。

### 7.2 可维护性与易读性：一套路由，两个运行时

Hono 让 `src/app.ts` 同时跑在本地 Node 与 Cloudflare Workers 上：`app.fetch(Request)` 是纯函数接缝，`@hono/node-server` 与 `worker-main.ts` 各自只做适配。运行时差异被压进 `VideoRepository` 接口——Node 侧把 `better-sqlite3` 的**同步** API 包成 Promise，Workers 侧用 D1 的 `bind().all()`。

- **换来什么**：迁移云端**没有一行 endpoint 被改写**；Prompt、错误分类、章节标题归一化（`src/repositories/heading.ts`）各只有一份，SQLite 与 D1 共用，不会出现「本地命中缓存、线上重复调用模型」。本地 `npm run dev` 就能直接调试业务逻辑，不必把 Miniflare 塞进日常回路。测试只打在接缝上，一份内存假仓储（`test/helpers/fake-repo.ts`）就锁死 HTTP 契约、缓存优先级与失败路径，不需要 mock 框架、密钥与网络。
- **付出什么**：对不熟 Hono 的读者更抽象——`Request`/`Response` 代替 `req`/`res`、`streamSSE(c, async (stream) => ...)` 的回调式流控制、`ctx.waitUntil()` 的生命周期语义、`run_worker_first` 决定哪些路径先打到 Worker，都要先理解模型才读得懂代码。DDL 也只保留一份语义（同为 SQLite 方言，`migrations/0001_init.sql` 与 `sqlite.ts` 建表逐字段对齐），接口异步化让本地多了一次无谓的微任务。
- **另一条路为什么没选**：本地 Express + 云端 Pages Functions 两套代码，每一边都更直白易读，但 6 个端点、错误语义、缓存优先级要各维护两份，改动面翻倍。最难查的事故恰恰是「本地能跑、线上少一列/多一层重定向」这类行为漂移——两套实现互不作为证据，测试也只覆盖其中一套。这里选择牺牲一部分即时可读性，换单一代码路径与一半的测试面。
- 传输层同一取舍的延伸：需求只是单向逐块输出，SSE 比 WebSocket 少掉握手、心跳与升级链路，在 Workers 与本地代理下更稳，代码也更短；代价是前端不能用 `EventSource`（只支持 GET），得用 `fetch` + `ReadableStream` 自己按 `\n\n` 切帧并保留半帧等下一个 chunk。

### 7.3 产品可用性与存储/缓存复杂度

系统对数据存储没有任何硬性要求，最省事的做法是让结果只活在浏览器内存里。仍然落库，是因为「可恢复」是好产品的底线体验：

- **URL 即状态**：生成后 `history.pushState` 写进 `/summary/<videoId>`（`public/app.js:402`），前后端都先校验 11 位 ID；刷新或浏览器前进后退时 `checkInitialRoute()`（`public/app.js:316-355`）直接读库，一次 `GET /api/summary/:videoId` 同时带回总结与**已点过的全部 5W1H**，按钮自动回到 `5W1H ✓`。
- **关掉页面、流中途报错都不白跑**：正文 >50 字符才落库（挡住退化输出）；异常时 >100 字符的半成品也存，并在错误事件里带 `partialAvailable`，前端渲染已收到的部分而不是扔掉；客户端提前断连时服务端停止读流但仍用 `waitUntil(saveSummary)` 写完（`src/app.ts:290-314`）。要说清楚的是：SSE 没有断点续传，刷新后看到的是**已持久化的那部分内容**，不是接着同一条流继续吐字。
- **读写可离线**：已缓存视频的读取不依赖外网，缓存命中路径连 Gemini 都不调用。
- **复杂度确实进来了**：多一套 `videos` / `transcripts` / `summaries` / `chapter_5w1h` 四表模型，UUID 主键 + `youtube_id` 业务键的双键设计（子表一律按内部 UUID 关联）；引入 D1 后同步 API 变成异步绑定，还带来单条语句 100 KB 的上限；`chapter_5w1h` 以 `(video_id, chapter_heading)` 为唯一键，于是章节标题成了语义键，必须靠归一化 + 互相包含匹配来命中。
- **缓存策略刻意简陋**：没有 TTL、没有版本号，「存在即权威」；视频改字幕或换语言轨道时靠显式清除接口重生成，而不是自动失效——不让一致性策略反过来污染读路径，也不为假想的并发付代价。

一旦决定存数据，就还得对「把数据搬到另一个运行时」负责。`scripts/export-sqlite-to-d1.mjs` 处理的不是拷数据，而是三个会**静默丢数据**的边界：

- **主键两边不通用**：SQLite 与 D1 各自生成 UUID，子表必须按 `youtube_id` 反查目标库的 `videos.id` 重新键定；照本地 UUID 导入只会造出孤儿行，API 仍然报「未处理」。
- **D1 单条语句 100 KB 上限**（`SQLITE_TOOBIG`）：超长字幕拆成一条 `INSERT` 首块 + 多条 `UPDATE` 追加块，每块以「该列此刻应有的精确字符长度」为守卫条件，重复导入自动变 no-op，不会二次追加。
- **不可覆盖已生成的资产**：源库只读打开，视频行用 `COALESCE` 保留目标库更完整的标题/简介，子表 `INSERT OR IGNORE`。线上后来生成的总结，永远不会被本地旧数据回退掉。

### 7.4 另外两笔值得记的账

- **非常规手段只给最小爆炸半径**：Workers 平台 `fetch` 出口被 YouTube 判为低信誉，`src/utils/socket-fetch.ts` 用 `cloudflare:sockets` 手写 HTTP/1.1 取字幕轨道，但 `withSocketEgress` **只改道 youtube.com / youtu.be**，Gemini 仍走平台 `fetch`，socket 任何异常自动回落——是包装层不是替换层，最坏退化成「今天的坏行为」而不是「全线不可用」。
- **零构建前端**：原生 HTML/CSS/JS + 随仓库分发的 `marked.min.js`，静态目录直接作为 assets bundle 上传。单人维护的工具，省掉的构建链就是省掉的未来维护成本；代价是没有类型检查与组件化，全靠 `app.js` 内部的分层自律。

---

## 8. 亮点

### 8.1 把 YouTube 官方简介当事实来源，而不是当装饰

ASR 字幕只有文本，不带「这句话是谁说的」，也不带作者的分段意图——这两件事只能从别处拿，而 `shortDescription` 恰好都有。

- **人**：主持人、嘉宾、他们的角色与机构（a16z 类访谈通常写成 "Marc Andreessen is joined by..."）。Prompt 把它列为硬约束：必须结合官方名单识别每句真实发言者，严禁脑补通用代称，多位嘉宾要按各自背景与语境区分（`src/prompts.ts:7`）。发言人归属错误是读者最容易一眼看出的错误，比措辞不佳更致命。
- **结构**：创作者自己写的时间戳大纲。Prompt 要求在有 timestamps 时**对齐官方章节主旨**组织 `##`，没有才自主划分 8–10 个大主题（`src/prompts.ts:11`）——等于借用作者本人的分段偏好当大纲，用户随后点击的章节名也就与视频里显示的章节一致，5W1H 才能对上号。
- 同一份简介在 5W1H 阶段再次注入（`buildFiveW1HPrompt` 的【视频官方背景与出场人物说明】），「谁说的」这条事实在两处一致，不由模型二次猜测。简介原文经 JSON 反转义保留换行与名单格式，不会被压成一行丢掉了时间戳结构。

### 8.2 异常处理：按错误性质分流，对用户说人话，对开发者留结构

- **确定性错误立刻失败**：`transcript is disabled` / `video is unavailable` 这类没有重试价值的错误直接放弃退避（`src/utils/youtube.ts:150-158`），无效 Key、模型 404 同理；429/5xx/socket 抖动才指数退避，jitter 取 0.5–1.5 倍延迟，避免同账号并发请求同时醒来。
- **流只在发起阶段重试**：Gemini 一旦开始吐字就不重连——半路重放会让用户读到重复段落，宁可不重试也不破坏输出幂等性。
- **四路异常归一**：`classifyError()` 把 YouTube、GenAI、SQLite、网络折叠成一个 `AppError`，携带 `code / statusCode / retryable / debug`；HTTP 状态与业务错误码分开（422 `NO_TRANSCRIPT`、404 `VIDEO_NOT_FOUND`、400 `INVALID_URL`），前端据此决定文案与是否显示「重试」按钮。
- **中文文案讲清因果与下一步**，例如「该视频已被创作者关闭或禁用了字幕功能，无法提取文字内容。」「YouTube 请求频次受限 (429 Too Many Requests)…系统已自动重试多次，请稍后再试或配置代理。」而不是抛 `Error: fetch failed`。
- **非致命写失败不炸主流程**：`upsertVideo`、`saveTranscript` 的异常只 `warn` 不抛（`src/app.ts:202,219`）——缓存层挂了不该让已经成功的生成失败。
- **可观测性**：前端每次请求带 `X-Request-Id`，服务端透传进日志前缀 `[时间] [级别] [Req] [Video] [stage]` 与响应体的 `debug` 字段；用户截图里的 requestId 能直接在 `wrangler tail` / `node-dev.log` 定位到同一次请求，堆栈只留 4 行。
- **顺序也是契约**：参数校验先于建流、先于任何数据库读，`test/api.test.ts` 里有断言锁死这一点，避免出现「错误体被 SSE 半帧吞掉」这种难复现的失败形态。

### 8.3 收窄 Prompt 注入面，而不是指望模型自觉

- 用户要求原文用 `"""` 包裹并显式声明为「用户提供的数据、作为规则执行」，同时要求输出不得复述、评价或解释要求本身（`src/prompts.ts:57-60`），降低「把要求当成新系统提示」的成功率。
- 要求被定位为**范围约束**而不是追加格式规则：允许完全改写结构，但明确禁止扩写用户未要求的章节/附录，堵住「顺便多写点」这类越界。
- 两条任何要求都不能突破的质量底线：不得虚构事实或编造数据、发言人必须用官方简介里的真实姓名。
- 边界一律在服务端强制：输入框 `maxlength=1000` 只是体验优化，`normalizeInstruction()`（`src/app.ts:25,101`）再截断一次；`/api/summary/:videoId`、清除接口、SPA 深链都先校验 11 位 ID 正则；所有 SQL 走参数绑定，无字符串拼接；本地静态服务对 `..` 越界做前缀判定后才读文件。
- 模型输出当不可信输入处理：`parse5W1HJson()` 剥 code fence、取最外层 `{}`、去尾逗号，缺字段 >2 项才判失败并触发重试。
- 要求版视图会把屏幕上的正文回传给 `/api/5w1h` 当基准，这份输入同样按数据对待：服务端 `slice(0, 200_000)` 限制体量，且不落库；官方简介仍是发言人的唯一来源，所以客户端文本改不动「必须用真实姓名」这条底线（实测一段完全虚构的正文，`who` 依然回到简介里的真实人物）。
- **注入的影响半径被持久化策略限制住**：带要求的生成不会覆盖已有的权威总结（`src/app.ts:179`），只在该视频从未有过总结时才被采纳，所以一条恶意要求最坏也只能决定「一份还不存在的总结」长什么样，改不动已经存好的内容，也不会经由 5W1H 二次放大给下一个读者。

### 8.4 持久化存储：状态可恢复，成本可复用

- 三层按「外部依赖的脆弱程度」各归其位：`transcripts`（最容易失败）→ `summaries`（最贵）→ `chapter_5w1h`（按点击懒生成）。
- 刷新即恢复现场：一次 `GET /api/summary/:videoId` 同时带回总结与全部已存 5W1H，不需要用户重跑。
- 已经花掉的 token 不作废：客户端断连、流中途报错都仍落库；缓存命中的首包 <10ms 且不产生任何模型调用。
- 按需生成而非一次生成全部章节：一次总结十几章、多数章节没人看，逐章点击省掉成倍的输出 token。
- 重复点击天然幂等：`ON CONFLICT(video_id, chapter_heading) DO UPDATE`，而不是攒出多份互相冲突的记录。

---

## 9. 已知局限

### 9.1 视频类型适配：默认规范是围着访谈类视频调的

金标准 Prompt 的全部假设来自 a16z 式多发言人访谈：`名字: 提问` / `名字: 回答` 的问答颗粒度、8–10 个宏观大主题、以官方时间戳对齐章节、发言人必须实名。换体裁就会失配：

- **调查报告 / 新闻解读**：价值在证据链、信源与时间线，「谁问谁答」并不存在，需要的是主张—证据—未证实的三分结构。
- **单人演讲 / keynote**：需要论点树与递进关系，强行套问答会削掉论证结构。
- **教程 / 操作演示**：应该产出可执行步骤、参数与坑，当前规范会把它写成「讨论」。
- **圆桌 / 多人面板**：实名归属依赖简介里的人物顺序与角色描述，嘉宾一多、简介一简略，归属准确率就明显下降。

真正的适配成本不在代码：`src/prompts.ts` 是单一定义点，按体裁分叉容易；难的是每种体裁都要人工反复校准出一份新的金标准，并用真实样本验收。本项目把时间投在访谈类，其余形式**尚未适配**，这是明确接受的缺口。

### 9.2 其他有意为之的欠账
- **无鉴权、无配额**：`*.workers.dev` 任何人可读可删；免费档最简路径，对外分享前必须补 `/api/*` 校验。
- **生成跑在请求内**：没有 Queues/Durable Objects，长视频受 Worker CPU 与 SSE 时长上限约束；同一视频双击会触发两次生成（D1 写入覆盖，不产生脏数据，但白花一次 token）。
- **章节以标题文本为键**：模型换措辞起标题会让旧 5W1H 成为孤儿记录，目前靠归一化 + 互相包含匹配缓解；彻底解法是引入稳定的章节 ID，代价是总结结构要带隐藏锚点，本次选择不做。
- **只缓存纯文本字幕**：丢弃了逐句时间戳与轨道语言信息，因此无法做「点击跳到视频对应位置」这类功能。
- **要求版的 5W1H 不入库**：以屏幕上的要求版正文为基准时，归纳结果同样是一次性产物（否则变体答案会被默认视图按同名章节继承）。代价是在那个视图里重复点同一章会重新调用模型，刷新后也要重新生成。
- **被采纳为默认总结的那一份可能没有章节**：用户要求可以完全改写结构（例如「只要 5 条要点」），此时它不含 `##` 大主题，前端就没有章节可点、5W1H 无从挂载。补救办法是再点一次不带要求的默认生成；本功能只保证「不会没有总结可用」，不保证采纳的产物适合被逐章拆析。
- **测试覆盖的是契约，不是外部服务**：15 个用例全部离线（内存仓储 + 纯函数），因此 SSE 生成主链路、YouTube 抓取、socket 出口（依赖 `cloudflare:sockets`，Node 侧无法导入）与真实 D1 行为都不在覆盖范围内，仍需靠 requestId 日志与 `wrangler d1 execute --remote` 直查验证；测试清单见 1.1。

更详细的架构笔记、数据库 DDL、API 契约与历史 Bug 复盘见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
