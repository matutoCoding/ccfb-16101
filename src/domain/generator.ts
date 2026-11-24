import { F, STICK_FLOATS } from './record'
import { slotCapacity, slotPosition, footprint } from './layout'
import { mulberry32, randInt } from './rng'
import type { Batch, Greenhouse, Settings, StickStatus } from './types'
import { StickStatus as S } from './types'

export const HOUSE_COUNT = 40
export const STICKS_PER_HOUSE = 10000
export const TOTAL_STICKS = HOUSE_COUNT * STICKS_PER_HOUSE
export const MOLD_HOUSE_ID = 2 // 三号棚 P03，大面积闹绿霉
export const SIM_START_DATE = '2026-11-24'

const VARIETIES = ['L808', '庆元212', '939 号', 'Cr04', '花香菇']
const LAYOUT_VARIANTS: Greenhouse['layout'][] = [
  { lengthM: 96, widthM: 8.5, shelfRows: 10, tiers: 5, cols: 200, aisleM: 0.9 },
  { lengthM: 118, widthM: 7.2, shelfRows: 8, tiers: 5, cols: 250, aisleM: 0.85 },
  { lengthM: 96, widthM: 8.5, shelfRows: 10, tiers: 5, cols: 200, aisleM: 0.9 },
  { lengthM: 62, widthM: 12, shelfRows: 5, tiers: 4, cols: 500, aisleM: 1.1 },
]

// 按菌龄反推状态机落点（与 STATUS_DURATION_DAYS 保持一致）
const STATUS_PLAN: { status: StickStatus; days: number }[] = [
  { status: S.SpawnRun, days: 35 },
  { status: S.ColorChange, days: 12 },
  { status: S.BudInduce, days: 4 },
  { status: S.Fruiting, days: 7 },
  { status: S.Resting, days: 10 },
  { status: S.Watering, days: 2 },
]

const stateAtAge = (age: number): {
  status: StickStatus
  statusDay: number
  flushNo: number
  fruitingDays: number
  colorProgress: number
} => {
  if (age < STATUS_PLAN[0].days) {
    return { status: S.SpawnRun, statusDay: age, flushNo: 1, fruitingDays: 0, colorProgress: 0 }
  }
  let rest = age - (STATUS_PLAN[0].days + STATUS_PLAN[1].days + STATUS_PLAN[2].days)
  const colorProgress = Math.min(1, Math.max(0, (age - 35) / 12))
  if (rest < 0) {
    // 落在转色或催蕾段
    let r = age - STATUS_PLAN[0].days
    if (r < STATUS_PLAN[1].days) {
      return { status: S.ColorChange, statusDay: r, flushNo: 1, fruitingDays: 0, colorProgress: r / 12 }
    }
    r -= STATUS_PLAN[1].days
    return { status: S.BudInduce, statusDay: r, flushNo: 1, fruitingDays: 0, colorProgress: 1 }
  }
  // 出菇/养菌/补水循环，每轮 19 天
  const cycle = 7 + 10 + 2
  const k = rest % cycle
  const flushNo = 1 + Math.floor(rest / cycle)
  if (k < 7) return { status: S.Fruiting, statusDay: k, flushNo, fruitingDays: k, colorProgress: 1 }
  if (k < 17) return { status: S.Resting, statusDay: k - 7, flushNo, fruitingDays: 7, colorProgress: 1 }
  return { status: S.Watering, statusDay: k - 17, flushNo, fruitingDays: 7, colorProgress: 1 }
}

export interface GeneratedData {
  greenhouses: Greenhouse[]
  batches: Batch[]
  records: Float32Array
  total: number
  origins: { x: number; z: number }[]
  settings: Settings
}

