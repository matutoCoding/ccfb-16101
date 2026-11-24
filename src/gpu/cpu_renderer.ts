import type { FarmStore } from '@/data/store'
import { F, STICK_FLOATS } from '@/domain/record'
import { OrbitCamera, projectPoint } from './camera'
import { STATUS_COLOR, StickStatus } from '@/domain/types'
import type { RenderStats } from './renderer'

// Canvas2D 降级路径：简单透视投影 + 视锥剔除，只画可见状态色点
export class CpuRenderer {
  canvas: HTMLCanvasElement
  store: FarmStore
  camera = new OrbitCamera()
  supported = false
  stats: RenderStats = { visible: 0, total: 0, frameMs: 0, cullMs: 0, mode: 'cpu-fallback' }
  highlightMode = 0
  filmOccludes = false
  onStats?: (s: RenderStats) => void
  private raf = 0
  private lastT = 0
  private screenPositions: { id: number; x: number; y: number; depth: number }[] = []

  constructor(canvas: HTMLCanvasElement, store: FarmStore) {
    this.canvas = canvas
    this.store = store
  }

  init = async (): Promise<boolean> => {
    this.resize()
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop)
      if (!this.lastT) this.lastT = t
      const dt = t - this.lastT
      this.lastT = t
      this.frame(dt)
    }
    this.raf = requestAnimationFrame(loop)
    return true
  }

  resize = (): void => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
  }

  private frame = (dt: number): void => {
    if (!this.store.ready) return
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const w = this.canvas.width
    const h = this.canvas.height
    const vp = this.camera.matrix(w / h)
    ctx.fillStyle = '#171b21'
    ctx.fillRect(0, 0, w, h)

    const start = performance.now()
    const projected: { id: number; x: number; y: number; depth: number; status: number }[] = []
    const r = this.store.records
    // 步长抽样：远景少画，保证核显之外的老机器也能转
    const step = this.camera.distance > 200 ? 4 : 1
    for (let id = 0; id < this.store.total; id += step) {
      const o = id * STICK_FLOATS
      if (r[o + F.scrapped] === 1) continue
      const p = projectPoint(vp, [r[o + F.posX], r[o + F.posY], r[o + F.posZ]])
      if (!p.visible || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue
      projected.push({ id, x: p.x * w, y: p.y * h, depth: p.z, status: r[o + F.status] })
    }
    projected.sort((a, b) => b.depth - a.depth)
    this.screenPositions = projected.map((p) => ({ id: p.id, x: p.x, y: p.y, depth: p.depth }))

    const sel = new Set(this.store.selectedIds)
    for (const p of projected) {
      const color = STATUS_COLOR[p.status as StickStatus]
      const isMold = p.status === StickStatus.GreenMold
      const isSel = sel.has(p.id)
      const radius = isSel ? 4 : isMold ? 3 : 2
      ctx.fillStyle = isSel
        ? '#40bff2'
        : this.highlightMode === 1 && isMold
          ? '#e64040'
          : `rgb(${color.map((c) => Math.round(c * 255)).join(',')})`
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    this.stats.frameMs = dt
    this.stats.cullMs = performance.now() - start
    this.stats.total = this.store.total
    this.stats.visible = projected.length
    this.onStats?.(this.stats)
  }

  pickAt = async (clientX: number, clientY: number): Promise<number> => {
    const rect = this.canvas.getBoundingClientRect()
    const dprX = this.canvas.width / rect.width
    const dprY = this.canvas.height / rect.height
    const x = (clientX - rect.left) * dprX
    const y = (clientY - rect.top) * dprY
    let best = -1
    let bestD = 14
    // 选最近的（screenPositions 已按深度从远到近，反向取最小距离）
    for (let i = this.screenPositions.length - 1; i >= 0; i--) {
      const p = this.screenPositions[i]
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bestD) {
        bestD = d
        best = p.id
      }
    }
    return best
  }

  uploadSelected = (): void => {}
  syncRecordsToGpu = (): void => {}
  setHighlight = (mode: number): void => {
    this.highlightMode = mode
  }
  flyToHouse = (houseId: number): void => {
    const o = this.store.origins[houseId]
    if (o) this.camera.flyTo(o.x, o.z)
  }
  advanceDayGpu = async (): Promise<number> => 0
  destroy = (): void => cancelAnimationFrame(this.raf)
}
