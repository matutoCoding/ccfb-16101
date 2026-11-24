import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const outFile = 'node_modules/.cache/bench.mjs'
await build({
  entryPoints: ['tests/bench.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: outFile,
  logLevel: 'silent',
})
const mod = await import(pathToFileURL(outFile).href)
mod.run()
