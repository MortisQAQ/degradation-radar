#!/usr/bin/env node
// Recover drawings from earlier runs.
//
// Before the harness handed the CLI a scratch directory + an explicit filename,
// agy wrote its SVG into ~/.gemini/antigravity-cli/brain/<conversation>/ and the
// archive only captured the reply text. Those originals are still on disk for a
// while; this pulls them back and rewrites the run log in place.
//
//   node scripts/backfill-artifacts.mjs [--dry]
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore } from '../src/store.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DRY = process.argv.includes('--dry')
const BRAIN = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const WINDOW_BEFORE_MS = 2 * 60_000
const WINDOW_AFTER_MS = 8 * 60_000

const HINTS = {
  'pelican-bicycle': /bicycle|bike/i,
  'pelican-skateboard': /skate/i,
  'pelican-tractor': /tractor/i,
  'pelican-rocket': /rocket/i,
}

/** Every .svg agy ever wrote, with the time it landed. */
async function indexBrain() {
  const out = []
  let dirs = []
  try {
    dirs = await readdir(BRAIN, { withFileTypes: true })
  } catch {
    return out
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const full = join(BRAIN, dir.name)
    let files = []
    try {
      files = await readdir(full)
    } catch {
      continue
    }
    for (const name of files) {
      // Raster files matter too: a run that answered "I cannot produce SVG,
      // here is a JPEG" left its only evidence in a .jpg.
      if (!/\.(svg|jpe?g|png)$/i.test(name)) continue
      const path = join(full, name)
      try {
        const info = await stat(path)
        if (info.size > 4 * 1024 * 1024) continue
        out.push({ path, name, mtime: info.mtimeMs, size: info.size })
      } catch {
        /* raced with cleanup */
      }
    }
  }
  return out
}

async function main() {
  const store = createStore(join(ROOT, 'data'))
  const runs = await store.load()
  const brain = await indexBrain()
  console.log(`brain 目录可用 svg: ${brain.length}`)

  let recovered = 0
  let skipped = 0
  for (const run of runs) {
    for (const probe of run.probes ?? []) {
      if (!probe.artifactPath || !probe.artifactPath.endsWith('.svg')) continue
      let current = ''
      try {
        current = await readFile(probe.artifactPath, 'utf8')
      } catch {
        current = ''
      }
      if (/<svg[\s>]/i.test(current) && current.length > 64) continue // already good

      const started = new Date(probe.startedAt ?? run.startedAt).getTime()
      const hint = HINTS[probe.probeId]
      const candidates = brain
        .filter((b) => b.mtime >= started - WINDOW_BEFORE_MS && b.mtime <= started + WINDOW_AFTER_MS)
        .filter((b) => (hint ? hint.test(b.name) : true))
        .sort((a, b) => Math.abs(a.mtime - started) - Math.abs(b.mtime - started))

      const pick = candidates[0]
      if (!pick) {
        skipped++
        console.log(`  x ${run.id.slice(0, 8)} ${probe.probeId}: 找不到对应原图`)
        continue
      }
      const isSvg = /\.svg$/i.test(pick.name)
      const body = await readFile(pick.path, isSvg ? 'utf8' : undefined)
      if (isSvg && !/<svg[\s>]/i.test(body)) {
        skipped++
        continue
      }
      if (!DRY) {
        const ext = isSvg ? 'svg' : pick.name.split('.').pop().toLowerCase()
        const saved = isSvg
          ? await store.saveArtifact(run.id, `${probe.probeId}-${probe.iteration}`, ext, body)
          : await store.saveBinary(run.id, `${probe.probeId}-${probe.iteration}.${ext}`, body)
        probe.artifactPath = saved
        probe.artifactKind = isSvg ? 'svg' : 'image'
        probe.backfilledFrom = pick.path
      }
      recovered++
      console.log(`  ok ${run.id.slice(0, 8)} ${probe.probeId}: <- ${pick.name} (${pick.size}B)`)
    }
  }

  if (!DRY && recovered > 0) {
    // Rewrite the log atomically: a torn file would lose the whole history.
    const tmp = join(ROOT, 'data', 'runs.jsonl.tmp')
    await writeFile(tmp, runs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    await rename(tmp, join(ROOT, 'data', 'runs.jsonl'))
  }

  console.log(`\n恢复 ${recovered} 张，跳过 ${skipped} 张${DRY ? '（dry run，未写盘）' : ''}`)
  if (recovered > 0 && !DRY) console.log('重启服务后可在 UI 里看到这些历史图。')
}

await main()
