import { STICK_STRIDE } from '@/domain/record'
import { slotCapacity } from '@/domain/layout'
import { simWgsl } from './wgsl_sim'
import { cullWgsl } from './wgsl_cull'
import { renderWgsl, pickWgsl, staticWgsl } from './wgsl_render'
import { buildCylinder, type Geometry } from './mesh'
import { buildScene, buildGround } from './scene'
import { OrbitCamera, type Mat4 } from './camera'
import type { FarmStore } from '@/data/store'

const PYRAMID_BASE = 512
const PYRAMID_LEVELS = 5
const PICK_W = 4
const PICK_H = 4
const SIM_WG = 256
const CULL_WG = 256

// 与 WGSL FrameUniforms 对齐（mat4 64B + vec3 16B + 5 标量 = 112B）
const FRAME_UNIFORM_SIZE = 112
// SimUniforms: 4u32/f32 前 8 个 = 32B
const SIM_UNIFORM_SIZE = 32
// CullUniforms: 64 + 8 + 8 + 4*4 = 96B
const CULL_UNIFORM_SIZE = 96
const HOUSE_UNIFORM_SIZE = 32

export interface RenderStats {
  visible: number
  total: number
  frameMs: number
  cullMs: number
  mode: 'webgpu' | 'cpu-fallback'
}

export class GpuRenderer {
  canvas: HTMLCanvasElement
  store: FarmStore
  device!: GPUDevice
  context!: GPUCanvasContext
  format!: GPUTextureFormat
  camera = new OrbitCamera()
  supported = false
  stats: RenderStats = { visible: 0, total: 0, frameMs: 0, cullMs: 0, mode: 'cpu-fallback' }
  highlightMode = 0
  filmOccludes = false
  onStats?: (s: RenderStats) => void

  private stickBufA!: GPUBuffer
  private stickBufB!: GPUBuffer
  private slotMapBuf!: GPUBuffer
  private visibleBuf!: GPUBuffer
  private counterBuf!: GPUBuffer
  private indirectBuf!: GPUBuffer
  private selectedBuf!: GPUBuffer
  private frameUniformBuf!: GPUBuffer
  private simUniformBuf!: GPUBuffer
  private cullUniformBuf!: GPUBuffer
  private houseUniformBuf!: GPUBuffer
  private depthTex!: GPUTexture
  private depthView!: GPUTextureView
  private pyramidTex!: GPUTexture
  private pyramidView!: GPUTextureView
  private pickTex!: GPUTexture
  private pickDepth!: GPUTexture
  private pickBuf!: GPUBuffer
  private cylinder!: Geometry
  private renderPipeline!: GPURenderPipeline
  private pickPipeline!: GPURenderPipeline
  private staticPipeline!: GPURenderPipeline
  private simPipeline!: GPUComputePipeline
  private remapPipeline!: GPUComputePipeline
  private moldPipeline!: GPUComputePipeline
  private cullPipeline!: GPUComputePipeline
  private indirectPipeline!: GPUComputePipeline
  private basePyramidPipeline!: GPUComputePipeline
  private reducePipeline!: GPUComputePipeline
  private renderBind!: GPUBindGroup
  private pickBind!: GPUBindGroup
  private cullBind!: GPUBindGroup
  private simBind!: GPUBindGroup
  private staticBind!: GPUBindGroup
  private raf = 0
  private lastT = 0
  private frameIndex = 0
  private simDaySeed = 1

  constructor(canvas: HTMLCanvasElement, store: FarmStore) {
    this.canvas = canvas
    this.store = store
  }

  init = async (): Promise<boolean> => {
    if (!navigator.gpu) return false
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return false
    this.device = await adapter.requestDevice()
    this.device.lost.then((info) => console.warn('GPU device lost:', info.message))
    this.context = this.canvas.getContext('webgpu')!
    this.format = navigator.gpu.getPreferredCanvasFormat()
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' })
    this.supported = true
    this.stats.mode = 'webgpu'
    this.buildPipelines()
    this.uploadAll()
    this.start()
    return true
  }

