// Radar server: owns the probe queue, the capture proxy and the SSE feed.
//
// One deliberate constraint: probes run strictly one at a time. Parallel runs
// fight over quota, over the capture proxy and over wall-clock, and the
// resulting latency/noise makes a "degradation" out of nothing.
import http from 'node:http'
import { readFile, readdir, readFile as readFileAsync, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { startCapture } from './capture/mitm.mjs'
import { listProviders, runProbe } from './providers/index.mjs'
import { PROBES, DEFAULT_PROBE_IDS } from './probes/index.mjs'
import { gradeProbe } from './scoring/grade.mjs'
import { createStore, computeSeries, RUBRIC_VERSION, PROBE_SET_VERSION } from './store.mjs'

const PORT = Number(process.env.RADAR_PORT ?? 7417)
const CAPTURE_PORT = Number(process.env.RADAR_CAPTURE_PORT ?? 8899)
const ROOT = resolve(import.meta.dirname, '..')
const PUBLIC = join(ROOT, 'public')
const PROBE_CWD = process.env.RADAR_CWD ?? join(ROOT, 'data', 'workspace')

/**
 * Snapshot the probe workspace so we can tell what the CLI actually delivered.
 * A coding agent legitimately delivers by writing a file; scoring only the chat
 * text would mark that run as a failure and invent a degradation.
 */
async function snapshotDir(dir) {
  const out = new Map()
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = join(entry.parentPath ?? entry.path ?? dir, entry.name)
      try {
        out.set(full, (await stat(full)).mtimeMs)
      } catch {
        /* raced with a delete */
      }
    }
  } catch {
    /* missing dir = empty snapshot */
  }
  return out
}

/** Text of files created or rewritten during the probe. */
async function harvestArtifacts(dir, before) {
  const after = await snapshotDir(dir)
  const changed = []
  for (const [full, mtime] of after) {
    if (!/\.(svg|py|json|txt|md)$/i.test(full)) continue
    const prev = before.get(full)
    if (prev !== undefined && prev === mtime) continue
    changed.push(full)
  }
  changed.sort()
  const parts = []
  for (const file of changed.slice(-6)) {
    try {
      parts.push(await readFileAsync(file, 'utf8'))
    } catch {
      /* an unreadable artifact contributes nothing */
    }
  }
  return { text: parts.join('\n\n'), files: changed }
}

const store = createStore(join(ROOT, 'data'))
const runs = await store.load()

const capture = await startCapture({ port: CAPTURE_PORT, certDir: join(ROOT, 'certs'), captureDir: join(ROOT, 'captures') })
const flows = capture.flows
const flowIndex = new Map()
for (const f of flows) flowIndex.set(f.id, f)
capture.onFlow((f) => flowIndex.set(f.id, f))

/** Proxy env for every provider, so a probe from any CLI is captured. */
const CAPTURE_ENV = {
  HTTPS_PROXY: `http://127.0.0.1:${CAPTURE_PORT}`,
  HTTP_PROXY: `http://127.0.0.1:${CAPTURE_PORT}`,
  https_proxy: `http://127.0.0.1:${CAPTURE_PORT}`,
  http_proxy: `http://127.0.0.1:${CAPTURE_PORT}`,
  ALL_PROXY: `http://127.0.0.1:${CAPTURE_PORT}`,
  NO_PROXY: '',
  no_proxy: '',
  // Node-based CLIs (Claude Code) verify against this bundle, not the OS store.
  NODE_EXTRA_CA_CERTS: join(ROOT, 'certs', 'ca.pem'),
  // Rust-based CLIs (Codex) ignore the OS store entirely.
  CODEX_CA_CERTIFICATE: join(ROOT, 'certs', 'ca.pem'),
  SSL_CERT_FILE: join(ROOT, 'certs', 'ca.pem'),
  // Claude Code gzips request bodies; capture needs them legible.
  CLAUDE_CODE_GZIP_REQUEST_BODIES: '0',
}

// ------------------------------------------------------------------ SSE

const clients = new Set()
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

// ------------------------------------------------------------------ runs

let busy = false
const pending = []

function enqueue(job) {
  pending.push(job)
  void drain()
}

async function drain() {
  if (busy) return
  const job = pending.shift()
  if (!job) return
  busy = true
  try {
    await job()
  } finally {
    busy = false
    void drain()
  }
}

