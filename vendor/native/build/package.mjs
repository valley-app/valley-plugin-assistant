import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.resolve(native, '../..')
const common = ['licenses/DeepSeek-LICENSE', 'licenses/DeepSeek-DEPENDENCIES.txt', 'node/provenance.json', 'build/deepseek-dependencies.json']
const executables = ['deepseek/launch.sh', ...['arm64', 'x64'].map(arch => `node/${arch}/node`)]
const paths = [...common, ...executables, 'deepseek/runtime.mjs', ...['arm64', 'x64'].map(arch => `node/${arch}/LICENSE`)]
const artifacts = []
for (const name of paths) {
  const file = path.join(native, name), stat = await fs.lstat(file)
  if (!stat.isFile()) throw new Error(`Expected a regular native artifact: ${name}`)
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  artifacts.push({ path: name, sha256: digest.digest('hex'), bytes: stat.size, executable: executables.includes(name) })
}
const record = name => {
  const artifact = artifacts.find(artifact => artifact.path === name)
  return { path: `runtime/assets/native/${name}`, sha256: artifact.sha256 }
}
const runtimes = ['arm64', 'x64'].map(arch => {
  const executable = record('deepseek/launch.sh')
  const dependencies = ['deepseek/runtime.mjs', `node/${arch}/node`, `node/${arch}/LICENSE`]
  return { id: 'deepseek', platform: 'darwin', arch, executable: executable.path, sha256: executable.sha256, artifacts: [...dependencies, ...common].map(record) }
})
await fs.writeFile(path.join(native, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sources: { deepseek: { url: 'https://github.com/deepseek-ai/deepseek-harness', revision: '477b4f420553e8a52c2fbccc464d7561b239c443', interface: 'SDK stdio' } }, artifacts, runtimes }, null, 2) + '\n')
const configPath = path.join(plugin, 'config.json'), config = JSON.parse(await fs.readFile(configPath, 'utf8'))
config.permissions.process.runtimes = runtimes
await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
console.log(`Verified ${artifacts.length} native artifacts (${artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)} bytes)`)
