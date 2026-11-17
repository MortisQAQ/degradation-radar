# 设计文档：怎么诚实地测「降智」

## 1. 问题定义

「降智」在日常语境里混着三件完全不同的事，混在一起测就永远测不出结论。

| 现象 | 真正的原因 | 该测什么 |
|---|---|---|
| 回答变短、变敷衍 | 编排层把请求路由到小模型 / 低思考预算 | 线上真实出现的 `model`、`thoughtsTokenCount` |
| 图崩了、代码跑不过 | 服务端真的退化（输出污染、近似 top-k、上下文路由错误） | 固定探针的确定性得分 |
| 干脆不干活，只回「计划已写好」 | **CLI 的模式 / 权限配置** | 运行参数（mode、权限、工具集） |

第三行是本项目第一天就踩到的坑，写在这里当警戒线。

## 2. 三条测量面

### 2.1 交付面：CLI 到底交了什么

后端起真实子进程：

- `agy --output-format stream-json --print-timeout 10m --model M --mode accept-edits -p PROMPT`
- `claude -p PROMPT --output-format stream-json --verbose --model M`
- `codex exec --json --skip-git-repo-check --sandbox read-only --cd DIR -m M PROMPT`

解析各自的 NDJSON 事件流，取最终文本、`usage`、以及 CLI 自己报告的模型名。

**关键细节：产物可能落在磁盘上，而不是聊天文本里。**
第一版只判 `text`，结果 `agy` 把 SVG 写进了工作区文件、聊天里只回「已生成」，
判分给出 `no-svg-element`——这是假阳性。现在每发探针前后对工作区做快照，
新增或改写过的 `.svg/.py/.json` 一并纳入判分：文件也是交付。

### 2.2 线缆面：上游到底回了什么

`src/capture/mitm.mjs` 是一个**观察型** MITM：

1. CLI 被注入 `HTTPS_PROXY=http://127.0.0.1:8899`，于是它对每个目标发 `CONNECT`。
2. 代理回 `200 Connection Established`，用本机 CA 签出的 leaf 证书**终止这一段 TLS**。
3. 代理再向**真实主机**另起一条独立 TLS 连接（`servername` = 真实域名，正常校验证书）。
4. 请求体、响应体、SSE 帧全部记录；`Authorization` / `Cookie` / API key 落盘前替换为 `<redacted>`。

ALPN 被**故意固定为 `http/1.1`**：上游都乐意说 h2，那样只能对着二进制帧发呆。
强制 h1 让每条请求、每个 SSE chunk 都是可读文本。代价是 CLI 那一跳不用 h2，对测量无影响。

这里没有任何请求被就地回答、改写或缓存，上游依然是真实那台机器。

### 2.3 路由面：真实服务你的模型是哪个

从 SSE 的 `usageMetadata` / 请求体的 `model` 抽真实模型名，与请求的模型对比。
这是本项目最有价值的一列，因为它直接暴露「你以为在用 A，其实被换成了 B」。

## 3. 本机实测证据（agy 1.5.10 / Windows）

### 3.1 agy 的出站域名

用只记录 `CONNECT` 的探针代理跑一发：

```
daily-cloudcode-pa.googleapis.com:443   <- 推理主通道（REST/JSON + SSE）
play.googleapis.com:443                 <- 遥测（大量 400，可忽略）
www.googleapis.com:443                  <- oauth2 userinfo
```

死代理实验同时证明 `HTTPS_PROXY` 生效：无代理时同一命令正常返回；带死代理时报

```
Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": Bad Gateway
```

### 3.2 推理请求长什么样

```
POST /v1internal:streamGenerateContent?alt=sse
body: { project, model, requestId, request: { contents, tools[14], sessionId } }
```

SSE 每帧形如：

```json
{"response":{"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"..."}]}}],
 "usageMetadata":{"promptTokenCount":21418,"cachedContentTokenCount":18432,"thoughtsTokenCount":113},
 "modelVersion":"gemini-4-hydrogen"}}
```

注意 `cachedContentTokenCount`：提示词缓存命中率是另一个可长期跟踪的退化信号。

### 3.3 一次运行里混着两个模型

单发 pelican 探针的抓包结果里，`streamGenerateContent` 出现了三条：

| model | 请求体 | 说明 |
|---|---|---|
| `gemini-4-hydrogen-high` | 85 KB | 主推理 |
| `gemini-3.5-flash-lite` | 12 KB | **隐藏的辅助调用** |
| `gemini-4-hydrogen-high` | 88 KB | 主推理续轮 |

只测 CLI 的输出文本，这条小模型调用完全不可见。它是否影响最终质量，取决于它承担的是
「标题生成」还是「计划/摘要」——所以要单独暴露路由列。

### 3.4 假阳性实录：`--mode plan`

