import { commonWgsl } from './wgsl_common'

export const simWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(0) var<storage, read_write> sticksIn: array<StickRecord>;
@group(0) @binding(1) var<storage, read_write> sticksOut: array<StickRecord>;
@group(0) @binding(2) var<storage, read_write> slotMap: array<i32>;
@group(0) @binding(3) var<uniform> sim: SimUniforms;
@group(0) @binding(4) var<uniform> houses: array<HouseUniform, 40>;

const MOISTURE_MIN: f32 = 0.32;
const MOISTURE_MAX: f32 = 0.66;

fn nextStatus(status: u32) -> u32 {
  // 0发菌 1转色 2催蕾 3出菇 4养菌 5补水 6绿霉 7报废
  if (status == 0u) { return 1u; }
  if (status == 1u) { return 2u; }
  if (status == 2u) { return 3u; }
  if (status == 3u) { return 4u; }
  if (status == 4u) { return 5u; }
  if (status == 5u) { return 2u; }
  return status;
}

fn statusDuration(status: u32) -> f32 {
  if (status == 0u) { return 35.0; }
  if (status == 1u) { return 12.0; }
  if (status == 2u) { return 4.0; }
  if (status == 3u) { return 7.0; }
  if (status == 4u) { return 10.0; }
  if (status == 5u) { return 2.0; }
  return 9999.0;
}

// 第一遍：状态机推进 + 重算 slotMap（重排后映射可能已失效）
@compute @workgroup_size(256)
fn passAdvance(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= sim.total) { return; }
  var r = sticksIn[i];
  if (i32(r.scrapped) == 1) {
    sticksOut[i] = r;
    return;
  }
  let status = u32(r.status);

  if (status == 6u) {
    r.ageDays = r.ageDays + 1.0;
    r.moldDay = r.moldDay + 1.0;
    r.statusDay = r.statusDay + 1.0;
    sticksOut[i] = r;
    return;
  }

  r.ageDays = r.ageDays + 1.0;
  r.statusDay = r.statusDay + 1.0;

  var drift: f32 = -0.006;
  if (status == 3u) { drift = -0.02; }
  if (status == 4u) { drift = -0.012; }
  if (status == 5u) { drift = 0.12; }
  r.moisture = clamp(r.moisture + drift, MOISTURE_MIN, MOISTURE_MAX);

  if (status == 1u) {
    r.colorProgress = min(1.0, r.colorProgress + 1.0 / 12.0);
  }
  if (status == 3u) {
    r.fruitingDays = r.fruitingDays + 1.0;
  }

  if (r.statusDay >= statusDuration(status)) {
    let next = nextStatus(status);
    r.status = f32(next);
    r.statusDay = 0.0;
    if (next == 2u && status == 5u) {
      r.flushNo = r.flushNo + 1.0;
    }
    if (next == 3u) {
      r.fruitingDays = 0.0;
    }
  }
  sticksOut[i] = r;
}

// 重建 slotMap：先每线程清一个格位，再每根棒原子写回自己的格位
@compute @workgroup_size(256)
fn passRemap(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k < arrayLength(&slotMap)) {
    slotMap[k] = -1;
  }
}

@compute @workgroup_size(256)
fn passRemapWrite(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= sim.total) { return; }
  let slot = i32(sticksOut[i].slotIndex);
  if (slot >= 0) {
    // 加上该棚在全局 slotMap 中的起始偏移
    let offset = i32(houses[u32(sticksOut[i].greenhouseId)].mapOffset);
    slot = slot + offset;
    slotMap[slot] = i32(i);
  }
}

// 第二遍：绿霉相邻传播
@compute @workgroup_size(256)
fn passMold(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= sim.total) { return; }
  var r = sticksOut[i];
  let status = u32(r.status);
  if (status == 6u || status == 7u) { return; }
  let slot = i32(r.slotIndex);
  if (slot < 0) { return; }

  let house = houses[u32(r.greenhouseId)];
  let cols = i32(house.cols);
  let tiers = i32(house.tiers);
  let cap = i32(house.cap);
  let col = slot % cols;
  let tier = (slot / cols) % tiers;
  let row = slot / (cols * tiers);
  let radius = i32(sim.moldRadius);

  var moldNeighbors: f32 = 0.0;
  for (var dr: i32 = -radius; dr <= radius; dr = dr + 1) {
    for (var dt: i32 = -radius; dt <= radius; dt = dt + 1) {
      for (var dc: i32 = -radius; dc <= radius; dc = dc + 1) {
        if (dr == 0 && dt == 0 && dc == 0) { continue; }
        let nr = row + dr;
        let nt = tier + dt;
        let nc = col + dc;
        if (nr < 0 || nt < 0 || nc < 0 || nc >= cols || nt >= tiers) { continue; }
        let nslot = nr * (cols * tiers) + nt * cols + nc;
        if (nslot >= cap) { continue; }
        let nid = slotMap[nslot + i32(house.mapOffset)];
        if (nid >= 0 && u32(sticksOut[nid].status) == 6u) {
          moldNeighbors = moldNeighbors + 1.0;
        }
      }
    }
  }
  if (moldNeighbors < 1.0) { return; }

  let p = min(0.9, sim.moldBaseProb * moldEnvFactor(house.tempC, house.humidity) * moldNeighbors);
  let rnd = hash01(i, sim.daySeed);
  if (rnd < p) {
    r.status = 6.0;
    r.statusDay = 0.0;
    r.moldDay = 0.0;
    sticksOut[i] = r;
  }
}
`
