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
    // Verbatim, the canonical Simon Willison wording. Do not polish it: the
    // whole point is that this exact string has years of public baselines.
    prompt: 'Generate an SVG of a pelican riding a bicycle.',
  },
  'pelican-skateboard': {
    id: 'pelican-skateboard',
    label: '鹈鹕踩滑板',
    kind: 'svg',
    prompt: 'Generate an SVG of a pelican riding a skateboard.',
  },
  'pelican-tractor': {
    id: 'pelican-tractor',
    label: '鹈鹕开拖拉机',
    kind: 'svg',
    prompt: 'Generate an SVG of a pelican driving a tractor.',
  },
  'pelican-rocket': {
    id: 'pelican-rocket',
    label: '鹈鹕搭火箭',
    kind: 'svg',
    prompt: 'Generate an SVG of a pelican riding a rocket.',
  },
  'json-strict': {
    id: 'json-strict',
    label: '严格 JSON',
    kind: 'json',
    prompt:
      'Return ONLY a JSON object, no prose and no code fence, with exactly these keys: ' +
      '"city" (string), "population" (integer), "landmarks" (array of exactly 3 strings), ' +
      '"founded" (integer year). Use Tokyo.',
  },
  math: {
    id: 'math',
    label: '数学推理',
    kind: 'number',
    prompt:
      'A tank is filled by pipe A in 6 hours and by pipe B in 4 hours. Both are opened together, ' +
      'but pipe A is closed 1 hour before the tank is full. How many hours did it take in total? ' +
      'Answer with the number only (decimals allowed).',
    // 1/a + 1/b = 5/12 per hour. If total time is t, A runs t-1, B runs t:
    // (t-1)/6 + t/4 = 1 => 2(t-1) + 3t = 12 => 5t = 14 => t = 2.8
    answer: 2.8,
    tolerance: 0.02,
  },
  'code-lis': {
    id: 'code-lis',
    label: '代码（LIS）',
    kind: 'code',
    prompt:
      'Write a Python function `lis(nums)` that returns the length of the longest strictly ' +
      'increasing subsequence in O(n log n). Output only one fenced python code block.',
    tests: [
      ['lis([10,9,2,5,3,7,101,18])', 4],
      ['lis([1,2,3,4])', 4],
      ['lis([5,4,3,2,1])', 1],
      ['lis([])', 0],
      ['lis([3,3,3])', 1],
    ],
  },
}

export const DEFAULT_PROBE_IDS = ['pelican-bicycle', 'json-strict', 'math', 'code-lis']

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
