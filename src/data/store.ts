import { F, STICK_FLOATS, readStick, stickCode, type StickView } from '@/domain/record'
import { slotCapacity, slotFromIndex, slotToRtc, neighborSlots } from '@/domain/layout'
import { buildSlotMap, advanceDayCpu, moldEnvFactor } from '@/domain/simulation'
import { dispatchTasks, estimateHouseYields, type HouseYield } from '@/domain/tasks'
import { mulberry32 } from '@/domain/rng'
import { STATUS_COUNT, STATUS_LABEL, StickStatus, type Batch, type FarmTask, type Greenhouse, type Settings, type TaskKind, type TimelineEvent } from '@/domain/types'

export interface HouseStats {
  greenhouseId: number
  total: number
  byStatus: number[]
  mold: number
  pendingTasks: number
}

export interface RiskInfo {
  moldIds: number[]
  riskIds: number[] // 高风险邻居
  rowsToClean: { house: number; row: number; moldCount: number }[]
}

type Listener = () => void

export class FarmStore {
  records: Float32Array = new Float32Array(0)
  total = 0
  greenhouses: Greenhouse[] = []
  batches: Batch[] = []
  origins: { x: number; z: number }[] = []
  settings: Settings | null = null
  tasks: FarmTask[] = []
  selectedId = -1
  selectedIds: number[] = []
  private slotMaps = new Map<number, Int32Array>()
  private listeners = new Set<Listener>()
  dirty = true
  private statsCache: HouseStats[] | null = null
  private globalCache: number[] | null = null

