import http from 'node:http'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && ['/v1/models', '/api/tags'].includes(request.url)) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ models: [{ name: 'assistant-ui-fixture', model: 'assistant-ui-fixture' }], object: 'list', data: [{ id: 'assistant-ui-fixture', object: 'model', owned_by: 'local-fixture' }] }))
    return
  }
  if (request.method !== 'POST' || !['/v1/chat/completions', '/api/chat'].includes(request.url)) { response.writeHead(404).end(); return }
  let data = ''
  for await (const chunk of request) { data += chunk; if (data.length > 4 * 1024 * 1024) { response.writeHead(413).end(); return } }
  const body = JSON.parse(data)
  const messages = body.messages ?? []
  const last = messages.findLast(message => message.role === 'user')
  const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
  console.log(JSON.stringify({ event: 'request', scenario: prompt.slice(0, 100), model: body.model }))
  if (/fixture error/i.test(prompt)) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Fixture provider unavailable. Try again.', type: 'fixture_error' } })); return }
  const ollama = request.url === '/api/chat'
  response.writeHead(200, { 'content-type': ollama ? 'application/x-ndjson' : 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (delta, finish_reason = null) => ollama ? response.write(JSON.stringify({ model: body.model, message: { role: 'assistant', ...delta, ...(delta.tool_calls ? { tool_calls: delta.tool_calls.map(call => ({ function: { name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) } : {}) }, done: !!finish_reason }) + '\n') : response.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  if (/fixture slow/i.test(prompt)) await sleep(20000)
  const lastUserIndex = messages.lastIndexOf(last)
  const hasResult = messages.slice(lastUserIndex + 1).some(message => message.role === 'tool')
  if (/fixture (tool|approval)/i.test(prompt) && !hasResult) {
    const write = /fixture approval/i.test(prompt)
    const desired = write ? 'write_note' : 'list_dir'
    const tool = body.tools?.find(tool => tool.function?.name === desired)
    if (tool) {
      const args = write ? { path: 'Assistant UI fixture.md', content: '# Moss\n\nA synthetic visual test.' } : { path: 'fileTypes' }
      send({ tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function', function: { name: desired, arguments: JSON.stringify(args) } }] })
      send({}, 'tool_calls'); response.end(ollama ? '' : 'data: [DONE]\n\n'); return
    }
  }
  const output = /fixture markdown/i.test(prompt) ? '# Plant observations\n\nMosses and ferns thrive in shaded habitats.\n\n- **Moss:** retains moisture.\n- **Fern:** reproduces through spores.\n\n| Plant | Habitat |\n| --- | --- |\n| Moss | Damp rock |\n| Fern | Forest floor |\n\n```python\nplants = ["moss", "fern"]\nfor plant in plants:\n    print(plant)\n```\n\n[Botanical reference](https://example.org/plants)\n\n' + 'A shaded habitat supports a diverse plant community.\n\n'.repeat(12)
    : /moss only/i.test(prompt) ? 'Moss only: the completed inventory is preserved. The plan now focuses on moss.'
    : hasResult ? 'The tool finished. Its result is available in the activity group.'
    : 'Ready. This is a deterministic streamed response from the local visual-test provider.'
  for (const token of output.match(/.{1,12}|\n/g) ?? []) { if (response.destroyed) return; send({ content: token }); await sleep(45) }
  send({}, 'stop'); response.end(ollama ? '' : 'data: [DONE]\n\n')
})
server.listen(Number(process.env.ASSISTANT_FIXTURE_PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}/v1` })))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
