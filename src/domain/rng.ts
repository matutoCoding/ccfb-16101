// 确定性伪随机，保证测试数据可复现
export const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 整数区间 [min, max]
export const randInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1))

// WGSL 侧同款哈希，CPU 测试可对齐
export const hashU32 = (x: number, seed: number): number => {
  let h = (x ^ seed) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

export const hash01 = (x: number, seed: number): number => hashU32(x, seed) / 4294967296
