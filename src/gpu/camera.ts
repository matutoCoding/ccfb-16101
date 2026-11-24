// 列主序 4x4，与 WGSL mat4x4 内存布局一致
export type Mat4 = Float32Array
export type Vec3 = [number, number, number]

export const identity = (): Mat4 => {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

export const perspective = (fovyRad: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fovyRad / 2)
  const nf = 1 / (near - far)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = far * nf
  m[11] = -1
  m[14] = far * near * nf
  return m
}

export const lookAt = (eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 => {
  const zx = eye[0] - target[0]
  const zy = eye[1] - target[1]
  const zz = eye[2] - target[2]
  const zl = Math.hypot(zx, zy, zz) || 1
  const fz: Vec3 = [zx / zl, zy / zl, zz / zl]
  const xx = up[1] * fz[2] - up[2] * fz[1]
  const xy = up[2] * fz[0] - up[0] * fz[2]
  const xz = up[0] * fz[1] - up[1] * fz[0]
  const xl = Math.hypot(xx, xy, xz) || 1
  const fx: Vec3 = [xx / xl, xy / xl, xz / xl]
  const fy: Vec3 = [
    fz[1] * fx[2] - fz[2] * fx[1],
    fz[2] * fx[0] - fz[0] * fx[2],
    fz[0] * fx[1] - fz[1] * fx[0],
  ]
  const m = new Float32Array(16)
  m[0] = fx[0]
  m[1] = fy[0]
  m[2] = fz[0]
  m[4] = fx[1]
  m[5] = fy[1]
  m[6] = fz[1]
  m[8] = fx[2]
  m[9] = fy[2]
  m[10] = fz[2]
  m[12] = -(fx[0] * eye[0] + fx[1] * eye[1] + fx[2] * eye[2])
  m[13] = -(fy[0] * eye[0] + fy[1] * eye[1] + fy[2] * eye[2])
  m[14] = -(fz[0] * eye[0] + fz[1] * eye[1] + fz[2] * eye[2])
  m[15] = 1
  return m
}

export const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3]
    }
  }
  return out
}

export const viewProj = (fovy: number, aspect: number, eye: Vec3, target: Vec3): Mat4 =>
  multiply(perspective(fovy, aspect, 0.1, 1200), lookAt(eye, target))

// 点的投影，框选用
export const projectPoint = (
  m: Mat4,
  p: Vec3,
): { x: number; y: number; z: number; w: number; visible: boolean } => {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
  return {
    x: (x / w) * 0.5 + 0.5,
    y: 1 - ((y / w) * 0.5 + 0.5),
    z: (z / w) * 0.5 + 0.5,
    w,
    visible: w > 0.1,
  }
}

export class OrbitCamera {
  target: Vec3 = [0, 2, 0]
  distance = 260
  yaw = -Math.PI * 0.25
  pitch = 0.55
  fov = (55 * Math.PI) / 180

  eye = (): Vec3 => {
    const cp = Math.cos(this.pitch)
    return [
      this.target[0] + this.distance * cp * Math.cos(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.sin(this.yaw),
    ]
  }

  matrix = (aspect: number): Mat4 => viewProj(this.fov, aspect, this.eye(), this.target)

  rotate = (dx: number, dy: number): void => {
    this.yaw -= dx * 0.005
    this.pitch = Math.min(1.45, Math.max(0.08, this.pitch + dy * 0.005))
  }

  zoom = (delta: number): void => {
    this.distance = Math.min(900, Math.max(6, this.distance * (1 + delta * 0.0012)))
  }

  pan = (dx: number, dy: number): void => {
    const s = this.distance * 0.0016
    this.target[0] -= dx * s * Math.cos(this.yaw)
    this.target[2] -= dx * s * Math.sin(this.yaw)
    this.target[1] += dy * s
  }

  // 飞到某个棚上方
  flyTo = (x: number, z: number, distance = 60): void => {
    this.target = [x, 1.5, z]
    this.distance = distance
    this.pitch = 0.7
    this.yaw = -Math.PI * 0.35
  }
}
