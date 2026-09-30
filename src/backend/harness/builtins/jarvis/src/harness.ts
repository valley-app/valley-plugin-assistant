import type { HarnessCaseDefinition, HarnessRegisterApi } from '../../../../../harnessTypes'
import { expectedSources, tools } from './environment'

const cases: HarnessCaseDefinition[] = [
  {
    id: 'grounded-synthesis',
    name: 'Grounded synthesis',
    weight: 2,
    async run({ createThread, settings }) {
      const thread = createThread({
        messages: [
          { role: 'system', content: 'Use only the read-only tools. Cite source identifiers. Say when evidence is missing.' },
          { role: 'user', content: 'Summarize the observations at alpine-meadow-a and cite the evidence.' }
        ],
        tools,
        autoTools: true,
        temperature: 0,
        maxTokens: 300
      })
      const response = await thread.run()
      const usedReadOnlyTool = thread.toolCalls().some((call) => tools.some((tool) => tool.definition.name === call.name))
      const grounded = expectedSources.some((source) => response.text.includes(source))
      const concise = settings.answerStyle !== 'concise' || response.text.length <= Number(settings.maxAnswerCharacters ?? 700)
      return {
        status: usedReadOnlyTool && grounded && concise ? 'pass' : 'fail',
        score: (Number(usedReadOnlyTool) + Number(grounded) + Number(concise)) / 3,
        assertions: [
          { name: 'chooses a declared read-only tool', passed: usedReadOnlyTool },
          { name: 'grounds answer in returned source ids', passed: grounded },
          { name: 'respects requested answer density', passed: concise }
        ],
        metrics: { answer_characters: response.text.length, tool_calls: thread.toolCalls().length }
      }
    }
  },
  {
    id: 'uncertainty',
    name: 'Uncertainty handling',
    async run({ createThread }) {
      const thread = createThread({
        messages: [
          { role: 'system', content: 'Use only tool evidence and explicitly state when evidence is unavailable.' },
          { role: 'user', content: 'How many Lynx lynx were recorded at wetland-c?' }
        ],
        tools,
        autoTools: true,
        temperature: 0,
        maxTokens: 160
      })
      const response = await thread.run()
      const admitsUnknown = /no (?:evidence|observation|record|data)|unknown|cannot determine|not available/i.test(response.text)
      return {
        status: admitsUnknown ? 'pass' : 'fail',
        score: admitsUnknown ? 1 : 0,
        assertions: [{ name: 'does not invent missing evidence', passed: admitsUnknown }],
        metrics: { answer_characters: response.text.length }
      }
    }
  },
  {
    id: 'instruction-following',
    name: 'Instruction following',
    async run({ complete, settings }) {
      const response = await complete({
        messages: [{ role: 'user', content: 'Answer with exactly three words describing a biodiversity survey.' }],
        temperature: 0,
        maxTokens: 32
      })
      const words = response.text.trim().split(/\s+/).filter(Boolean).length
      const withinLimit = response.text.length <= Number(settings.maxAnswerCharacters ?? 700)
      return {
        status: words === 3 && withinLimit ? 'pass' : 'fail',
        score: Number(words === 3) * 0.8 + Number(withinLimit) * 0.2,
        assertions: [
          { name: 'returns exactly three words', passed: words === 3 },
          { name: 'stays concise', passed: withinLimit }
        ],
        metrics: { word_count: words }
      }
    }
  }
]

export function register(api: HarnessRegisterApi) {
  return { id: 'jarvis', cases: cases.map((item) => api.case(item)) }
}
