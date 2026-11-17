// Dashboard wiring. No framework: the interesting state is one run, one probe,
// one flow — a handful of DOM swaps beats a build step here.

const $ = (sel) => document.querySelector(sel)
const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

const state = {
  providers: [],
  probes: [],
  run: null,
  probe: null,
  flows: [],
  flow: null,
  tab: 'req',
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—')
const clock = (iso) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const elapsed = (a, b) => {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 60000 ? `${(ms / 1000).toFixed(0)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`
}

async function api(path, init) {
  const res = await fetch(path, init)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------- bootstrap

async function init() {
  const info = await api('/api/providers')
  state.providers = info.providers
  state.probes = info.probes

  const providerSel = $('#provider')
  providerSel.innerHTML = ''
  for (const p of state.providers) {
    const opt = el('option', null, `${p.label}${p.available ? '' : '（未安装）'}`)
    opt.value = p.id
    opt.disabled = !p.available
    providerSel.append(opt)
  }
  providerSel.value = state.providers.find((p) => p.available)?.id ?? 'agy'
  syncModel()

  const probeSel = $('#probe')
  probeSel.innerHTML = ''
  for (const p of state.probes) {
    const opt = el('option', null, `${p.label} · ${p.kind}`)
    opt.value = p.id
    opt.selected = info.defaultProbeIds.includes(p.id)
    probeSel.append(opt)
  }

  $('#capture-info').textContent = `capture :${info.capture.port} · ${info.capture.path.split(/[\\/]/).pop()}`
  $('#live-dot').classList.add('live')
  void showJudgeInfo()

  providerSel.addEventListener('change', syncModel)
  $('#run').addEventListener('click', startRun)
  $('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true))
  // Escape closes the flow drawer: a panel that covers most of the viewport
  // needs a keyboard exit, not just a 12px target.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) $('#drawer').hidden = true
  })
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab
      for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn)
      renderDrawer()
    })
  }

  await Promise.all([refreshSeries(), refreshHistory(info)])
  connectEvents()
}

async function showJudgeInfo() {
  try {
    const health = await api('/api/judge/health')
    const chip = $('#judge-info')
    if (health.ok) {
      chip.textContent = `judge ${health.config.model}${health.hasModel === false ? ' (模型未提供)' : ''}`
      chip.style.color = 'var(--accent)'
    } else {
      chip.textContent = `judge 不可用：${health.error ?? `HTTP ${health.status}`}`
      chip.style.color = 'var(--bad)'
    }
  } catch (err) {
    $('#judge-info').textContent = `judge ${String(err)}`
  }
}

function syncModel() {
  const p = state.providers.find((x) => x.id === $('#provider').value)
  $('#model').value = p?.defaultModel ?? ''
}

// ---------------------------------------------------------------- live feed

function connectEvents() {
  const source = new EventSource('/api/events')
  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data)
    if (event.type === 'run-start') {
      $('#live-dot').className = 'dot busy'
      $('#run').disabled = true
      setLog(`运行中：${event.run.provider} / ${event.run.model}`)
    }
    if (event.type === 'probe-done') {
      const p = event.probe
      setLog(`${p.label}: ${p.grade.pass ? '合格' : '不合格'} (${p.grade.score}) · ${fmt(p.durationMs)}ms`)
      if (state.run && state.run.id === event.runId) {
        state.run.probes = state.run.probes.filter((x) => !(x.probeId === p.probeId && x.iteration === p.iteration))
        state.run.probes.push(p)
        renderGallery(state.run)
      }
    }
    if (event.type === 'run-done') {
      $('#live-dot').className = 'dot live'
      $('#run').disabled = false
      const v = event.run.verdict
      setLog(
        `完成：${v ? v.label : '—'} · 视觉 ${event.run.summary?.avgVisionScore ?? '—'}/100 · 合格率 ${Math.round(
          (event.run.summary?.passRate ?? 0) * 100,
        )}%`,
      )
      state.run = event.run
      renderGallery(event.run)
      void refreshSeries()
      void refreshHistory()
    }
    if (event.type === 'judge-unavailable') {
      setLog(`视觉裁判不可用：${event.error}（确定性判分仍然有效）`)
    }
    if (event.type === 'judge-done') {
      const v = event.vision
      setLog(`${event.probeId} 视觉判定：${v.ok ? v.score + '/100' : v.note}`)
      if (state.run && state.run.id === event.runId) {
        const probe = state.run.probes.find((p) => p.probeId === event.probeId && p.iteration === event.iteration)
        if (probe) probe.vision = v
        renderGallery(state.run)
      }
    }
  }
  source.onerror = () => setLog('SSE 断开，浏览器会自动重连')
}

