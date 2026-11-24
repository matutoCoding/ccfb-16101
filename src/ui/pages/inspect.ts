import { h, toast, num, clear } from '../dom'
import { farmStore } from '@/data/store'
import { GpuRenderer, type RenderStats } from '@/gpu/renderer'
import { CpuRenderer } from '@/gpu/cpu_renderer'
import { projectPoint } from '@/gpu/camera'
import { STATUS_LABEL, StickStatus } from '@/domain/types'
import { STATUS_ORDER, statusTag } from '../status_ui'
import { schedulePersist, appState } from '../app'
import { registerCleaner } from '../cleanup'
import { F, STICK_FLOATS, stickCode } from '@/domain/record'

type AnyRenderer = GpuRenderer | CpuRenderer

let renderer: AnyRenderer | null = null
let canvasEl: HTMLCanvasElement | null = null
let hudEl: HTMLElement | null = null
let detailHost: HTMLElement | null = null
let resizeObs: ResizeObserver | null = null

const statusOptions = () => STATUS_ORDER.map((s) => h('option', { value: String(s) }, STATUS_LABEL[s]))

const renderDetail = (): void => {
  if (!detailHost) return
  const ids = farmStore.selectedIds
  if (ids.length === 0) {
    clear(detailHost)
    detailHost.append(
      h('div', { class: 'empty-state' }, h('div', { class: 'icon-box' }, h('span', { style: { fontSize: '24px' } }, '◈')), h('h3', {}, '未选中菌棒'), h('p', {}, '左键旋转视角，Shift+拖拽框选一片可批量改状态，右键平移，滚轮缩放')),
    )
    return
  }
  if (ids.length > 1) {
    clear(detailHost)
    const select = h('select', {}, ...statusOptions())
    detailHost.append(
      h('div', { class: 'card' }, h('h3', { class: 'card-title' }, `框选 ${num(ids.length)} 根`), h('div', { class: 'form-row' }, h('label', {}, '批量状态'), select), h('button', {
        class: 'primary',
        style: { width: '100%' },
        onclick: () => {
          const st = Number(select.value) as StickStatus
          farmStore.batchSetStatus(ids, st)
          renderer?.syncRecordsToGpu()
          renderer?.uploadSelected()
          schedulePersist()
          toast(`已将 ${num(ids.length)} 根标记为「${STATUS_LABEL[st]}」`)
          renderDetail()
        },
      }, '应用批量状态')),
    )
    return
  }

  const id = ids[0]
  const s = farmStore.stick(id)
  if (!s) return
  const batch = farmStore.batchOf(s.batchId)
  const house = farmStore.house(s.greenhouseId)
  const [row, tier, col] = farmStore.rtcOf(s.greenhouseId, s.slotIndex)
  const timeline = farmStore.timeline(id)
  clear(detailHost)
  detailHost.append(
    h(
      'div',
      { class: 'card' },
      h('h3', { class: 'card-title' }, stickCode(id)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '状态'), statusTag(s.status)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '批次 / 品种'), h('span', {}, `${batch?.code ?? '-'} · ${batch?.variety ?? '-'}`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '棚 / 排层列'), h('span', {}, `${house?.code ?? '-'} · ${row + 1}排 ${tier + 1}层 ${col + 1}列`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '菌龄'), h('span', {}, `${s.ageDays} 天（状态第 ${s.statusDay + 1} 天）`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '棒重'), h('span', {}, `${s.weightG.toFixed(0)} g`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '含水率'), h('span', {}, `${(s.moisture * 100).toFixed(1)}%`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '潮次'), h('span', {}, `第 ${s.flushNo} 潮，本潮出菇 ${s.fruitingDays} 天`)),
      h('div', { class: 'detail-line' }, h('span', { class: 'k' }, '转色进度'), h('span', {}, `${(s.colorProgress * 100).toFixed(0)}%`)),
    ),
    h(
      'div',
      { class: 'card' },
      h('h3', { class: 'card-title' }, '状态时间线'),
      h('div', { class: 'timeline' }, ...timeline.map((e) => h('div', { class: 'tl-item' }, h('div', { style: { fontWeight: 'var(--fw-medium)' } }, `${STATUS_LABEL[e.status]} · D${e.day}`), h('div', { class: 'tl-note' }, e.note)))),
    ),
  )
}

