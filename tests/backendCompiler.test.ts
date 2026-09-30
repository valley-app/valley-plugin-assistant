// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { compileUserModule } from '../src/backend/compiler'

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