function setLog(text) {
  $('#log').textContent = text
}

// ---------------------------------------------------------------- run

async function startRun() {
  const provider = $('#provider').value
  const model = $('#model').value.trim()
  const probeIds = [...$('#probe').selectedOptions].map((o) => o.value)
  const repeat = Number($('#repeat').value) || 1
  if (!model) return setLog('模型不能为空')
  if (probeIds.length === 0) return setLog('至少选一个探针')

  $('#run').disabled = true
  setLog('已入队…')
  try {
    await api('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, model, probeIds, repeat }),
    })
  } catch (err) {
    $('#run').disabled = false
    setLog(String(err))
  }
}

async function refreshHistory(info) {
  const data = await api('/api/runs?limit=40')
  const box = $('#history')
  box.innerHTML = ''
  if (data.runs.length === 0) {
    box.append(el('p', 'muted', '暂无运行记录'))
    return
  }
  for (const run of data.runs) {
    const btn = el('button')
    const pass = Math.round((run.summary?.passRate ?? 0) * 100)
    btn.append(el('div', null, `${run.provider} · ${run.model}`))
    const vision = run.summary?.visionJudged > 0 ? ` · 视觉${run.summary.avgVisionScore}` : ''
    const meta = el('div', 'hmeta', `${clock(run.startedAt)} · ${pass}% · ${run.summary?.avgScore ?? 0}分${vision}`)
    btn.append(meta)
    // Infrastructure deaths look identical to "the model produced nothing"
    // unless we say so; mark them so they never get read as evidence.
    if ((run.summary?.infraBlocked ?? 0) > 0) btn.append(el('div', 'hmeta', '⚠ 基础设施失败，非降智证据'))
    btn.addEventListener('click', () => {
      for (const b of box.querySelectorAll('button')) b.classList.remove('active')
      btn.classList.add('active')
      void showRun(run.id)
    })
    if (state.run && state.run.id === run.id) btn.classList.add('active')
    box.append(btn)
  }
  if (info?.busy) $('#queue').textContent = '有一个运行在进行'
}

async function refreshSeries() {
  const data = await api('/api/series')
  const box = $('#services')
  box.innerHTML = ''
  if (data.services.length === 0) {
    box.append(el('p', 'muted', '还没有足够的样本建立基线'))
    return
  }
  for (const svc of data.services) {
    const card = el('div', 'service')
    const row = el('div', 'row')
    row.append(el('span', 'name', `${svc.provider} / ${svc.model}`))
    const health = svc.health === null ? '基线中' : String(svc.health)
    const color = svc.health === null ? 'var(--muted)' : svc.health >= 85 ? 'var(--accent)' : svc.health >= 60 ? 'var(--warn)' : 'var(--bad)'
    const h = el('span', 'health', health)
    h.style.color = color
    row.append(h)
    card.append(row)
    const latest = svc.points.at(-1)
    card.append(
      el(
        'div',
        'kv muted',
        `${svc.runs} 轮 · 合格 ${Math.round((latest?.passRate ?? 0) * 100)}% · 输出 ${fmt(latest?.avgOutputTokens)} tok`,
      ),
    )
    const bar = el('div', 'bar')
    const fill = el('i')
    fill.style.width = `${svc.health ?? 40}%`
    fill.style.background = color
    bar.append(fill)
    card.append(bar)
    box.append(card)
  }
}

async function showRun(id) {
  const run = await api(`/api/run/${id}`)
  state.run = run
  renderGallery(run)
  $('#flows').innerHTML = '<p class="muted">选中一个探针后显示它经过的请求</p>'
  $('#traffic-count').textContent = ''
}

// ---------------------------------------------------------------- gallery

