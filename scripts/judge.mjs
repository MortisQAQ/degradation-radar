#!/usr/bin/env node
// Standalone judge entry point.
//
// This is the path a DSH subagent (or any other orchestrator) should take:
// one process, one JSON answer, no server lifecycle to manage.
//
//   node scripts/judge.mjs --run <runId>            judge an existing run
//   node scripts/judge.mjs --svg <file.svg> --probe pelican-bicycle
//   node scripts/judge.mjs --latest                 judge the newest run
//
// Exit code is 0 whenever a verdict was produced, even a bad one — a degraded
// verdict is a successful measurement, not a failed process.
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

import { judgeSvgArtifact } from '../src/judge/index.mjs'
import { judgeConfig, judgeHealth, judgeImage } from '../src/judge/vision.mjs'
import { judgeProfile } from '../src/judge/profile.mjs'
import { computeVerdict } from '../src/judge/verdict.mjs'
import { renderSvg } from '../src/judge/render.mjs'
import { createStore } from '../src/store.mjs'

const ROOT = resolve(import.meta.dirname, '..')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

async function main() {
  const config = judgeConfig()
  const health = await judgeHealth(config)
  if (!health.ok) {
    console.error(JSON.stringify({ ok: false, error: health.error ?? `judge unavailable (HTTP ${health.status})`, config: judgeProfile(config) }))
    process.exit(2)
  }

  // --- ad-hoc image ------------------------------------------------------
  const svgPath = arg('svg')
  if (typeof svgPath === 'string') {
    const probeId = String(arg('probe') ?? 'pelican-bicycle')
    const svgText = await readFile(svgPath, 'utf8')
    const result = await judgeSvgArtifact({ artifactPath: resolve(svgPath), svgText, probeId, config })
    console.log(JSON.stringify({ ok: result.ok ?? false, probeId, file: svgPath, ...result, profile: judgeProfile(config) }, null, 2))
    return
  }

  // --- existing run ------------------------------------------------------
  const store = createStore(join(ROOT, 'data'))
  const runs = await store.load()
  let run = null
  const runArg = arg('run')
  if (typeof runArg === 'string') run = runs.find((r) => r.id === runArg) ?? null
  else if (arg('latest')) run = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  if (!run) {
    console.error('usage: node scripts/judge.mjs --run <runId> | --latest | --svg <file> --probe <id>')
    process.exit(1)
  }

  const judged = []
  for (const probe of run.probes) {
    if (!probe.artifactPath || !probe.artifactPath.endsWith('.svg')) continue
    const full = resolve(ROOT, probe.artifactPath)
    if (!existsSync(full)) {
      judged.push({ probeId: probe.probeId, iteration: probe.iteration, ok: false, note: 'artifact missing' })
      continue
    }
    const svgText = await readFile(full, 'utf8')
    const result = await judgeSvgArtifact({ artifactPath: full, svgText, probeId: probe.probeId, config })
    judged.push({ probeId: probe.probeId, iteration: probe.iteration, ...result })
  }

  // Recompute the aggregate from fresh eyes rather than trusting the stored one.
  const ok = judged.filter((j) => j.ok === true)
  const summary = {
    ...(run.summary ?? {}),
    visionJudged: ok.length,
    avgVisionScore: ok.length === 0 ? null : Math.round(ok.reduce((a, j) => a + j.score, 0) / ok.length),
  }
  const history = runs
    .filter((r) => r.provider === run.provider && r.model === run.model && r.startedAt < run.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const verdict = computeVerdict({ ...run, summary }, history)

  console.log(
    JSON.stringify(
      {
        ok: true,
        runId: run.id,
        provider: run.provider,
        model: run.model,
        startedAt: run.startedAt,
        judge: judgeProfile(config),
        drawings: judged,
        summary: { visionJudged: summary.visionJudged, avgVisionScore: summary.avgVisionScore },
        verdict,
      },
      null,
      2,
    ),
  )
}

await main()
