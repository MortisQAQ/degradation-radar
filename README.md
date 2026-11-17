# Degradation Radar

检测「订阅制大模型是不是变笨了」的本地仪表盘。

它不是反向代理。后端**直接启动真实 CLI**（`agy` / `claude` / `codex`），让它们照常连
Google / Anthropic / OpenAI 的真实上游；同一个进程以 `HTTPS_PROXY` 的形式在旁边做一次
**观察**，把请求原文和上游 SSE 回答录下来。判分只看两件事：CLI 最终交付了什么，
以及网线上真实返回了什么模型。

```
                    +------------------------------------------+
 浏览器 -- /api --> |  radar server (node)                     |
                    |   |- 探针队列（串行，一次一发）            |
                    |   |- 抓包代理 :8899（CONNECT + TLS 终止）  |
                    |   `- 确定性判分 + 基线对比                 |
                    +-------+----------------------+-----------+
                            | spawn                | HTTPS_PROXY
                            v                      v
                    真实 CLI 子进程 -------> 抓包代理 --TLS--> 真实上游
                    (agy/claude/codex)                            |
                            `---------- 交付物 --------------------'
```

## 为什么不做反代

反代会把「谁在服务你」这件事抹平：你测到的是转发层的实现，而不是订阅实际给你的东西。
而降智最常见的形态不是权重变了，是**编排层把你换掉了**。本项目实测就抓到：

> 一次 `agy` 运行里，除了 `gemini-4-hydrogen-high` 的主请求，
> 线上还出现了一条 `gemini-3.5-flash-lite` 的隐藏调用。

反代看不见这条。真实 CLI + 旁路抓包看得见。

## 快速开始

```bash
# 1) 生成本机 CA + 服务端证书，并把 CA 装进当前用户根证书区。
#    agy 是 Go（走系统证书库）；claude 是 Node（NODE_EXTRA_CA_CERTS）；
#    codex 是 Rust（CODEX_CA_CERTIFICATE）。三者都由服务端自动注入。
pwsh -NoProfile -File scripts/make-certs.ps1

# 2) 起服务（UI + 抓包代理）
node src/server.mjs
#   UI            http://127.0.0.1:7417
#   capture proxy http://127.0.0.1:8899

# 3) 打开 UI，选服务/模型/探针，点「跑一轮」
```

也可以纯命令行驱动：

```bash
curl -s localhost:7417/api/run -H 'content-type: application/json' \
  -d '{"provider":"agy","model":"gemini-4-hydrogen-high",
       "probeIds":["pelican-bicycle","json-strict","math","code-lis"],
       "repeat":1,"wait":true}' | jq .summary
```

## 探针

| id | 类型 | 判分方式 |
|---|---|---|
| `pelican-bicycle` | SVG | 逐字 `Generate an SVG of a pelican riding a bicycle.`；结构/丰富度/约束三维扣分 |
| `pelican-skateboard` / `-tractor` / `-rocket` | SVG | 同族变体，换题材不换口径 |
| `json-strict` | JSON | 禁止代码围栏，逐字段校验类型与数组长度 |
| `math` | 数值 | 唯一解，比较首个数字 |
| `code-lis` | 代码 | 抽出函数，在临时进程里跑 5 个用例 |

**判分是纯代码**，没有 LLM 裁判——裁判模型自己会版本漂移，那是让仪表凭空造出「降智」的经典方式。

主指标是**首次交付合格率**：超时、截断、拒答、什么都没交付都算失败，而不是「无数据」。
其次才是确定性分数、输出 token、思考 token、真实返回模型。

## 参照基准：和「正常水平」比，而不是凭空打分

绝对评分只能回答「像不像一只鹈鹕」，没有锚点，同一张图两次调用能差 17 分。
所以 `pelican-bicycle` 走**成对比较**：判官同时看参考图和被测图，回答「相对同模型正常
放开跑差多少」，映射成 `same_or_better 100 / slightly_worse 70 / clearly_worse 40 / unusable 0`。

