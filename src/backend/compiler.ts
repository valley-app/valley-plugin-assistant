import { t } from './runtime'
import type ts from 'typescript'
import path from 'path-browserify'

interface CompilerOptions {
  readText(path: string): Promise<string>
  rootPath?: string
  sdkModules?: Record<string, string>
}

export async function compileUserModule(entryPath: string, options: CompilerOptions): Promise<{ url: string; sourceDigest: string; dispose(): void }> {
  const root = path.resolve(options.rootPath ?? path.dirname(entryPath))
  const entry = path.resolve(entryPath)
  const modules = new Map<string, { code: string; dependencies: Record<string, string> }>()
  const sources = new Map<string, string>()
  const names = new Set<string>(['register', 'provider'])
  let size = 0
  const contained = (file: string): string => {
    const normalized = path.resolve(file)
    if (!normalized.startsWith(root + '/') || normalized.split('/').some((part) => /claude/i.test(part))) throw new Error(t('assistant.backend.moduleOutside'))
    return normalized
  }
  const read = async (file: string): Promise<string> => {
    file = contained(file)
    if (sources.has(file)) return sources.get(file)!
    const source = await options.readText(file)
    if (source.length > 2 * 1024 * 1024 || size + source.length > 16 * 1024 * 1024) throw new Error(t('assistant.backend.moduleSize'))
    size += source.length
    sources.set(file, source)
    return source
  }
  const resolve = async (specifier: string, importer: string): Promise<string> => {
    if (Object.hasOwn(options.sdkModules ?? {}, specifier)) return `sdk:${specifier}`
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(t('assistant.backend.moduleImport', { value: specifier }))
    const base = contained(path.resolve(path.dirname(importer), specifier))
    const candidates = /\.(ts|tsx|js|mjs|json)$/.test(base) ? [base] : [base + '.ts', base + '.tsx', base + '.js', base + '.mjs', base + '.json', path.join(base, 'index.ts'), path.join(base, 'index.js')]
    for (const file of candidates) {
      try { await read(file); return file } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT' && !/does not exist|not found/i.test(String(error))) throw error
      }
    }
    throw new Error(t('assistant.backend.moduleMissing', { value: specifier }))
  }
  const visit = async (file: string): Promise<void> => {
    if (modules.has(file)) return
    if (modules.size >= 128) throw new Error(t('assistant.backend.moduleCount'))
    const source = await read(file)
    const ts = (await import('typescript')).default
    const output = file.endsWith('.json') ? { outputText: `module.exports=${JSON.stringify(JSON.parse(source))};`, diagnostics: [] } : ts.transpileModule(source, {
      fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, isolatedModules: true }
    })
    const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    if (errors?.length) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
    const module = { code: output.outputText, dependencies: {} as Record<string, string> }
    modules.set(file, module)
    const tree = ts.createSourceFile(file + '.js', module.code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
    const imports = new Set<string>()
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) throw new Error(t('assistant.backend.moduleLiteral'))
        imports.add(node.arguments[0].text)
      }
      if (file === entry && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'exports') names.add(node.name.text)
      if (file === entry && ts.isCallExpression(node) && node.expression.getText(tree) === 'Object.defineProperty' && node.arguments[0]?.getText(tree) === 'exports' && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) names.add(node.arguments[1].text)
      ts.forEachChild(node, scan)
    }
    scan(tree)
    for (const specifier of imports) {
      const dependency = await resolve(specifier, file)
      module.dependencies[specifier] = dependency
      if (!dependency.startsWith('sdk:')) await visit(dependency)
    }
  }
  await visit(entry)
  const sdk = Object.entries(options.sdkModules ?? {})
  const imported = sdk.map(([, url], index) => `import * as sdk${index} from ${JSON.stringify(url)};`).join('\n')
  const factories = [...modules].map(([file, value]) => `${JSON.stringify(file)}:(module,exports,require)=>{\n${value.code}\n}`).join(',\n')
  const mappings = Object.fromEntries([...modules].map(([file, value]) => [file, value.dependencies]))
  const exports = [...names].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !['default', '__esModule'].includes(name)).map((name) => `export const ${name}=result[${JSON.stringify(name)}];`).join('\n')
  const code = `${imported}\nconst sdk={${sdk.map(([name], index) => `${JSON.stringify('sdk:' + name)}:sdk${index}`).join(',')}};
const factories={${factories}};const dependencies=${JSON.stringify(mappings)};const cache=Object.create(null);
function load(id){if(Object.hasOwn(sdk,id))return sdk[id];if(Object.hasOwn(cache,id))return cache[id].exports;if(!Object.hasOwn(factories,id))throw Error(${JSON.stringify(t('assistant.backend.unknownModule'))});const module={exports:{}};cache[id]=module;factories[id](module,module.exports,specifier=>{if(!Object.hasOwn(dependencies[id],specifier))throw Error(${JSON.stringify(t('assistant.backend.unknownImport'))});return load(dependencies[id][specifier])});return module.exports}
const result=load(${JSON.stringify(entry)});${exports}\nexport default result.default??result;`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...sources].sort(([a], [b]) => a.localeCompare(b)).map(([file, source]) => file + '\0' + source).join('\0')))
  const sourceDigest = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  return { url, sourceDigest, dispose: () => URL.revokeObjectURL(url) }
}