// 标准交互：左键旋转 / Shift+左键框选 / 右键平移 / 滚轮缩放 / 单击拾取
const bindControls = (): void => {
  if (!canvasEl || !renderer) return
  const cam = renderer.camera
  const canvas = canvasEl
  let mode: 'none' | 'rotate' | 'pan' | 'select' = 'none'
  let sx = 0
  let sy = 0
  let marquee: HTMLElement | null = null

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId)
    sx = e.offsetX
    sy = e.offsetY
    if (e.button === 2) mode = 'pan'
    else if (e.button === 0) mode = e.shiftKey ? 'select' : 'rotate'
  }
  const onMove = (e: PointerEvent) => {
    if (mode === 'rotate') cam.rotate(e.offsetX - sx, e.offsetY - sy)
    else if (mode === 'pan') cam.pan(e.offsetX - sx, e.offsetY - sy)
    else if (mode === 'select') {
      const dx = e.offsetX - sx
      const dy = e.offsetY - sy
      if (Math.abs(dx) + Math.abs(dy) <= 6) return
      if (!marquee) {
        marquee = h('div', { class: 'marquee' })
        canvas.parentElement?.append(marquee)
      }
      const parentRect = canvas.parentElement!.getBoundingClientRect()
      const rect = canvas.getBoundingClientRect()
      marquee.style.left = `${Math.min(e.offsetX, sx) + rect.left - parentRect.left}px`
      marquee.style.top = `${Math.min(e.offsetY, sy) + rect.top - parentRect.top}px`
      marquee.style.width = `${Math.abs(dx)}px`
      marquee.style.height = `${Math.abs(dy)}px`
    }
    if (mode === 'rotate' || mode === 'pan') {
      sx = e.offsetX
      sy = e.offsetY
    }
  }
  const onUp = async (e: PointerEvent) => {
    const wasSelect = mode === 'select'
    const wasRotate = mode === 'rotate'
    const moved = Math.abs(e.offsetX - sx) + Math.abs(e.offsetY - sy) > 6
    mode = 'none'
    marquee?.remove()
    marquee = null
    if (wasSelect && moved) {
      doRectSelect(sx, sy, e.offsetX, e.offsetY)
    } else if (!wasSelect && !wasRotate) {
      const id = await renderer!.pickAt(e.clientX, e.clientY)
      farmStore.select(id)
      renderer?.uploadSelected()
      if (id < 0) toast('点到了棚外或被遮挡的棒，换个角度再试')
      renderDetail()
    }
  }
  const onCancel = () => {
    mode = 'none'
    marquee?.remove()
    marquee = null
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    cam.zoom(e.deltaY)
  }
  const onCtx = (e: Event) => e.preventDefault()

  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onCancel)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('contextmenu', onCtx)
  registerCleaner(() => {
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onCancel)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('contextmenu', onCtx)
  })
}

const doRectSelect = (x0c: number, y0c: number, x1c: number, y1c: number): void => {
  if (!canvasEl || !renderer) return
  const rect = canvasEl.getBoundingClientRect()
  const dprX = canvasEl.width / rect.width
  const dprY = canvasEl.height / rect.height
  const x0 = Math.min(x0c, x1c) * dprX
  const x1 = Math.max(x0c, x1c) * dprX
  const y0 = Math.min(y0c, y1c) * dprY
  const y1 = Math.max(y0c, y1c) * dprY
  const vp = renderer.camera.matrix(canvasEl.width / canvasEl.height)
  const ids: number[] = []
  const rec = farmStore.records
  for (let id = 0; id < farmStore.total; id++) {
    const o = id * STICK_FLOATS
    const p = projectPoint(vp, [rec[o + F.posX], rec[o + F.posY], rec[o + F.posZ]])
    if (!p.visible) continue
    const px = p.x * canvasEl.width
    const py = p.y * canvasEl.height
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) ids.push(id)
    if (ids.length >= 2000) break
  }
  farmStore.selectMany(ids)
  renderer.uploadSelected()
  toast(ids.length ? `框中 ${num(ids.length)} 根，可在右侧批量改状态` : '框内没有菌棒')
  renderDetail()
}

