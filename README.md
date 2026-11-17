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

## 目录

```
src/capture/mitm.mjs   CONNECT 隧道 + TLS 终止 + 请求/SSE 记录（ALPN 固定 http/1.1）
src/providers/         三个 CLI 的 spawn 适配（含 Windows .cmd shim 处理）
src/probes/            探针定义与产物抽取
src/scoring/grade.mjs  确定性判分（SVG / JSON / 数值 / 代码）
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
