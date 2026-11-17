// Reference drawings for pairwise judging.
//
// Absolute scoring asks "does this look like a pelican?" — with no anchor, the
// answer drifts between calls and between weeks. Pairwise asks the question we
// actually care about: "how does this compare to what the same model produces
// when nothing is in its way?"
//
// Only probe families with a published, same-model reference get one. Anything
// else keeps absolute scoring rather than pretending to have a baseline.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const BASELINE_DIR = join(ROOT, 'data', 'baselines')

/** probeId -> baseline stem (model + thinking level + probe). */
export const BASELINES = {
  'pelican-bicycle': 'gemini-4-hydrogen-high.pelican-bicycle',
}

export function baselineInfo(probeId) {
  const stem = BASELINES[probeId]
  if (!stem) return null
  const png = join(BASELINE_DIR, `${stem}.png`)
  if (!existsSync(png)) {
    return {
      probeId,
      stem,
      available: false,
      hint: 'run: node scripts/fetch-baseline.mjs',
    }
  }
  return {
    probeId,
    stem,
    available: true,
    id: stem,
    pngPath: png,
    png: readFileSync(png),
    source: 'simonwillison.net/static/2026/gemini-4-pelicans.html (thinking=high × gemini-4-hydrogen)',
  }
}

export function listBaselines(probeIds) {
  return probeIds.map((id) => {
    const info = baselineInfo(id)
    if (!info) return { probeId: id, available: false, hint: 'no published same-model reference' }
    return { probeId: id, available: info.available, id: info.id, hint: info.hint }
  })
}
