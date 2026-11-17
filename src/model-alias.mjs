// Model identity.
//
// `gemini-4-hydrogen-tiered-high` and `gemini-4-hydrogen-high` are the same
// model to a subscriber: the tier suffix describes how the request was served,
// not which model answered. Counting it as "got switched to another model"
// turned a routing detail into a fake degradation signal.
const DROP_INFIX = /-(?:tiered|ephemeral|preview|experimental)-/g

export function canonicalModel(id) {
  if (typeof id !== 'string') return ''
  return id.trim().toLowerCase().replace(DROP_INFIX, '-')
}

/** Same model family: equal after normalisation. */
export function sameModel(a, b) {
  return canonicalModel(a) === canonicalModel(b)
}

/** Everything in `routed` that is genuinely a different model than `requested`. */
export function foreignModels(requested, routed) {
  const list = Array.isArray(routed) ? routed : []
  const wanted = canonicalModel(requested)
  const seen = new Set()
  const out = []
  for (const model of list) {
    if (typeof model !== 'string' || model === '') continue
    const key = canonicalModel(model)
    if (wanted !== '' && key === wanted) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(model)
  }
  return out
}