const updateHud = (st: RenderStats): void => {
  if (!hudEl) return
  const modeText = st.mode === 'webgpu' ? 'WebGPU 计算管线' : 'CPU 降级渲染'
  hudEl.innerHTML = `实际绘制 <b>${num(st.visible)}</b> / ${num(st.total)} 根<br>帧耗时 <b>${st.frameMs.toFixed(1)}</b> ms · 剔除 ${st.cullMs.toFixed(1)} ms<br>${modeText}`
}

export const inspectPage = (): HTMLElement => {
  canvasEl = h('canvas', {})
  hudEl = h('div', { class: 'hud' }, '初始化中...')
  detailHost = h('div', { class: 'side-panel' })

  const highlightBtn = h('button', {}, '绿霉高亮：关')
  let highlight = 0
  highlightBtn.addEventListener('click', () => {
    highlight = highlight ? 0 : 1
    renderer?.setHighlight(highlight)
    highlightBtn.textContent = `绿霉高亮：${highlight ? '开' : '关'}`
    if (highlight) {
      const risk = farmStore.moldRisk()
      farmStore.selectMany(risk.riskIds.slice(0, 4000))
      renderer?.uploadSelected()
      const top = risk.rowsToClean[0]
      toast(`污染 ${num(risk.moldIds.length)} 根，高风险邻居已标橙，优先清 ${top ? `P${String(top.house + 1).padStart(2, '0')} 第 ${top.row + 1} 排` : '-'}`)
    } else {
      farmStore.selectMany([])
      renderer?.uploadSelected()
    }
  })

  const advanceBtn = h('button', { class: 'primary' }, '推进一天')
  advanceBtn.addEventListener('click', async () => {
    advanceBtn.disabled = true
    const t0 = performance.now()
    if (renderer instanceof GpuRenderer) {
      await renderer.advanceDayGpu()
    } else {
      farmStore.advanceDayCpu()
    }
    const cost = performance.now() - t0
    schedulePersist()
    toast(`已推进到 ${farmStore.settings?.simulationDay}，计算耗时 ${cost.toFixed(1)} ms`)
    advanceBtn.disabled = false
    renderDetail()
  })

  const resetViewBtn = h('button', {}, '回到基地全景')
  resetViewBtn.addEventListener('click', () => {
    if (!renderer) return
    renderer.camera.target = [0, 2, 0]
    renderer.camera.distance = 260
    renderer.camera.pitch = 0.55
  })

  const filmBtn = h('button', {}, '薄膜遮挡：关')
  filmBtn.addEventListener('click', () => {
    if (!renderer) return
    renderer.filmOccludes = !renderer.filmOccludes
    filmBtn.textContent = `薄膜遮挡：${renderer.filmOccludes ? '开' : '关'}`
  })

  const page = h(
    'div',
    { class: 'inspect-layout' },
    h('div', { class: 'card viewport-card' }, h('div', { class: 'viewport-tools' }, advanceBtn, highlightBtn, filmBtn, resetViewBtn), canvasEl, hudEl),
    detailHost,
  )
  renderDetail()

  requestAnimationFrame(async () => {
    const gpu = new GpuRenderer(canvasEl!, farmStore)
    const ok = await gpu.init().catch(() => false)
    if (ok) {
      renderer = gpu
    } else {
      gpu.destroy()
      const cpu = new CpuRenderer(canvasEl!, farmStore)
      await cpu.init()
      renderer = cpu
      toast('当前环境不支持 WebGPU，已切换 CPU 降级模式')
    }
    renderer.onStats = updateHud
    renderer.resize()
    if (appState.flyHouse >= 0) {
      renderer.flyToHouse(appState.flyHouse)
      appState.flyHouse = -1
    }
    bindControls()
    resizeObs = new ResizeObserver(() => renderer?.resize())
    resizeObs.observe(canvasEl!.parentElement!)
    registerCleaner(() => {
      resizeObs?.disconnect()
      renderer?.destroy()
      renderer = null
      canvasEl = null
      hudEl = null
      detailHost = null
      resizeObs = null
    })
  })

  return page
}
