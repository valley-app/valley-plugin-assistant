import type { HarnessCaseDefinition, HarnessCaseResult, HarnessRegisterApi } from '../../../../../harnessTypes'
import { lookupTool, survey } from './fixtures'

const pass = (name: string, passed: boolean, message?: string): HarnessCaseResult => ({
  status: passed ? 'pass' : 'fail',
  score: passed ? 1 : 0,
  assertions: [{ name, passed, ...(message ? { message } : {}) }],
  metrics: {}
})

const cases: HarnessCaseDefinition[] = [
  {
    id: 'streamed-response',
    name: 'Streamed response',
    async run({ complete, settings }) {
      const response = await complete({
        messages: [{ role: 'user', content: `Reply with exactly the survey site: ${survey.site}` }],
        maxTokens: Number(settings.maxTokens ?? 256)
      })
      const textEvents = response.events.filter((event) => event.type === 'text').length
      return {
        status: response.text.includes(survey.site) && textEvents > 0 ? 'pass' : 'fail',
        score: response.text.includes(survey.site) && textEvents > 0 ? 1 : 0,
        assertions: [
          { name: 'contains expected content', passed: response.text.includes(survey.site) },
          { name: 'emits normalized text events', passed: textEvents > 0 }
        ],
        metrics: { text_event_count: textEvents }
      }
    }
  },
  {
    id: 'structured-output',
    name: 'Structured output',
    async run({ complete, settings }) {
      const response = await complete({
        messages: [{ role: 'user', content: `Return JSON with keys site and observations for this survey: ${JSON.stringify(survey)}. No markdown.` }],
        maxTokens: Number(settings.maxTokens ?? 256),
        temperature: 0
      })
      let parsed: unknown
      try { parsed = JSON.parse(response.text) } catch { parsed = null }
      const object = parsed as { site?: unknown; observations?: unknown } | null
      const valid = object?.site === survey.site && object?.observations === survey.observations
      const strict = settings.strictJson !== true || response.text.trim().startsWith('{')
      return {
        status: valid && strict ? 'pass' : 'fail',
        score: Number(valid) * 0.8 + Number(strict) * 0.2,
        assertions: [
          { name: 'valid JSON schema', passed: valid },
          { name: 'contains no wrapper text', passed: strict }
        ],
        metrics: { response_bytes: response.text.length }
      }
    }
  },
  {
    id: 'tool-selection',
    name: 'Tool selection and arguments',
    async run({ complete }) {
      const species = survey.species[0]
      const response = await complete({
        messages: [{ role: 'user', content: `Use the tool to look up ${species}. Do not answer from memory.` }],
        tools: [lookupTool],
        temperature: 0,
        maxTokens: 128
      })
      const call = response.toolCalls[0]
      const selected = call?.name === lookupTool.name
      const argumentsValid = call?.arguments?.species === species
      return {
        status: selected && argumentsValid ? 'pass' : 'fail',
        score: Number(selected) * 0.5 + Number(argumentsValid) * 0.5,
        assertions: [
          { name: 'selects declared tool', passed: selected },
          { name: 'emits valid arguments', passed: argumentsValid }
        ],
        metrics: { tool_call_count: response.toolCalls.length }
      }
    }
  },
  {
    id: 'termination',
    name: 'Termination',
    async run({ complete }) {
      const response = await complete({ messages: [{ role: 'user', content: 'Answer only: complete' }], maxTokens: 32 })
      return pass('emits a terminal finish reason', Boolean(response.finishReason), response.finishReason)
    }
  },
  {
    id: 'error-boundary',
    name: 'Error boundary',
    async run({ complete }) {
      const response = await complete({ messages: [{ role: 'user', content: 'State in one short sentence that no external lookup was requested.' }], maxTokens: 64 })
      return pass('returns a bounded normalized response', response.text.length > 0 && response.text.length < 4096)
    }
  }
]

export function register(api: HarnessRegisterApi) {
  return { id: 'windmill', cases: cases.map((item) => api.case(item)) }
}
