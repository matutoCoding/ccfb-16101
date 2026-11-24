// 低面数圆柱网格（菌棒），径向 8 段足够 40 万实例规模
export interface Geometry {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  vertexCount: number
}

export const buildCylinder = (radius = 0.06, len = 0.42, radial = 8): Geometry => {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let side = 0; side < 2; side++) {
    const x = side === 0 ? -len / 2 : len / 2
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2
      const cy = Math.cos(a) * radius
      const cz = Math.sin(a) * radius
      positions.push(x, cy, cz)
      normals.push(side === 0 ? -1 : 1, 0, 0)
    }
  }
  const ring = radial + 1
  // 两端盖
  for (let i = 0; i < radial; i++) {
    indices.push(0, i + 1, i + 2)
    indices.push(ring, ring + i + 2, ring + i + 1)
  }

  // 侧面：重新一圈带法线的顶点
  const sideStart = positions.length / 3
  for (let i = 0; i <= radial; i++) {
    const a = (i / radial) * Math.PI * 2
    const ny = Math.cos(a)
    const nz = Math.sin(a)
    positions.push(-len / 2, ny * radius, nz * radius)
    normals.push(0, ny, nz)
    positions.push(len / 2, ny * radius, nz * radius)
    normals.push(0, ny, nz)
  }
  for (let i = 0; i < radial; i++) {
    const a = sideStart + i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    indices.push(a, c, b, c, d, b)
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
  }
}

// 程序化盒子（层架梁、立柱），法线沿主轴
export const buildBox = (
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
): Geometry => {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const h = [sx / 2, sy / 2, sz / 2]
  const normalsList = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ]
  for (let f = 0; f < 6; f++) {
    const n = normalsList[f]
    const axis = f >> 1
    const uAxis = (axis + 1) % 3
    const vAxis = (axis + 2) % 3
    const sign = f % 2 === 0 ? -1 : 1
    const base = positions.length / 3
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = [cx, cy, cz]
      p[axis] += sign * h[axis]
      p[uAxis] += su * h[uAxis]
      p[vAxis] += sv * h[vAxis]
      positions.push(...p)
      normals.push(...n)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    vertexCount: positions.length / 3,
  }
}