参考图来自 Simon Willison 的
[Gemini 4 SVG thinking-level comparison](https://static.simonwillison.net/static/2026/gemini-4-pelicans.html)，
取 `thinking=high × gemini-4-hydrogen` 那一格（逐字同一句 prompt）：

```bash
node scripts/fetch-baseline.mjs     # 抓取 + 渲染 + 写 PROVENANCE.md
```

仓库不内置这张图（它是别人的产出），由脚本按来源重建，出处记在
`data/baselines/PROVENANCE.md`。只有 `pelican-bicycle` 有公开可比参照，
其余三个变体仍走绝对评分，界面上会标出用的是哪把尺子。

**两者不可混算**：成对分和绝对分是两条独立序列，基线与健康分都按判定模式分开统计。

## 视觉裁判：交给有眼睛的模型

rubric 只能判断「这是不是一个格式正确的 SVG」，判断不了「这是不是一只鹈鹕在骑车」。
所以 SVG 类探针的主指标交给多模态模型（默认 `deepseek-v4.1-flash`，走 OpenAI 兼容端点）：

```
SVG 产物 -> 截取单段 <svg> -> Chromium headless 渲染成 PNG -> 视觉模型
        -> {pelican, vehicle, riding} ∈ {0,1,2} -> 视觉分 = 和/6×100
```

同一张图两层打分能差 40 分，这不是 bug，是两把尺子量的是两件事：

| 探针 | rubric | 视觉 | 判官原话 |
|---|---|---|---|
| pelican-bicycle | 76 | **33** | 「两只简单鸟形带楔形喙…没有合理骑姿」 |
| pelican-tractor | 87 | **50** | 「鸟没有喉囊；方正车体带轮；鸟坐在上方但无操控动作」 |

裁判身份（endpoint / model / prompt 版本）会跟着每轮运行入档——换裁判或改 prompt 之后，
新旧运行不能直接比，仪表必须说出来。聚合判定是算术，不外包给第二个模型自评。

独立调用（给子 agent 或定时任务用，一条命令拿 JSON 结论）：

```bash
node scripts/judge.mjs --latest                       # 判定最新一轮
node scripts/judge.mjs --run <runId>                  # 判定指定一轮
node scripts/judge.mjs --svg out.svg --probe pelican-tractor
```

配置走环境变量：`RADAR_JUDGE_BASE` / `RADAR_JUDGE_KEY` / `RADAR_JUDGE_MODEL`。
裁判不可用时，确定性判分照常工作，UI 会明说「视觉裁判不可用」而不是给个假分数。

## 目录

```
src/capture/mitm.mjs   CONNECT 隧道 + TLS 终止 + 请求/SSE 记录（ALPN 固定 http/1.1）
src/providers/         三个 CLI 的 spawn 适配（含 Windows .cmd shim 处理）
src/probes/            探针定义与产物抽取
src/scoring/grade.mjs  确定性判分（SVG / JSON / 数值 / 代码）
src/judge/             视觉裁判：SVG->PNG 渲染、多模态判定、判定聚合
scripts/judge.mjs      单命令判定入口（子 agent / 定时任务用）
src/store.mjs          JSONL 运行日志 + 基线对比
src/server.mjs         HTTP + SSE + 串行队列
public/                单页仪表盘（无构建）
docs/DESIGN.md         设计文档：实测证据、口径、已知假阳性
```

## 安全说明

- `certs/` 是本机自签 CA 与带私钥的 leaf 证书，**已被 .gitignore 排除**。
  它只用于让本机 CLI 接受观察连接；不需要时从根证书区删掉即可。
- `captures/` 记录真实请求与回答，同样不入库。
- 抓包代理对上游仍然做正常证书校验，它不降低链路安全性，只是把「本机 -> 上游」
  拆成两段各自可信的连接。
- `Authorization` / `Cookie` / API key 类请求头在落盘前会被替换成 `<redacted>`。

## 已知局限

见 `docs/DESIGN.md` 的「已知假阳性」与「尚未实现」。一句话：单次运行不能下结论，
至少 3 轮建立起滚动基线之后，健康分才有意义。