async function executeRun({ provider, model, probeIds, repeat, cwd }) {
  const run = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    provider,
    model,
    probeIds,
    repeat,
    cwd,
    rubricVersion: RUBRIC_VERSION,
    probeSetVersion: PROBE_SET_VERSION,
    probes: [],
    summary: null,
    status: 'running',
  }
  broadcast({ type: 'run-start', run })

  for (const probeId of probeIds) {
    const probe = PROBES[probeId]
    if (!probe) continue
    for (let i = 0; i < repeat; i++) {
      const flowStart = flows.length
      const before = await snapshotDir(cwd)
      let result
      try {
        result = await runProbe({
          providerId: provider,
          prompt: probe.prompt,
          model,
          cwd,
          env: CAPTURE_ENV,
          timeoutMs: Number(process.env.RADAR_PROBE_TIMEOUT_MS ?? 600_000),
        })
      } catch (err) {
        result = { text: '', error: String(err), usage: null, durationMs: 0, exitCode: -1, timedOut: false }
      }

      const capturedThisProbe = flows.slice(flowStart)
      const harvested = await harvestArtifacts(cwd, before)
      // Grade what was delivered, inline or on disk — a file IS a delivery.
      const delivered = harvested.text === '' ? result.text : `${result.text}\n\n${harvested.text}`
      const returnedModels = [
        ...new Set(
          capturedThisProbe
            .map((f) => f.reqSummary?.model)
            .filter((m) => typeof m === 'string' && m !== ''),
        ),
      ]
      const sseText = extractGeneratedText(capturedThisProbe)

      // Grade the CLI's own output. When the CLI returned nothing usable but
      // the wire shows a complete answer, that mismatch is itself a finding
      // (the orchestration layer dropped it) and is recorded separately.
      const grade = await gradeProbe(probe, delivered, result.error ?? result.stderrTail)
      const wireGrade = sseText !== null && sseText !== result.text ? await gradeProbe(probe, sseText) : null

      let artifactPath = null
      if (probe.kind === 'svg') {
        const svg = /<svg/i.test(delivered) ? delivered.slice(delivered.search(/<svg/i)) : delivered
        artifactPath = await store.saveArtifact(run.id, `${probeId}-${i}`, 'svg', svg)
      } else {
        artifactPath = await store.saveArtifact(run.id, `${probeId}-${i}`, 'txt', delivered)
      }

      const record = {
        probeId,
        label: probe.label,
        iteration: i,
        startedAt: new Date().toISOString(),
        text: result.text,
        deliveredFiles: harvested.files.map((f) => f.slice(ROOT.length + 1).split('\\').join('/')),
        grade,
        wireGrade,
        usage: result.usage ?? null,
        returnedModel: result.returnedModel ?? null,
        routedModels: returnedModels,
        finish: result.finish ?? null,
        error: result.error ?? null,
        timedOut: Boolean(result.timedOut),
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs ?? 0,
        stderrTail: result.stderrTail ?? '',
        artifactPath,
        flowIds: capturedThisProbe.map((f) => f.id),
      }
      run.probes.push(record)
      broadcast({
        type: 'probe-done',
        runId: run.id,
        probe: { ...record, text: record.text.slice(0, 20000) },
      })
    }
  }

  run.summary = summarize(run)
  run.status = 'done'
  run.finishedAt = new Date().toISOString()
  await store.append(run)
  broadcast({ type: 'run-done', run })
  return run
}

/** Text the upstream model actually produced, reassembled from the SSE frames. */
function extractGeneratedText(capturedFlows) {
  const gen = capturedFlows.filter((f) => f.respSummary?.kind === 'sse' && Array.isArray(f.respSummary.events))
  if (gen.length === 0) return null
  const parts = []
  for (const flow of gen) {
    for (const ev of flow.respSummary.events) {
      for (const cand of ev?.response?.candidates ?? []) {
        for (const p of cand?.content?.parts ?? []) {
          if (typeof p?.text === 'string' && p.thought !== true) parts.push(p.text)
        }
      }
    }
  }
  const text = parts.join('')
  return text.trim() === '' ? null : text
}

