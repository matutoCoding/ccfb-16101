// 与 src/domain/record.ts 的 STICK_FLOATS / F 逐字段对齐，80 字节
// FrameUniforms：mat4(64B) + vec3(16B对齐) + 5 标量，WGSL 结构体向上对齐到 112B
export const FRAME_UNIFORM_BYTES = 112
export const commonWgsl = /* wgsl */ `
struct StickRecord {
  id: f32,
  batchId: f32,
  greenhouseId: f32,
  slotIndex: f32,
  weightG: f32,
  status: f32,
  statusDay: f32,
  ageDays: f32,
  moisture: f32,
  flushNo: f32,
  fruitingDays: f32,
  colorProgress: f32,
  moldDay: f32,
  scrapped: f32,
  posX: f32,
  posY: f32,
  posZ: f32,
  houseX: f32,
  houseY: f32,
  houseZ: f32,
};

struct SimUniforms {
  total: u32,
  daySeed: u32,
  moldBaseProb: f32,
  moldRadius: u32,
  simDay: u32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

struct HouseUniform {
  id: f32,
  cols: f32,
  tiers: f32,
  cap: f32,
  tempC: f32,
  humidity: f32,
  baseProb: f32,
  mapOffset: f32, // 该棚格位在全局 slotMap 中的起始偏移
};

struct FrameUniforms {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  width: f32,
  height: f32,
  time: f32,
  highlightMode: u32, // 0 普通 1 绿霉+高风险高亮
  selectedCount: u32,
  pad: f32,
};

struct CullUniforms {
  viewProj: mat4x4<f32>,
  pyramidSize: vec2<u32>,
  screenSize: vec2<u32>,
  total: u32,
  frameIndex: u32,
  level: f32,
  selectedCount: u32,
};

struct DrawIndirect {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: u32,
  firstInstance: u32,
};

fn hash01(x: u32, seed: u32) -> f32 {
  var h = x ^ seed;
  h = (h ^ (h >> 16)) * 0x7feb352du;
  h = (h ^ (h >> 15)) * 0x846ca68bu;
  h = h ^ (h >> 16);
  return f32(h) / 4294967296.0;
}

fn moldEnvFactor(tempC: f32, humidity: f32) -> f32 {
  let tempFactor = max(0.0, 1.0 - abs(tempC - 25.0) / 14.0);
  let humFactor = clamp(humidity * 1.45, 0.0, 1.4);
  return tempFactor * humFactor;
}
`
