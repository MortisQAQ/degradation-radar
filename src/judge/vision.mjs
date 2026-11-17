// Vision judge.
//
// The deterministic rubric answers "is this a well-formed drawing?"; it cannot
// answer "is this a pelican riding a bicycle?". That second question needs
// eyes. So one multimodal model looks at the rendered PNG and returns three
// discrete judgements, and *that* is what moves the needle for the pelican
// probes.
//
// Everything about the judge is pinned and recorded (endpoint, model id, prompt
// version) because an unpinned judge is how a dashboard silently changes its
// own mind between weeks without any model having degraded.
import { JUDGE_PROMPT_VERSION } from './profile.mjs'
export { JUDGE_PROMPT_VERSION }

const DEFAULTS = {
  baseUrl: process.env.RADAR_JUDGE_BASE ?? 'http://127.0.0.1:8317/v1',
  apiKey: process.env.RADAR_JUDGE_KEY ?? '123456',
  model: process.env.RADAR_JUDGE_MODEL ?? 'deepseek-v4.1-flash',
  timeoutMs: Number(process.env.RADAR_JUDGE_TIMEOUT_MS ?? 120_000),
}

export function judgeConfig() {
  return { ...DEFAULTS }
}

/** What the judge is asked to look at, per probe family. */
const SUBJECTS = {
  'pelican-bicycle': 'a pelican riding a bicycle',
  'pelican-skateboard': 'a pelican riding a skateboard',
  'pelican-tractor': 'a pelican driving a tractor',
  'pelican-rocket': 'a pelican riding a rocket',
}

export function subjectFor(probeId) {
  return SUBJECTS[probeId] ?? null
}

function buildPrompt(subject) {
  return [
    `This image is a render of a drawing a language model produced for the prompt "Generate an SVG of ${subject}".`,
    '',
    'Judge what is actually visible. Ignore style, colour and beauty.',
    'Return ONLY a JSON object, no prose, no code fence:',
    '{',
    `  "pelican": 0 | 1 | 2,`,
    `  "vehicle": 0 | 1 | 2,`,
    `  "riding": 0 | 1 | 2,`,
    `  "note": "<= 20 words"`,
    '}',
    'Scale: 0 = absent, 1 = present but partial/unrecognizable, 2 = clearly present.',
    '"pelican" = a bird with a pelican-like head/beak/pouch. ' +
      '"vehicle" = the requested vehicle with the parts that make it that vehicle. ' +
      '"riding" = the animal is positioned on/in the vehicle in a plausible riding pose ' +
      '(pedals, seat, handlebars touched where the vehicle has them).',
    '',
    'Output the JSON object and nothing else. Do not analyse, do not explain.',
  ].join('\n')
}

/**
 * Find the verdict object in a reply that may contain prose, a markdown fence,
 * and — the trap here — an *echo of the prompt's own schema*, which is not
 * valid JSON (`"pelican": 0 | 1 | 2`). So: scan every balanced object, keep the
 * first one that parses AND carries the three numeric fields.
 */
function extractVerdict(text) {
  if (typeof text !== 'string') return null
  const candidates = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const dims = ['pelican', 'vehicle', 'riding']
    if (dims.every((k) => parsed && typeof parsed[k] === 'number')) return parsed
  }
  return null
}

const clamp01 = (v) => (v === 0 || v === 1 || v === 2 ? v : null)

/**
 * Ask the multimodal model to judge one rendered drawing.
 * @returns {Promise<{ok: boolean, score: number|null, dims: object|null, note: string, model: string, latencyMs: number, error?: string, raw?: string}>}
 */
