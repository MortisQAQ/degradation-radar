// SVG -> PNG, so a vision model can look at what the subscriber actually drew.
//
// We shell out to an installed Chromium instead of adding a rasterizer
// dependency: every machine that can run these CLIs already has a browser, and
// a headless screenshot is the same renderer the user will judge with. No npm
// packages, no native build step.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const CANDIDATES = [
  process.env.RADAR_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

export function findBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* unreadable path, keep looking */
    }
  }
  return null
}

/** Pull a viewport out of the SVG. Models emit wildly inconsistent units. */
function viewportOf(svg) {
  const num = (re) => {
    const m = re.exec(svg)
    if (!m) return null
    const value = Number.parseFloat(m[1])
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const w = num(/<svg[^>]*\bwidth\s*=\s*["'](\d+(?:\.\d+)?)/i)
  const h = num(/<svg[^>]*\bheight\s*=\s*["'](\d+(?:\.\d+)?)/i)
  const viewBox = /<svg[^>]*\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg)
  const vbW = viewBox ? Number.parseFloat(viewBox[3]) : null
  const vbH = viewBox ? Number.parseFloat(viewBox[4]) : null
  // Floor at 480: a 200x200 drawing rendered at 200px is too small for a
  // vision model to tell a pelican's beak from a smudge.
  const scale = Math.max(1, 480 / Math.max(w ?? vbW ?? 480, h ?? vbH ?? 480))
  const width = Math.round(Math.min(1600, Math.max(480, (w ?? vbW ?? 800) * scale)))
  const height = Math.round(Math.min(1600, Math.max(360, (h ?? vbH ?? 600) * scale)))
  return { width, height }
}

/**
 * Take exactly one SVG document out of a model reply.
 *
 * The reply usually has prose (or a markdown artifact report) after `</svg>`.
 * Left in place, the browser renders that prose as visible text inside the
 * stage — and the judge then correctly reports "this image is text".
 */
export function isolateSvg(text) {
  if (typeof text !== 'string') return null
  const start = text.search(/<svg[\s>]/i)
  if (start < 0) return null
  const close = text.lastIndexOf('</svg>')
  if (close > start) return text.slice(start, close + 6)
  // Truncated document: hand over what exists so the grader/judge can see the
  // damage instead of silently rendering nothing.
  return text.slice(start)
}

/**
 * Rasterize an SVG document to PNG.
 * @returns {{ png: Buffer, width: number, height: number, browser: string }}
 */
export async function renderSvg(svg, options = {}) {
  const browser = options.browser ?? findBrowser()
  if (!browser) throw new Error('no chromium/edge found (set RADAR_CHROME)')
  const document = isolateSvg(svg)
  if (!document) throw new Error('not an svg document')

  // A dark-on-dark drawing on a transparent page screenshots as a black
  // rectangle; force an opaque white canvas the way a reader would see it.
  const { width, height } = viewportOf(document)
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#fff;}
  #stage{width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center;}
  #stage>svg{max-width:100%;max-height:100%;}
</style>
<div id="stage">${document}</div>`

  const dir = await mkdtemp(join(tmpdir(), 'radar-render-'))
  const page = join(dir, 'page.html')
  const shot = join(dir, 'shot.png')
  const profile = join(dir, 'profile')
  mkdirSync(profile, { recursive: true })
  await writeFile(page, html, 'utf8')

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--screenshot=${shot}`,
    'file:///' + page.split('\\').join('/'),
  ]

  try {
    await new Promise((resolve, reject) => {
      const child = execFile(browser, args, { timeout: options.timeoutMs ?? 30_000, windowsHide: true }, (err) =>
        err ? reject(err) : resolve(),
      )
      child.on('error', reject)
    })
    const png = await readFile(shot)
    if (png.length === 0) throw new Error('empty screenshot')
    return { png, width, height, browser }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Write a rendered PNG next to the artifact it came from. */
export async function saveRender(artifactPath, png) {
  const target = artifactPath.replace(/\.svg$/i, '.render.png')
  mkdirSync(dirname(target), { recursive: true })
  await writeFile(target, png)
  return target
}