| 运行模式 | 合格率 | 均分 | pelican 实际返回 |
|---|---|---|---|
| `--mode plan`（只读规划） | 1/4 | 28 | 「计划已写好，请确认风格」 |
| `--mode accept-edits` + 产物纳入判分 | **4/4** | **97** | 有效 SVG 文件 |

同一模型、同一分钟、同一探针，差 69 分全在运行参数上。所以每次运行都必须把 `argv`
与模式存进记录，否则事后无法区分「模型退化」与「参数退化」。

## 4. 判分口径

### 4.1 确定性 rubric

SVG 三维：结构 40（有 `<svg>`、未截断、标签平衡）、丰富度 35（元素数、标签种类、`path`、
圆或椭圆）、约束 25（`viewBox`、宽高、无 `<script>` / `on*=` / 外链）。合格线：可解析、
无夹带、≥60 分。

JSON：可 parse 40 分，四字段每个 12 分，无代码围栏再 +12。
数值：首个数字命中得 100，埋在散文里得 55。
代码：抽函数进临时进程跑 5 个用例，全过才合格。

### 4.2 统计纪律

- 主指标 = 首次交付合格率（超时、截断、拒答、空交付都算失败）。
- 基线用**滚动尾部窗口**（默认前 5 轮，至少 3 轮），绝不用「未来的运行」做基线。
- 单轮不下结论；置信区间与显著性检验属于消费端逻辑，不在采集端做。
- `not-authenticated` 与基础设施错误单独计数（`infraBlocked`），不参与合格率——
  否则一个过期 token 会变成「100% 降智」。

## 5. 各 CLI 的注入点

| CLI | 代理 | 证书信任 | 原生取数 | 备注 |
|---|---|---|---|---|
| `agy` | `HTTPS_PROXY`（实测通过） | 系统根证书库（Go） | 无 body 级 telemetry；`--log-file` 改日志路径，日志含每条出站 URL | Windows 上是 `.exe` |
| `claude` | `HTTPS_PROXY` | `NODE_EXTRA_CA_CERTS`（Node） | `OTEL_LOG_RAW_API_BODIES=file:<dir>` 可落原始 Messages 请求/响应 | Windows 上是 `.cmd` shim，必须经 `cmd /c` |
| `codex` | `HTTPS_PROXY` | `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`（Rust 不读系统库） | `RUST_LOG=debug`；请求体可能是 zstd | Windows 上同样是 `.cmd` shim |

## 6. 已知假阳性（按踩坑顺序）

1. **只读模式当探针** —— 模型「不干活」被判成降智。已改可写并记录 argv。
2. **只看聊天文本** —— 落盘产物被忽略。已加入工作区快照。
3. **未登录被当降智** —— 已识别 `not-authenticated` 并从合格率中隔离。
4. **Windows `.cmd` shim** —— `spawn claude ENOENT`。已按扩展名走 `cmd.exe` 并做参数引用。
5. **代理未生效时静默降级** —— 若某发没抓到流，UI 明说「这一发没经过抓包代理」，
   而不是给一个看起来正常的空流量面板。

## 7. 视觉裁判（为什么必须有眼睛）

rubric 能回答「这是不是一个格式正确、结构完整的 SVG」，回答不了「这是不是一只鹈鹕在骑车」。
这两件事的差距是实测出来的：

| 探针 | rubric 分 | 视觉分 | 判官原话 |
|---|---|---|---|
| pelican-bicycle | 76 | **33**（1/1/0） | 「两只简单鸟形带楔形喙，立在最简两轮车架上；没有合理骑姿」 |
| pelican-tractor | 87 | **50**（1/1/1） | 「鸟没有喉囊；方正车体带轮；鸟坐在上方但没有操控动作」 |

rubric 说 76/87（很棒），眼睛说 33/50（勉强）。差的那 40 分正是「像不像」。
所以 SVG 类探针的**主指标交给视觉模型**，rubric 退化成廉价闸门（截断/夹带/空文档先被它挡掉，
不必浪费一次多模态调用）。

### 7.1 流水线

```
SVG 产物 ──isolateSvg──▶ 只截取一段 <svg>…</svg> ──Chromium headless──▶ PNG
                                                                    │
                          deepseek-v4.1-flash（多模态，temperature 0）◀┘
                                                                    │
                      {pelican, vehicle, riding} ∈ {0,1,2} ──────────▶ 视觉分 = 和/6×100
```

判分维度固定三问：鹈鹕（真正的鹈鹕头/喙/喉囊）、载具（该载具的定义性部件）、骑姿
（是否真的坐在/踩在对应位置上）。`0=没有，1=有但残缺/不可辨，2=明确存在`。

### 7.2 三处必须钉死的地方

1. **裁判身份入档**：`judge = {kind, baseUrl, model, promptVersion}` 跟着每轮运行一起存。
   换裁判模型或改 prompt，新旧运行不可比——仪表必须能说出这件事，而不是画一条悬崖。
