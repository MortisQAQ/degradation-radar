// Deterministic graders.
//
// No LLM judge is required for a run to be scored: a judge introduces its own
// version drift, which is one of the documented ways a dashboard invents a
// degradation that never happened. The rubric below is pure code — same input,
// same number, forever.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Tags that turn an "SVG" into an HTML page / a script host. */
const FORBIDDEN_TAGS = ['script', 'foreignobject', 'iframe', 'image', 'animate', 'set']

/** One pass over the markup: balance check plus a tag census. */
function scanMarkup(svg) {
  const VOID_OK = new Set([])
  const stack = []
  const tags = new Map()
  let unbalanced = null
  let truncated = false
  const re = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = re.exec(svg)) !== null) {
    const [, closing, rawName, attrs, selfClose] = m
    const name = rawName.toLowerCase()
    if (closing === '/') {
      const open = stack.pop()
      if (open !== name && unbalanced === null) unbalanced = `</${name}> closes <${open ?? 'nothing'}>`
    } else if (selfClose !== '/' && !VOID_OK.has(name)) {
      stack.push(name)
    }
    if (closing !== '/') tags.set(name, (tags.get(name) ?? 0) + 1)
    // Attribute-level smuggling: onclick= / javascript: / external refs.
    if (attrs && /(on[a-z]+\s*=|javascript:|href\s*=\s*["']https?:)/i.test(attrs)) {
      if (unbalanced === null) unbalanced = 'scriptable attribute'
    }
  }
  if (stack.length > 0) {
    // An unclosed root is the signature of a truncated stream.
    truncated = stack.includes('svg')
    if (!truncated && unbalanced === null) unbalanced = `unclosed <${stack[stack.length - 1]}>`
  }
  return { tags, unbalanced, truncated, elementCount: [...tags.values()].reduce((a, b) => a + b, 0) }
}

/**
 * Score a pelican SVG 0-100.
 *
 * Weights encode what actually distinguishes a degraded answer from a healthy
 * one: does a document exist at all (structure), is it rich enough to be a
 * drawing rather than a placeholder (richness), and does it respect the
 * constraints a real client would enforce (constraints).
 */
export function gradeSvg(text, { requireViewBox = true } = {}) {
  const metrics = {}
  if (!text || text.trim() === '') {
    return { pass: false, score: 0, failureReason: 'empty-response', metrics }
  }
  const svgMatch = /<svg[\s\S]*?(<\/svg>|$)/i.exec(text)
  if (!svgMatch) {
    return { pass: false, score: 0, failureReason: 'no-svg-element', metrics }
  }
  const svg = svgMatch[0]
  metrics.bytes = Buffer.byteLength(svg)
  const scan = scanMarkup(svg)
  metrics.elementCount = scan.elementCount
  metrics.distinctTags = scan.tags.size
  metrics.hasPath = (scan.tags.get('path') ?? 0) > 0
  metrics.hasCircle = (scan.tags.get('circle') ?? 0) > 0
  metrics.hasEllipse = (scan.tags.get('ellipse') ?? 0) > 0
  metrics.hasGroup = (scan.tags.get('g') ?? 0) > 0
  metrics.circles = scan.tags.get('circle') ?? 0
  metrics.paths = scan.tags.get('path') ?? 0
  metrics.hasViewBox = /viewBox\s*=\s*["'][^"']+["']/i.test(svg)
  metrics.hasDimensions = /<svg[^>]*(width|height)\s*=/i.test(svg)

  const forbidden = FORBIDDEN_TAGS.filter((t) => scan.tags.has(t))
  metrics.forbiddenTags = forbidden

  const problems = []
  if (scan.truncated) problems.push('truncated-svg')
  if (scan.unbalanced) problems.push('malformed:' + scan.unbalanced)
  if (forbidden.length > 0) problems.push('forbidden-tag:' + forbidden.join(','))
  if (requireViewBox && !metrics.hasViewBox) problems.push('missing-viewbox')

  // Structure: 40
  let structure = 0
  structure += scan.tags.has('svg') ? 20 : 0
  structure += !scan.truncated ? 10 : 0
  structure += scan.unbalanced === null ? 10 : 0
  // Richness: 35 — a pelican on a bicycle needs real geometry, not three rects.
  let richness = 0
  richness += Math.min(15, Math.floor(scan.elementCount / 6))
  richness += Math.min(8, scan.tags.size * 2)
  richness += metrics.hasPath ? 6 : 0
  richness += metrics.hasCircle || metrics.hasEllipse ? 6 : 0
  richness = Math.min(35, richness)
  // Constraints: 25
  let constraints = 0
  constraints += metrics.hasViewBox ? 10 : 0
  constraints += metrics.hasDimensions ? 5 : 0
  constraints += forbidden.length === 0 ? 10 : 0

  const score = Math.round(Math.max(0, Math.min(100, structure + richness + constraints)))
  // Pass requires the document to be usable: parseable, no smuggling, and
  // enough content that a human would recognise a drawing.
  const pass = !scan.truncated && scan.unbalanced === null && forbidden.length === 0 && score >= 60
  return {
    pass,
    score,
    failureReason: pass ? null : problems[0] ?? 'below-threshold',
    metrics: { ...metrics, structure, richness, constraints, problems },
  }
}

export function gradeJson(text) {
  const metrics = {}
  if (!text) return { pass: false, score: 0, failureReason: 'empty-response', metrics }
  // Models love fences even when told not to; a fence means the answer is not
  // machine-consumable as delivered, so it costs points but is not fatal.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced ? fenced[1] : text).trim()
  metrics.hadFence = Boolean(fenced)
  metrics.proseChars = text.length - body.length
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return { pass: false, score: 10, failureReason: 'unparsable-json', metrics }
  }
  const checks = [
    ['city', typeof parsed.city === 'string'],
    ['population', Number.isInteger(parsed.population)],
    ['landmarks', Array.isArray(parsed.landmarks) && parsed.landmarks.length === 3],
    ['founded', Number.isInteger(parsed.founded)],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([k]) => k)
  metrics.failedFields = failed
  let score = 40
  score += (checks.length - failed.length) * 12
  score += metrics.hadFence ? 0 : 12
  score = Math.min(100, score)
  return {
    pass: failed.length === 0 && !metrics.hadFence,
    score,
    failureReason: failed.length > 0 ? 'bad-fields:' + failed.join(',') : metrics.hadFence ? 'wrapped-in-fence' : null,
    metrics,
  }
}

