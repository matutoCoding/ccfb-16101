import { commonWgsl } from './wgsl_common'

export const cullWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(0) var<storage, read> sticks: array<StickRecord>;
@group(0) @binding(1) var<storage, read_write> visibleIds: array<u32>;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> indirect: DrawIndirect;
@group(0) @binding(4) var depthPyramid: texture_storage_2d_array<r32float, read_write>;
@group(0) @binding(5) var<uniform> cu: CullUniforms;
@group(0) @binding(6) var<storage, read> selected: array<u32>;
@group(0) @binding(7) var depthRead: texture_2d<f32>;

struct Frustum { planes: array<vec4<f32>, 6> };

fn buildFrustum(m: mat4x4<f32>) -> Frustum {
  var f: Frustum;
  f.planes[0] = m[3] + m[0];
  f.planes[1] = m[3] - m[0];
  f.planes[2] = m[3] + m[1];
  f.planes[3] = m[3] - m[1];
  f.planes[4] = m[3] + m[2];
  f.planes[5] = m[3] - m[2];
  return f;
}

fn inFrustum(f: Frustum, center: vec3<f32>, radius: f32) -> bool {
  for (var i: i32 = 0; i < 6; i = i + 1) {
    let p = f.planes[i];
    let d = dot(vec4(center, 1.0), p);
    if (d < -radius * length(p.xyz)) {
      return false;
    }
  }
  return true;
}

fn isSelected(id: u32) -> bool {
  for (var i: u32 = 0u; i < cu.selectedCount; i = i + 1u) {
    if (selected[i] == id) { return true; }
  }
  return false;
}

// 遮挡测试：在深度金字塔对应层采样，层号随外接球投影尺寸选择
fn occluded(center: vec3<f32>, id: u32) -> bool {
  let clip = cu.viewProj * vec4<f32>(center, 1.0);
  if (clip.w <= 0.1) { return true; }
  let ndc = clip.xyz / clip.w;
  let screenU = ndc.x * 0.5 + 0.5;
  let screenV = ndc.y * 0.5 + 0.5;
  let depth = ndc.z * 0.5 + 0.5;

  // 金字塔固定 5 层，每层对应 2^level 像素的保守深度
  let level = 2u;
  let scale = vec2<f32>(cu.pyramidSize) / f32(1u << level);
  let uv = vec2<f32>(screenU, screenV) * scale;
  let px = clamp(i32(uv.x), 0, i32(scale.x) - 1);
  let py = clamp(i32(uv.y), 0, i32(scale.y) - 1);
  // 采样对应粗层中心，取该层及上一层最大深度，得到外接球尺度的保守遮挡值
  let hiZ = textureLoad(depthPyramid, vec2<i32>(px, py), i32(level));
  let fine = textureLoad(depthPyramid, vec2<i32>(px, py), i32(level - 1u));
  hiZ = max(hiZ, fine);
  return depth > hiZ + 0.004 && !isSelected(id);
}

@compute @workgroup_size(256)
fn cullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= cu.total) { return; }
  let r = sticks[i];
  if (i32(r.scrapped) == 1) { return; }

  let frustum = buildFrustum(cu.viewProj);
  let center = vec3<f32>(r.posX, r.posY, r.posZ);
  let radius = 0.26;
  if (!inFrustum(frustum, center, radius)) { return; }
  if (occluded(center, i)) { return; }

  let slot = atomicAdd(&counters[0], 1u);
  visibleIds[slot] = i;
}

@compute @workgroup_size(1)
fn writeIndirect() {
  // indexCount 由 CPU 初始化，这里每帧只回填实例数
  indirect.instanceCount = atomicLoad(&counters[0]);
  indirect.firstIndex = 0u;
  indirect.baseVertex = 0u;
  indirect.firstInstance = 0u;
}

  // 第 0 层：从上一帧深度纹理按比例取最近点，降采样到金字塔基分辨率
@compute @workgroup_size(8, 8)
fn buildBase(@builtin(global_invocation_id) g: vec3<u32>) {
  let dims = vec2<i32>(cu.pyramidSize);
  let dst = vec2<i32>(g.xy);
  if (dst.x >= dims.x || dst.y >= dims.y) { return; }
  let sd = vec2<i32>(textureDimensions(depthRead));
  let sx = clamp(dst.x * sd.x / dims.x, 0, sd.x - 1);
  let sy = clamp(dst.y * sd.y / dims.y, 0, sd.y - 1);
  // 取 2x2 最大深度，得到保守的最近遮挡面
  var d = 0.0;
  for (var oy: i32 = 0; oy < 2; oy = oy + 1) {
    for (var ox: i32 = 0; ox < 2; ox = ox + 1) {
      d = max(d, textureLoad(depthRead, vec2<i32>(min(sx + ox, sd.x - 1), min(sy + oy, sd.y - 1)), 0).r);
    }
  }
  textureStore(depthPyramid, dst, 0, vec4<f32>(d, 0.0, 0.0, 1.0));
}

// 后续层：每层取上一层 2x2 的最大深度
@compute @workgroup_size(8, 8)
fn reduceLevel(
  @builtin(global_invocation_id) g: vec3<u32>,
) {
  // 目标层通过 uniform.level 传入，源层 = 目标层 - 1
  let level = u32(cu.level);
  let dims = vec2<i32>(cu.pyramidSize) / i32(1u << level);
  let dst = vec2<i32>(g.xy);
  if (dst.x >= dims.x || dst.y >= dims.y) { return; }
  let src = dst * 2;
  var d = 0.0;
  for (var oy: i32 = 0; oy < 2; oy = oy + 1) {
    for (var ox: i32 = 0; ox < 2; ox = ox + 1) {
      d = max(d, textureLoad(depthPyramid, src + vec2<i32>(ox, oy), i32(level - 1u)));
    }
  }
  textureStore(depthPyramid, dst, i32(level), vec4<f32>(d, 0.0, 0.0, 1.0));
}
`
