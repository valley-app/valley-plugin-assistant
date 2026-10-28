// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build, type BuildOptions } from 'esbuild'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const root = path.resolve(import.meta.dirname, '..')
let directory: string

beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), 'assistant-split-probe-')) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

// The backend runs in Valley's guest realm: a module worker without Node globals, where `Worker` is a web worker.
// This realm reproduces that boundary on Node (a module worker receives its messages once its module has run) so the split chunks, the PDF worker and the compiler run as they do in the guest;
// the host serves package files to fetch and installs full DOMMatrix and Uint8Array hex polyfills there; text extraction needs only these minimal forms.
const realm = `
  const { parentPort, Worker: NodeWorker } = require('node:worker_threads');
  const listeners = new Set();
  globalThis.self = globalThis;
  globalThis.onmessage = null;
  globalThis.addEventListener = (type, listener) => { if (type === 'message') listeners.add(listener) };
  globalThis.removeEventListener = (_type, listener) => { listeners.delete(listener) };
  globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
  const deliver = data => { const event = { data }; globalThis.onmessage?.(event); for (const listener of listeners) listener(event) };
  let queued = [];
  globalThis.__started = () => { const pending = queued; queued = null; pending.forEach(deliver) };
  parentPort.on('message', data => { if (queued) queued.push(data); else deliver(data) });
  globalThis.Worker = class extends EventTarget {
    constructor(url) {
      super();
      this.inner = new NodeWorker(globalThis.__realm + 'import(' + JSON.stringify(String(url)) + ').then(() => globalThis.__started(), error => { throw error });', { eval: true });
      this.inner.on('message', data => { const event = new MessageEvent('message', { data }); this.onmessage?.(event); this.dispatchEvent(event) });
      this.inner.on('error', error => { const event = Object.assign(new Event('error'), { message: error.message, error }); this.onerror?.(event); this.dispatchEvent(event) });
    }
    postMessage(data, transfer) { this.inner.postMessage(data, transfer) }
    terminate() { void this.inner.terminate() }
  };
  const networkFetch = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    const url = String(resource?.url ?? resource);
    return url.startsWith('file:') ? new Response(require('node:fs').readFileSync(require('node:url').fileURLToPath(url))) : networkFetch(resource, init);
  };
  Uint8Array.prototype.toHex ??= function () { return Array.from(this, byte => byte.toString(16).padStart(2, '0')).join('') };
  globalThis.DOMMatrix ??= class DOMMatrix { constructor(init) { [this.a, this.b, this.c, this.d, this.e, this.f] = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0] } };
  delete globalThis.process;
`

function inRealm(script: string, input: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`globalThis.__realm = ${JSON.stringify(realm)};${realm}globalThis.__started();(async () => { const input = ${JSON.stringify(input)}; ${script} })().then(value => parentPort.postMessage({ value }), error => parentPort.postMessage({ error: String(error && error.message || error) }))`, { eval: true })
    worker.once('message', message => { void worker.terminate(); resolve(message) })
    worker.once('error', error => { void worker.terminate(); reject(error) })
  })
}

async function splitProbe(name: string, entry: string, prepare?: (runtime: string) => Promise<void>): Promise<string> {
  const runtime = path.join(directory, name, 'runtime')
  const { backendBuildOptions } = await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'build.mjs')).href) as { backendBuildOptions(root: string, outdir: string): BuildOptions }
  await build({ absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, ...backendBuildOptions(root, runtime), entryPoints: { backend: path.join(root, entry) } })
  await prepare?.(runtime)
  return pathToFileURL(path.join(runtime, 'backend.js')).href
}

function syntheticPdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 30 90 Td (Valley synthetic PDF text) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Uint8Array(Buffer.from(pdf))
}

const readPdf = `const module = await import(input.url); const result = await module.readPdf(Uint8Array.from(input.pdf), { mode: 'text' }); return JSON.parse(JSON.stringify(result))`

it('extracts synthetic PDF text through the split PDF pipeline and its packaged PDF worker', async () => {
  const pdfRoot = path.join(root, 'node_modules/pdfjs-dist'), pdf = [...syntheticPdf()]
  const url = await splitProbe('pdf', 'src/backend/attachments/pdfPipeline.ts', async runtime => {
    const assets = path.join(runtime, 'assets/pdf')
    await mkdir(assets, { recursive: true })
    await cp(path.join(pdfRoot, 'build/pdf.worker.min.mjs'), path.join(assets, 'pdf.worker.min.mjs'))
    await cp(path.join(pdfRoot, 'standard_fonts'), path.join(assets, 'standard_fonts'), { recursive: true })
  })
  expect(await inRealm(readPdf, { url, pdf })).toMatchObject({ value: { pageCount: 1, pages: [{ page: 1, method: 'text', text: 'Valley synthetic PDF text' }] } })
  const missingWorker = await splitProbe('pdf-missing-worker', 'src/backend/attachments/pdfPipeline.ts')
  expect(await inRealm(readPdf, { url: missingWorker, pdf })).toMatchObject({ error: expect.stringMatching(/ENOENT|file|module/i) })
}, 30_000)

it('loads the split TypeScript compiler on demand and executes the compiled module', async () => {
  const url = await splitProbe('compiler', 'src/backend/compiler.ts')
  const files = {
    '/package/src/provider.ts': `import {value} from './value'; export function register(): number {return value + 2;}`,
    '/package/src/value.ts': 'export const value: number = 5;'
  }
  expect(await inRealm(`
    const module = await import(input.url);
    const compiled = await module.compileUserModule('/package/src/provider.ts', { rootPath: '/package', readText: async file => { if (!(file in input.files)) throw Object.assign(new Error('Not found'), { code: 'ENOENT' }); return input.files[file] } });
    try {
      const code = await (await fetch(compiled.url)).text();
      const result = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
      return { value: result.register(), digest: compiled.sourceDigest };
    } finally { compiled.dispose() }
  `, { url, files })).toMatchObject({ value: { value: 7, digest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
}, 30_000)
