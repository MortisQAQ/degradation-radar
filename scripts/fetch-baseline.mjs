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
const MODELS = ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon']
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
  const ri = rows.indexOf(THINKING)
  if (ri < 0) throw new Error(`thinking level not found: ${THINKING}`)
  await mkdir(OUT, { recursive: true })

  const written = []
  for (const model of MODELS) {
    const ci = modelColumns.indexOf(model)
    if (ci < 0) {
      console.warn(`  skip ${model}: column missing`)
      continue
    }
    const cell = cells[ri * modelColumns.length + ci]
    if (!cell?.base64) {
      console.warn(`  skip ${model}: cell has no embedded svg`)
      continue
    }
    const svg = Buffer.from(cell.base64, 'base64').toString('utf8')
    const stem = `${model}-${THINKING}.pelican-bicycle`
    fs.writeFileSync(join(OUT, `${stem}.svg`), svg)
    const render = await renderSvg(svg)
    fs.writeFileSync(join(OUT, `${stem}.png`), render.png)
    written.push({ model, stem, bytes: svg.length, caption: cell.caption, size: `${render.width}x${render.height}` })
    console.log(`  wrote ${stem}.svg (${svg.length}B) + .png (${render.width}x${render.height})`)
  }
  if (written.length === 0) throw new Error('no baselines extracted')

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
      `- 取用单元格: 思考档 \`${THINKING}\` × 模型 ${written.map((w) => '`' + w.model + '`').join(' / ')}`,
      '',
      '| 模型 | 文件 | 页面自有统计 |',
      '|---|---|---|',
      ...written.map((w) => `| \`${w.model}\` | \`${w.stem}.svg\` / \`.png\`（${w.size}） | ${w.caption} |`),
      '',
      '## 用途',
      '成对比较（pairwise）的参照图：判官同时看这张参考图和被测图，回答「相对同模型',
      '正常放开跑差多少」，而不是给一个没有锚点的绝对分。',
      '',
      '## 注意',
      '这条是 Simon 通过 API 直接跑的，与本机 agy CLI 的编排层不同（系统提示、工具集、',
      '模式都不一样）。它代表「同模型不受编排层干扰时的水平」，不代表 agy 的默认行为。',
      '参照按「请求的模型」选择：测 argon 就用 argon 的参照，测 hydrogen 就用 hydrogen 的，',
      '绝不拿另一个模型的图当自己的锚点。没有对应模型参照的探针/模型仍然使用绝对评分。',
    ].join('\n'),
  )

  console.log(`done: ${written.length} baseline(s) in ${OUT}`)
}

await main()
