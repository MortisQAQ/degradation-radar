// Durable run log.
//
// Append-only JSONL so an interrupted window never corrupts history, and every
// field needed to re-derive a verdict later is on disk (judge/rubric versions
// included — a rubric bump must be visible in the record, not implicit).
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const RUBRIC_VERSION = 'svg-1'
export const PROBE_SET_VERSION = 'probes-1'

export function createStore(root = 'data') {
  const runsPath = join(root, 'runs.jsonl')
  const artifactDir = join(root, 'artifacts')
  let hydrated = null

  async function ensure() {
    await mkdir(dirname(runsPath), { recursive: true })
    await mkdir(artifactDir, { recursive: true })
  }

  return {
    runsPath,
    artifactDir,

    async load() {
      if (hydrated) return hydrated
      await ensure()
      let text = ''
      try {
        text = await readFile(runsPath, 'utf8')
      } catch {
        text = ''
      }
      const runs = []
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        try {
          runs.push(JSON.parse(line))
        } catch {
          // A torn last line after a crash is expected; skip it.
        }
      }
      hydrated = runs
      return runs
    },

    async append(run) {
      await ensure()
      await appendFile(runsPath, JSON.stringify(run) + '\n', 'utf8')
      if (hydrated) hydrated.push(run)
    },

    /** Persist the raw artifact so later rubric/renders can be re-applied. */
    async saveArtifact(runId, probeId, ext, body) {
      await ensure()
      const dir = join(artifactDir, runId)
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${probeId}.${ext}`)
      await writeFile(path, body, 'utf8')
      // Served to the browser as /artifact/<posix-relative-to-cwd>.
      return path.split('\\').join('/')
    },

    /**
     * Persist a binary artifact (a delivered JPEG, a render, …).
     *
     * Text-only archiving is how a 500 KB drawing the model actually produced
     * ends up with nothing but a one-line "see this file" left behind.
     */
    async saveBinary(runId, name, buffer) {
      await ensure()
      const dir = join(artifactDir, runId)
      await mkdir(dir, { recursive: true })
      const path = join(dir, name)
      await writeFile(path, buffer)
      return path.split('\\').join('/')
    },
  }
}

/**
 * Turn a run history into a per-service time series plus a health score.
 *
 * The comparison window is *rolling and trailing*: each run is judged against
 * the runs that came before it, never against runs collected afterwards, so a
 * dashboard cannot retroactively "discover" a regression.
 */
export function computeSeries(runs, { baselineWindow = 5, minBaseline = 3 } = {}) {
  const byService = new Map()
  for (const run of runs) {
    // Mode is part of the identity: pairwise and absolute scores are not
    // comparable, so they are separate series even for the same model.
    const mode = run.judge?.mode ?? 'none'
    const key = `${run.provider}/${run.model}${mode === 'pairwise' ? ' · 对比参照' : mode === 'absolute' ? ' · 绝对分' : ''}`
    if (!byService.has(key)) byService.set(key, [])
    byService.get(key).push(run)
  }

  const services = []
  for (const [key, list] of byService) {
    const ordered = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const points = []
    for (let i = 0; i < ordered.length; i++) {
      const run = ordered[i]
      const history = ordered.slice(Math.max(0, i - baselineWindow), i)
      const baselineReady = history.length >= minBaseline
      const scoreNow = run.summary?.avgScore ?? 0
      const tokensNow = run.summary?.avgOutputTokens ?? 0
      const visionNow = run.summary?.visionJudged > 0 ? run.summary.avgVisionScore : null
      const scoreBase = baselineReady ? median(history.map((r) => r.summary?.avgScore ?? 0)) : null
      const tokensBase = baselineReady ? median(history.map((r) => r.summary?.avgOutputTokens ?? 0)) : null
      const visionBase = baselineReady
        ? median(history.filter((r) => r.summary?.visionJudged > 0).map((r) => r.summary.avgVisionScore))
        : null
      const stat = (now, base, scale) =>
        base === null || base === 0 ? null : Number(((now - base) / Math.max(scale, base * scale)).toFixed(3))

      const scoreZ = stat(scoreNow, scoreBase, 0.35)
      const tokensZ = stat(tokensNow, tokensBase, 0.35)
      const visionZ = visionNow !== null && visionBase ? Number(((visionNow - visionBase) / Math.max(1, visionBase)).toFixed(3)) : null
      const passZ = baselineReady
        ? Number(((run.summary?.passRate ?? 0) - median(history.map((r) => r.summary?.passRate ?? 0))).toFixed(3))
        : null

      points.push({
        runId: run.id,
        startedAt: run.startedAt,
        passRate: run.summary?.passRate ?? 0,
        avgScore: scoreNow,
        visionScore: visionNow,
        avgOutputTokens: tokensNow,
        avgLatencyMs: run.summary?.avgLatencyMs ?? 0,
        returnedModels: run.summary?.returnedModels ?? [],
        scoreZ,
        visionZ,
        tokensZ,
        passZ,
        baselineReady,
        verdict: run.verdict?.level ?? null,
      })
    }
    const latest = points[points.length - 1] ?? null
    services.push({
      key,
      provider: ordered[0]?.provider ?? '',
      model: ordered[0]?.model ?? '',
      runs: ordered.length,
      points,
      health: latest ? healthScore(latest) : null,
    })
  }
  services.sort((a, b) => (a.health ?? 100) - (b.health ?? 100))
  return services
}

/** 0-100: 100 is "matches its own recent baseline", lower is worse. */
function healthScore(point) {
  if (!point.baselineReady) return null
  // Vision has no meaningful baseline yet (judge added later, or too few
  // drawings judged) — fall back to the rubric rather than pretending.
  if (point.visionScore !== null && point.visionZ !== null) {
    return Math.round(Math.max(0, Math.min(100, 100 + point.visionZ * 100)))
  }
  let health = 100
  if (point.passZ !== null) health += point.passZ * 100
  if (point.scoreZ !== null) health += point.scoreZ * 30
  if (point.tokensZ !== null) health += point.tokensZ * 15
  return Math.round(Math.max(0, Math.min(100, health)))
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}