function summarize(run) {
  const list = run.probes
  const pass = list.filter((p) => p.grade?.pass).length
  const scores = list.map((p) => p.grade?.score ?? 0)
  const outputTokens = list.map((p) => p.usage?.output_tokens ?? p.usage?.output_tokens ?? p.usage?.completion_tokens ?? 0)
  const thinking = list.map((p) => p.usage?.thinking_tokens ?? 0)
  const latencies = list.map((p) => p.durationMs ?? 0)
  const routed = [...new Set(list.flatMap((p) => p.routedModels ?? []))]
  const requestedButNeverServed = run.model && !routed.includes(run.model)
  return {
    total: list.length,
    passed: pass,
    passRate: list.length === 0 ? 0 : Number((pass / list.length).toFixed(3)),
    avgScore: list.length === 0 ? 0 : Math.round(scores.reduce((a, b) => a + b, 0) / list.length),
    avgOutputTokens: Math.round(outputTokens.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    avgThinkingTokens: Math.round(thinking.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    returnedModels: routed,
    requestedModelNeverServed: Boolean(requestedButNeverServed),
    failures: list.filter((p) => !p.grade?.pass).map((p) => `${p.probeId}#${p.iteration}: ${p.grade?.failureReason ?? 'unknown'}`),
    // Runs that never reached the model must be excluded from rate maths:
    // including them turns an expired login into a "100% degradation" event.
    infraBlocked: list.filter((p) => p.grade?.metrics?.infra === true).length,
  }
}

// ------------------------------------------------------------------ http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  try {
    if (path === '/api/providers') {
      return json(res, 200, {
        providers: await listProviders(),
        probes: Object.values(PROBES).map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
        defaultProbeIds: DEFAULT_PROBE_IDS,
        capture: { port: capture.port, path: capture.capturePath },
        busy,
        queued: pending.length,
      })
    }

    if (path === '/api/run' && req.method === 'POST') {
      const body = await readBody(req)
      const provider = String(body.provider ?? 'agy')
      const model = String(body.model ?? '')
      if (model === '') return json(res, 400, { error: 'model is required' })
      const probeIds = Array.isArray(body.probeIds) && body.probeIds.length > 0 ? body.probeIds : DEFAULT_PROBE_IDS
      const repeat = Math.max(1, Math.min(5, Number(body.repeat ?? 1)))
      const runPromise = new Promise((resolveRun) => {
        enqueue(async () => {
          try {
            resolveRun(await executeRun({ provider, model, probeIds, repeat, cwd: PROBE_CWD }))
          } catch (err) {
            resolveRun({ error: String(err) })
          }
        })
      })
      if (body.wait === true) return json(res, 200, await runPromise)
      return json(res, 202, { accepted: true, provider, model, probeIds, repeat })
    }

    if (path === '/api/runs') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      return json(res, 200, {
        runs: [...runs]
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            startedAt: r.startedAt,
            provider: r.provider,
            model: r.model,
            summary: r.summary,
          })),
      })
    }

    if (path.startsWith('/api/run/')) {
      const id = path.slice('/api/run/'.length)
      const run = runs.find((r) => r.id === id)
      if (!run) return json(res, 404, { error: 'not found' })
      return json(res, 200, run)
    }

    if (path === '/api/flows') {
      const runId = url.searchParams.get('runId')
      const probeId = url.searchParams.get('probeId')
      let list = flows
      if (runId) {
        const run = runs.find((r) => r.id === runId)
        if (!run) return json(res, 404, { error: 'not found' })
        const wanted = new Set(run.probes.filter((p) => !probeId || p.probeId === probeId).flatMap((p) => p.flowIds ?? []))
        list = flows.filter((f) => wanted.has(f.id))
      }
      return json(
        res,
        200,
        list.slice(-200).map((f) => ({
          id: f.id,
          ts: f.ts,
          host: f.host,
          path: f.path,
          status: f.status,
          durationMs: f.durationMs,
          reqSummary: f.reqSummary,
          respEvents: f.respSummary?.eventCount ?? 0,
          bytes: { req: (f.reqBody ?? '').length, resp: (f.respBody ?? '').length },
        })),
      )
    }

    if (path.startsWith('/api/flow/')) {
      const id = path.slice('/api/flow/'.length)
      const flow = flowIndex.get(id)
      if (!flow) return json(res, 404, { error: 'not found' })
      return json(res, 200, flow)
    }

    if (path === '/api/series') {
      return json(res, 200, { services: computeSeries(runs) })
    }

    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': radar stream open\n\n')
      clients.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(ping)
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }

    // Artifacts (probe output files) are served from disk by absolute path.
    if (path.startsWith('/artifact/')) {
      const rel = decodeURIComponent(path.slice('/artifact/'.length))
      const full = resolve(ROOT, rel)
      if (!full.startsWith(resolve(ROOT, 'data'))) return json(res, 403, { error: 'forbidden' })
      const body = await readFile(full, 'utf8')
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'text/plain; charset=utf-8' })
      return res.end(body)
    }

    // Static UI.
    const rel = path === '/' ? 'index.html' : path.slice(1)
    const filePath = join(PUBLIC, normalize(rel))
    if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' })
    try {
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      return res.end(body)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  } catch (err) {
    return json(res, 500, { error: String(err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`radar ui        http://127.0.0.1:${PORT}`)
  console.log(`capture proxy   http://127.0.0.1:${CAPTURE_PORT}  -> ${capture.capturePath}`)
  console.log(`probe cwd       ${PROBE_CWD}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await capture.close()
    server.close()
    process.exit(0)
  })
}