export function gradeNumber(text, expected, tolerance = 0.02) {
  const metrics = {}
  if (!text) return { pass: false, score: 0, failureReason: 'empty-response', metrics }
  const nums = [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
  metrics.found = nums.slice(0, 8)
  metrics.length = text.length
  if (nums.length === 0) return { pass: false, score: 0, failureReason: 'no-number', metrics }
  // The correct value should surface early; a number buried in a wall of prose
  // is a weaker signal than one stated plainly.
  const first = nums[0]
  const anywhere = nums.some((n) => Math.abs(n - expected) <= tolerance)
  const score = Math.abs(first - expected) <= tolerance ? 100 : anywhere ? 55 : 10
  return {
    pass: Math.abs(first - expected) <= tolerance,
    score,
    failureReason: score === 100 ? null : anywhere ? 'answer-not-first' : 'wrong-answer',
    metrics,
  }
}

/** Run generated Python against fixed cases in a throwaway process. */
export async function gradeCode(text, tests, { timeoutMs = 8000 } = {}) {
  const metrics = {}
  if (!text) return { pass: false, score: 0, failureReason: 'empty-response', metrics }
  const fenced = /```(?:python|py)?\s*([\s\S]*?)```/i.exec(text)
  const code = (fenced ? fenced[1] : text).trim()
  metrics.hadFence = Boolean(fenced)
  metrics.codeBytes = Buffer.byteLength(code)
  if (!/def\s+lis\s*\(/.test(code)) {
    return { pass: false, score: 0, failureReason: 'no-lis-function', metrics }
  }
  metrics.usesBisect = /bisect/.test(code)

  const dir = await mkdtemp(join(tmpdir(), 'radar-code-'))
  const harness = [
    code,
    '',
    'import json, sys',
    'cases = ' + JSON.stringify(tests),
    'out = []',
    'for expr, want in cases:',
    '    try:',
    '        got = eval(expr)',
    '        out.append([expr, got, want, got == want])',
    '    except Exception as e:',
    '        out.append([expr, "EXC:" + type(e).__name__, want, False])',
    'print(json.dumps(out))',
  ].join('\n')
  const file = join(dir, 'solution.py')
  await writeFile(file, harness, 'utf8')
  const py = process.env.RADAR_PYTHON ?? 'python'
  const result = await new Promise((resolve) => {
    const child = spawn(py, [file], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: String(e) })
    })
  })
  await rm(dir, { recursive: true, force: true })

  if (result.code !== 0) {
    return { pass: false, score: 5, failureReason: 'python-error', metrics: { ...metrics, stderrTail: result.err.slice(-400) } }
  }
  const line = result.out.trim().split(/\r?\n/).pop() ?? ''
  let rows
  try {
    rows = JSON.parse(line)
  } catch {
    return { pass: false, score: 5, failureReason: 'harness-output-unparseable', metrics }
  }
  const passed = rows.filter((r) => r[3]).length
  metrics.cases = rows.map(([expr, got, want, ok]) => ({ expr, got, want, ok }))
  metrics.passed = passed
  metrics.total = rows.length
  const score = Math.round((passed / rows.length) * 100)
  return {
    pass: passed === rows.length,
    score,
    failureReason: passed === rows.length ? null : `failed ${rows.length - passed}/${rows.length} cases`,
    metrics,
  }
}

/** Refusals are a degradation symptom in their own right — and must be graded
 *  as a failure, never as an unparseable artifact. */
export function looksLikeRefusal(text) {
  if (!text || text.length > 4000) return false
  return /^(i'?m sorry|i apologi[sz]e|i can'?t|i cannot|sorry|as an ai|我无法|抱歉|很抱歉|我不能)/i.test(text.trim())
}

/**
 * A signed-out or misconfigured CLI is an infrastructure failure, not a model
 * quality signal. Conflating the two is how a dashboard "proves" a regression
 * that is really just an expired token.
 */
export function looksLikeAuthFailure(text, error) {
  const haystack = `${text ?? ''}\n${error ?? ''}`
  if (haystack.trim() === '') return false
  return /not logged in|please run \/?login|not signed in|sign in to|invalid api key|unauthorized|401|authentication_error|credentials? (?:expired|missing)/i.test(
    haystack,
  )
}

/** Dispatch by probe kind. */
export async function gradeProbe(probe, text, error) {
  if (looksLikeAuthFailure(text, error)) {
    return { pass: false, score: 0, failureReason: 'not-authenticated', metrics: { infra: true } }
  }
  if (looksLikeRefusal(text)) {
    return { pass: false, score: 0, failureReason: 'refusal', metrics: {} }
  }
  switch (probe.kind) {
    case 'svg':
      return gradeSvg(text)
    case 'json':
      return gradeJson(text)
    case 'number':
      return gradeNumber(text, probe.answer, probe.tolerance)
    case 'code':
      return await gradeCode(text, probe.tests)
    default:
      return { pass: false, score: 0, failureReason: 'unknown-probe-kind', metrics: {} }
  }
}
