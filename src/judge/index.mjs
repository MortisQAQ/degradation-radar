// Judging one drawing: rasterize, ask the multimodal model, keep both artifacts.
import { saveRender, renderSvg } from './render.mjs'
import { judgeImage, judgeConfig, subjectFor } from './vision.mjs'
import { judgeProfile } from './profile.mjs'

/**
 * Render + judge a single SVG artifact.
 *
 * Failures here are recorded, never thrown: a dead judge endpoint must not
 * destroy a completed probe run.
 */
export async function judgeSvgArtifact({ artifactPath, svgText, probeId, config = judgeConfig() }) {
  if (!subjectFor(probeId)) {
    return { skipped: 'probe has no visual subject' }
  }
  if (!svgText || !/<svg/i.test(svgText)) {
    return { skipped: 'no svg to render' }
  }

  let render
  try {
    render = await renderSvg(svgText)
  } catch (err) {
    return { ok: false, error: `render failed: ${String(err).slice(0, 200)}`, profile: judgeProfile(config) }
  }

  let renderPath = null
  try {
    if (artifactPath) renderPath = await saveRender(artifactPath, render.png)
  } catch {
    // Keeping the PNG is a convenience, not a requirement.
  }

  const verdict = await judgeImage({ png: render.png, probeId, config })
  return {
    ...verdict,
    renderPath: renderPath ? renderPath.split('\\').join('/') : null,
    viewport: { width: render.width, height: render.height },
    profile: judgeProfile(config),
  }
}
