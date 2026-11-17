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

/** Probe families that have published, same-prompt references. */
const REFERENCED_PROBES = new Set(['pelican-bicycle'])

/**
 * Resolve the reference for one (probe, model) pair.
 *
 * The reference must come from the *same* model — comparing argon against a
 * hydrogen drawing would answer a different question ("argon vs hydrogen")
 * while pretending to answer "is argon degraded".
 */
export function baselineInfo(probeId, model) {
  if (!REFERENCED_PROBES.has(probeId)) return null
  const requested = String(model ?? '').toLowerCase().trim()
  if (requested === '') return null

  // gemini-4-argon-high -> gemini-4-argon / high ; also accept a bare family id.
  const thinking = /\b(high|medium|low|minimal|xhigh)$/.exec(requested)?.[1] ?? 'high'
  const family = requested.replace(/-(?:high|medium|low|minimal|xhigh)$/, '')
  const candidates = [`${requested}.${probeId}`, `${family}-${thinking}.${probeId}`, `${family}-high.${probeId}`]
  const stem = candidates.find((c) => existsSync(join(BASELINE_DIR, `${c}.png`)))
  if (!stem) {
    return {
      probeId,
      model: requested,
      available: false,
      hint: `no published ${family} reference — run: node scripts/fetch-baseline.mjs`,
    }
  }
  const png = join(BASELINE_DIR, `${stem}.png`)
  return {
    probeId,
    model: requested,
    stem,
    available: true,
    id: stem,
    pngPath: png,
    png: readFileSync(png),
    source: `simonwillison.net/static/2026/gemini-4-pelicans.html (${stem})`,
  }
}

export function listBaselines(probeIds, model) {
  return probeIds.map((id) => {
    const info = baselineInfo(id, model)
    if (!info) return { probeId: id, available: false, hint: 'no published same-model reference' }
    return { probeId: id, available: info.available, id: info.id, hint: info.hint, model: info.model }
  })
}
