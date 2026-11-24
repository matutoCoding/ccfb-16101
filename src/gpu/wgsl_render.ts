import { commonWgsl } from './wgsl_common'

const head = /* wgsl */ `
${commonWgsl}

struct VertexInput {
  @location(0) localPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldNormal: vec3<f32>,
  @location(1) worldPos: vec3<f32>,
  @location(2) stickId: f32,
  @location(3) localUv: vec2<f32>,
};

@group(0) @binding(0) var<storage, read> sticks: array<StickRecord>;
@group(0) @binding(1) var<storage, read> visibleIds: array<u32>;
@group(0) @binding(2) var<uniform> frame: FrameUniforms;
@group(0) @binding(3) var<storage, read> selected: array<u32>;

fn isSel(id: u32) -> bool {
  for (var i: u32 = 0u; i < frame.selectedCount; i = i + 1u) {
    if (selected[i] == id) { return true; }
  }
  return false;
}

// 棒面程序噪声：用 id + 表面坐标做哈希，斑块稳定不闪烁
fn surfaceNoise(id: f32, uv: vec2<f32>) -> f32 {
  let p = uv * vec2<f32>(8.0, 4.0) + vec2<f32>(fract(id * 0.013) * 17.0, fract(id * 0.071) * 9.0);
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = fract(sin(dot(i, vec2<f32>(12.9898, 78.233)) + id) * 43758.5453);
  let b = fract(sin(dot(i + vec2<f32>(1.0, 0.0), vec2<f32>(12.9898, 78.233)) + id) * 43758.5453);
  let c = fract(sin(dot(i + vec2<f32>(0.0, 1.0), vec2<f32>(12.9898, 78.233)) + id) * 43758.5453);
  let d = fract(sin(dot(i + vec2<f32>(1.0, 1.0), vec2<f32>(12.9898, 78.233)) + id) * 43758.5453);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`

// 主实例化渲染：可见实例来自计算着色器压缩后的 visibleIds
export const renderWgsl = /* wgsl */ `
${head}

fn statusColor(r: StickRecord, uv: vec2<f32>) -> vec3<f32> {
  let id = r.id;
  let status = u32(r.status);
  // 基底：发菌白
  var base = vec3<f32>(0.93, 0.91, 0.86);

  if (status == 1u || status == 2u || status == 3u || status == 4u || status == 5u) {
    // 转色：噪声斑块随 colorProgress 连片，棕褐色逐渐吃掉白色
    let n = surfaceNoise(id, uv);
    let brown = vec3<f32>(0.45, 0.3, 0.18);
    let patch = smoothstep(1.0 - r.colorProgress, 1.05 - r.colorProgress, n);
    base = mix(base, brown, patch);
    if (status == 5u) {
      base = mix(base, vec3<f32>(0.4, 0.32, 0.26), 0.4); // 补水偏深润
    }
  }
  if (status == 6u) {
    // 绿霉：绿斑随污染天数扩散泛绿
    let n = surfaceNoise(id + 101.0, uv);
    let spread = clamp(0.35 + r.moldDay * 0.08, 0.0, 0.95);
    let green = vec3<f32>(0.28, 0.55, 0.2);
    base = mix(base, green, smoothstep(1.0 - spread, 1.05 - spread, n));
  }
  if (status == 7u) {
    base = vec3<f32>(0.32, 0.3, 0.28);
  }
  return base;
}

fn mushroomDetail(r: StickRecord, uv: vec2<f32>, base: vec3<f32>) -> vec3<f32> {
  // 出菇期：棒面上半侧按固定点位冒菇蕾/菇体，大小随出菇天数
  if (u32(r.status) != 3u) { return base; }
  let grow = clamp(r.fruitingDays / 5.0, 0.0, 1.0);
  // 沿棒长 5 个出菇点
  let pointU = fract(uv.x * 5.0);
  let onTop = smoothstep(0.25, 0.45, uv.y);
  let spot = (1.0 - smoothstep(0.0, 0.12 + 0.1 * grow, abs(pointU - 0.5))) * onTop;
  let cap = vec3<f32>(0.78, 0.72, 0.6) * (0.8 + 0.2 * grow);
  return mix(base, cap, spot * (0.35 + 0.5 * grow));
}

@vertex
fn vsMain(in: VertexInput, @builtin(instance_index) ii: u32) -> VSOut {
  let id = visibleIds[ii];
  let r = sticks[id];
  let world = vec4<f32>(in.localPos + vec3<f32>(r.posX, r.posY, r.posZ), 1.0);
  var out: VSOut;
  out.clip = frame.viewProj * world;
  out.worldNormal = in.normal;
  out.worldPos = world.xyz;
  out.stickId = r.id;
  out.localUv = in.localPos.xz / 0.42 + vec2<f32>(0.5);
  return out;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let id = u32(in.stickId);
  let r = sticks[id];
  var albedo = statusColor(r, in.localUv);
  albedo = mushroomDetail(r, in.localUv, albedo);

  // 简单方向光 + 环境光
  let lightDir = normalize(vec3<f32>(0.5, 0.9, 0.35));
  let ndl = max(dot(normalize(in.worldNormal), lightDir), 0.0);
  var color = albedo * (0.35 + 0.65 * ndl);

  // 高亮模式：绿霉红描边感、高风险邻居琥珀色；选中棒亮青边
  if (frame.highlightMode == 1u) {
    let status = u32(r.status);
    if (status == 6u) {
      color = mix(color, vec3<f32>(0.9, 0.25, 0.2), 0.55);
    } else if (isSel(id)) {
      color = mix(color, vec3<f32>(1.0, 0.65, 0.15), 0.5);
    }
  }
  if (isSel(id) && frame.highlightMode != 1u) {
    color = mix(color, vec3<f32>(0.25, 0.75, 0.95), 0.45);
  }
  return vec4<f32>(color, 1.0);
}
`

// ID 拾取 pass：输出 R32Uint，像素值即全局菌棒 id，与档案编号同源
export const pickWgsl = /* wgsl */ `
${head}

@vertex
fn vsPick(in: VertexInput, @builtin(instance_index) ii: u32) -> VSOut {
  let id = visibleIds[ii];
  let r = sticks[id];
  let world = vec4<f32>(in.localPos + vec3<f32>(r.posX, r.posY, r.posZ), 1.0);
  var out: VSOut;
  out.clip = frame.viewProj * world;
  out.worldNormal = in.normal;
  out.worldPos = world.xyz;
  out.stickId = r.id;
  out.localUv = in.localPos.xz;
  return out;
}

@fragment
fn fsPick(in: VSOut) -> @location(0) u32 {
  return u32(in.stickId) + 1u; // 0 留给背景
}
`

// 静态场景（层架/地面/薄膜）shader
export const staticWgsl = /* wgsl */ `
struct StaticUniforms {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
};
@group(0) @binding(0) var<uniform> su: StaticUniforms;

struct SVIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
};
struct SVOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
};

@vertex
fn vsStatic(in: SVIn) -> SVOut {
  var out: SVOut;
  out.clip = su.viewProj * vec4<f32>(in.pos, 1.0);
  out.normal = in.normal;
  out.color = in.color;
  return out;
}

@fragment
fn fsStatic(in: SVOut) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.5, 0.9, 0.35));
  let ndl = max(dot(normalize(in.normal), lightDir), 0.0);
  return vec4<f32>(in.color * (0.4 + 0.6 * ndl), 1.0);
}
`
