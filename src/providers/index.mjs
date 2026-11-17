// Provider adapters.
//
// Every adapter starts the *real* CLI as a child process. No HTTP shim, no
// reverse proxy, no re-implemented API: if the vendor ships a regression in the
// orchestration layer (prompt scaffolding, tool routing, model selection), a
// re-implementation would silently hide it. Driving the binary is the only way
// to measure what a subscriber actually receives.
import { spawn } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/**
 * Resolve every match on PATH.
 *
 * `where` matters here: npm installs BOTH an extensionless POSIX shim and a
 * `.cmd` shim on Windows, and only the latter is runnable by CreateProcess.
 * (In PowerShell `where` is an alias for Where-Object, which is why this must
 * stay a spawned `where.exe`, not a shell call.)
 */
async function which(bin) {
  const cmd = IS_WIN ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    const child = spawn(cmd, [bin], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('exit', (code) => resolve(code === 0 ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []))
    child.on('error', () => resolve([]))
  })
}

const binCache = new Map()

/** Prefer a directly executable artefact over a shell shim when one exists. */
async function resolveBin(bin) {
  if (binCache.has(bin)) return binCache.get(bin)
  const matches = await which(bin)
  const chosen =
    matches.find((p) => /\.exe$/i.test(p)) ??
    matches.find((p) => /\.(cmd|bat)$/i.test(p)) ??
    matches[0] ??
    bin
  binCache.set(bin, chosen)
  return chosen
}

/** C-runtime style argument quoting for a `cmd /c` command line. */
function quoteArg(value) {
  if (value === '') return '""'
  if (!/[\s"&|<>^]/.test(value)) return value
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, (m) => m + m) + '"'
}

/** `.cmd` / `.bat` cannot be spawned directly on Windows; route via cmd.exe. */
function spawnSpec(file, args) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', [file, ...args].map(quoteArg).join(' ')],
      windowsVerbatimArguments: true,
    }
  }
  return { file, args, windowsVerbatimArguments: false }
}

function killTree(child) {
  if (!child.pid) return
  if (IS_WIN) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/**
 * Spawn a CLI and collect its stdout lines.
 * Returns { lines, stderr, code, durationMs, timedOut }.
 */
function runCli({ bin, args, cwd, env, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const spec = spawnSpec(bin, args)
    const child = spawn(spec.file, spec.args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      detached: !IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = []
    let stderr = ''
    let pending = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, Math.max(1000, timeoutMs))

    child.stdout.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      let nl
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '')
        pending = pending.slice(nl + 1)
        if (line.trim() !== '') {
          lines.push(line)
          onLine?.(line)
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192)
    })
    child.stdin.on('error', () => {})
    child.stdin.end()
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (pending.trim() !== '') {
        lines.push(pending.trim())
        onLine?.(pending.trim())
      }
      resolve({ lines, stderr, code, durationMs: Date.now() - started, timedOut })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ lines, stderr: stderr + String(err), code: -1, durationMs: Date.now() - started, timedOut })
    })
  })
}