export async function judgeImage({ png, probeId, config = judgeConfig() }) {
  const subject = subjectFor(probeId)
  if (!subject) return { ok: false, score: null, dims: null, note: 'no vision subject for this probe', model: config.model, latencyMs: 0 }
  if (!png || png.length === 0) return { ok: false, score: null, dims: null, note: 'empty render', model: config.model, latencyMs: 0 }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        // Reasoning models spend output budget on the chain of thought first.
        // 400 was enough to think and leave `content` completely empty, which
        // looked exactly like a judge that refused to answer.
        // Reasoning models burn the budget on the chain of thought first; at
        // 1500 one judge call ended with finish_reason=length and no verdict.
        // 2500 was still not enough for a chatty judge; finish_reason=length
        // with an empty answer counts as "no verdict", which is worse than a
        // slightly truncated one.
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPrompt(subject) },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
            ],
          },
        ],
      }),
    })
    const latencyMs = Date.now() - started
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, score: null, dims: null, note: `judge HTTP ${res.status}`, model: config.model, latencyMs, raw: text.slice(0, 400) }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, score: null, dims: null, note: 'judge returned non-JSON envelope', model: config.model, latencyMs, raw: text.slice(0, 400) }
    }
    const message = body?.choices?.[0]?.message ?? {}
    // `content` first; some reasoning models park everything in
    // `reasoning_content` and hand back an empty string.
    const primary = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    const fallback = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    const presented = primary.trim() === '' ? fallback : primary
    const parsed = extractVerdict(presented)
    if (!parsed) {
      const lengthNote = presented.trim() === '' ? 'judge returned empty content (token budget?)' : 'judge verdict was not parseable'
      return {
        ok: false,
        score: null,
        dims: null,
        note: lengthNote,
        model: body?.model ?? config.model,
        latencyMs,
        raw: String(presented).slice(0, 600),
        finishReason: body?.choices?.[0]?.finish_reason ?? null,
      }
    }
    const pelican = clamp01(parsed.pelican)
    const vehicle = clamp01(parsed.vehicle)
    const riding = clamp01(parsed.riding)
    if (pelican === null || vehicle === null || riding === null) {
      return { ok: false, score: null, dims: null, note: 'judge used out-of-range values', model: body?.model ?? config.model, latencyMs, raw: JSON.stringify(parsed).slice(0, 400) }
    }
    const score = Math.round(((pelican + vehicle + riding) / 6) * 100)
    return {
      ok: true,
      score,
      dims: { pelican, vehicle, riding },
      // A pelican that is only "partial" is the classic degradation tell: the
      // shape is a bird-ish blob because the model stopped reasoning about what
      // a pelican actually looks like. Record it rather than smoothing it away.
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 160) : '',
      model: body?.model ?? config.model,
      latencyMs,
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return {
      ok: false,
      score: null,
      dims: null,
      note: aborted ? `judge timed out after ${config.timeoutMs}ms` : String(err).slice(0, 200),
      model: config.model,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Cheap liveness probe so the UI can say "judge unreachable" up front. */
export async function judgeHealth(config = judgeConfig()) {
  const started = Date.now()
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, status: res.status, model: config.model, latencyMs: Date.now() - started }
    const body = await res.json()
    const ids = (body?.data ?? []).map((m) => m.id)
    return {
      ok: ids.includes(config.model) || ids.length === 0,
      status: res.status,
      model: config.model,
      modelsAvailable: ids.length,
      hasModel: ids.includes(config.model),
      latencyMs: Date.now() - started,
    }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200), model: config.model, latencyMs: Date.now() - started }
  }
}

// ---------------------------------------------------------------- pairwise

const GAP_SCORE = { same_or_better: 100, slightly_worse: 70, clearly_worse: 40, unusable: 0 }

