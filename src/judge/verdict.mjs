// Verdict: turn measurements into one sentence a human can act on.
//
// Deliberately NOT another model call. The judge already produced the hard part
// (what is visible in the drawing); asking a second LLM "so is this degraded?"
// would let the same family of model grade its own homework and would make the
// verdict unreproducible. Arithmetic over the judge's output is auditable; a
// second opinion is not.

const LEVELS = {
  unmeasured: { label: '未测到', tone: 'muted' },
  baseline: { label: '基线中', tone: 'muted' },
  healthy: { label: '正常', tone: 'ok' },
  suspect: { label: '疑似降智', tone: 'warn' },
  degraded: { label: '降智', tone: 'bad' },
}

export { LEVELS }

/** Median of the trailing window, ignoring runs that never reached the model. */
function trailingMedian(history, pick) {
  const values = history
    .filter((r) => (r.summary?.infraBlocked ?? 0) < Math.max(1, r.summary?.total ?? 1))
    .map(pick)
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * @param run         the completed run record
 * @param history     earlier runs for the same provider+model, oldest first
 */
export function computeVerdict(run, history = []) {
  const s = run.summary ?? {}
  const total = s.total ?? 0
  const blocked = s.infraBlocked ?? 0
  const reasons = []

  if (total === 0) {
    return { level: 'unmeasured', label: LEVELS.unmeasured.label, tone: 'muted', score: null, reasons: ['这一轮没有产生任何探针结果'] }
  }
  if (blocked >= total) {
    return {
      level: 'unmeasured',
      label: LEVELS.unmeasured.label,
      tone: 'muted',
      score: null,
      reasons: [`全部 ${total} 个探针都没到达模型（多为未登录或凭据失效），本轮不计入降智判断`],
    }
  }

  const vision = typeof s.avgVisionScore === 'number' && s.visionJudged > 0 ? s.avgVisionScore : null
  const baseVision = trailingMedian(history, (r) => r.summary?.avgVisionScore)
  const basePass = trailingMedian(history, (r) => r.summary?.passRate)

  // Vision is the primary signal whenever it exists: "is it a pelican riding a
  // bicycle" is the question we actually care about.
  const primary = vision ?? Math.round((s.passRate ?? 0) * 100)
  const basePrimary = vision !== null ? baseVision : basePass !== null ? Math.round(basePass * 100) : null

  if (blocked > 0) reasons.push(`${blocked}/${total} 个探针基础设施失败，已从判定中剔除`)

  if (s.requestedModelNeverServed) {
    reasons.push(`请求的模型 ${run.model} 在网线上一次都没被真正服务——路由被换掉了`)
  }

  const extra = (s.returnedModels ?? []).filter((m) => m !== run.model)
  if (extra.length > 0) {
    reasons.push(`线上还出现了 ${extra.join(', ')} 的调用（辅助任务或路由降级，需结合上下文判断）`)
  }

  if (basePrimary === null) {
    if (vision !== null) reasons.push(`视觉判定 ${vision}/100（尚无历史基线可比）`)
    return {
      level: 'baseline',
      label: LEVELS.baseline.label,
      tone: 'muted',
      score: primary,
      reasons: [...reasons, '至少 3 轮之后才能与自身基线比较'],
    }
  }

  const drop = basePrimary === 0 ? 0 : ((basePrimary - primary) / basePrimary) * 100
  reasons.push(vision !== null ? `视觉判定 ${primary}/100（基线 ${Math.round(basePrimary)}）` : `合格率 ${primary}%（基线 ${Math.round(basePrimary)}%）`)

  let level
  if (primary <= 33 || drop >= 35) level = 'degraded'
  else if (primary <= 60 || drop >= 18) level = 'suspect'
  else level = 'healthy'

  if (drop >= 18) reasons.push(`相对自身基线下降 ${drop.toFixed(0)}%`)
  if (s.failures?.length > 0 && level !== 'healthy') reasons.push(`失败项：${s.failures.slice(0, 4).join('；')}`)

  return { level, label: LEVELS[level].label, tone: LEVELS[level].tone, score: primary, baseline: Math.round(basePrimary), reasons }
}
