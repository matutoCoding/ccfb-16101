// 纯领域逻辑测试：node --experimental-strip-types tests/run_logic.test.ts
import assert from 'node:assert/strict'
import { generateData, HOUSE_COUNT, TOTAL_STICKS, MOLD_HOUSE_ID, STICKS_PER_HOUSE } from '../src/domain/generator.ts'
import { slotCapacity, slotToRtc, rtcToSlot, neighborSlots } from '../src/domain/layout.ts'
import { F, STICK_FLOATS, stickCode } from '../src/domain/record.ts'
import { advanceDayCpu, buildSlotMap, moldEnvFactor } from '../src/domain/simulation.ts'
import { mulberry32 } from '../src/domain/rng.ts'
import { StickStatus } from '../src/domain/types.ts'
import { dispatchTasks, estimateFlushYield } from '../src/domain/tasks.ts'

let passed = 0
const test = (name: string, fn: () => void) => {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

const data = generateData()

test('规模正确：40 棚 × 1 万 = 40 万根', () => {
  assert.equal(HOUSE_COUNT, 40)
  assert.equal(TOTAL_STICKS, 400000)
  assert.equal(data.total, 400000)
  assert.equal(data.greenhouses.length, 40)
})

test('每棚四种排布容量都是 10000，且无两根占同一格', () => {
  for (const h of data.greenhouses) {
    assert.equal(slotCapacity(h.layout), STICKS_PER_HOUSE)
  }
  const seen = new Set<number>()
  for (let id = 0; id < data.total; id++) {
    const o = id * STICK_FLOATS
    const key = data.records[o + F.greenhouseId] * 100000 + data.records[o + F.slotIndex]
    assert.ok(!seen.has(key), `格位冲突 id=${id}`)
    seen.add(key)
  }
  assert.equal(seen.size, TOTAL_STICKS)
})

test('格位序号与 (row,tier,col) 双向映射严格互逆', () => {
  const l = data.greenhouses[0].layout
  for (let i = 0; i < 1000; i++) {
    const slot = Math.floor((i / 1000) * slotCapacity(l))
    const [r, t, c] = slotToRtc(slot, l)
    assert.equal(rtcToSlot(r, t, c, l), slot)
  }
})

test('档案编号与 id 同源，拾取 id 不错位', () => {
  assert.equal(stickCode(0), 'S000000')
  assert.equal(stickCode(20003), 'S020003')
  assert.equal(stickCode(399999), 'S399999')
})

test('三号棚棚尾大面积绿霉，污染规模显著高于其他棚', () => {
  let moldHouse = 0
  let moldOthers = 0
  for (let id = 0; id < data.total; id++) {
    const o = id * STICK_FLOATS
    if (data.records[o + F.status] !== StickStatus.GreenMold) continue
    if (data.records[o + F.greenhouseId] === MOLD_HOUSE_ID) moldHouse++
    else moldOthers++
  }
  assert.ok(moldHouse > 1500, `三号棚污染 ${moldHouse} 根，应大于 1500`)
  assert.ok(moldHouse > moldOthers * 5)
})

test('批次菌龄错开：16 批接种日期不同且一批跨多棚', () => {
  const dates = new Set(data.batches.map((b) => b.inoculatedAt))
  assert.equal(dates.size, 16)
  const housesOfBatch = new Set<number>()
  for (let id = 0; id < data.total; id += data.batches.length) {
    housesOfBatch.add(data.records[id * STICK_FLOATS + F.greenhouseId])
  }
  assert.ok(housesOfBatch.size >= 3, '单批次应分布到至少 3 个棚')
})

test('温湿度霉菌因子：25°C 高湿最高，低温低湿趋零', () => {
  assert.ok(moldEnvFactor(25, 0.95) > moldEnvFactor(12, 0.5))
  assert.ok(moldEnvFactor(5, 0.3) < 0.1)
})

test('邻居格位不越界且不含自身', () => {
  const l = data.greenhouses[0].layout
  const ns = neighborSlots(0, l, 1)
  assert.ok(!ns.includes(0))
  for (const s of ns) assert.ok(s >= 0 && s < slotCapacity(l))
  const corner = slotCapacity(l) - 1
  const ns2 = neighborSlots(corner, l, 1)
  for (const s of ns2) assert.ok(s >= 0 && s < slotCapacity(l))
})

test('CPU 推进一天：菌龄 +1，健康棒不产生负状态，绿霉会扩散', () => {
  const rng = mulberry32(42)
  const before = new Float32Array(data.records)
  const maps = data.greenhouses.map((g) => buildSlotMap(before, data.total, g))
  const settings = { ...data.settings, moldBaseProb: 0.9 }
  const beforeMold = countStatus(before, StickStatus.GreenMold)
  const res = advanceDayCpu(before, data.total, data.greenhouses, maps, settings, rng)
  assert.ok(res.infected > 0, '高概率下应有新增感染')
  const afterMold = countStatus(before, StickStatus.GreenMold)
  assert.equal(afterMold, beforeMold + res.infected)
  // 所有非报废棒菌龄都 +1
  let checked = 0
  for (let id = 0; id < data.total; id++) {
    const o = id * STICK_FLOATS
    if (before[o + F.scrapped] === 1) continue
    assert.equal(before[o + F.ageDays], data.records[o + F.ageDays] + 1)
    checked++
  }
  assert.ok(checked > 0)
})

test('状态机循环：出菇→养菌→补水→催蕾，潮次递增', () => {
  const rec = new Float32Array(STICK_FLOATS)
  rec[F.id] = 1
  rec[F.status] = StickStatus.Fruiting
  rec[F.statusDay] = 6
  rec[F.ageDays] = 100
  rec[F.moisture] = 0.5
  rec[F.flushNo] = 1
  rec[F.slotIndex] = -1
  const maps = data.greenhouses.map((g) => new Int32Array(slotCapacity(g.layout)).fill(-1))
  const rng = mulberry32(1)
  // 连推 45 天，至少走完一个完整潮次循环（出菇7+养菌10+补水2=19天）
  let sawWatering = false
  let sawBud = false
  for (let d = 0; d < 45; d++) {
    advanceDayCpu(rec, 1, data.greenhouses, maps, data.settings, rng)
    if (rec[F.status] === StickStatus.Watering) sawWatering = true
    if (rec[F.status] === StickStatus.BudInduce) sawBud = true
  }
  assert.ok(sawWatering && sawBud)
  assert.ok(rec[F.flushNo] >= 2, `潮次应递增，实际 ${rec[F.flushNo]}`)
})

test('含水率被约束在安全区间，补水后回升', () => {
  const rec = new Float32Array(STICK_FLOATS)
  rec[F.id] = 2
  rec[F.status] = StickStatus.Watering
  rec[F.statusDay] = 0
  rec[F.ageDays] = 80
  rec[F.moisture] = 0.34
  rec[F.slotIndex] = -1
  const maps = data.greenhouses.map((g) => new Int32Array(slotCapacity(g.layout)).fill(-1))
  advanceDayCpu(rec, 1, data.greenhouses, maps, data.settings, mulberry32(2))
  assert.ok(rec[F.moisture] > 0.34 && rec[F.moisture] <= 0.66)
})

test('自动派单：清污染单优先级最高且按棚排聚合', () => {
  const tasks = dispatchTasks(data.records, data.total, (h, s) => slotToRtc(s, data.greenhouses[h].layout), data.settings.simulationDay)
  assert.ok(tasks.length > 0)
  if (tasks.length > 1) {
    const firstClean = tasks.findIndex((t) => t.kind === 'clean')
    const firstNonClean = tasks.findIndex((t) => t.kind !== 'clean')
    if (firstClean >= 0 && firstNonClean >= 0) assert.ok(firstClean < firstNonClean)
  }
  const totalClean = tasks.filter((t) => t.kind === 'clean').reduce((s, t) => s + t.stickCount, 0)
  assert.ok(totalClean >= countStatus(data.records, StickStatus.GreenMold) * 0.9)
})

test('潮次产量随潮次衰减', () => {
  const y1 = estimateFlushYield(1, 1800)
  const y3 = estimateFlushYield(3, 1800)
  assert.ok(y3 < y1)
  assert.ok(y1 > 0)
})

function countStatus(rec: Float32Array, status: StickStatus): number {
  let n = 0
  for (let id = 0; id < rec.length / STICK_FLOATS; id++) {
    if (rec[id * STICK_FLOATS + F.status] === status) n++
  }
  return n
}

console.log(`\n全部 ${passed} 项逻辑测试通过`)
