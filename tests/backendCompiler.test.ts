// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { compileUserModule } from '../src/backend/compiler'
import { build, type BuildOptions } from 'esbuild'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const compilerLoads = vi.hoisted(() => ({ count: 0 }))
vi.mock('typescript', async () => {
  compilerLoads.count++
  return vi.importActual('typescript')
})

function readText(files: Record<string, string>) {
  return vi.fn(async (file: string) => {
    if (!(file in files)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' })
    return files[file]
  })
}

async function compiledModule(files: Record<string, string>) {
  const result = await compileUserModule('/package/src/provider.ts', { rootPath: '/package', readText: readText(files) })
  const code = await (await fetch(result.url)).text()
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  result.dispose()
  return { module, code, digest: result.sourceDigest }
}

it('loads the optional compiler only after a valid source read and shares it across concurrent compilations', async () => {
  expect(compilerLoads.count).toBe(0)
  await expect(compileUserModule('/package/missing.ts', { readText: readText({}) })).rejects.toThrow('Not found')
  expect(compilerLoads.count).toBe(0)
  const results = await Promise.all(['one', 'two'].map(name => compiledModule({
    '/package/src/provider.ts': `export function register() { return ${JSON.stringify(name)} }`
  })))
  expect(results.map(result => result.module.register())).toEqual(['one', 'two'])
  expect(compilerLoads.count).toBe(1)
})

it('compiles local TypeScript and circular imports without eval or Function constructors', async () => {
  const files = {
    '/package/src/provider.ts': "import { value } from './value'; export const prefix: string = 'local'; export function register(){ return value() }",
    '/package/src/value.ts': "import { prefix } from './provider'; export function value(){ return prefix + '-provider' }"
  }
  const first = await compiledModule(files)
  expect(first.module.register()).toBe('local-provider')
  expect(first.code).not.toMatch(/\beval\(|new Function\(/)
  expect(first.digest).toHaveLength(64)
  const second = await compiledModule({ ...files, '/package/src/value.ts': "export function value(){ return 'changed' }" })
  expect(second.digest).not.toBe(first.digest)
})

it.each(["import '../outside'", "import 'node:fs'", "import name from './missing'; export {name}", "export const load = (name:string)=>import(name)"] )('rejects imports beyond the declared package graph: %s', async (source) => {
  await expect(compileUserModule('/package/provider.ts', { readText: readText({ '/package/provider.ts': source }) })).rejects.toThrow()
})

it('rejects excluded paths before asking the storage broker to read them', async () => {
  const read = readText({})
  await expect(compileUserModule('/package/claude/provider.ts', { rootPath: '/package', readText: read })).rejects.toThrow('outside its package')
  expect(read).not.toHaveBeenCalled()
})

it('packages optional compiler and PDF libraries outside the startup graph while keeping asset bases stable', async () => {
  const root = process.cwd(), outdir = path.join(root, 'runtime')
  const { backendBuildOptions } = await import(pathToFileURL(path.join(root, 'build.mjs')).href) as { backendBuildOptions(root: string, directory: string): BuildOptions }
  const output = await build({ absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, metafile: true, write: false, ...backendBuildOptions(root, outdir) })
  const files = output.metafile!.outputs
  const entry = Object.keys(files).find(file => files[file].entryPoint === 'src/backend/index.ts')!
  expect(entry).toBe('runtime/backend.js')
  const visited = new Set<string>()
  const visit = (file: string): void => {
    if (visited.has(file)) return
    visited.add(file)
    for (const dependency of files[file].imports) if (dependency.kind !== 'dynamic-import' && !dependency.external) visit(dependency.path)
  }
  visit(entry)
  const startupInputs = [...visited].flatMap(file => Object.keys(files[file].inputs))
  expect(startupInputs.some(input => /node_modules\/(typescript|pdfjs-dist)\//.test(input))).toBe(false)
  for (const name of ['typescript', 'pdfjs-dist']) expect(Object.values(files).some(file => Object.keys(file.inputs).some(input => input.includes(`node_modules/${name}/`)))).toBe(true)
  for (const [file, metadata] of Object.entries(files)) {
    if (Object.keys(metadata.inputs).some(input => ['src/backend/attachments/pdfPipeline.ts', 'src/backend/harness/packages.ts'].includes(input))) expect(path.dirname(file)).toBe('runtime')
    for (const dependency of metadata.imports) if (!dependency.external) expect(files[dependency.path]).toBeDefined()
  }
})
