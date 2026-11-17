#!/usr/bin/env node
// Fetch the reference drawing used for pairwise judging.
//
// Baseline: Simon Willison's "Gemini 4 SVG thinking-level comparison" page,
// cell (thinking=high × model=gemini-4-hydrogen), prompt run verbatim as
// "Generate an SVG of a pelican riding a bicycle".
//
// The SVG is not vendored into the repo (it is someone else's output, and it
// should stay traceable to its source). This script re-derives it, writes the
// raw SVG plus a provenance note, and renders a PNG for the judge.
//
//   node scripts/fetch-baseline.mjs
import fs from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderSvg } from '../src/judge/render.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'data', 'baselines')
const PAGE = 'https://static.simonwillison.net/static/2026/gemini-4-pelicans.html'
const MODEL = 'gemini-4-hydrogen'
const THINKING = 'high'

async function main() {
  console.log(`fetching ${PAGE}`)
  const html = await (await fetch(PAGE)).text()
  const table = html.slice(html.indexOf('<table'), html.indexOf('</table>') + 8)
  if (table === '') throw new Error('table not found — page layout changed')

  const columns = [...table.matchAll(/<th scope="col">(?:<a[^>]*>)?([a-zA-Z0-9-]+)/g)].map((m) => m[1])
  const rows = [...table.matchAll(/<th scope="row">\s*([a-z]+)\s*<\/th>/g)].map((m) => m[1])
  const gist = /<th scope="col"><a href="([^"]+)">gemini-4-hydrogen/.exec(table)?.[1] ?? ''
  const cells = [...table.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => {
    const img = /src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/.exec(m[1])
    return {
      base64: img ? img[1] : null,
      caption: m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    }
  })

  const modelColumns = columns.filter((c) => c.startsWith('gemini-4-'))
  const ci = modelColumns.indexOf(MODEL)
  const ri = rows.indexOf(THINKING)
  if (ci < 0 || ri < 0) throw new Error(`cell not found: model=${MODEL} thinking=${THINKING}`)
  const cell = cells[ri * modelColumns.length + ci]
  if (!cell?.base64) throw new Error('cell has no embedded svg')

  const svg = Buffer.from(cell.base64, 'base64').toString('utf8')
  await mkdir(OUT, { recursive: true })
  const stem = `${MODEL}-${THINKING}.pelican-bicycle`
  fs.writeFileSync(join(OUT, `${stem}.svg`), svg)

  const render = await renderSvg(svg)
  fs.writeFileSync(join(OUT, `${stem}.png`), render.png)

  fs.writeFileSync(
    join(OUT, 'PROVENANCE.md'),
    [
      '# 参考基准出处',
      '',
      `- 来源页面: ${PAGE}`,
      '- 页面标题: Gemini 4 SVG thinking-level comparison（作者 Simon Willison）',
      `- 原始 SVG gist: ${gist}`,
      `- 抓取时间: ${new Date().toISOString()}`,
      '- 逐字 prompt: `Generate an SVG of a pelican riding a bicycle`',
      `- 取用单元格: 思考档 \`${THINKING}\` × 模型 \`${MODEL}\``,
      `- 页面自有统计: ${cell.caption}`,
      `- 本地文件: \`${stem}.svg\` / \`${stem}.png\`（${render.width}×${render.height}）`,
      '',
      '## 用途',
      '成对比较（pairwise）的参照图：判官同时看这张参考图和被测图，回答「相对同模型',
      '正常放开跑差多少」，而不是给一个没有锚点的绝对分。',
      '',
      '## 注意',
      '这条是 Simon 通过 API 直接跑的，与本机 agy CLI 的编排层不同（系统提示、工具集、',
      '模式都不一样）。它代表「同模型不受编排层干扰时的水平」，不代表 agy 的默认行为。',
      '只有 pelican-bicycle 有公开可比的参照；其余变体仍然使用绝对评分。',
    ].join('\n'),
  )

  console.log(`wrote ${stem}.svg (${svg.length}B) and .png (${render.width}x${render.height})`)
}

await main()
