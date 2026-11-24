import { F, STICK_FLOATS } from './record'
import { neighborSlots, slotCapacity } from './layout'
import type { Greenhouse, Settings, StickStatus } from './types'
import { STATUS_DURATION_DAYS, StickStatus as S } from './types'

export interface HouseEnv {
  id: number
  tempC: number
  humidity: number
}

// 温湿度对绿霉的加成：25°C、湿度 90% 附近最适宜霉菌
export const moldEnvFactor = (tempC: number, humidity: number): number => {
  const tempFactor = Math.max(0, 1 - Math.abs(tempC - 25) / 14)
  const humFactor = Math.max(0, Math.min(1.4, humidity * 1.45))
  return tempFactor * humFactor
}

const MOISTURE_MIN = 0.32
const MOISTURE_MAX = 0.66

const nextStatus = (status: StickStatus): StickStatus => {
  switch (status) {
    case S.SpawnRun:
      return S.ColorChange
    case S.ColorChange:
      return S.BudInduce
    case S.BudInduce:
      return S.Fruiting
    case S.Fruiting:
      return S.Resting
    case S.Resting:
      return S.Watering
    case S.Watering:
      return S.BudInduce
    default:
      return status
  }
}

// 单根棒推进一天（不含绿霉传播），返回是否发生了状态切换
const advanceOne = (rec: Float32Array, o: number): boolean => {
  const status = rec[o + F.status] as StickStatus
  rec[o + F.ageDays] += 1
  rec[o + F.statusDay] += 1

  // 含水率日常漂移
  let drift = 0
  if (status === S.Fruiting) drift = -0.02
  else if (status === S.Resting) drift = -0.012
  else if (status === S.Watering) drift = 0.12
  else drift = -0.006
  rec[o + F.moisture] = Math.min(MOISTURE_MAX, Math.max(MOISTURE_MIN, rec[o + F.moisture] + drift))

  if (status === S.ColorChange) {
    rec[o + F.colorProgress] = Math.min(1, rec[o + F.colorProgress] + 1 / STATUS_DURATION_DAYS[S.ColorChange])
  }
  if (status === S.Fruiting) rec[o + F.fruitingDays] += 1

  const duration = STATUS_DURATION_DAYS[status]
  if (rec[o + F.statusDay] >= duration && status !== S.GreenMold && status !== S.Scrapped) {
    const next = nextStatus(status)
    rec[o + F.status] = next
    rec[o + F.statusDay] = 0
    if (next === S.BudInduce && status === S.Watering) rec[o + F.flushNo] += 1
    if (next === S.Fruiting) rec[o + F.fruitingDays] = 0
    return true
  }
  return false
}

export interface AdvanceResult {
  infected: number
  transitions: number
}

// CPU 参考实现：全基地推进一天。records 为所有菌棒的连续 Float32Array，
// slotMaps[houseId] 为格位 -> 菌棒 id 的映射
export const advanceDayCpu = (
  records: Float32Array,
  total: number,
  houses: Greenhouse[],
  slotMaps: Int32Array[],
  settings: Settings,
  rng: () => number,
): AdvanceResult => {
  let infected = 0
  let transitions = 0

  // 先做状态机推进
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    if (records[o + F.scrapped] === 1) continue
    if (records[o + F.status] === S.GreenMold) {
      records[o + F.ageDays] += 1
      records[o + F.moldDay] += 1
      continue
    }
    if (advanceOne(records, o)) transitions++
  }

  // 再做绿霉传播：只扫健康棒，查同棚相邻格位
  const houseById = new Map(houses.map((h) => [h.id, h]))
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    const status = records[o + F.status] as StickStatus
    if (status === S.GreenMold || status === S.Scrapped) continue

    const houseId = records[o + F.greenhouseId]
    const slot = records[o + F.slotIndex]
    if (slot < 0) continue
    const house = houseById.get(houseId)
    if (!house) continue

    const map = slotMaps[houseId]
    const neighbors = neighborSlots(slot, house.layout, settings.moldSpreadRadius)
    let moldNeighbors = 0
    for (const n of neighbors) {
      const nid = map[n]
      if (nid < 0) continue
      if (records[nid * STICK_FLOATS + F.status] === S.GreenMold) moldNeighbors++
    }
    if (moldNeighbors === 0) continue

    const p = settings.moldBaseProb * moldEnvFactor(house.tempC, house.humidity) * moldNeighbors
    if (rng() < Math.min(0.9, p)) {
      records[o + F.status] = S.GreenMold
      records[o + F.statusDay] = 0
      records[o + F.moldDay] = 0
      infected++
    }
  }
  return { infected, transitions }
}

// 重建某棚的格位映射；未占格位为 -1。容量变化时调用方负责先扩容
export const buildSlotMap = (records: Float32Array, total: number, house: Greenhouse): Int32Array => {
  const cap = slotCapacity(house.layout)
  const map = new Int32Array(cap).fill(-1)
  for (let id = 0; id < total; id++) {
    const o = id * STICK_FLOATS
    if (records[o + F.greenhouseId] !== house.id) continue
    const slot = records[o + F.slotIndex]
    if (slot >= 0 && slot < cap) map[slot] = id
  }
  return map
}