function renderGallery(run) {
  const box = $('#gallery')
  box.innerHTML = ''
  const probes = [...run.probes].sort((a, b) => (a.probeId + a.iteration).localeCompare(b.probeId + b.iteration))
  $('#gallery-title').textContent = `探针结果 · ${run.provider}`
  const s = run.summary
  const when = run.finishedAt ? `${clock(run.startedAt)} → ${clock(run.finishedAt).slice(11)}（${elapsed(run.startedAt, run.finishedAt)}）` : clock(run.startedAt)
  $('#run-meta').textContent = s
    ? `${when} · ${run.model} · 视觉 ${s.avgVisionScore ?? '—'}/100 · 可渲染 ${s.renderableArtifacts ?? '—'}/${s.total} · 合格 ${s.passed}/${s.total} · 均分 ${s.avgScore} · 输出 ${fmt(
        s.avgOutputTokens,
      )} tok · 思考 ${fmt(s.avgThinkingTokens)} tok · ${fmt(s.avgLatencyMs)}ms`
    : `${when} · ${probes.length} 个结果`

  renderVerdict(run)

  if (probes.length === 0) {
    box.append(el('p', 'muted empty', '这一轮还没有结果'))
    return
  }

  for (const probe of probes) {
    const card = el('div', `card ${probe.grade?.pass ? 'pass' : 'fail'}`)
    const shot = el('div', 'shot')
    const isImage = /\.(svg|png|jpe?g|webp|gif)$/i.test(probe.artifactPath ?? '')
    // Prefer the render: it is literally what the judge looked at, and it is
    // what a human would see.
    const imagePath = probe.vision?.renderPath ?? probe.artifactPath
    if (probe.artifactKind === 'broken') {
      shot.append(el('pre', null, '该轮产物无法渲染（归档内容不是有效 SVG，且已无法找回）'))
    } else if (isImage && imagePath) {
      const img = el('img')
      img.src = `/artifact/${imagePath}`
      img.alt = probe.label
      img.loading = 'lazy'
      // Old runs archived the reply text under a .svg name; the file is real
      // but not renderable. Say so instead of showing a broken-image icon.
      img.addEventListener('error', () => {
        shot.innerHTML = ''
        shot.append(el('pre', null, '当轮没有可渲染的产物（归档内容不是有效 SVG）'))
      })
      shot.append(img)
    } else {
      shot.append(el('pre', null, (probe.text ?? '').slice(0, 600) || '(空)'))
    }
    card.append(shot)

    const body = el('div', 'body')
    const title = el('div', 'title')
    title.append(el('b', null, `${probe.label} #${probe.iteration + 1}`))
    title.append(el('span', `badge ${probe.grade?.pass ? 'ok' : 'no'}`, `${probe.grade?.score ?? 0}`))
    body.append(title)

    if (!probe.grade?.pass) body.append(el('div', 'reason', probe.grade?.failureReason ?? 'failed'))
    if (probe.artifactKind === 'image') body.append(el('div', 'reason', '交付的是栅格图而不是 SVG —— 按口径记失败'))
    if (probe.backfilledFrom) body.append(el('div', 'reason', '产物为事后从 CLI 缓存找回，当轮判定保持原样'))

    const kv = el('div', 'kv')
    kv.append(el('span', null, `出 ${fmt(probe.usage?.output_tokens)}/${fmt(probe.usage?.thoughtsTokenCount ?? probe.usage?.thinking_tokens)}`))
    kv.append(el('span', null, `${fmt(probe.durationMs)}ms`))
    if (probe.returnedModel) kv.append(el('span', null, `答:${probe.returnedModel}`))
    body.append(kv)

    const routed = (probe.routedModels ?? []).filter((m) => m !== run.model)
    if (routed.length > 0) {
      const warn = el('div', 'reason', `线上还出现: ${routed.join(', ')}`)
      body.append(warn)
    }
    if (probe.wireGrade && probe.wireGrade.pass !== probe.grade?.pass) {
      body.append(el('div', 'reason', `线上回答本应合格（${probe.wireGrade.score}），CLI 交付侧丢掉了`))
    }

    if (probe.vision) body.append(visionRow(probe.vision))

    card.append(body)
    card.addEventListener('click', () => void selectProbe(run, probe))
    box.append(card)
  }
}

function dimClass(n) {
  return n === 2 ? 'good' : n === 1 ? 'mid' : 'bad'
}

