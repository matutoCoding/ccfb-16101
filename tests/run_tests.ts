// 测试入口：用 esbuild 把 TS（含 enum）转译为 ESM 后再执行
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const outFile = 'node_modules/.cache/test-bundle.mjs'
await build({
  entryPoints: ['tests/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
})
try {
  await import(pathToFileURL(outFile).href)
} finally {
  rmSync(outFile, { force: true })
  void writeFileSync
}
