import { StickStatus } from './types'

// 菌棒 GPU 存储记录：20 个 f32，80 字节。
// WGSL 中的 struct StickRecord 必须与这里逐字段对齐，IndexedDB 持久化同一份 ArrayBuffer。
export const STICK_FLOATS = 20
export const STICK_STRIDE = STICK_FLOATS * 4

export const F = {
  id: 0,
  batchId: 1,
  greenhouseId: 2,
  slotIndex: 3,
  weightG: 4,
  status: 5,
  statusDay: 6,
  ageDays: 7,
  moisture: 8,
  flushNo: 9,
  fruitingDays: 10,
  colorProgress: 11,
  moldDay: 12,
  scrapped: 13,
  posX: 14,
  posY: 15,
  posZ: 16,
  houseX: 17,
  houseY: 18,
  houseZ: 19,
} as const

// 档案编号规则：S + 6 位补零 id，全局唯一，拾取 id 与档案号同源
export const stickCode = (id: number): string => `S${String(id).padStart(6, '0')}`

export interface StickView {
  id: number
  batchId: number
  greenhouseId: number
  slotIndex: number
  weightG: number
  status: StickStatus
  statusDay: number
  ageDays: number
  moisture: number
  flushNo: number
  fruitingDays: number
  colorProgress: number
  moldDay: number
  scrapped: number
  x: number
  y: number
  z: number
}

export const readStick = (buf: Float32Array, id: number): StickView => {
  const o = id * STICK_FLOATS
  return {
    id: buf[o + F.id],
    batchId: buf[o + F.batchId],
    greenhouseId: buf[o + F.greenhouseId],
    slotIndex: buf[o + F.slotIndex],
    weightG: buf[o + F.weightG],
    status: buf[o + F.status] as StickStatus,
    statusDay: buf[o + F.statusDay],
    ageDays: buf[o + F.ageDays],
    moisture: buf[o + F.moisture],
    flushNo: buf[o + F.flushNo],
    fruitingDays: buf[o + F.fruitingDays],
    colorProgress: buf[o + F.colorProgress],
    moldDay: buf[o + F.moldDay],
    scrapped: buf[o + F.scrapped],
    x: buf[o + F.posX],
    y: buf[o + F.posY],
    z: buf[o + F.posZ],
  }
}

export const writeStickField = (
  buf: Float32Array,
  id: number,
  field: number,
  value: number,
): void => {
  buf[id * STICK_FLOATS + field] = value
}
