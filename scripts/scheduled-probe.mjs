#!/usr/bin/env node
// One scheduled probe run.
//
// Design rule: this script never spawns agy directly. It drives the radar
// server's /api/run so the capture proxy and the vision judge are in the loop —
// a bare CLI call would produce a drawing with no traffic record and no verdict.
//
// The server is long-lived but a reboot kills it, so this makes sure it is up
// (spawning it detached if needed) before asking for a run.
//
//   node scripts/scheduled-probe.mjs            # run now
//   node scripts/scheduled-probe.mjs --report   # show recent trend, no run
import { spawn } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = process.env.RADAR_BASE ?? 'http://127.0.0.1:7417'

/** Read --flag value, falling back to env, then to the default. */
function arg(name, envName, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  return process.env[envName] ?? fallback
}

const MODEL = arg('model', 'RADAR_SCHEDULE_MODEL', 'gemini-4-hydrogen-high')
const PROBE_IDS = arg('probes', 'RADAR_SCHEDULE_PROBES', 'pelican-bicycle').split(',').map((s) => s.trim()).filter(Boolean)
const REPEAT = Number(arg('repeat', 'RADAR_SCHEDULE_REPEAT', '1'))
const LOG = join(ROOT, 'data', 'scheduled.log')
const RUN_TIMEOUT_MS = Number(arg('timeout', 'RADAR_SCHEDULE_TIMEOUT_MS', '900000'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

async function log(line) {
  await mkdir(join(ROOT, 'data'), { recursive: true })
  await appendFile(LOG, `[${stamp()}] ${line}\n`, 'utf8')
  console.log(line)
}

async function serverUp() {
  try {
    const res = await fetch(`${BASE}/api/providers`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

async function ensureServer() {
  if (await serverUp()) return 'already running'
  // Detached: the scheduled task must exit, the server must not.
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(750)
    if (await serverUp()) return 'started by scheduler'
  }
  throw new Error('radar server did not become reachable at ' + BASE)
}

function fmt(run) {
  const s = run.summary ?? {}
  const probes = (run.probes ?? [])
    .map((p) => {
      const v = p.vision?.ok ? `${p.vision.score}${p.vision.gap ? '/' + p.vision.gap : ''}` : '—'
      return `${p.probeId}:rubric=${p.grade?.score ?? '-'} vision=${v}`
    })
    .join(' ')
  return `${run.provider}/${run.model} pass=${s.passed}/${s.total} vision=${s.avgVisionScore ?? '—'} (${s.visionMode ?? '-'}) ${probes}`
}

async function runOnce() {
  const how = await ensureServer()
  await log(`server: ${how}`)

  const res = await fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'agy', model: MODEL, probeIds: PROBE_IDS, repeat: REPEAT, wait: true }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text()
    await log(`RUN REQUEST FAILED ${res.status}: ${text.slice(0, 300)}`)
    process.exitCode = 1
    return
  }
  const run = await res.json()
  if (run.error) {
    await log(`RUN FAILED: ${String(run.error).slice(0, 300)}`)
    process.exitCode = 1
    return
  }
  await log(`OK ${run.id.slice(0, 8)} ${fmt(run)} verdict=${run.verdict?.label ?? '—'}`)
  for (const reason of run.verdict?.reasons ?? []) await log(`   · ${reason}`)
  if (run.judge?.mode === 'none') await log('   ! 判官没参与（视觉端点不可用？确定性判分与抓包仍然有效）')
}

async function report() {
  const services = await (await fetch(`${BASE}/api/series`, { signal: AbortSignal.timeout(10_000) })).json()
  const runs = await (await fetch(`${BASE}/api/runs?limit=12`, { signal: AbortSignal.timeout(10_000) })).json()
  console.log('=== 最近 12 轮 ===')
  for (const r of [...runs.runs].reverse()) {
    const when = new Date(r.startedAt).toLocaleString('zh-CN')
    console.log(
      `${when}  ${r.model}  pass=${r.summary?.passed}/${r.summary?.total}  vision=${r.summary?.avgVisionScore ?? '—'}  ${r.summary?.visionMode ?? ''}`,
    )
  }
  console.log('\n=== 服务健康 ===')
  for (const svc of services.services ?? []) {
    console.log(`${svc.key}  runs=${svc.runs}  health=${svc.health ?? '基线中'}`)
  }
}

const wantReport = process.argv.includes('--report')
try {
  if (wantReport) await report()
  else await runOnce()
} catch (err) {
  await log(`ERROR ${String(err).slice(0, 400)}`)
  process.exitCode = 1
}
