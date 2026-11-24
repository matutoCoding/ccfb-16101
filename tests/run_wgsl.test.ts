// WGSL 静态结构校验：不依赖浏览器，拦截括号失配、重复 let/var、入口点缺失等硬伤
import assert from 'node:assert/strict'
import { commonWgsl } from '../src/gpu/wgsl_common.ts'
import { simWgsl } from '../src/gpu/wgsl_sim.ts'
import { cullWgsl } from '../src/gpu/wgsl_cull.ts'
import { renderWgsl, pickWgsl, staticWgsl } from '../src/gpu/wgsl_render.ts'

let passed = 0
const test = (name: string, fn: () => void) => {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

const stripComments = (src: string): string =>
  src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

const checkBalanced = (src: string) => {
  const s = stripComments(src)
  const pairs: [string, string][] = [
    ['{', '}'],
    ['(', ')'],
    ['[', ']'],
  ]
  for (const [open, close] of pairs) {
    let depth = 0
    for (const ch of s) {
      if (ch === open) depth++
      if (ch === close) depth--
      assert.ok(depth >= 0, `出现多余的闭合符号 ${close}`)
    }
    assert.equal(depth, 0, `${open}${close} 不配平`)
  }
}

const checkNoDuplicateLet = (src: string) => {
  const s = stripComments(src)
  // WGSL 允许嵌套块作用域复用变量名，这里只拦截最典型的手误：
  // 同一函数体内连续两行声明同名变量（即历史上真实出现过的重复 let 写法）
  const fnBodies = [...s.matchAll(/fn\s+[A-Za-z0-9_]+\s*\([^)]*\)[^{]*\{/g)].map((m) => {
    const start = m.index! + m[0].length
    let depth = 1
    let i = start
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === '{') depth++
      if (s[i] === '}') depth--
    }
    return s.slice(start, i)
  })
  for (const body of fnBodies) {
    const decls = [...body.matchAll(/\b(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/g)].map((m) => m[1])
    // 只在没有新作用域边界（{）隔开的连续片段里判重
    let segment: string[] = []
    const flush = () => {
      const seen = new Set<string>()
      for (const name of segment) {
        assert.ok(!seen.has(name), `同一作用域重复声明变量 ${name}`)
        seen.add(name)
      }
      segment = []
    }
    let cursor = 0
    for (const m of body.matchAll(/[{}]/g)) {
      const head = body.slice(cursor, m.index)
      segment.push(...[...head.matchAll(/\b(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/g)].map((x) => x[1]))
      flush()
      cursor = m.index! + 1
    }
    const tail = body.slice(cursor)
    segment.push(...[...tail.matchAll(/\b(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/g)].map((x) => x[1]))
    flush()
    void decls
  }
}

test('common 头括号配平且包含全部共享结构体', () => {
  checkBalanced(commonWgsl)
  for (const name of ['StickRecord', 'SimUniforms', 'HouseUniform', 'FrameUniforms', 'CullUniforms', 'DrawIndirect']) {
    assert.ok(commonWgsl.includes(`struct ${name}`), `缺少结构体 ${name}`)
  }
})

test('模拟着色器四个计算入口齐全', () => {
  checkBalanced(simWgsl)
  checkNoDuplicateLet(simWgsl)
  for (const ep of ['passAdvance', 'passRemap', 'passRemapWrite', 'passMold']) {
    assert.ok(simWgsl.includes(`fn ${ep}`), `缺少入口 ${ep}`)
  }
  // 绿霉必须走相邻格位 + 温湿度因子，不能退化成全局随机
  assert.ok(simWgsl.includes('moldEnvFactor'))
  assert.ok(simWgsl.includes('mapOffset'))
})

test('剔除着色器含视锥、Hi-Z、压缩与间接回填', () => {
  checkBalanced(cullWgsl)
  checkNoDuplicateLet(cullWgsl)
  for (const ep of ['cullMain', 'writeIndirect', 'buildBase', 'reduceLevel']) {
    assert.ok(cullWgsl.includes(`fn ${ep}`), `缺少入口 ${ep}`)
  }
  assert.ok(cullWgsl.includes('inFrustum'))
  assert.ok(cullWgsl.includes('atomicAdd'))
  assert.ok(cullWgsl.includes('drawIndirect') === false) // 间接参数是存储结构，不直接调绘制
})

test('渲染与拾取着色器入口齐全且括号配平', () => {
  for (const [name, src, eps] of [
    ['render', renderWgsl, ['vsMain', 'fsMain']],
    ['pick', pickWgsl, ['vsPick', 'fsPick']],
    ['static', staticWgsl, ['vsStatic', 'fsStatic']],
  ] as const) {
    checkBalanced(src)
    checkNoDuplicateLet(src)
    for (const ep of eps) assert.ok(src.includes(`fn ${ep}`), `${name} 缺少入口 ${ep}`)
  }
  // 拾取必须输出 uint id 且 0 留给背景，保证与档案编号同源
  assert.ok(pickWgsl.includes('-> @location(0) u32'))
  assert.ok(pickWgsl.includes('+ 1u'))
})

test('状态外观覆盖全部 8 种状态', () => {
  // 0 发菌走基底白；1-5 在转色系分支；6 绿霉、7 报废各自独立分支
  for (const i of [1, 6, 7]) {
    assert.ok(renderWgsl.includes(`status == ${i}u`), `渲染着色器未覆盖状态 ${i}`)
  }
  const colorChain = renderWgsl.match(/status == 1u[\s\S]*?status == 5u/)
  assert.ok(colorChain, '转色/催蕾/出菇/养菌/补水应共用斑块分支')
  // 出菇菇体、绿霉泛绿、转色连片三个关键外观特征
  assert.ok(renderWgsl.includes('mushroomDetail'))
  assert.ok(renderWgsl.includes('colorProgress'))
  assert.ok(renderWgsl.includes('moldDay'))
})

console.log(`\n全部 ${passed} 项 WGSL 静态校验通过`)
