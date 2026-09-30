import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const buildDirectory = path.dirname(fileURLToPath(import.meta.url))
const upstream = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the extracted pinned DeepSeek source directory')
const plugin = path.resolve(buildDirectory, '../../..')
const packages = new Map()
const directories = (relative) => fs.readdirSync(path.join(upstream, relative), { withFileTypes: true }).filter(entry => entry.isDirectory() && !/claude/i.test(entry.name)).map(entry => path.join(relative, entry.name))
const locations = [...directories('vendor'), ...directories('packages').flatMap(directories), 'native/system']
for (const relative of locations) {
  const location = path.join(upstream, relative, 'package.json')
  if (!fs.existsSync(location)) continue
  const manifest = JSON.parse(fs.readFileSync(location, 'utf8'))
  packages.set(manifest.name, { directory: path.dirname(location), manifest })
}

const external = new Set()
const result = await build({ entryPoints: [path.join(plugin, 'vendor/native/deepseek/entry.ts')], outfile: path.join(plugin, 'vendor/native/deepseek/runtime.mjs'), platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true, sourcemap: false,
  banner: { js: "import { createRequire as valleyCreateRequire } from 'node:module'; const require = valleyCreateRequire(import.meta.url);" },
  plugins: [{ name: 'pinned-upstream-sources', setup(build) {
    build.onLoad({ filter: /[\\/]llm[\\/]src[\\/]attribution\.ts$/ }, args => ({ contents: fs.readFileSync(args.path,'utf8').replace(/createRequire\(import\.meta\.url\)\(['"]\.\.\/package\.json['"]\)/, JSON.stringify({ version: packages.get('@deepseek-ai/dsh-llm').manifest.version })), loader:'ts' }))
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.resolved || args.path.startsWith('node:')) return
      const name = args.path.startsWith('@') ? args.path.split('/').slice(0,2).join('/') : args.path.split('/')[0]
      const entry = packages.get(name)
      if (!entry) { external.add(name); return build.resolve(args.path, { resolveDir: buildDirectory, kind: args.kind, pluginData: { resolved: true } }) }
      const sub = args.path.slice(name.length), key = sub ? '.' + sub : '.'
      let exported = entry.manifest.exports?.[key]
      if (!exported && key.startsWith('./src/')) exported = key
      if (typeof exported === 'object') exported = exported.default ?? exported.import
      let relative = exported ?? (sub ? '.' + sub : entry.manifest.main ?? './lib/index.js')
      if (typeof relative !== 'string') throw new Error('Unsupported package export '+args.path)
      relative = relative.replace(/^\.\/lib\/types\//,'./src/').replace(/^\.\/lib\//,'./src/').replace(/\.m?js$/,'.ts')
      const file = path.resolve(entry.directory, relative)
      if (/claude/i.test(file)) throw new Error('Excluded upstream integration')
      if (!fs.existsSync(file)) throw new Error('Missing source for '+args.path+': '+file)
      return { path: file }
    })
  } }]
})
fs.writeFileSync(path.join(buildDirectory, 'metafile.json'), JSON.stringify(result.metafile,null,2)+'\n')
fs.writeFileSync(path.join(buildDirectory, 'external.json'),JSON.stringify([...external].sort(),null,2)+'\n')
