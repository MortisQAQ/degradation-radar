// Observation-only MITM proxy.
//
// It is NOT a reverse proxy: the CLI still talks to the real upstream
// (daily-cloudcode-pa.googleapis.com, api.anthropic.com, ...). This process
// only terminates the TLS hop the CLI opened *towards us* because we were
// configured as HTTPS_PROXY, then re-originates a separately verified TLS
// connection to the genuine host. Nothing is rewritten, nothing is cached,
// no request is answered from here.
//
// ALPN is deliberately pinned to http/1.1: the upstreams would happily speak
// h2/gRPC and we would be left staring at binary frame soup. Forcing h1 keeps
// every request and every SSE chunk readable as text.
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const REDACTED = '<redacted>'
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-goog-api-key',
  'anthropic-api-key',
  'openai-api-key',
  'x-api-key',
])

/** Headers worth keeping for forensics, but never the credentials. */
function scrubHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v
  }
  return out
}

/** Shape summary of a generation request, so the UI can label a flow. */
function summarizeRequestBody(text) {
  const summary = { kind: 'other' }
  if (!text) return summary
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    return summary
  }
  if (typeof json !== 'object' || json === null) return summary

  if (typeof json.model === 'string') summary.model = json.model
  if (typeof json.project === 'string') summary.project = json.project

  const request = json.request ?? json
  const contents = request.contents
  if (Array.isArray(contents)) {
    summary.kind = 'generate'
    summary.turns = contents.length
    const texts = []
    for (const c of contents) {
      for (const p of c?.parts ?? []) if (typeof p?.text === 'string') texts.push(p.text)
    }
    summary.promptChars = texts.join('\n').length
    summary.promptHead = texts.length > 0 ? texts[0].slice(0, 240) : ''
    const last = texts.length > 0 ? texts[texts.length - 1] : ''
    summary.promptTail = last.slice(-240)
  }
  const tools = request.tools
  if (Array.isArray(tools)) summary.toolCount = tools.length
  const gen = request.generationConfig
  if (gen && typeof gen === 'object') {
    if (typeof gen.temperature === 'number') summary.temperature = gen.temperature
    if (typeof gen.maxOutputTokens === 'number') summary.maxOutputTokens = gen.maxOutputTokens
    if (typeof gen.thinkingConfig === 'object' && gen.thinkingConfig !== null) {
      summary.thinkingBudget = gen.thinkingConfig.thinkingBudget ?? gen.thinkingConfig.thinking_level
    }
  }
  if (typeof json.metadata === 'object') summary.kind = 'loadCodeAssist'
  return summary
}

/** Split an SSE body into timed events; falls back to one blob for JSON. */
function summarizeResponseBody(text, contentType = '') {
  const out = { kind: 'json', bytes: Buffer.byteLength(text ?? '') }
  if (!text) {
    out.kind = 'empty'
    return out
  }
  if (!contentType.includes('event-stream') && !text.startsWith('data:')) {
    out.text = text.slice(0, 4000)
    return out
  }
  out.kind = 'sse'
  const events = []
  for (const raw of text.split(/\r?\n\r?\n/)) {
    const lines = raw.split(/\r?\n/).filter((l) => l.startsWith('data:'))
    if (lines.length === 0) continue
    const payload = lines.map((l) => l.slice(5).trim()).join('')
    if (payload === '' || payload === '[DONE]') continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      events.push({ _raw: payload.slice(0, 500) })
    }
  }
  out.eventCount = events.length
  out.events = events.slice(0, 200)
  return out
}

/**
 * Start the capture proxy.
 * @returns {{port:number, close:()=>Promise<void>, onFlow:(fn:(f:any)=>void)=>()=>void, flows:unknown[]}}
 */
