// Radar server: owns the probe queue, the capture proxy and the SSE feed.
//
// One deliberate constraint: probes run strictly one at a time. Parallel runs
// fight over quota, over the capture proxy and over wall-clock, and the
// resulting latency/noise makes a "degradation" out of nothing.
import http from 'node:http'
import { mkdir, readFile, readdir, readFile as readFileAsync, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { startCapture } from './capture/mitm.mjs'
import { listProviders, runProbe } from './providers/index.mjs'
import { PROBES, DEFAULT_PROBE_IDS } from './probes/index.mjs'
import { gradeProbe } from './scoring/grade.mjs'
import { createStore, computeSeries, RUBRIC_VERSION, PROBE_SET_VERSION } from './store.mjs'
import { judgeSvgArtifact } from './judge/index.mjs'
import { judgeConfig, judgeHealth } from './judge/vision.mjs'
import { judgeProfile } from './judge/profile.mjs'
import { computeVerdict } from './judge/verdict.mjs'
import { foreignModels, sameModel } from './model-alias.mjs'

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

/** Absolute file references the CLI put in its own answer. */
function referencedFiles(text) {
  const out = new Set()
  if (!text) return []
  // file:///C:/... and file:///home/... links
  for (const m of text.matchAll(/file:\/\/\/([^\s)\]"'<>]+)/g)) {
    try {
      out.add(decodeURIComponent(m[1]))
    } catch {
      out.add(m[1])
    }
  }
  // bare Windows paths that point at a plausible artifact
  for (const m of text.matchAll(/\b([A-Za-z]:\\[^\s)\]"'<>|]+\.(?:svg|py|json|txt|md))\b/g)) {
    out.add(m[1])
  }
  return [...out].slice(0, 8)
}

/**
 * Some CLIs deliver by writing outside the workspace and linking the file.
 * agy, for instance, drops artifacts in its own brain directory
 * (~/.gemini/antigravity-cli/brain/<conversation>/). Treating that as "no
 * delivery" scored a perfectly good pelican as a 0/100 degradation.
 */
async function harvestReferenced(text) {
  const parts = []
  const files = []
  for (const ref of referencedFiles(text)) {
    if (!/\.(svg|py|json|txt|md)$/i.test(ref)) continue
    try {
      const info = await stat(ref)
      if (!info.isFile() || info.size > 512 * 1024) continue
      parts.push(await readFileAsync(ref, 'utf8'))
      files.push(ref)
    } catch {
      /* a broken link in prose is not an error */
    }
  }
  return { text: parts.join('\n\n'), files }
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

// Legacy records predate `artifactKind`. Infer it once at load time so the UI
// and the summary do not have to special-case a field that was simply absent.
for (const run of runs) {
  for (const probe of run.probes ?? []) {
    if (probe.artifactKind || !probe.artifactPath) continue
    probe.artifactKind = /\.svg$/i.test(probe.artifactPath)
      ? 'svg'
      : /\.(png|jpe?g|webp|gif)$/i.test(probe.artifactPath)
        ? 'image'
        : 'text'
  }
}

// A .svg name proves nothing: early runs archived the reply prose under that
// name. Verify the bytes once at load so the UI can never dress up a broken
// archive as a drawing.
for (const run of runs) {
  for (const probe of run.probes ?? []) {
    if (probe.artifactKind !== 'svg' || !probe.artifactPath) continue
    try {
      const body = await readFile(probe.artifactPath, 'utf8')
      probe.artifactRenderable = /<svg[\s>]/i.test(body) && body.length > 32
    } catch {
      probe.artifactRenderable = false
    }
    if (probe.artifactRenderable === false) probe.artifactKind = 'broken'
  }
}

/**
 * Recompute the renderability gate for stored runs.
 *
 * Only probes that were *supposed* to produce a drawing count: the retired
 * JSON / math / code probes archived plain text by design, and treating that as
 * "product missing" would slander every historical run.
 */
const isSvgProbe = (probe) =>
  probe.probeKind === 'svg' || (probe.probeKind === undefined && ['svg', 'image', 'broken'].includes(probe.artifactKind))
for (const run of runs) {
  if (!run.summary) continue
  const svgProbes = (run.probes ?? []).filter(isSvgProbe)
  if (svgProbes.length === 0) continue
  run.summary.svgProbes = svgProbes.length
  run.summary.renderableArtifacts = svgProbes.filter((p) => p.artifactRenderable === true).length
}

// Give every stored probe a browser-facing URL, so the UI never has to build a
// path out of a disk location.
for (const run of runs) {
  for (const probe of run.probes ?? []) {
    probe.artifactUrl = artifactUrl(run.id, probe.artifactPath)
    if (probe.vision?.renderPath) probe.vision.renderUrl = artifactUrl(run.id, probe.vision.renderPath)
  }
}

const capture = await startCapture({ port: CAPTURE_PORT, certDir: join(ROOT, 'certs'), captureDir: join(ROOT, 'captures') })
const flows = capture.flows
const flowIndex = new Map()
for (const f of flows) flowIndex.set(f.id, f)
capture.onFlow((f) => flowIndex.set(f.id, f))

/**
 * Reload captured flows from disk at boot.
 *
 * They are already persisted as JSONL, but keeping them only in memory meant a
 * restart silently emptied the traffic panel for every past run — the run
 * record still listed flow ids that now resolved to nothing.
 */
async function loadCaptureHistory() {
  const dir = join(ROOT, 'captures')
  let names = []
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'))
  } catch {
    return
  }
  const files = []
  for (const name of names) {
    try {
      const info = await stat(join(dir, name))
      files.push({ name, mtime: info.mtimeMs })
    } catch {
      /* raced with cleanup */
    }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  for (const { name } of files) {
    let text = ''
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const flow = JSON.parse(line)
        if (flow?.id && !flowIndex.has(flow.id)) {
          flowIndex.set(flow.id, flow)
          flows.push(flow)
        }
      } catch {
        /* a torn line from an interrupted write */
      }
    }
  }
  // Bounded memory: the panel only ever shows a run's own flows.
  while (flows.length > 30_000) {
    const dropped = flows.shift()
    if (dropped) flowIndex.delete(dropped.id)
  }
}

await loadCaptureHistory()

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
      // One scratch directory per probe: the CLI writes its artifact to a path
      // we chose, so "where did the file go" stops being a forensic question.
      const scratch = join(cwd, run.id, `${probeId}-${i}`)
      await mkdir(scratch, { recursive: true })
      const prompt =
        probe.saveAs === undefined
          ? probe.prompt
          : `${probe.prompt}\n\nWrite the result to ./${probe.saveAs} in the current working directory. ` +
            'Do not ask for confirmation; just create the file and then say you are done.'
      const before = await snapshotDir(scratch)
      let result
      try {
        result = await runProbe({
          providerId: provider,
          prompt,
          model,
          cwd: scratch,
          env: CAPTURE_ENV,
          timeoutMs: Number(process.env.RADAR_PROBE_TIMEOUT_MS ?? 600_000),
        })
      } catch (err) {
        result = { text: '', error: String(err), usage: null, durationMs: 0, exitCode: -1, timedOut: false }
      }

      const capturedThisProbe = flows.slice(flowStart)
      const harvested = await harvestArtifacts(scratch, before)
      const linked = await harvestReferenced(result.text)
      // The named file is the delivery. Everything else is a fallback for a CLI
      // that ignored the instruction.
      let named = null
      if (probe.saveAs !== undefined) {
        try {
          named = { path: join(scratch, probe.saveAs), text: await readFileAsync(join(scratch, probe.saveAs), 'utf8') }
        } catch {
          named = null
        }
      }
      const extra = [named?.text, harvested.text, linked.text].filter((t) => typeof t === 'string' && t !== '').join('\n\n')
      const delivered = extra === '' ? result.text : `${result.text}\n\n${extra}`
      const returnedModels = [
        ...new Set(
          capturedThisProbe
            .map((f) => f.reqSummary?.model)
            .filter((m) => typeof m === 'string' && m !== ''),
        ),
      ]
      const sseText = extractGeneratedText(capturedThisProbe)

      // (grading happens below, against the archived artifact)
      // Archive every raw file the CLI produced — binaries included. Copying
      // only text is how a 500 KB drawing survives nowhere except a scratch
      // directory the vendor is free to prune.
      const copied = []
      const seenFiles = new Set()
      const produced = [...new Set([...(named ? [named.path] : []), ...harvested.files, ...linked.files])]
      for (const file of produced) {
        if (seenFiles.has(file)) continue
        seenFiles.add(file)
        try {
          const buf = await readFileAsync(file)
          const kind = /\.(jpe?g|png|webp|gif)$/i.test(file) ? 'image' : /\.svg$/i.test(file) ? 'svg' : 'text'
          const rel = await store.saveBinary(run.id, `raw-${basename(file)}`, buf)
          copied.push({ kind, path: rel, bytes: buf.length, source: file })
        } catch {
          /* the file vanished between being linked and being read */
        }
      }

      let artifactPath = null
      let artifactKind = 'text'
      if (probe.kind === 'svg') {
        const start = delivered.search(/<svg[\s>]/i)
        if (start >= 0) {
          // Cut at the closing tag: everything after it is commentary, and a
          // browser would happily paint that commentary into the screenshot.
          const close = delivered.lastIndexOf('</svg>')
          const svg = close > start ? delivered.slice(start, close + 6) : delivered.slice(start)
          artifactPath = await store.saveArtifact(run.id, `${probeId}-${i}`, 'svg', svg)
          artifactKind = 'svg'
        } else {
          // No markup at all: keep whatever was actually delivered, so an
          // image-producing run still leaves an image behind.
          const image = copied.find((c) => c.kind === 'image')
          if (image) {
            artifactPath = image.path
            artifactKind = 'image'
          } else {
            artifactPath = await store.saveArtifact(run.id, `${probeId}-${i}`, 'txt', delivered)
          }
        }
      } else {
        artifactPath = await store.saveArtifact(run.id, `${probeId}-${i}`, 'txt', delivered)
      }

      // Grade the archived bytes, not the transient reply. Scoring one text
      // while the card renders another is exactly how a run reports 100% next
      // to a card that says "no renderable artifact".
      let artifactBody = null
      if (artifactKind === 'svg' && artifactPath) {
        try {
          artifactBody = await readFileAsync(artifactPath, 'utf8')
        } catch {
          artifactBody = null
        }
      }
      const artifactRenderable = Boolean(artifactBody && /<svg[\s>]/i.test(artifactBody))
      const grade = await gradeProbe(probe, artifactBody ?? delivered, result.error ?? result.stderrTail)
      if (probe.kind === 'svg' && !artifactRenderable && grade.pass) {
        // Nothing renderable was archived: this is a failed delivery whatever
        // the reply text claimed.
        grade.pass = false
        grade.score = 0
        grade.failureReason = 'artifact-not-renderable'
      }
      // Only meaningful when the CLI failed: it answers "did the wire contain a
      // usable drawing that the orchestration layer then dropped?".
      const wireGrade = grade.pass === false && sseText !== null ? await gradeProbe(probe, sseText) : null

      const record = {
        probeId,
        probeKind: probe.kind,
        label: probe.label,
        iteration: i,
        startedAt: new Date().toISOString(),
        text: result.text,
        promptSent: prompt,
        // Recorded so a later "did the prompt change?" question has an answer:
        // the canonical line is untouched, the save instruction is appended.
        promptVariant: probe.saveAs === undefined ? 'canonical' : 'save-to-workspace',
        deliveredFiles: produced.map((f) =>
          f.startsWith(ROOT) ? f.slice(ROOT.length + 1).split('\\').join('/') : f.split('\\').join('/'),
        ),
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
        artifactUrl: artifactUrl(run.id, artifactPath),
        artifactKind,
        artifactRenderable,
        deliveredArtifacts: copied,
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

  // ---- vision pass -------------------------------------------------------
  // The rubric already answered "is this a well-formed drawing". Only the eyes
  // can answer "is this a pelican riding a bicycle", and that is the question
  // the whole dashboard exists for.
  const judgeCfg = judgeConfig()
  run.judge = judgeProfile(judgeCfg)
  const health = await judgeHealth(judgeCfg)
  if (!health.ok) {
    run.judgeError = health.error ?? (health.hasModel === false ? `judge model ${judgeCfg.model} not offered by ${judgeCfg.baseUrl}` : `judge HTTP ${health.status}`)
    broadcast({ type: 'judge-unavailable', runId: run.id, error: run.judgeError })
  } else {
    for (const record of run.probes) {
      if (PROBES[record.probeId]?.kind !== 'svg' || !record.artifactPath) continue
      let svgText = ''
      try {
        svgText = await readFileAsync(resolve(ROOT, record.artifactPath), 'utf8')
      } catch {
        record.vision = { ok: false, note: 'artifact unreadable' }
        continue
      }
      record.vision = await judgeSvgArtifact({
        artifactPath: resolve(ROOT, record.artifactPath),
        svgText,
        probeId: record.probeId,
        config: judgeCfg,
      })
      if (record.vision.renderPath) record.vision.renderUrl = artifactUrl(run.id, record.vision.renderPath)
      broadcast({ type: 'judge-done', runId: run.id, probeId: record.probeId, iteration: record.iteration, vision: record.vision })
    }
  }

  run.summary = summarize(run)
  // History must be read before this run is appended, so a run is never
  // compared against itself.
  run.verdict = computeVerdict(
    run,
    runs.filter((r) => r.provider === run.provider && r.model === run.model),
  )
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
  // tiered-/preview- variants are the same model; only a genuinely different
  // model counts as "the route changed".
  const requestedButNeverServed = Boolean(run.model) && !routed.some((m) => sameModel(m, run.model))
  const foreign = foreignModels(run.model, routed)
  const judged = list.filter((p) => p.vision?.ok === true && typeof p.vision.score === 'number')
  const renderable = list.filter((p) => p.artifactRenderable === true).length
  const drawingProbes = list.filter((p) => p.probeKind === 'svg').length
  return {
    total: list.length,
    passed: pass,
    passRate: list.length === 0 ? 0 : Number((pass / list.length).toFixed(3)),
    avgScore: list.length === 0 ? 0 : Math.round(scores.reduce((a, b) => a + b, 0) / list.length),
    avgOutputTokens: Math.round(outputTokens.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    avgThinkingTokens: Math.round(thinking.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, list.length)),
    returnedModels: routed,
    foreignModels: foreign,
    requestedModelNeverServed: Boolean(requestedButNeverServed),
    wrongFormat: list.filter((p) => p.grade?.metrics?.wrongFormat === true).length,
    failures: list.filter((p) => !p.grade?.pass).map((p) => `${p.probeId}#${p.iteration}: ${p.grade?.failureReason ?? 'unknown'}`),
    // Runs that never reached the model must be excluded from rate maths:
    // including them turns an expired login into a "100% degradation" event.
    infraBlocked: list.filter((p) => p.grade?.metrics?.infra === true).length,
    // Vision is the headline number for the pelican probes; null means "nobody
    // looked", which is different from "it scored zero".
    visionJudged: judged.length,
    avgVisionScore: judged.length === 0 ? null : Math.round(judged.reduce((a, p) => a + p.vision.score, 0) / judged.length),
    // Did we end up with a file a human could open? This is a gate, not a
    // detail: a pass rate computed over artifacts nobody can render is noise.
    renderableArtifacts: renderable,
    svgProbes: drawingProbes,
  }
}

// ------------------------------------------------------------------ http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Browser-facing artifact URL.
 *
 * Deliberately opaque: `/artifacts/<runId>/<file>`. An absolute Windows path
 * in a URL ("/artifact/D:/…") carries a colon and a drive letter, and the
 * browser refused to load it as an image while curl was happy — the kind of
 * mismatch that makes a working backend look broken.
 */
function artifactUrl(runId, filePath) {
  if (!filePath) return null
  return `/artifacts/${runId}/${encodeURIComponent(basename(filePath))}`
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

    if (path === '/api/judge/health') {
      return json(res, 200, { config: judgeConfig(), ...(await judgeHealth()) })
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
    if (path.startsWith('/artifacts/')) {
      const rest = decodeURIComponent(path.slice('/artifacts/'.length))
      const [runId, ...nameParts] = rest.split('/')
      const name = nameParts.join('/')
      if (!/^[A-Za-z0-9-]+$/.test(runId ?? '') || name === '' || name.includes('..')) {
        return json(res, 400, { error: 'bad artifact path' })
      }
      const full = join(ROOT, 'data', 'artifacts', runId, name)
      try {
        const body = await readFile(full)
        res.writeHead(200, {
          'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        return res.end(body)
      } catch {
        return json(res, 404, { error: 'artifact not found' })
      }
    }

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
      const ext = extname(filePath)
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        // Without this the browser happily serves a stale index.html that
        // points at a JS bundle from two versions ago — which looks exactly
        // like "the page renders but nothing works".
        'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-store' : 'no-cache',
      })
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
