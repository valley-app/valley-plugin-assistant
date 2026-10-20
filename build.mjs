import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

export function backendBuildOptions(root, outDir) {
  return {
    outfile: undefined,
    outdir: outDir,
    entryPoints: { backend: path.join(root, 'src/backend/entry.ts') },
    splitting: true,
    chunkNames: 'backend-[name]-[hash]',
    plugins: [{
      name: 'typescript-browser-runtime',
      setup(build) {
        build.onResolve({ filter: /^(?:fs|path|os|crypto|perf_hooks|inspector|source-map-support)$/ }, (args) => {
          if (!/[\\/]node_modules[\\/]typescript[\\/]lib[\\/]typescript\.js$/.test(args.importer)) return
          return { path: args.path, namespace: 'typescript-optional-node' }
        })
        build.onLoad({ filter: /.*/, namespace: 'typescript-optional-node' }, () => ({ contents: 'export {}', loader: 'js' }))
      }
    }]
  }
}

export default async function ({ root, outDir }) {
  const pdfRoot = path.join(root, 'node_modules/pdfjs-dist'), pdfTarget = path.join(outDir, 'assets/pdf')
  await fs.mkdir(pdfTarget, { recursive: true })
  await fs.copyFile(path.join(pdfRoot, 'build/pdf.worker.min.mjs'), path.join(pdfTarget, 'pdf.worker.min.mjs'))
  await fs.copyFile(path.join(pdfRoot, 'LICENSE'), path.join(pdfTarget, 'LICENSE'))
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await fs.cp(path.join(pdfRoot, directory), path.join(pdfTarget, directory), { recursive: true })
  const native = JSON.parse(await fs.readFile(path.join(root, 'vendor/native/manifest.json'), 'utf8'))
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'))
  if (JSON.stringify(config.permissions.process.runtimes) !== JSON.stringify(native.runtimes)) throw new Error('Refresh the native runtime manifest before building')
  for (const artifact of native.artifacts) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(artifact.path) || artifact.path.split('/').some(part => !part || part === '..' || /claude/i.test(part))) throw new Error('Invalid native artifact path')
    const source = path.join(root, 'vendor/native', artifact.path), destination = path.join(outDir, 'assets/native', artifact.path)
    if (!(await fs.lstat(source)).isFile()) throw new Error('Native artifacts must be regular files')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(source)) hash.update(bytes)
    if (hash.digest('hex') !== artifact.sha256) throw new Error(`Native artifact changed: ${artifact.path}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination)
    await fs.chmod(destination, artifact.executable ? 0o755 : 0o644)
  }
  await fs.copyFile(path.join(root, 'vendor/native/manifest.json'), path.join(outDir, 'assets/native/manifest.json'))
  await fs.mkdir(path.join(outDir, 'assets/math'), { recursive: true })
  await fs.copyFile(path.join(root, 'node_modules/katex/LICENSE'), path.join(outDir, 'assets/math/LICENSE'))
  const harnesses = {}
  for (const id of ['jarvis', 'windmill']) {
    const source = path.join(root, 'src/backend/harness/builtins', id)
    const files = {}
    for (const name of (await fs.readdir(path.join(source, 'src'))).filter((name) => name.endsWith('.ts') && !/claude/i.test(name))) files[`src/${name}`] = await fs.readFile(path.join(source, 'src', name), 'utf8')
    harnesses[id] = { manifest: JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')), config: JSON.parse(await fs.readFile(path.join(source, 'config.json'), 'utf8')), files }
  }
  await fs.mkdir(path.join(outDir, 'assets/harnesses'), { recursive: true })
  await fs.writeFile(path.join(outDir, 'assets/harnesses/index.json'), JSON.stringify(harnesses))
  return {
    plugins: [{
      name: 'inline-math-fonts',
      setup(build) {
        build.onLoad({ filter: /[\\/]katex[\\/]dist[\\/]katex\.min\.css$/ }, async ({ path: file }) => {
          let css = await fs.readFile(file, 'utf8')
          for (const match of css.matchAll(/src:([^;}]+)/g)) {
            const font = match[1].match(/url\(([^)]+\.woff2)\)/)?.[1]
            if (!font) throw new Error('Missing KaTeX WOFF2 font')
            const bytes = await fs.readFile(path.join(path.dirname(file), font))
            css = css.replace(match[0], `src:url(data:font/woff2;base64,${bytes.toString('base64')}) format("woff2")`)
          }
          return { contents: css, loader: 'text' }
        })
      }
    }],
    backendOptions: backendBuildOptions(root, outDir)
  }
}