function buildPairPrompt(subject) {
  return [
    `IMAGE 1 is the reference: the same model answering "Generate an SVG of ${subject}" under normal conditions.`,
    `IMAGE 2 is the candidate under test, same prompt.`,
    '',
    'Compare IMAGE 2 against IMAGE 1. Judge only what is visible.',
    'Return ONLY a JSON object, no prose, no code fence:',
    '{',
    '  "pelican": 0 | 1 | 2,',
    '  "vehicle": 0 | 1 | 2,',
    '  "riding": 0 | 1 | 2,',
    '  "gap": "same_or_better" | "slightly_worse" | "clearly_worse" | "unusable",',
    '  "note": "<= 20 words"',
    '}',
    '',
    'pelican/vehicle/riding describe IMAGE 2 on the 0-2 scale ' +
      '(0 = absent, 1 = partial or unrecognizable, 2 = clearly present).',
    'gap = how far IMAGE 2 falls short of IMAGE 1 overall:',
    '  same_or_better = comparable detail and structure;',
    '  slightly_worse = recognizably the same subject but thinner (missing parts, crude shapes);',
    '  clearly_worse = the subject is only barely there, major parts missing;',
    '  unusable = not a drawing of the requested subject.',
    'Output the JSON object and nothing else. Do not analyse, do not explain.',
  ].join('\n')
}

/**
 * Judge a candidate drawing against a reference drawing.
 * @returns {Promise<{ok:boolean, score:number|null, gap:string|null, dims:object|null, note:string, model:string, latencyMs:number}>}
 */
export async function judgePair({ candidatePng, referencePng, probeId, config = judgeConfig() }) {
  const subject = subjectFor(probeId)
  if (!subject) return { ok: false, score: null, gap: null, dims: null, note: 'no vision subject', model: config.model, latencyMs: 0 }
  if (!candidatePng?.length) return { ok: false, score: null, gap: null, dims: null, note: 'empty render', model: config.model, latencyMs: 0 }
  if (!referencePng?.length) return { ok: false, score: null, gap: null, dims: null, note: 'empty reference', model: config.model, latencyMs: 0 }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: buildPairPrompt(subject) },
              { type: 'text', text: 'IMAGE 1 (reference):' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${referencePng.toString('base64')}` } },
              { type: 'text', text: 'IMAGE 2 (candidate):' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${candidatePng.toString('base64')}` } },
            ],
          },
        ],
      }),
    })
    const latencyMs = Date.now() - started
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, score: null, gap: null, dims: null, note: `judge HTTP ${res.status}`, model: config.model, latencyMs, raw: text.slice(0, 400) }
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, score: null, gap: null, dims: null, note: 'judge returned non-JSON envelope', model: config.model, latencyMs }
    }
    const message = body?.choices?.[0]?.message ?? {}
    const primary = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    const presented = primary.trim() === '' ? String(message.reasoning_content ?? '') : primary
    const parsed = extractVerdict(presented)
    if (!parsed) {
      return {
        ok: false,
        score: null,
        gap: null,
        dims: null,
        note: presented.trim() === '' ? 'judge returned empty content (token budget?)' : 'judge verdict was not parseable',
        model: body?.model ?? config.model,
        latencyMs,
        raw: presented.slice(0, 600),
        finishReason: body?.choices?.[0]?.finish_reason ?? null,
      }
    }
    const pelican = clamp01(parsed.pelican)
    const vehicle = clamp01(parsed.vehicle)
    const riding = clamp01(parsed.riding)
    const gap = typeof parsed.gap === 'string' ? parsed.gap.trim().toLowerCase() : ''
    if (pelican === null || vehicle === null || riding === null || !(gap in GAP_SCORE)) {
      return {
        ok: false,
        score: null,
        gap: null,
        dims: null,
        note: 'judge used values outside the rubric',
        model: body?.model ?? config.model,
        latencyMs,
        raw: JSON.stringify(parsed).slice(0, 400),
      }
    }
    return {
      ok: true,
      score: GAP_SCORE[gap],
      gap,
      dims: { pelican, vehicle, riding },
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 160) : '',
      model: body?.model ?? config.model,
      latencyMs,
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return {
      ok: false,
      score: null,
      gap: null,
      dims: null,
      note: aborted ? `judge timed out after ${config.timeoutMs}ms` : String(err).slice(0, 200),
      model: config.model,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}