/** Pull the last well-formed JSON object out of a line that may have a prefix. */
function parseJsonLine(line) {
  const start = line.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(line.slice(start))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- agy

const agy = {
  id: 'agy',
  label: 'Google Antigravity (agy)',
  bin: 'agy',
  /**
   * agy needs an explicit --model: without it the run dies with
   * "failed to construct executor: plan model not specified" (observed 1.5.10).
   */
  defaultModel: 'gemini-4-hydrogen-high',
  buildArgs({ prompt, model, cwd }) {
    return [
      '--output-format', 'stream-json',
      '--print-timeout', '10m',
      '--model', model,
      // plan mode is read-only and answers with "here is my plan, please
      // approve" — a probe measured exactly that and scored the model as
      // degraded. accept-edits lets the agent actually deliver the artifact.
      '--mode', 'accept-edits',
      '--disable-slash-commands',
      '--add-dir', cwd,
      '-p', prompt,
    ]
  },
  parse(lines) {
    let text = ''
    const textParts = []
    let usage = null
    let returnedModel = null
    let finish = null
    let conversationId = null
    let error = null
    for (const line of lines) {
      const ev = parseJsonLine(line)
      if (!ev) continue
      if (ev.event === 'init') {
        conversationId = ev.conversation_id ?? conversationId
        returnedModel = ev.init?.model ?? returnedModel
      }
      if (ev.event === 'step_update') {
        const s = ev.step_update
        if (s?.text_delta && s.step_type === 'agent_response') textParts.push(s.text_delta)
        if (s?.usage) usage = s.usage
      }
      if (ev.event === 'result') {
        finish = ev.result?.finished_reason ?? null
        if (ev.result?.response) text = ev.result.response
        if (ev.result?.usage) usage = ev.result.usage
        if (ev.result?.error) error = ev.result.error
      }
    }
    const joined = textParts.join('')
    return { text: joined.trim() !== '' ? joined : text, usage, returnedModel, finish, conversationId, error }
  },
}

// ---------------------------------------------------------------- claude

const claude = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  defaultModel: 'claude-opus-5-5',
  buildArgs({ prompt, model }) {
    return [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      // No --permission-mode: the default is already non-interactive under -p,
      // and 'plan' would suppress the artifact we are trying to measure.
    ]
  },
  parse(lines) {
    let text = ''
    const parts = []
    let usage = null
    let returnedModel = null
    let finish = null
    let error = null
    for (const line of lines) {
      const ev = parseJsonLine(line)
      if (!ev) continue
      if (ev.type === 'assistant') {
        const msg = ev.message
        returnedModel = msg?.model ?? returnedModel
        for (const block of msg?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        }
        if (msg?.usage) usage = msg.usage
      }
      if (ev.type === 'result') {
        if (typeof ev.result === 'string') text = ev.result
        if (ev.usage) usage = ev.usage
        finish = ev.subtype ?? null
        if (ev.is_error) error = ev.result ?? 'error'
      }
    }
    const joined = parts.join('')
    return { text: joined.trim() !== '' ? joined : text, usage, returnedModel, finish, conversationId: null, error }
  },
}

// ---------------------------------------------------------------- codex

const codex = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  bin: 'codex',
  defaultModel: 'gpt-5.1-codex',
  buildArgs({ prompt, model, cwd }) {
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--cd', cwd,
      '-m', model,
      prompt,
    ]
  },
  parse(lines) {
    const parts = []
    let usage = null
    let returnedModel = null
    let finish = null
    let error = null
    for (const line of lines) {
      const ev = parseJsonLine(line)
      if (!ev) continue
      if (ev.type === 'thread.started') returnedModel = returnedModel ?? null
      if (ev.type === 'item.completed' && ev.item?.item_type === 'assistant_message') {
        if (typeof ev.item.text === 'string') parts.push(ev.item.text)
      }
      if (ev.type === 'turn.completed') {
        usage = ev.usage ?? usage
        finish = 'completed'
      }
      if (ev.type === 'turn.failed' || ev.type === 'error') {
        error = ev.error?.message ?? ev.message ?? 'turn failed'
        finish = 'error'
      }
    }
    return { text: parts.join('\n'), usage, returnedModel, finish, conversationId: null, error }
  },
}

export const PROVIDERS = { agy, claude, codex }

export async function listProviders() {
  const out = []
  for (const p of Object.values(PROVIDERS)) {
    const resolved = await resolveBin(p.bin)
    out.push({
      id: p.id,
      label: p.label,
      bin: p.bin,
      resolved,
      defaultModel: p.defaultModel,
      available: resolved !== p.bin || !IS_WIN,
    })
  }
  return out
}

/**
 * Run one probe through a provider.
 * `env` is merged last so the caller can inject HTTPS_PROXY for capture.
 */
export async function runProbe({ providerId, prompt, model, cwd, env, timeoutMs = 600_000, onLine }) {
  const p = PROVIDERS[providerId]
  if (!p) throw new Error(`unknown provider: ${providerId}`)
  const args = p.buildArgs({ prompt, model, cwd })
  const bin = await resolveBin(p.bin)
  const res = await runCli({ bin, args, cwd, env: { ...process.env, ...env }, timeoutMs, onLine })
  const parsed = p.parse(res.lines)
  return {
    ...parsed,
    exitCode: res.code,
    stderrTail: res.stderr.slice(-1200),
    durationMs: res.durationMs,
    timedOut: res.timedOut,
    argv: args,
    rawLines: res.lines.length,
  }
}
