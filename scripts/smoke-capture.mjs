// Feasibility smoke test: does a *real* agy run, forced through the capture
// proxy, yield readable request bodies and upstream SSE answers?
import { spawn } from 'node:child_process'
import { startCapture } from '../src/capture/mitm.mjs'

const PORT = 8899
const capture = await startCapture({ port: PORT, verbose: true, captureDir: 'captures' })
console.log(`capture listening on ${PORT} -> ${capture.capturePath}`)

const prompt = 'Generate an SVG of a pelican riding a bicycle.'
const args = [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--print-timeout', '3m',
  '--model', process.env.RADAR_MODEL ?? 'gemini-4-hydrogen-high',
]

const env = {
  ...process.env,
  HTTPS_PROXY: `http://127.0.0.1:${PORT}`,
  HTTP_PROXY: `http://127.0.0.1:${PORT}`,
  NO_PROXY: '',
  https_proxy: `http://127.0.0.1:${PORT}`,
  http_proxy: `http://127.0.0.1:${PORT}`,
}

const child = spawn('agy', args, { env, windowsHide: true })
let stdout = ''
child.stdout.on('data', (c) => (stdout += c))
child.stderr.on('data', (c) => (stdout += c))
child.stdin.end()

const t0 = Date.now()
const code = await new Promise((resolve) => child.on('exit', resolve))
console.log(`\nagy exited ${code} in ${Date.now() - t0}ms`)

const resultLine = stdout.split('\n').filter((l) => l.includes('"event":"result"')).at(-1)
console.log('result envelope:', resultLine ? resultLine.slice(0, 300) : '(none)')

await new Promise((r) => setTimeout(r, 500))
await capture.close()

console.log(`\n=== captured ${capture.flows.length} flows ===`)
for (const f of capture.flows) {
  const s = f.reqSummary ?? {}
  console.log(
    `${f.status} ${f.method} ${f.host}${f.path.slice(0, 60)} ${f.durationMs}ms ` +
      `req=${(f.reqBody ?? '').length}B resp=${(f.respBody ?? '').length}B ` +
      `model=${s.model ?? '-'} promptChars=${s.promptChars ?? '-'} sseEvents=${f.respSummary?.eventCount ?? '-'}`,
  )
}

const gen = capture.flows.find((f) => f.reqSummary?.kind === 'generate')
if (gen) {
  console.log('\n=== generate flow detail ===')
  console.log('model:', gen.reqSummary.model)
  console.log('prompt head:', gen.reqSummary.promptHead?.slice(0, 200))
  console.log('tools:', gen.reqSummary.toolCount, 'temp:', gen.reqSummary.temperature)
  const first = gen.respSummary?.events?.[0]
  console.log('first sse event (truncated):', JSON.stringify(first).slice(0, 600))
  const textPart = JSON.stringify(gen.respSummary?.events ?? []).match(/"text":"([^"]{20,300})/)
  console.log('some model text:', textPart?.[1]?.slice(0, 300) ?? '(none found)')
} else {
  console.log('\n!! no generate flow captured')
}
