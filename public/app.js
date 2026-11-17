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

  providerSel.addEventListener('change', syncModel)
  $('#run').addEventListener('click', startRun)
  $('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true))
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
      setLog(`完成：合格率 ${Math.round((event.run.summary?.passRate ?? 0) * 100)}% · 均分 ${event.run.summary?.avgScore ?? 0}`)
      state.run = event.run
      renderGallery(event.run)
      void refreshSeries()
      void refreshHistory()
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
    const meta = el('div', 'hmeta', `${new Date(run.startedAt).toLocaleString('zh-CN')} · ${pass}% · ${run.summary?.avgScore ?? 0}分`)
    btn.append(meta)
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
  $('#run-meta').textContent = s
    ? `合格 ${s.passed}/${s.total} · 均分 ${s.avgScore} · 输出 ${fmt(s.avgOutputTokens)} tok · 思考 ${fmt(s.avgThinkingTokens)} tok · ${fmt(s.avgLatencyMs)}ms`
    : `${probes.length} 个结果`

  if (probes.length === 0) {
    box.append(el('p', 'muted empty', '这一轮还没有结果'))
    return
  }

  for (const probe of probes) {
    const card = el('div', `card ${probe.grade?.pass ? 'pass' : 'fail'}`)
    const shot = el('div', 'shot')
    const isSvg = probe.artifactPath?.endsWith('.svg')
    if (isSvg) {
      const img = el('img')
      img.src = `/artifact/${probe.artifactPath}`
      img.alt = probe.label
      img.loading = 'lazy'
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

    card.append(body)
    card.addEventListener('click', () => void selectProbe(run, probe))
    box.append(card)
  }
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