  get ready(): boolean {
    return this.total > 0 && this.settings !== null
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit = (): void => {
    this.dirty = true
    this.statsCache = null
    this.globalCache = null
    this.listeners.forEach((fn) => fn())
  }

  load = (data: {
    records: Float32Array
    total: number
    greenhouses: Greenhouse[]
    batches: Batch[]
    origins: { x: number; z: number }[]
    settings: Settings
  }): void => {
    this.records = data.records
    this.total = data.total
    this.greenhouses = data.greenhouses
    this.batches = data.batches
    this.origins = data.origins
    this.settings = data.settings
    this.slotMaps.clear()
    this.selectedId = -1
    this.selectedIds = []
    this.dirty = true
    this.emit()
  }

  house = (id: number): Greenhouse | undefined => this.greenhouses.find((g) => g.id === id)

  rtcOf = (houseId: number, slot: number): [number, number, number] => {
    const h = this.house(houseId)
    if (!h || slot < 0) return [-1, -1, -1]
    return slotToRtc(slot, h.layout)
  }

  getSlotMap = (houseId: number): Int32Array => {
    const cached = this.slotMaps.get(houseId)
    if (cached) return cached
    const house = this.house(houseId)
    const map = house ? buildSlotMap(this.records, this.total, house) : new Int32Array(0)
    this.slotMaps.set(houseId, map)
    return map
  }

  private invalidateSlotMaps = (): void => this.slotMaps.clear()

  stick = (id: number): StickView | null => {
    if (id < 0 || id >= this.total) return null
    return readStick(this.records, id)
  }

  codeOf = (id: number): string => stickCode(id)

  batchOf = (batchId: number): Batch | undefined => this.batches.find((b) => b.id === batchId)

  select = (id: number): void => {
    this.selectedId = id
    this.selectedIds = id >= 0 ? [id] : []
    this.emit()
  }

  selectMany = (ids: number[]): void => {
    this.selectedIds = ids
    this.selectedId = ids.length === 1 ? ids[0] : -1
    this.emit()
  }

  // 棚排布变更：容量够则按原格位规则重铺并刷新世界坐标，容量不足返回 false
  relayout = (houseId: number, next: Greenhouse['layout']): boolean => {
    const house = this.house(houseId)
    if (!house) return false
    const newCap = slotCapacity(next)
    const oldCap = slotCapacity(house.layout)
    if (newCap < oldCap) return false

    house.layout = { ...next }
    const origin = this.origins[houseId]
    for (let id = 0; id < this.total; id++) {
      const o = id * STICK_FLOATS
      if (this.records[o + F.greenhouseId] !== houseId) continue
      const slot = this.records[o + F.slotIndex]
      if (slot < 0) continue
      const p = slotFromIndex(slot, house.layout)
      this.records[o + F.posX] = p.x + origin.x
      this.records[o + F.posY] = p.y
      this.records[o + F.posZ] = p.z + origin.z
    }
    this.invalidateSlotMaps()
    this.emit()
    return true
  }

  // 框选批量改状态（工人巡棚）
  batchSetStatus = (ids: number[], status: StickStatus): void => {
    for (const id of ids) {
      const o = id * STICK_FLOATS
      this.records[o + F.status] = status
      this.records[o + F.statusDay] = 0
      if (status === StickStatus.GreenMold && this.records[o + F.moldDay] < 0) {
        this.records[o + F.moldDay] = 0
      }
      if (status === StickStatus.Scrapped) this.records[o + F.scrapped] = 1
    }
    this.invalidateSlotMaps()
    this.emit()
  }

  setHouseEnv = (houseId: number, tempC: number, humidity: number): void => {
    const h = this.house(houseId)
    if (!h) return
    h.tempC = tempC
    h.humidity = humidity
    this.emit()
  }

  // CPU 推进一天（GPU 不可用时的等价路径）
  advanceDayCpu = (): { infected: number; transitions: number } => {
    if (!this.settings) return { infected: 0, transitions: 0 }
    const maps = this.greenhouses.map((g) => this.getSlotMap(g.id))
    const rng = mulberry32((Number(this.settings.simulationDay.replaceAll('-', '')) ^ 0x9e3779b9) >>> 0)
    const result = advanceDayCpu(this.records, this.total, this.greenhouses, maps, this.settings, rng)
    const d = new Date(this.settings.simulationDay + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    this.settings.simulationDay = d.toISOString().slice(0, 10)
    this.invalidateSlotMaps()
    if (this.settings.autoTask) this.refreshTasks()
    this.emit()
    return result
  }

  // GPU 推进完成后由外部回调，统一更新日历与派单
  afterGpuAdvance = (): void => {
    if (!this.settings) return
    const d = new Date(this.settings.simulationDay + 'T00:00:00')
    d.setDate(d.getDate() + 1)
    this.settings.simulationDay = d.toISOString().slice(0, 10)
    this.invalidateSlotMaps()
    if (this.settings.autoTask) this.refreshTasks()
    this.emit()
  }

  refreshTasks = (): void => {
    if (!this.settings) return
    this.tasks = dispatchTasks(this.records, this.total, this.rtcOf, this.settings.simulationDay)
  }

  toggleTask = (taskId: number): void => {
    const t = this.tasks.find((x) => x.id === taskId)
    if (t) {
      t.done = t.done ? 0 : 1
      this.emit()
    }
  }

  stats = (): HouseStats[] => {
    if (this.statsCache) return this.statsCache
    const result = this.greenhouses.map((g) => {
      const byStatus = new Array<number>(STATUS_COUNT).fill(0)
      let mold = 0
      let total = 0
      for (let id = 0; id < this.total; id++) {
        const o = id * STICK_FLOATS
        if (this.records[o + F.greenhouseId] !== g.id) continue
        total++
        const st = this.records[o + F.status] as StickStatus
        byStatus[st]++
        if (st === StickStatus.GreenMold) mold++
      }
      return {
        greenhouseId: g.id,
        total,
        byStatus,
        mold,
        pendingTasks: this.tasks.filter((t) => t.greenhouseId === g.id && !t.done).length,
      }
    })
    this.statsCache = result
    return result
  }

  globalByStatus = (): number[] => {
    if (this.globalCache) return this.globalCache
    const out = new Array<number>(STATUS_COUNT).fill(0)
    for (let id = 0; id < this.total; id++) out[this.records[id * STICK_FLOATS + F.status]]++
    this.globalCache = out
    return out
  }

  yields = (): HouseYield[] =>
    estimateHouseYields(this.records, this.total, (batchId) => this.batchOf(batchId)?.baseWeightG ?? 1800)

  // 绿霉全景：污染棒 + 高风险邻居 + 优先清理排
  moldRisk = (): RiskInfo => {
    if (!this.settings) return { moldIds: [], riskIds: [], rowsToClean: [] }
    const moldIds: number[] = []
    const riskSet = new Set<number>()
    const rowCount = new Map<string, { house: number; row: number; moldCount: number }>()
    for (let id = 0; id < this.total; id++) {
      const o = id * STICK_FLOATS
      if (this.records[o + F.status] === StickStatus.GreenMold) moldIds.push(id)
    }
    for (const id of moldIds) {
      const o = id * STICK_FLOATS
      const houseId = this.records[o + F.greenhouseId]
      const house = this.house(houseId)
      if (!house) continue
      const [row] = this.rtcOf(houseId, this.records[o + F.slotIndex])
      const key = `${houseId}-${row}`
      const rc = rowCount.get(key) ?? { house: houseId, row, moldCount: 0 }
      rc.moldCount++
      rowCount.set(key, rc)

      const map = this.getSlotMap(houseId)
      const slot = this.records[o + F.slotIndex]
      const p = this.settings.moldBaseProb * moldEnvFactor(house.tempC, house.humidity)
      for (const n of neighborSlots(slot, house.layout, this.settings.moldSpreadRadius)) {
        const nid = map[n]
        if (nid < 0) continue
        const no = nid * STICK_FLOATS
        const ns = this.records[no + F.status]
        if (ns !== StickStatus.GreenMold && ns !== StickStatus.Scrapped && p > 0.04) riskSet.add(nid)
      }
    }
    return {
      moldIds,
      riskIds: [...riskSet],
      rowsToClean: [...rowCount.values()].sort((a, b) => b.moldCount - a.moldCount).slice(0, 8),
    }
  }

  // 状态时间线：由当前菌龄按状态机合成，避免为 40 万根预存事件
  timeline = (id: number): TimelineEvent[] => {
    const s = this.stick(id)
    if (!s) return []
    const batch = this.batchOf(s.batchId)
    const events: TimelineEvent[] = []
    const day0 = batch ? new Date(batch.inoculatedAt + 'T00:00:00') : new Date()
    const push = (dayOffset: number, status: StickStatus, moisture: number, note: string) => {
      const d = new Date(day0)
      d.setDate(d.getDate() + dayOffset)
      events.push({ day: dayOffset, status, moisture, note: `${d.toISOString().slice(0, 10)} ${note}` })
    }
    push(0, StickStatus.SpawnRun, 0.6, `接种建档，品种 ${batch?.variety ?? '-'}，棒重 ${s.weightG.toFixed(0)}g`)
    push(35, StickStatus.ColorChange, 0.55, '菌丝满棒，进入转色期')
    push(47, StickStatus.BudInduce, 0.58, '转色完成，温差催蕾')
    for (let f = 1; f <= Math.max(1, s.flushNo); f++) {
      const base = 51 + (f - 1) * 19
      push(base, StickStatus.Fruiting, 0.56, `第 ${f} 潮出菇，菇蕾形成`)
      push(base + 7, StickStatus.Resting, 0.42, `第 ${f} 潮采收结束，进入养菌`)
      push(base + 17, StickStatus.Watering, 0.62, `第 ${f} 潮补水，准备下潮`)
    }
    if (s.status === StickStatus.GreenMold) {
      push(s.ageDays - s.moldDay, StickStatus.GreenMold, s.moisture, '巡检发现绿霉污染，标记待清理')
    }
    push(s.ageDays, s.status, s.moisture, `当前状态：${STATUS_LABEL[s.status]}（第 ${s.statusDay + 1} 天）`)
    return events
  }

  taskLabel = (kind: TaskKind): string => TASK_LABEL_ZH[kind]
}

const TASK_LABEL_ZH: Record<TaskKind, string> = {
  water: '补水',
  turn: '翻棒',
  harvest: '采菇',
  clean: '清污染',
}

export const farmStore = new FarmStore()
