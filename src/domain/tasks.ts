import { F, STICK_FLOATS } from './record'
import type { FarmTask, StickStatus } from './types'
import { StickStatus as S } from './types'
import type { TaskKind } from './types'

export const TASK_LABEL: Record<TaskKind, string> = {
  water: '补水',
  turn: '翻棒',
  harvest: '采菇',
  clean: '清污染',
}

interface Bucket {
  key: string
  kind: TaskKind
  house: number
  row: number
  tier: number
  count: number
}

// 单根棒当天是否需要某种农事，规则与状态严格挂钩
const taskForStatus = (status: StickStatus, statusDay: number, moisture: number): TaskKind | null => {
  switch (status) {
    case S.Watering:
      return 'water'
    case S.ColorChange:
      // 转色中期翻棒一次，保证两面均匀转色
      return statusDay === 6 ? 'turn' : null
    case S.Fruiting:
      // 出菇第 5 天进入采收窗口；含水率过低也触发补水单
      if (statusDay >= 5) return 'harvest'
      if (moisture < 0.4) return 'water'
      return null
    case S.GreenMold:
      return 'clean'
    default:
      return null
  }
}

// 按棚 + 排 + 层聚合派单，污染单独成单且优先级最高
export const dispatchTasks = (
  records: Float32Array,
  total: number,
  rtcOf: (houseId: number, slot: number) => [number, number, number],
  dueDate: string,
): FarmTask[] => {
  const buckets = new Map<string, Bucket>()
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    if (records[o + F.scrapped] === 1) continue
    const kind = taskForStatus(
      records[o + F.status] as StickStatus,
      records[o + F.statusDay],
      records[o + F.moisture],
    )
    if (!kind) continue

    const houseId = records[o + F.greenhouseId]
    const slot = records[o + F.slotIndex]
    const [row, tier] = slot >= 0 ? rtcOf(houseId, slot) : [-1, -1]
    const key = `${kind}|${houseId}|${row}|${tier}`
    const b = buckets.get(key)
    if (b) b.count++
    else buckets.set(key, { key, kind, house: houseId, row, tier, count: 1 })
  }

  return [...buckets.values()]
    .sort((a, b) => {
      if (a.kind === 'clean' && b.kind !== 'clean') return -1
      if (b.kind === 'clean' && a.kind !== 'clean') return 1
      return a.house - b.house || a.row - b.row
    })
    .map((b, i) => ({
      id: i + 1,
      kind: b.kind,
      greenhouseId: b.house,
      row: b.row,
      tier: b.tier,
      stickCount: b.count,
      dueDate,
      done: 0 as const,
      note: taskNote(b.kind, b.count),
    }))
}

const taskNote = (kind: TaskKind, count: number): string => {
  switch (kind) {
    case 'clean':
      return `绿霉污染 ${count} 根，优先清排并隔离，防止向相邻层架扩散`
    case 'water':
      return `${count} 根需补水至标准棒重，补水后复称`
    case 'turn':
      return `转色中期翻棒 ${count} 根，翻面后保持同向码放`
    case 'harvest':
      return `${count} 根进入采收窗口，按菇体成熟度分批采`
  }
}

// 潮次产量估算：出菇棒按潮次衰减，单潮单棒采菇重量随潮次递减
export const estimateFlushYield = (flushNo: number, baseWeightG: number): number => {
  const factor = Math.max(0.35, 1 - (flushNo - 1) * 0.22)
  return Math.round(baseWeightG * 0.28 * factor)
}

export interface HouseYield {
  greenhouseId: number
  flushes: { flushNo: number; sticks: number; estKg: number }[]
  totalKg: number
}

// 棚内批次棒重均值
const houseBaseWeight = (
  records: Float32Array,
  total: number,
  house: number,
  baseWeightOf: (batchId: number) => number,
): number => {
  let sum = 0
  let n = 0
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    if (records[o + F.greenhouseId] !== house) continue
    sum += baseWeightOf(records[o + F.batchId])
    n++
  }
  return n ? sum / n : 1800
}

export const estimateHouseYields = (
  records: Float32Array,
  total: number,
  baseWeightOf: (batchId: number) => number,
): HouseYield[] => {
  const map = new Map<number, Map<number, number>>()
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    const house = records[o + F.greenhouseId]
    const flush = Math.max(1, records[o + F.flushNo])
    if (!map.has(house)) map.set(house, new Map())
    const fm = map.get(house)!
    fm.set(flush, (fm.get(flush) ?? 0) + 1)
  }
  return [...map.entries()].map(([greenhouseId, fm]) => {
    const flushes = [...fm.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([flushNo, sticks]) => {
        // 棚内多批次时按各棒自身批次棒重加权，这里取棚内批次均值近似
        const base = houseBaseWeight(records, total, greenhouseId, baseWeightOf)
        return {
          flushNo,
          sticks,
          estKg: Math.round((estimateFlushYield(flushNo, base) * sticks) / 10) / 100,
        }
      })
    return {
      greenhouseId,
      flushes,
      totalKg: Math.round(flushes.reduce((sum, f) => sum + f.estKg, 0) * 100) / 100,
    }
  })
}