2. **判定不外包给第二个 LLM**：裁判已经把最难的部分（看见了什么）量化成三个整数；
   再问一次「所以算不算降智」等于让同一族模型给自己改卷，而且不可复现。
   聚合是算术，可审计；第二个意见不是。
3. **只取离散维度，不取散文**：实测判官会把红色车体说成绿色（见 pelican-tractor），
   但 `1/1/1` 是对的。分数只用 dims，`note` 只作为人看的解释。

### 7.3 接入方式

- 服务内：每轮跑完自动对 SVG 探针做渲染+判定，结果进 `probe.vision` 与 `summary.avgVisionScore`。
- 独立调用（给 DSH 子 agent 用）：`node scripts/judge.mjs --run <id> | --latest | --svg <file> --probe <id>`，
  输出一份 JSON（含每张图的维度分与最终 verdict），退出码 0 表示「测完了」，判成降智也算测完。

### 7.4 视觉环节踩出来的四个坑

1. **产物不在工作区**：agy 把 SVG 写进自己的 brain 目录（`~/.gemini/antigravity-cli/brain/<会话>/`）
   并在回答里给 `file:///...` 链接。只扫工作区 → 判定「没交付」→ 冤枉成降智 0 分。
   **正解是别让它自己选路径**：每个探针现在有独立的 scratch 目录，prompt 里点名
   `./pelican-tractor.svg`，产物直接落在我们手上。`file://` 反查降级为兜底，
   `scripts/backfill-artifacts.mjs` 负责把这类历史轮次从 brain 目录捞回来。
2. **`</svg>` 之后全是散文**：整段塞进 `<div>` 后浏览器把 Markdown 也画出来，判官如实回答
   「这张图只有文字」。产物一律截断到 `</svg>`。
3. **判官会复述 prompt 里的模板**：`"pelican": 0 | 1 | 2` 不是合法 JSON，第一版抓到它直接解析失败。
   现在扫描所有平衡的 `{}` 候选，只认三个字段都是数字的那个。
4. **思考链吃光 token 预算**：`max_tokens: 400` 时模型想完就没内容输出，`content` 为空，
   看起来像裁判拒答。抬到 1500，并在 `content` 为空时回落到 `reasoning_content`。

### 7.5 裁判自己的噪声

同一张图、同一 prompt、`temperature: 0`，两次调用给出不同结果：`pelican-bicycle` 一次
`1/1/0`（33 分），另一次 `1/1/1`（50 分）——`riding` 这一维在边界上会翻。

所以：

- 视觉分是**有噪声的信号**，单个 ±1 维度的跳动（约 ±17 分）不构成降智证据；
- 判定要吃**多轮/多次**的平均或中位数，`repeat` 参数就是为这个存在的；
- 这也是为什么 verdict 除了绝对分还要跟自身滚动基线比：边界抖动在基线里会被平均掉，
  而真正的退化不会。

### 7.6 成对比较：把「像不像」换成「差多少」

绝对评分没有锚点。同一张图、`temperature: 0`，两次调用能差 17 分（见 7.5），
而「58 分算不算降智」这个问题本身就没有答案。

改法是把参照图喂给判官，让它做两图对比，回答「相对同模型正常放开跑差多少」：

| gap | 含义 | 折算分 |
|---|---|---|
| `same_or_better` | 细节与结构相当 | 100 |
| `slightly_worse` | 认得出来，但更薄（缺件、形状粗糙） | 70 |
| `clearly_worse` | 主体勉强能看，主要部件缺失 | 40 |
| `unusable` | 画的不是要求的东西 | 0 |

参照来源：Simon Willison 的 [Gemini 4 SVG thinking-level comparison](https://static.simonwillison.net/static/2026/gemini-4-pelicans.html)，
取 `thinking=high × gemini-4-hydrogen`，逐字同一句 prompt。`scripts/fetch-baseline.mjs`
负责抓取、渲染并记录出处——图不入库，只入脚本，保证可追溯。

**实测差别很大**：改成成对之后，连着两发都是 `clearly_worse`（40 分），判词一致
（「crude duplicate icons; pelican and bicycle only barely recognizable」）；
而绝对模式下同一批图在 33/50/83 之间来回跳。

两条纪律：

1. **成对分与绝对分是两把尺子，不能混算**。运行记录里存 `judge.mode` 与
   `judge.baselineIds`，基线与健康分按模式分开成序列；混着算会凭空造出 ±20 分的漂移。
2. **只有有公开同模型参照的探针才做成对**。`pelican-bicycle` 有，
   skateboard / tractor / rocket 没有，就老老实实标「绝对分」，不假装有基准。

## 8. 尚未实现

- h2 / gRPC 上游（当前 ALPN 固定 h1，若某厂商强制 h2 会退化）
- 请求体压缩（zstd / gzip）自动解压后再记录
- 滚动窗口的显著性检验与 Wilson 区间（采集端只存原始数据）
- 定时任务、告警、多账号轮换
- Linux / macOS 的证书信任路径（目前只做过 Windows 实测）
