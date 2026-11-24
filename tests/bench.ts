import { generateData } from '../src/domain/generator.ts'
import { advanceDayCpu, buildSlotMap } from '../src/domain/simulation.ts'
import { mulberry32 } from '../src/domain/rng.ts'

export const run = () => {
  let t0 = performance.now()
  const data = generateData()
  console.log(`数据生成 40 万根: ${(performance.now() - t0).toFixed(1)} ms`)

  t0 = performance.now()
  const maps = data.greenhouses.map((g) => buildSlotMap(data.records, data.total, g))
  console.log(`构建 40 个 slotMap: ${(performance.now() - t0).toFixed(1)} ms`)

  t0 = performance.now()
  advanceDayCpu(data.records, data.total, data.greenhouses, maps, data.settings, mulberry32(7))
  console.log(`CPU 推进一天（对照参考）: ${(performance.now() - t0).toFixed(1)} ms`)

  t0 = performance.now()
  let mold = 0
  for (let id = 0; id < data.total; id++) if (data.records[id * 20 + 5] === 6) mold++
  console.log(`全表状态扫描: ${(performance.now() - t0).toFixed(1)} ms，绿霉 ${mold} 根`)
}