export const generateData = (seed = 20261124): GeneratedData => {
  const rng = mulberry32(seed)
  const records = new Float32Array(TOTAL_STICKS * STICK_FLOATS)

  // 16 个接种批次，每批 25000 根，自然跨 2-3 个棚
  const BATCH_COUNT = 16
  const BATCH_SIZE = TOTAL_STICKS / BATCH_COUNT
  const batches: Batch[] = []
  const inoculateDates: string[] = []
  for (let b = 0; b < BATCH_COUNT; b++) {
    const d = new Date(2026, 7, 6)
    d.setDate(d.getDate() + b * 6)
    const iso = d.toISOString().slice(0, 10)
    inoculateDates.push(iso)
    const baseWeightG = randInt(rng, 1700, 1900)
    batches.push({
      id: b,
      code: `B${iso.replaceAll('-', '')}-${String(b + 1).padStart(2, '0')}`,
      variety: VARIETIES[b % VARIETIES.length],
      inoculatedAt: iso,
      baseWeightG,
      targetWeightG: baseWeightG - randInt(rng, 60, 110),
      count: BATCH_SIZE,
    })
  }

  // 40 个棚，四种排布变体，容量均为 10000
  const greenhouses: Greenhouse[] = []
  const origins: { x: number; z: number }[] = []
  const GRID_COLS = 5
  const GAP_X = 14
  const GAP_Z = 16
  for (let h = 0; h < HOUSE_COUNT; h++) {
    const layout = LAYOUT_VARIANTS[h % LAYOUT_VARIANTS.length]
    const isMoldHouse = h === MOLD_HOUSE_ID
    greenhouses.push({
      id: h,
      code: `P${String(h + 1).padStart(2, '0')}`,
      layout,
      tempC: isMoldHouse ? 25.6 : 18 + rng() * 6,
      humidity: isMoldHouse ? 0.94 : 0.66 + rng() * 0.22,
      createdAt: '2026-07-20',
    })
    const gx = h % GRID_COLS
    const gz = Math.floor(h / GRID_COLS)
    const fp = footprint(layout)
    origins.push({ x: gx * (fp.halfX * 2 + GAP_X), z: gz * GAP_Z })
  }

  const simStart = new Date(SIM_START_DATE + 'T00:00:00')
  const dayIndexOf = (iso: string): number =>
    Math.round((simStart.getTime() - new Date(iso + 'T00:00:00').getTime()) / 86400000)

  // 全局按棚按格位铺棒，批次号轮转，保证一批跨多棚可追溯
  let globalId = 0
  for (let h = 0; h < HOUSE_COUNT; h++) {
    const house = greenhouses[h]
    const cap = slotCapacity(house.layout)
    if (cap !== STICKS_PER_HOUSE) throw new Error(`棚 ${house.code} 容量异常 ${cap}`)
    for (let slot = 0; slot < cap; slot++) {
      const id = globalId++
      const batchId = id % BATCH_COUNT
      const batch = batches[batchId]
      const age = Math.max(0, dayIndexOf(batch.inoculatedAt) + randInt(rng, -1, 1))
      const st = stateAtAge(age)
      // 按序号反算 (row, tier, col)，与 layout.ts 的映射规则完全一致
      const col = slot % house.layout.cols
      const tier = Math.floor(slot / house.layout.cols) % house.layout.tiers
      const row = Math.floor(slot / (house.layout.cols * house.layout.tiers))
      const p = slotPosition(row, tier, col, house.layout)

      const o = id * STICK_FLOATS
      records[o + F.id] = id
      records[o + F.batchId] = batchId
      records[o + F.greenhouseId] = h
      records[o + F.slotIndex] = slot
      records[o + F.weightG] = batch.baseWeightG + randInt(rng, -40, 40)
      records[o + F.status] = st.status
      records[o + F.statusDay] = st.statusDay
      records[o + F.ageDays] = age
      records[o + F.moisture] = Math.min(0.65, 0.42 + rng() * 0.18)
      records[o + F.flushNo] = st.flushNo
      records[o + F.fruitingDays] = st.fruitingDays
      records[o + F.colorProgress] = st.colorProgress
      records[o + F.moldDay] = -1
      records[o + F.scrapped] = 0
      records[o + F.posX] = p.x + origins[h].x
      records[o + F.posY] = p.y
      records[o + F.posZ] = p.z + origins[h].z
      records[o + F.houseX] = origins[h].x
      records[o + F.houseY] = 0
      records[o + F.houseZ] = origins[h].z
    }
  }

  // 三号棚棚尾两排大面积绿霉，七排零星扩散；其余棚偶发个例
  const moldHouse = greenhouses[MOLD_HOUSE_ID]
  const { shelfRows, tiers, cols } = moldHouse.layout
  const infect = (id: number, moldDay: number) => {
    const o = id * STICK_FLOATS
    records[o + F.status] = S.GreenMold
    records[o + F.statusDay] = moldDay
    records[o + F.moldDay] = moldDay
    records[o + F.moisture] = Math.min(0.66, records[o + F.moisture] + 0.05)
  }
  for (let row = shelfRows - 2; row < shelfRows; row++) {
    for (let tier = 0; tier < tiers; tier++) {
      for (let col = 0; col < cols; col++) {
        if (rng() < 0.72) {
          const slot = row * tiers * cols + tier * cols + col
          infect(MOLD_HOUSE_ID * STICKS_PER_HOUSE + slot, randInt(rng, 5, 9))
        }
      }
    }
  }
  for (let tier = 0; tier < tiers; tier++) {
    for (let col = 0; col < cols; col++) {
      if (rng() < 0.22) {
        const slot = (shelfRows - 3) * tiers * cols + tier * cols + col
        infect(MOLD_HOUSE_ID * STICKS_PER_HOUSE + slot, randInt(rng, 2, 5))
      }
    }
  }
  for (let h = 0; h < HOUSE_COUNT; h++) {
    if (h === MOLD_HOUSE_ID) continue
    const n = rng() < 0.35 ? randInt(rng, 1, 4) : 0
    for (let k = 0; k < n; k++) {
      infect(h * STICKS_PER_HOUSE + randInt(rng, 0, STICKS_PER_HOUSE - 1), randInt(rng, 1, 3))
    }
  }

  const settings: Settings = {
    baseName: '云栖谷香菇基地',
    simulationDay: SIM_START_DATE,
    moldBaseProb: 0.08,
    moldSpreadRadius: 1,
    autoTask: true,
  }

  return { greenhouses, batches, records, total: TOTAL_STICKS, origins, settings }
}
