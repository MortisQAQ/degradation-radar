// Judge identity.
//
// Stored with every run: if the judge model or its prompt changes, old runs are
// not comparable to new ones, and the dashboard must be able to say so instead
// of quietly drawing a cliff.
export const JUDGE_PROMPT_VERSION = 'pelican-vision-1'

export function judgeProfile(config) {
  return {
    kind: 'vision',
    baseUrl: config.baseUrl,
    model: config.model,
    promptVersion: JUDGE_PROMPT_VERSION,
  }
}

/** Two profiles are comparable only when every pin matches. */
export function sameJudge(a, b) {
  if (!a || !b) return false
  return a.model === b.model && a.promptVersion === b.promptVersion && a.baseUrl === b.baseUrl
}