  private buildPipelines = (): void => {
    const d = this.device
    this.cylinder = buildCylinder()
    const cylBufDesc: GPUVertexBufferLayout[] = [
      {
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      },
    ]
    const renderMod = d.createShaderModule({ code: renderWgsl })
    this.renderPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderMod, entryPoint: 'vsMain', buffers: cylBufDesc },
      fragment: {
        module: renderMod,
        entryPoint: 'fsMain',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth32float',
      },
    })
    const pickMod = d.createShaderModule({ code: pickWgsl })
    this.pickPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pickMod, entryPoint: 'vsPick', buffers: cylBufDesc },
      fragment: {
        module: pickMod,
        entryPoint: 'fsPick',
        targets: [{ format: 'r32uint' }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth32float' },
    })

    const staticMod = d.createShaderModule({ code: staticWgsl })
    this.staticPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: staticMod,
        entryPoint: 'vsStatic',
        buffers: [
          {
            arrayStride: 36,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32x3' },
            ],
          },
        ],
      },
      fragment: { module: staticMod, entryPoint: 'fsStatic', targets: [{ format: this.format }] },
      depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth32float' },
    })

    const simMod = d.createShaderModule({ code: simWgsl })
    this.simPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: simMod, entryPoint: 'passAdvance' },
    })
    this.remapPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: simMod, entryPoint: 'passRemap' },
    })
    this.remapWritePipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: simMod, entryPoint: 'passRemapWrite' },
    })
    this.moldPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: simMod, entryPoint: 'passMold' },
    })
    const cullMod = d.createShaderModule({ code: cullWgsl })
    this.cullPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: cullMod, entryPoint: 'cullMain' },
    })
    this.indirectPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: cullMod, entryPoint: 'writeIndirect' },
    })
    this.basePyramidPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: cullMod, entryPoint: 'buildBase' },
    })
    this.reducePipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: cullMod, entryPoint: 'reduceLevel' },
    })
  }

  private remapWritePipeline!: GPUComputePipeline

  private makeBuf = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer =>
    this.device.createBuffer({ size, usage, label })

  uploadAll = (): void => {
    const d = this.device
    const n = this.store.total
    const bytes = n * STICK_STRIDE
    this.stickBufA = this.makeBuf(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'stickA')
    this.stickBufB = this.makeBuf(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'stickB')
    d.queue.writeBuffer(this.stickBufA, 0, this.store.records.buffer, 0, bytes)
    d.queue.writeBuffer(this.stickBufB, 0, this.store.records.buffer, 0, bytes)

    const mapCap = this.store.greenhouses.reduce((s, h) => s + slotCapacity(h.layout), 0)
    this.slotMapBuf = this.makeBuf(mapCap * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'slotMap')
    this.visibleBuf = this.makeBuf(n * 4, GPUBufferUsage.STORAGE, 'visible')
    this.counterBuf = this.makeBuf(16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, 'counter')
    this.indirectBuf = this.makeBuf(20, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.INDIRECT, 'indirect')
    this.selectedBuf = this.makeBuf(n * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, 'selected')
    this.frameUniformBuf = this.makeBuf(FRAME_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'frameU')
    this.simUniformBuf = this.makeBuf(SIM_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'simU')
    this.cullUniformBuf = this.makeBuf(CULL_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'cullU')
    this.houseUniformBuf = this.makeBuf(40 * HOUSE_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'houseU')
    this.uploadHouseUniforms()
    this.uploadSelected()
    this.uploadSlotMap()
    this.writeIndirectVertexCount()
    this.buildStaticGeometry()
    this.ensureTargets()
    this.buildBindGroups()
  }

  private uploadHouseUniforms = (): void => {
    const data = new Float32Array(40 * 8)
    let offset = 0
    this.store.greenhouses.forEach((h, i) => {
      const o = i * 8
      data[o] = h.id
      data[o + 1] = h.layout.cols
      data[o + 2] = h.layout.tiers
      data[o + 3] = slotCapacity(h.layout)
      data[o + 4] = h.tempC
      data[o + 5] = h.humidity
      data[o + 6] = this.store.settings?.moldBaseProb ?? 0.08
      data[o + 7] = offset
      offset += slotCapacity(h.layout)
    })
    this.device.queue.writeBuffer(this.houseUniformBuf, 0, data)
  }

  private uploadSlotMap = (): void => {
    const merged = new Int32Array(this.slotMapBuf.size / 4)
    let offset = 0
    for (const h of this.store.greenhouses) {
      const map = this.store.getSlotMap(h.id)
      merged.set(map, offset)
      offset += map.length
    }
    this.device.queue.writeBuffer(this.slotMapBuf, 0, merged)
  }

  private writeIndirectVertexCount = (): void => {
    // 索引式 DrawIndirect 五字段：indexCount / instanceCount / firstIndex / baseVertex / firstInstance
    const data = new Uint32Array([this.cylinder.indices.length, 0, 0, 0, 0])
    this.device.queue.writeBuffer(this.indirectBuf, 0, data)
  }

  private buildStaticGeometry = (): void => {
    const scene = buildScene(this.store.greenhouses, this.store.origins)
    const ground = buildGround(1400, 900)
    const pos = [...scene.positions, ...ground.positions]
    const nor = [...scene.normals, ...ground.normals]
    const col: number[] = []
    for (let i = 0; i < scene.positions.length / 3; i++) col.push(...[0.36, 0.4, 0.44])
    for (let i = 0; i < ground.vertexCount; i++) col.push(...[0.26, 0.3, 0.24])
    const idx = [
      ...scene.indices,
      ...[...ground.indices].map((x) => x + scene.positions.length / 3),
    ]
    const vBuf = this.makeBuf(pos.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'staticPos')
    const nBuf = this.makeBuf(nor.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'staticNor')
    const cBuf = this.makeBuf(col.length * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'staticCol')
    const iBuf = this.makeBuf(idx.length * 4, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, 'staticIdx')
    this.device.queue.writeBuffer(vBuf, 0, new Float32Array(pos))
    this.device.queue.writeBuffer(nBuf, 0, new Float32Array(nor))
    this.device.queue.writeBuffer(cBuf, 0, new Float32Array(col))
    this.device.queue.writeBuffer(iBuf, 0, new Uint32Array(idx))

    // 薄膜外壳独立网格：开关打开时写深度，遮挡剔除即可让棚内被挡住的棒不画
    const fvBuf = this.makeBuf(scene.filmPositions.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'filmPos')
    const fnBuf = this.makeBuf(scene.filmNormals.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'filmNor')
    const fiBuf = this.makeBuf(scene.filmIndices.byteLength, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, 'filmIdx')
    const filmVertexCount = scene.filmPositions.length / 3
    const fcBuf = this.makeBuf(filmVertexCount * 3 * 4, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'filmCol')
    const filmColors = new Float32Array(filmVertexCount * 3).fill(0)
    for (let i = 0; i < filmVertexCount; i++) {
      filmColors[i * 3] = 0.72
      filmColors[i * 3 + 1] = 0.82
      filmColors[i * 3 + 2] = 0.88
    }
    this.device.queue.writeBuffer(fvBuf, 0, scene.filmPositions)
    this.device.queue.writeBuffer(fnBuf, 0, scene.filmNormals)
    this.device.queue.writeBuffer(fiBuf, 0, scene.filmIndices)
    this.device.queue.writeBuffer(fcBuf, 0, filmColors)
    this.staticGeometry = {
      vBuf,
      nBuf,
      cBuf,
      iBuf,
      indexCount: idx.length,
      film: { vBuf: fvBuf, nBuf: fnBuf, cBuf: fcBuf, iBuf: fiBuf, indexCount: scene.filmIndices.length },
    }
  }

  private staticGeometry: {
    vBuf: GPUBuffer
    nBuf: GPUBuffer
    cBuf: GPUBuffer
    iBuf: GPUBuffer
    indexCount: number
    film: { vBuf: GPUBuffer; nBuf: GPUBuffer; cBuf: GPUBuffer; iBuf: GPUBuffer; indexCount: number } | null
  } | null = null

  private ensureTargets = (): void => {
    const size = { width: Math.max(1, this.canvas.width), height: Math.max(1, this.canvas.height) }
    this.depthTex?.destroy()
    this.depthTex = this.device.createTexture({
      size,
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    this.depthView = this.depthTex.createView()
    this.pyramidTex?.destroy()
    this.pyramidTex = this.device.createTexture({
      size: { width: PYRAMID_BASE, height: Math.round(PYRAMID_BASE * (size.height / size.width)), depthOrArrayLayers: PYRAMID_LEVELS },
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.pyramidView = this.pyramidTex.createView()
    this.pickTex?.destroy()
    this.pickTex = this.device.createTexture({
      size: { width: size.width, height: size.height },
      format: 'r32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    this.pickBuf?.destroy()
    this.pickBuf = this.makeBuf(PICK_W * PICK_H * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'pickRead')
    this.pickDepth?.destroy()
    this.pickDepth = this.device.createTexture({
      size: { width: size.width, height: size.height },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private buildBindGroups = (): void => {
    const d = this.device
    const cyl = this.cylinder
    const posBuf = this.makeBuf(cyl.positions.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'cylPos')
    const norBuf = this.makeBuf(cyl.normals.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, 'cylNor')
    const idxBuf = this.makeBuf(cyl.indices.byteLength, GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, 'cylIdx')
    d.queue.writeBuffer(posBuf, 0, cyl.positions)
    d.queue.writeBuffer(norBuf, 0, cyl.normals)
    d.queue.writeBuffer(idxBuf, 0, cyl.indices)
    this.cylinderBuffers = { posBuf, norBuf, idxBuf }

    const common = {
      sticks: this.stickBufA,
      visible: this.visibleBuf,
      frame: this.frameUniformBuf,
      selected: this.selectedBuf,
    }
    this.renderBind = d.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: common.sticks } },
        { binding: 1, resource: { buffer: common.visible } },
        { binding: 2, resource: { buffer: common.frame } },
        { binding: 3, resource: { buffer: common.selected } },
      ],
    })
    this.pickBind = d.createBindGroup({
      layout: this.pickPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: common.sticks } },
        { binding: 1, resource: { buffer: common.visible } },
        { binding: 2, resource: { buffer: common.frame } },
        { binding: 3, resource: { buffer: common.selected } },
      ],
    })
    this.cullBind = d.createBindGroup({
      layout: this.cullPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.visibleBuf } },
        { binding: 2, resource: { buffer: this.counterBuf } },
        { binding: 3, resource: { buffer: this.indirectBuf } },
        { binding: 4, resource: this.pyramidView },
        { binding: 5, resource: { buffer: this.cullUniformBuf } },
        { binding: 6, resource: { buffer: this.selectedBuf } },
        { binding: 7, resource: this.depthView },
      ],
    })
    this.simBind = d.createBindGroup({
      layout: this.simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.stickBufB } },
        { binding: 2, resource: { buffer: this.slotMapBuf } },
        { binding: 3, resource: { buffer: this.simUniformBuf } },
        { binding: 4, resource: { buffer: this.houseUniformBuf } },
      ],
    })
    const suBuf = this.makeBuf(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, 'staticU')
    this.staticUniformBuf = suBuf
    this.staticBind = d.createBindGroup({
      layout: this.staticPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: suBuf } }],
    })
  }

  private cylinderBuffers!: { posBuf: GPUBuffer; norBuf: GPUBuffer; idxBuf: GPUBuffer }
  private staticUniformBuf!: GPUBuffer

  // 每帧写 FrameUniforms
  private writeFrameUniform = (vp: Mat4): void => {
    const data = new Float32Array(FRAME_UNIFORM_SIZE / 4)
    data.set(vp, 0)
    const eye = this.camera.eye()
    data[16] = eye[0]
    data[17] = eye[1]
    data[18] = eye[2]
    data[19] = this.canvas.width
    data[20] = this.canvas.height
    data[21] = this.frameIndex
    data[22] = this.highlightMode
    data[23] = Math.min(this.store.selectedIds.length, this.store.total)
    this.device.queue.writeBuffer(this.frameUniformBuf, 0, data)
    const sd = new Float32Array(20)
    sd.set(vp, 0)
    sd[16] = eye[0]
    sd[17] = eye[1]
    sd[18] = eye[2]
    this.device.queue.writeBuffer(this.staticUniformBuf, 0, sd)
  }

  private writeCullUniform = (vp: Mat4): void => {
    const data = new Float32Array(CULL_UNIFORM_SIZE / 4)
    data.set(vp, 0)
    data[16] = PYRAMID_BASE
    data[17] = this.pyramidTex.height
    data[18] = this.canvas.width
    data[19] = this.canvas.height
    data[20] = this.store.total
    data[21] = this.frameIndex
    data[22] = 0
    data[23] = Math.min(this.store.selectedIds.length, this.store.total)
    this.device.queue.writeBuffer(this.cullUniformBuf, 0, data)
  }

  private start = (): void => {
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop)
      if (!this.lastT) this.lastT = t
      const dt = t - this.lastT
      this.lastT = t
      this.frame(t, dt)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private frame = (t: number, dt: number): void => {
    if (!this.supported || !this.store.ready) return
    const d = this.device
    const aspect = this.canvas.width / Math.max(1, this.canvas.height)
    const vp = this.camera.matrix(aspect)
    this.frameIndex++
    const cullStart = performance.now()
    this.writeFrameUniform(vp)
    this.writeCullUniform(vp)

    const encoder = d.createCommandEncoder()
    // 1. 清计数器
    encoder.clearBuffer(this.counterBuf)
    // 2. 用上一帧深度构建金字塔
    this.buildPyramid(encoder)
    // 3. 视锥 + 遮挡剔除，压缩可见 id
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.cullPipeline)
      pass.setBindGroup(0, this.cullBind)
      pass.dispatchWorkgroups(Math.ceil(this.store.total / CULL_WG))
      pass.end()
    }
    // 4. 回填间接绘制 instanceCount
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.indirectPipeline)
      pass.setBindGroup(0, this.cullBind)
      pass.dispatchWorkgroups(1)
      pass.end()
    }
    // 5. 主渲染
    const view = this.context.getCurrentTexture().createView()
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view, clearValue: { r: 0.09, g: 0.11, b: 0.1, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
        depthStencilAttachment: {
          view: this.depthView,
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      })
      // 静态场景先画，写深度供下一帧遮挡剔除
      if (this.staticGeometry) {
        pass.setPipeline(this.staticPipeline)
        pass.setBindGroup(0, this.staticBind)
        pass.setVertexBuffer(0, this.staticGeometry.vBuf)
        pass.setVertexBuffer(1, this.staticGeometry.nBuf)
        pass.setVertexBuffer(2, this.staticGeometry.cBuf)
        pass.setIndexBuffer(this.staticGeometry.iBuf, 'uint32')
        pass.drawIndexed(this.staticGeometry.indexCount)
        // 薄膜外壳：开启后参与深度写入，棚内被膜/架挡住的棒在下一帧被遮挡剔除
        if (this.filmOccludes && this.staticGeometry.film) {
          const f = this.staticGeometry.film
          pass.setVertexBuffer(0, f.vBuf)
          pass.setVertexBuffer(1, f.nBuf)
          pass.setVertexBuffer(2, f.cBuf)
          pass.setIndexBuffer(f.iBuf, 'uint32')
          pass.drawIndexed(f.indexCount)
        }
      }
      // 菌棒间接绘制
      pass.setPipeline(this.renderPipeline)
      pass.setBindGroup(0, this.renderBind)
      pass.setVertexBuffer(0, this.cylinderBuffers.posBuf)
      pass.setVertexBuffer(1, this.cylinderBuffers.norBuf)
      pass.setIndexBuffer(this.cylinderBuffers.idxBuf, 'uint32')
      pass.drawIndexedIndirect(this.indirectBuf, 0)
      pass.end()
    }
    d.queue.submit([encoder.finish()])

    this.stats.frameMs = dt
    this.stats.cullMs = performance.now() - cullStart
    this.stats.total = this.store.total
    // 异步回读可见数，不阻塞帧
    this.readVisibleCount()
    void t
  }

  private buildPyramid = (encoder: GPUCommandEncoder): void => {
    const w = PYRAMID_BASE
    const h = this.pyramidTex.height
    // 基层：上一帧深度降采样
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.basePyramidPipeline)
      pass.setBindGroup(0, this.cullBind)
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8))
      pass.end()
    }
    // 逐级 2x2 取最大深度
    for (let level = 1; level < PYRAMID_LEVELS; level++) {
      // 仅更新 uniform 的 level 字段（CullUniforms 第 22 个 f32，偏移 88B）
      this.device.queue.writeBuffer(this.cullUniformBuf, 88, new Float32Array([level]))
      const lw = Math.max(1, Math.floor(w / 2 ** level))
      const lh = Math.max(1, Math.floor(h / 2 ** level))
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.reducePipeline)
      pass.setBindGroup(0, this.cullBind)
      pass.dispatchWorkgroups(Math.ceil(lw / 8), Math.ceil(lh / 8))
      pass.end()
    }
    // 复位 level 字段，供 cullMain 使用
    this.device.queue.writeBuffer(this.cullUniformBuf, 88, new Float32Array([0]))
  }

  private readVisibleCount = (): void => {
    // 每 12 帧回读一次即可，统计角无需逐帧精确，避免每帧分配 staging 缓冲
    if (this.frameIndex % 12 !== 0) return
    const d = this.device
    const staging = this.makeBuf(16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'visRead')
    const encoder = d.createCommandEncoder()
    encoder.copyBufferToBuffer(this.counterBuf, 0, staging, 0, 16)
    d.queue.submit([encoder.finish()])
    staging.mapAsync(GPUMapMode.READ).then(() => {
      const n = new Uint32Array(staging.getMappedRange())[0]
      this.stats.visible = n
      this.onStats?.(this.stats)
      staging.unmap()
      staging.destroy()
    })
  }

  // GPU 推进一天：两遍状态机/绿霉，回读后同步到 store，目标 50ms 内
  advanceDayGpu = async (): Promise<number> => {
    const d = this.device
    const n = this.store.total
    const simU = new Float32Array(SIM_UNIFORM_SIZE / 4)
    simU[0] = n
    simU[1] = this.simDaySeed++
    simU[2] = this.store.settings?.moldBaseProb ?? 0.08
    simU[3] = this.store.settings?.moldSpreadRadius ?? 1
    simU[4] = Number(this.store.settings?.simulationDay.replaceAll('-', '')) ?? 0
    d.queue.writeBuffer(this.simUniformBuf, 0, simU)
    this.uploadSlotMap()

    const groups = Math.ceil(n / SIM_WG)
    const encoder = d.createCommandEncoder()
    {
      const pass = encoder.beginComputePass()
      pass.setBindGroup(0, this.simBind)
      pass.setPipeline(this.simPipeline)
      pass.dispatchWorkgroups(groups)
      pass.end()
    }
    // 重建 slotMap：先清后写
    {
      const pass = encoder.beginComputePass()
      pass.setBindGroup(0, this.simBind)
      pass.setPipeline(this.remapPipeline)
      pass.dispatchWorkgroups(Math.ceil(this.slotMapBuf.size / 4 / 256))
      pass.end()
    }
    {
      const pass = encoder.beginComputePass()
      pass.setBindGroup(0, this.simBind)
      pass.setPipeline(this.remapWritePipeline)
      pass.dispatchWorkgroups(groups)
      pass.end()
    }
    {
      const pass = encoder.beginComputePass()
      pass.setBindGroup(0, this.simBind)
      pass.setPipeline(this.moldPipeline)
      pass.dispatchWorkgroups(groups)
      pass.end()
    }
    // 回读 B -> 镜像 ArrayBuffer
    const staging = this.makeBuf(n * STICK_STRIDE, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'simRead')
    encoder.copyBufferToBuffer(this.stickBufB, 0, staging, 0, staging.size)
    d.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = new Float32Array(staging.size / 4)
    out.set(new Float32Array(staging.getMappedRange().slice(0)))
    staging.unmap()
    staging.destroy()

    // B 成为当前缓冲，A 复制一份保持双缓冲内容一致
    const tmp = this.stickBufA
    this.stickBufA = this.stickBufB
    this.stickBufB = tmp
    d.queue.writeBuffer(this.stickBufB, 0, out)
    this.store.records = out
    this.rebuildBindsAfterSwap()
    this.store.afterGpuAdvance()
    return out.length
  }

  private rebuildBindsAfterSwap = (): void => {
    const d = this.device
    this.renderBind = d.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.visibleBuf } },
        { binding: 2, resource: { buffer: this.frameUniformBuf } },
        { binding: 3, resource: { buffer: this.selectedBuf } },
      ],
    })
    this.pickBind = d.createBindGroup({
      layout: this.pickPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.visibleBuf } },
        { binding: 2, resource: { buffer: this.frameUniformBuf } },
        { binding: 3, resource: { buffer: this.selectedBuf } },
      ],
    })
    this.cullBind = d.createBindGroup({
      layout: this.cullPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.visibleBuf } },
        { binding: 2, resource: { buffer: this.counterBuf } },
        { binding: 3, resource: { buffer: this.indirectBuf } },
        { binding: 4, resource: this.pyramidView },
        { binding: 5, resource: { buffer: this.cullUniformBuf } },
        { binding: 6, resource: { buffer: this.selectedBuf } },
        { binding: 7, resource: this.depthView },
      ],
    })
    this.simBind = d.createBindGroup({
      layout: this.simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.stickBufA } },
        { binding: 1, resource: { buffer: this.stickBufB } },
        { binding: 2, resource: { buffer: this.slotMapBuf } },
        { binding: 3, resource: { buffer: this.simUniformBuf } },
        { binding: 4, resource: { buffer: this.houseUniformBuf } },
      ],
    })
  }

  uploadSelected = (): void => {
    const ids = new Uint32Array(this.selectedBuf.size / 4)
    this.store.selectedIds.forEach((id, i) => {
      ids[i] = id
    })
    this.device.queue.writeBuffer(this.selectedBuf, 0, ids)
  }

  // 手动改状态/重排后把 store 镜像刷回 GPU，slotMap 与房屋参数一并重建
  syncRecordsToGpu = (): void => {
    const bytes = this.store.total * STICK_STRIDE
    this.device.queue.writeBuffer(this.stickBufA, 0, this.store.records.buffer, 0, bytes)
    this.device.queue.writeBuffer(this.stickBufB, 0, this.store.records.buffer, 0, bytes)
    this.uploadHouseUniforms()
    this.uploadSlotMap()
  }

  resize = (): void => {
    if (!this.supported) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    this.ensureTargets()
    this.rebuildBindsAfterSwap()
  }

  // ID 缓冲拾取：全尺寸离屏渲染一遍 R32Uint，只回读点击点周围 4x4，取中心像素
  pickAt = async (clientX: number, clientY: number): Promise<number> => {
    if (!this.supported) return -1
    const rect = this.canvas.getBoundingClientRect()
    const px = Math.floor(((clientX - rect.left) / rect.width) * this.canvas.width)
    const py = Math.floor(((clientY - rect.top) / rect.height) * this.canvas.height)
    const aspect = this.canvas.width / this.canvas.height
    const vp = this.camera.matrix(aspect)
    this.writeFrameUniform(vp)

    const d = this.device
    const encoder = d.createCommandEncoder()
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.pickTex.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: this.pickDepth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
        },
      })
      pass.setPipeline(this.pickPipeline)
      pass.setBindGroup(0, this.pickBind)
      pass.setVertexBuffer(0, this.cylinderBuffers.posBuf)
      pass.setVertexBuffer(1, this.cylinderBuffers.norBuf)
      pass.setIndexBuffer(this.cylinderBuffers.idxBuf, 'uint32')
      pass.drawIndexedIndirect(this.indirectBuf, 0)
      pass.end()
    }
    // bytesPerRow 必须 256 对齐：每行 64 个 u32 = 256B，只取前 4 个
    const ROW_TEXELS = 64
    const half = Math.floor(PICK_W / 2)
    const ox = Math.max(0, Math.min(this.canvas.width - PICK_W, px - half))
    const oy = Math.max(0, Math.min(this.canvas.height - PICK_H, py - half))
    encoder.copyTextureToBuffer(
      { texture: this.pickTex, origin: { x: ox, y: oy } },
      { buffer: this.pickBuf, bytesPerRow: ROW_TEXELS * 4, rowsPerImage: PICK_H },
      { width: PICK_W, height: PICK_H, depthOrArrayLayers: 1 },
    )
    d.queue.submit([encoder.finish()])
    await this.pickBuf.mapAsync(GPUMapMode.READ)
    const raw = new Uint32Array(this.pickBuf.getMappedRange().slice(0))
    this.pickBuf.unmap()
    const centerX = Math.max(0, px - ox)
    const centerY = Math.max(0, py - oy)
    const id = raw[centerY * ROW_TEXELS + centerX]
    return id > 0 ? id - 1 : -1
  }

  flyToHouse = (houseId: number): void => {
    const o = this.store.origins[houseId]
    if (o) this.camera.flyTo(o.x, o.z)
  }

  setHighlight = (mode: number): void => {
    this.highlightMode = mode
  }

  destroy = (): void => {
    cancelAnimationFrame(this.raf)
  }
}
