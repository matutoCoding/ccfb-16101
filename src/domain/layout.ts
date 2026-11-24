import type { GreenhouseLayout } from './types'

// 单根菌棒实例尺寸（米）：棒为短圆柱，横放在层架上
export const STICK_LEN = 0.42
export const STICK_RADIUS = 0.06
// 层架层高与排宽
export const TIER_PITCH = 0.45
export const ROW_PITCH = 0.62
export const SHELF_BASE_Y = 0.35

export interface Slot {
  index: number
  row: number
  tier: number
  col: number
  x: number
  y: number
  z: number
}

// 一个棚的格位总数，重排前先算容量，容量不足的棒下架
export const slotCapacity = (l: GreenhouseLayout): number => l.shelfRows * l.tiers * l.cols

// 格位序号 <-> (row, tier, col) 双向映射，全棚统一规则，保证拾取编号不错位
export const slotToRtc = (index: number, l: GreenhouseLayout): [number, number, number] => {
  const col = index % l.cols
  const tier = Math.floor(index / l.cols) % l.tiers
  const row = Math.floor(index / (l.cols * l.tiers))
  return [row, tier, col]
}

export const rtcToSlot = (row: number, tier: number, col: number, l: GreenhouseLayout): number =>
  row * l.tiers * l.cols + tier * l.cols + col

// 格位世界坐标：排沿 Z 铺开、列沿 X 铺开、层沿 Y 抬高，棚中心为原点
export const slotPosition = (row: number, tier: number, col: number, l: GreenhouseLayout): Slot => {
  const totalRowDepth = (l.shelfRows - 1) * ROW_PITCH
  const totalColLen = (l.cols - 1) * (STICK_LEN + 0.04)
  const x = -totalColLen / 2 + col * (STICK_LEN + 0.04)
  const y = SHELF_BASE_Y + tier * TIER_PITCH
  const z = -totalRowDepth / 2 + row * ROW_PITCH
  return { index: rtcToSlot(row, tier, col, l), row, tier, col, x, y, z }
}

export const slotFromIndex = (index: number, l: GreenhouseLayout): Slot => {
  const [row, tier, col] = slotToRtc(index, l)
  return slotPosition(row, tier, col, l)
}

// 棚整体占地半宽，给三维镜头与薄膜外壳用
export const footprint = (l: GreenhouseLayout): { halfX: number; halfZ: number; height: number } => ({
  halfX: Math.max(l.lengthM / 2, (l.cols * (STICK_LEN + 0.04)) / 2 + 0.6),
  halfZ: Math.max(l.widthM / 2, ((l.shelfRows - 1) * ROW_PITCH) / 2 + 0.7),
  height: SHELF_BASE_Y + l.tiers * TIER_PITCH + 0.5,
})

// 同一棚内，某格位的相邻格位（绿霉扩散用），返回格位序号数组
export const neighborSlots = (index: number, l: GreenhouseLayout, radius: number): number[] => {
  const [row, tier, col] = slotToRtc(index, l)
  const out: number[] = []
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dt = -radius; dt <= radius; dt++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dt === 0 && dc === 0) continue
        const r = row + dr
        const t = tier + dt
        const c = col + dc
        if (r < 0 || r >= l.shelfRows || t < 0 || t >= l.tiers || c < 0 || c >= l.cols) continue
        out.push(rtcToSlot(r, t, c, l))
      }
    }
  }
  return out
}