function visionRow(vision) {
  const wrap = el('div', 'vision')
  if (vision.ok !== true) {
    wrap.append(el('span', `v ${'bad'}`, `视觉: ${vision.note ?? vision.error ?? 'failed'}`))
    return wrap
  }
  const score = el('span', `v ${vision.score >= 67 ? 'good' : vision.score >= 34 ? 'mid' : 'bad'}`, `视觉 ${vision.score}`)
  wrap.append(score)
  wrap.append(el('span', `v ${dimClass(vision.dims.pelican)}`, `鹈鹕${vision.dims.pelican}`))
  wrap.append(el('span', `v ${dimClass(vision.dims.vehicle)}`, `车${vision.dims.vehicle}`))
  wrap.append(el('span', `v ${dimClass(vision.dims.riding)}`, `骑${vision.dims.riding}`))
  if (vision.note) wrap.append(el('span', 'note', vision.note))
  return wrap
}

function renderVerdict(run) {
  const box = $('#verdict')
  const v = run.verdict
  if (!v) {
    box.hidden = true
    return
  }
  box.hidden = false
  box.className = `verdict ${v.tone}`
  box.innerHTML = ''
  box.append(el('span', 'lvl', `${v.label}${v.score !== null ? ' · ' + v.score + '/100' : ''}`))
  const why = el('div', 'why')
  why.append(el('div', null, `本轮 @ ${clock(run.startedAt)}`))
  for (const reason of v.reasons ?? []) {
    const line = el('div')
    line.textContent = reason
    why.append(line)
  }
  box.append(why)
}

// ---------------------------------------------------------------- traffic

async function selectProbe(run, probe) {
  state.probe = probe
  const flows = await api(`/api/flows?runId=${encodeURIComponent(run.id)}&probeId=${encodeURIComponent(probe.probeId)}`)
  const mine = flows.filter((f) => (probe.flowIds ?? []).includes(f.id))
  state.flows = mine
  const box = $('#flows')
  box.innerHTML = ''
  $('#traffic-count').textContent = `${mine.length} 条`
  if (mine.length === 0) {
    box.append(el('p', 'muted', '这一发没有经过抓包代理（检查 HTTPS_PROXY 注入）'))
    return
  }
  for (const flow of mine) {
    const node = el('div', 'flow')
    const l1 = el('div', 'l1')
    const status = el('span', `s${String(flow.status)[0]}`, `${flow.status}`)
    l1.append(status, el('span', null, `${fmt(flow.durationMs)}ms`))
    node.append(l1)
    node.append(el('div', 'l2', `${flow.host}${flow.path}`))
    const bits = []
    if (flow.reqSummary?.model) bits.push(flow.reqSummary.model)
    if (flow.reqSummary?.promptChars) bits.push(`${flow.reqSummary.promptChars} 字`)
    if (flow.reqSummary?.toolCount) bits.push(`${flow.reqSummary.toolCount} 工具`)
    if (flow.respEvents) bits.push(`${flow.respEvents} 帧`)
    node.append(el('div', 'l2', bits.join(' · ')))
    node.addEventListener('click', () => void openFlow(flow.id))
    box.append(node)
  }
}

async function openFlow(id) {
  state.flow = await api(`/api/flow/${id}`)
  $('#drawer').hidden = false
  const flow = state.flow
  $('#drawer-title').textContent = `${flow.method} ${flow.host}${flow.path}`
  renderDrawer()
}

function pretty(text) {
  if (!text) return '(空)'
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function renderDrawer() {
  const flow = state.flow
  if (!flow) return
  const body = $('#drawer-body')
  if (state.tab === 'req') {
    body.textContent = pretty(flow.reqBody)
  } else if (state.tab === 'resp') {
    const events = flow.respSummary?.events ?? []
    if (events.length > 0) {
      body.textContent = events.map((e, i) => `── frame ${i + 1} ──\n${JSON.stringify(e, null, 2)}`).join('\n\n')
    } else {
      body.textContent = pretty(flow.respBody)
    }
  } else {
    body.textContent = JSON.stringify(
      {
        id: flow.id,
        ts: flow.ts,
        status: flow.status,
        durationMs: flow.durationMs,
        bytes: { req: (flow.reqBody ?? '').length, resp: (flow.respBody ?? '').length },
        reqSummary: flow.reqSummary,
        reqHeaders: flow.reqHeaders,
        respHeaders: flow.respHeaders,
        error: flow.error,
      },
      null,
      2,
    )
  }
}

void init()