export async function startCapture(options = {}) {
  const {
    port = 8899,
    certDir = path.resolve('certs'),
    captureDir = path.resolve('captures'),
    host = '127.0.0.1',
    verbose = false,
  } = options

  const pfx = fs.readFileSync(path.join(certDir, 'leaf.pfx'))
  const passphrase = fs.readFileSync(path.join(certDir, 'pass.txt'), 'utf8').trim()
  const secureContext = tls.createSecureContext({ pfx, passphrase })

  fs.mkdirSync(captureDir, { recursive: true })
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}`
  const capturePath = path.join(captureDir, `capture-${sessionId}.jsonl`)
  const sink = fs.createWriteStream(capturePath, { flags: 'a' })

  const flows = []
  const listeners = new Set()
  const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8 })

  const emit = (flow) => {
    sink.write(JSON.stringify(flow) + '\n')
    if (flows.length >= 2000) flows.shift()
    flows.push(flow)
    for (const fn of listeners) {
      try {
        fn(flow)
      } catch {
        /* a dead subscriber must not break capture */
      }
    }
    if (verbose) {
      console.log(`[flow] ${flow.method} ${flow.host}${flow.path} -> ${flow.status} ${flow.durationMs}ms`)
    }
  }

  // Decrypted requests land here. The owning TLS socket carries the target host.
  const inner = http.createServer()
  inner.on('request', (req, res) => {
    const host = req.socket.__targetHost ?? (req.headers.host ?? '').split(':')[0]
    const start = Date.now()
    const id = randomUUID()
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const reqText = Buffer.concat(chunks).toString('utf8')
      const flow = {
        id,
        ts: new Date().toISOString(),
        host,
        method: req.method,
        path: req.url,
        reqHeaders: scrubHeaders(req.headers),
        reqBody: reqText.length > 512 * 1024 ? reqText.slice(0, 512 * 1024) : reqText,
        reqSummary: summarizeRequestBody(reqText),
        status: 0,
        respHeaders: {},
        respBody: '',
        respSummary: null,
        durationMs: 0,
        error: null,
      }

      const upstreamHeaders = { ...req.headers }
      delete upstreamHeaders['proxy-connection']
      const up = https.request(
        {
          host,
          port: 443,
          method: req.method,
          path: req.url,
          headers: upstreamHeaders,
          agent: upstreamAgent,
          servername: host, // SNI must be the real host; cert is verified normally
        },
        (upRes) => {
          flow.status = upRes.statusCode ?? 0
          flow.respHeaders = scrubHeaders(upRes.headers)
          res.writeHead(upRes.statusCode ?? 502, upRes.headers)
          const parts = []
          upRes.on('data', (chunk) => {
            parts.push(chunk)
            res.write(chunk)
          })
          upRes.on('end', () => {
            const text = Buffer.concat(parts).toString('utf8')
            flow.respBody = text.length > 1024 * 1024 ? text.slice(0, 1024 * 1024) : text
            flow.respSummary = summarizeResponseBody(text, String(upRes.headers['content-type'] ?? ''))
            flow.durationMs = Date.now() - start
            res.end()
            emit(flow)
          })
          upRes.on('error', (err) => {
            flow.error = String(err)
            flow.durationMs = Date.now() - start
            res.destroy()
            emit(flow)
          })
        },
      )
      up.on('error', (err) => {
        flow.error = String(err)
        flow.status = 502
        flow.durationMs = Date.now() - start
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`radar-upstream-error: ${err.message}`)
        emit(flow)
      })
      if (reqText !== '') up.write(reqText)
      up.end()
    })
  })

  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying is almost never used by these CLIs; answer honestly.
    res.writeHead(501, { 'content-type': 'text/plain' })
    res.end('radar capture expects CONNECT tunnels\n')
  })

  const tunnels = new Set()
  server.on('connect', (req, clientSocket, head) => {
    const [host, portText] = (req.url ?? '').split(':')
    tunnels.add(clientSocket)
    clientSocket.on('close', () => tunnels.delete(clientSocket))
    clientSocket.on('error', () => tunnels.delete(clientSocket))
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length > 0) clientSocket.unshift(head)

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
      ALPNProtocols: ['http/1.1'],
    })
    tlsSocket.__targetHost = host
    tlsSocket.on('error', () => clientSocket.destroy())
    inner.emit('connection', tlsSocket)
  })

  server.on('clientError', (_err, socket) => {
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  return {
    port,
    capturePath,
    flows,
    onFlow(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    async close() {
      for (const socket of tunnels) socket.destroy()
      upstreamAgent.destroy()
      await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => sink.end(resolve))
    },
  }
}
