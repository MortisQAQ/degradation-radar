// Probe library.
//
// Design rule taken from Folkbench's methodology: the headline metric is
// "first-delivery pass rate" — a timeout, a truncation, a refusal or a run that
// never emits an artifact all count as failures, not as "no data".

export const PROBES = {
  'pelican-bicycle': {
    id: 'pelican-bicycle',
    label: '鹈鹕骑自行车',
    kind: 'svg',
    // Every drawing probe names the file it must produce. Without this the CLI
    // is free to drop the artifact in its own brain directory, and the run has
    // to reconstruct where it went after the fact.
    saveAs: 'pelican-bicycle.svg',
    // Verbatim, the canonical Simon Willison wording. Do not polish it: the
    // whole point is that this exact string has years of public baselines.
    prompt: 'Generate an SVG of a pelican riding a bicycle.',
  },
  'pelican-skateboard': {
    id: 'pelican-skateboard',
    label: '鹈鹕踩滑板',
    kind: 'svg',
    saveAs: 'pelican-skateboard.svg',
    prompt: 'Generate an SVG of a pelican riding a skateboard.',
  },
  'pelican-tractor': {
    id: 'pelican-tractor',
    label: '鹈鹕开拖拉机',
    kind: 'svg',
    saveAs: 'pelican-tractor.svg',
    prompt: 'Generate an SVG of a pelican driving a tractor.',
  },
  'pelican-rocket': {
    id: 'pelican-rocket',
    label: '鹈鹕搭火箭',
    kind: 'svg',
    saveAs: 'pelican-rocket.svg',
    prompt: 'Generate an SVG of a pelican riding a rocket.',
  },
}

/**
 * Pelican only, by decision: a drawing probe answers the question the
 * dashboard exists for, and it does so in one comparable unit. The JSON / math
 * / code probes were dropped — they measured "is the model smart" but told us
 * nothing about whether the delivered artifact was usable, and mixing them into
 * a pass rate made a 1-of-4 pelican round look like a 100% clean run.
 */
export const DEFAULT_PROBE_IDS = ['pelican-bicycle', 'pelican-skateboard', 'pelican-tractor', 'pelican-rocket']

/** Extract the first plausible SVG document from a model reply. */
export function extractSvg(text) {
  if (!text) return null
  const fenced = /```(?:svg|xml|html)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = []
  if (fenced) candidates.push(fenced[1])
  candidates.push(text)
  for (const c of candidates) {
    const start = c.indexOf('<svg')
    if (start < 0) continue
    const end = c.lastIndexOf('</svg>')
    if (end > start) return c.slice(start, end + 6)
    return c.slice(start) // truncated — the grader reports it
  }
  return null
}

/** Extract a fenced python block (or the raw text when the model ignored fences). */
export function extractCode(text, lang = 'python') {
  if (!text) return null
  const fenced = new RegExp('```(?:' + lang + ')?\\s*([\\s\\S]*?)```', 'i').exec(text)
  return fenced ? fenced[1] : text
}
