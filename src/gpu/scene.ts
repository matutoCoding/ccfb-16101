import type { Greenhouse } from '@/domain/types'
import { footprint, TIER_PITCH, ROW_PITCH, SHELF_BASE_Y, STICK_LEN } from '@/domain/layout'
import { buildBox } from './mesh'

export interface StaticScene {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
  // 薄膜半透明部分单独一份，遮挡剔除可选
  filmPositions: Float32Array
  filmNormals: Float32Array
  filmIndices: Uint32Array
}

const merge = (geoms: ReturnType<typeof buildBox>[], color: [number, number, number]) => {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (const g of geoms) {
    const base = positions.length / 3
    positions.push(...g.positions)
    normals.push(...g.normals)
    for (let i = 0; i < g.vertexCount; i++) colors.push(...color)
    for (const idx of g.indices) indices.push(idx + base)
  }
  return { positions, normals, colors, indices }
}

// 为控制总顶点数，层架用间隔抽样的立柱 + 每层两根纵梁表达
export const buildScene = (
  greenhouses: Greenhouse[],
  origins: { x: number; z: number }[],
): StaticScene => {
  const shelfGeoms: ReturnType<typeof buildBox>[] = []
  const filmGeoms: ReturnType<typeof buildBox>[] = []

  greenhouses.forEach((house, hi) => {
    const ox = origins[hi].x
    const oz = origins[hi].z
    const fp = footprint(house.layout)
    const { shelfRows, tiers, cols } = house.layout
    const totalLen = (cols - 1) * (STICK_LEN + 0.04)
    const totalDepth = (shelfRows - 1) * ROW_PITCH

    // 每排每层层架纵梁（沿 X 两根）
    for (let row = 0; row < shelfRows; row++) {
      const z = oz - totalDepth / 2 + row * ROW_PITCH
      for (let tier = 0; tier <= tiers; tier++) {
        const y = SHELF_BASE_Y + tier * TIER_PITCH - 0.12
        shelfGeoms.push(buildBox(ox, y, z - 0.16, totalLen + 0.4, 0.05, 0.04))
        shelfGeoms.push(buildBox(ox, y, z + 0.16, totalLen + 0.4, 0.05, 0.04))
      }
    }
    // 立柱：每排两端 + 沿长度每 40 列一根，压顶点量
    const postStep = Math.max(1, Math.floor(cols / 5))
    for (let row = 0; row < shelfRows; row++) {
      const z = oz - totalDepth / 2 + row * ROW_PITCH
      for (let c = 0; c < cols; c += postStep) {
        const x = ox - totalLen / 2 + c * (STICK_LEN + 0.04)
        const h = tiers * TIER_PITCH
        shelfGeoms.push(buildBox(x, SHELF_BASE_Y + h / 2 - 0.1, z, 0.06, h, 0.06))
      }
    }

    // 薄膜外壳：四面薄板 + 顶棚，整体作为可切换的遮挡体
    const top = fp.height
    filmGeoms.push(buildBox(ox, top, oz - fp.halfZ, fp.halfX * 2, 0.04, 0.04))
    filmGeoms.push(buildBox(ox, top, oz + fp.halfZ, fp.halfX * 2, 0.04, 0.04))
    filmGeoms.push(buildBox(ox - fp.halfX, top / 2, oz, 0.04, top, fp.halfZ * 2))
    filmGeoms.push(buildBox(ox + fp.halfX, top / 2, oz, 0.04, top, fp.halfZ * 2))
    filmGeoms.push(buildBox(ox, top, oz, fp.halfX * 2, 0.04, fp.halfZ * 2))
  })

  const shelf = merge(shelfGeoms, [0.42, 0.46, 0.5])
  const filmRaw = merge(filmGeoms, [0.72, 0.82, 0.88])

  return {
    positions: new Float32Array(shelf.positions),
    normals: new Float32Array(shelf.normals),
    colors: new Float32Array(shelf.colors),
    indices: new Uint32Array(shelf.indices),
    filmPositions: new Float32Array(filmRaw.positions),
    filmNormals: new Float32Array(filmRaw.normals),
    filmIndices: new Uint32Array(filmRaw.indices),
  }
}

// 地面网格：一块大板
export const buildGround = (spanX: number, spanZ: number): ReturnType<typeof buildBox> =>
  buildBox(0, -0.05, 0, spanX, 0.1, spanZ)
