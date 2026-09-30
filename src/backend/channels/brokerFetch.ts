import type { PluginFetchRequest } from '@valley/plugin-sdk/pluginNetwork'
import { backendApi } from '../runtime'

interface BrokerRequest extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>
  credential?: PluginFetchRequest['credential']
  stream?: boolean
}

function base64(bytes: Uint8Array): string {
  let value = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return btoa(value)
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

export async function brokerFetch(url: string, input: BrokerRequest = {}): Promise<Response> {
  const network = backendApi().network
  const requestId = crypto.randomUUID()
  const signal = input.signal
  signal?.throwIfAborted()
  const encoded = new Request(url, { method: input.method ?? 'GET', headers: input.headers, body: input.body })
  const request: PluginFetchRequest & { requestId: string } = {
    url, requestId, method: encoded.method as PluginFetchRequest['method'],
    headers: Object.fromEntries(encoded.headers), credential: input.credential,
    timeoutMs: input.stream ? 900_000 : 30_000,
    ...(input.body === undefined || input.body === null ? {} : { bodyBase64: base64(new Uint8Array(await encoded.arrayBuffer())) })
  }
  let cancelling: Promise<void> | undefined
  const cancel = (): Promise<void> => cancelling ??= network.cancel(requestId).then(() => undefined)
  const abort = (): void => { void cancel().catch(() => undefined) }
  signal?.throwIfAborted()
  signal?.addEventListener('abort', abort, { once: true })
  const cleanup = (): void => signal?.removeEventListener('abort', abort)
  try {
    if (!input.stream) {
      const response = await network.fetch(request)
      signal?.throwIfAborted()
      return new Response([101, 103, 204, 205, 304].includes(response.status) ? null : decode(response.bodyBase64), { status: response.status, headers: response.headers })
    }
    const response = await network.fetchStream(request)
    if (signal?.aborted) { await cancel(); signal.throwIfAborted() }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal?.throwIfAborted()
          const chunk = await network.readStream(response.streamId, { maxBytes: 64 * 1024 })
          signal?.throwIfAborted()
          if (chunk.bodyBase64) controller.enqueue(decode(chunk.bodyBase64))
          if (chunk.done) { cleanup(); controller.close() }
        } catch (error) { cleanup(); await cancel().catch(() => undefined); controller.error(error) }
      },
      async cancel() { cleanup(); await cancel() }
    })
    return new Response(body, { status: response.status, headers: response.headers })
  } catch (error) { cleanup(); await cancel().catch(() => undefined); throw error }
  finally { if (!input.stream) cleanup() }
}
