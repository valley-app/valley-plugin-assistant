import { describe, expect, it } from 'vitest'
import { createMockValleyApi } from './mock'
import { buildTools, type InAppSurface, type ToolRunResult } from '../src/agent/tools'
import {
  answerChoices,
  isMultiAnswer,
  isTrueFalse,
  matchesFilter,
  parseAnswerLetter,
  parseOptions,
  parseProblems,
  parseSolutionImages,
  pickProblem,
  sessionFor,
  toProblem
} from '../src/quiz'
import type { IndexEntry } from '@valley/plugin-sdk/types'

const tool = (api: ReturnType<typeof createMockValleyApi>['api'], name: string) => buildTools(api).find((t) => t.name === name)!

/** A tool answers `string | ToolRunResult`; these assertions read the text half. */
const text = (res: string | ToolRunResult): string => (typeof res === 'string' ? res : res.text)

const mcRecord = {
  id: 'p_mc',
  subject: 'fungi-survey',
  title: 'Canopy symbiosis',
  problemText:
    'Die Population $P(t)$ folgt einem saisonalen Muster. Welche Aussage stimmt?\n\n(A) Falsch eins.\n(B) Richtig zwei.\n(C) Falsch drei.\n(D) Falsch vier.',
  images: ['Meadow/img/q_mc.jpg'],
  notes: '**B ist richtig.**\n- Beobachtung aus dem Wald.',
  difficulty: 4,
  tags: []
}

const freeRecord = {
  id: 'p_free',
  subject: 'fungi-survey',
  title: 'Spore dispersal',
  problemText: 'Berechne die mittlere Sporenrate $dz$.',
  images: ['Meadow/img/q_free.jpg'],
  notes: '**$dz=\\frac{4}{x}dx$.**\n- Das Modell beschreibt Pilzwachstum.\n\nSiehe ![[Pilzdiagramm_x.jpg]] für Details.',
  difficulty: 5,
  tags: []
}

const trueFalseRecord = {
  id: 'p_tf',
  subject: 'fungi-survey',
  title: 'Mycelium boundary',
  problemText: 'Das Gebiet $D$ enthält ein zusammenhängendes Myzel.\n\nDiese Behauptung ist wahr oder falsch?',
  images: ['Meadow/img/q_tf.jpg'],
  notes: 'Falsch — die Kolonien sind getrennt.',
  difficulty: 3,
  tags: []
}

const jsonl = [JSON.stringify(mcRecord), '', '{ broken json', JSON.stringify(freeRecord)].join('\n')

describe('quiz pure helpers', () => {
  it('parses (A)–(D) options without mistaking LaTeX (t) for a marker', () => {
    const opts = parseOptions(mcRecord.problemText)
    expect(opts.map((o) => o.letter)).toEqual(['A', 'B', 'C', 'D'])
    expect(opts[1].text).toBe('Richtig zwei.')
  })

  it('returns no options for a free-text problem', () => {
    expect(parseOptions(freeRecord.problemText)).toEqual([])
  })

  it('detects a true/false claim', () => {
    expect(isTrueFalse(trueFalseRecord.problemText)).toBe(true)
    expect(isTrueFalse(freeRecord.problemText)).toBe(false)
  })

  it('derives answer choices only for genuine choice questions, else [] (type)', () => {
    // Parsed options → letters; single true/false → Wahr/Falsch.
    expect(answerChoices(toProblem(mcRecord)).map((c) => c.value)).toEqual(['A', 'B', 'C', 'D'])
    expect(answerChoices(toProblem(trueFalseRecord)).map((c) => c.value)).toEqual(['Wahr', 'Falsch'])
    // Free-input (no options, no TF, no answer letter) → no buttons, must type.
    expect(answerChoices(toProblem(freeRecord))).toEqual([])
    // A single-choice whose answer is one letter but options live only in the image → A–D.
    const imgOnlyMc = { ...freeRecord, id: 'p_imgmc', problemText: 'Welche Aussage stimmt?', notes: '**C ist richtig.**\n- weil …' }
    expect(answerChoices(toProblem(imgOnlyMc)).map((c) => c.value)).toEqual(['A', 'B', 'C', 'D'])
    // A multi-statement grid (notes list several answers) → no buttons, must type.
    const multi = { ...freeRecord, id: 'p_multi', notes: '**Wahr/Falsch: wahr, falsch, falsch.**\n- …' }
    expect(answerChoices(toProblem(multi))).toEqual([])
  })

  it('flags a multi-answer / multi-statement notes block', () => {
    expect(isMultiAnswer('**Wahr/Falsch: wahr, falsch, falsch.**')).toBe(true)
    expect(isMultiAnswer('falsch, wahr, falsch')).toBe(true)
    expect(isMultiAnswer('**B ist richtig.**')).toBe(false)
    expect(isMultiAnswer('**Falsch.** Für eine Kugel …')).toBe(false)
  })

  it('reads the bolded correct-answer letter, else null', () => {
    expect(parseAnswerLetter(mcRecord.notes)).toBe('B')
    expect(parseAnswerLetter(freeRecord.notes)).toBeNull()
  })

  it('extracts solution-image embeds by basename', () => {
    expect(parseSolutionImages(freeRecord.notes)).toEqual(['Pilzdiagramm_x.jpg'])
    expect(parseSolutionImages('no embeds here')).toEqual([])
  })

  it('normalizes a record into a QuizProblem', () => {
    const p = toProblem(mcRecord)
    expect(p).toMatchObject({ id: 'p_mc', answerLetter: 'B', subject: 'fungi-survey' })
    expect(p.options).toHaveLength(4)
  })

  it('parses a jsonl file, skipping blank and malformed lines', () => {
    const problems = parseProblems(jsonl)
    expect(problems.map((p) => p.id)).toEqual(['p_mc', 'p_free'])
  })

  it('filters by multiple-choice and subject', () => {
    const [mc, free] = parseProblems(jsonl)
    expect(matchesFilter(free, { multipleChoiceOnly: true })).toBe(false)
    expect(matchesFilter(mc, { multipleChoiceOnly: true })).toBe(true)
    expect(matchesFilter(mc, { subject: 'fungi' })).toBe(true)
    expect(matchesFilter(mc, { subject: 'plants' })).toBe(false)
  })

  it('picks unserved problems and returns null when exhausted', () => {
    const problems = parseProblems(jsonl)
    const served = new Set<string>()
    const first = pickProblem(problems, served, {}, () => 0)
    served.add(first!.id)
    const second = pickProblem(problems, served, {}, () => 0)
    expect(second!.id).not.toBe(first!.id)
    served.add(second!.id)
    expect(pickProblem(problems, served, {}, () => 0)).toBeNull()
  })

  it('resets a session on a new source or explicit reset', () => {
    const { api } = createMockValleyApi()
    const a = sessionFor(api, 'k', 'src1')
    a.add('x')
    expect(sessionFor(api, 'k', 'src1').has('x')).toBe(true)
    expect(sessionFor(api, 'k', 'src2').has('x')).toBe(false) // new source → fresh
    sessionFor(api, 'k', 'src2').add('y')
    expect(sessionFor(api, 'k', 'src2', true).has('y')).toBe(false) // explicit reset
  })
})

describe('quiz tools', () => {
  const source = 'Fungi/FungiSurvey/listli.jsonl'
  const mockInApp = (): InAppSurface & { posted: string[]; quizzed: { source: string; choices: { value: string }[]; imagePath?: string }[] } => {
    const posted: string[] = []
    const quizzed: { source: string; choices: { value: string }[]; imagePath?: string }[] = []
    return {
      posted,
      quizzed,
      postImage: (p) => posted.push(p),
      setQuiz: (s, choices, imagePath) => quizzed.push({ source: s, choices, imagePath })
    }
  }
  const channelOpts = { channel: { channelId: 'c1', chatRef: '123' } }
  const indexEntries: IndexEntry[] = [{ relPath: 'Pilzdiagramm_x.jpg', title: 'Pilzdiagramm_x', kind: 'asset', mtimeMs: 0 }]

  it('serves a question: sends the image FIRST, then answer buttons, and returns the private answer', async () => {
    const { api, driverCalls } = createMockValleyApi({ files: { [source]: jsonl } })
    const res = text(await tool(api, 'quiz_next').run({ source, multipleChoiceOnly: true }, channelOpts))

    const photoIdx = driverCalls.findIndex((c) => c.method === 'sendAttachment')
    const buttonsIdx = driverCalls.findIndex((c) => c.method === 'sendButtons')
    expect(driverCalls[photoIdx]?.payload).toMatchObject({ channelId: 'c1', chatRef: '123', path: 'Meadow/img/q_mc.jpg' })
    // Image must be sent before the options (the user requirement).
    expect(photoIdx).toBeGreaterThanOrEqual(0)
    expect(buttonsIdx).toBeGreaterThan(photoIdx)
    expect((driverCalls[buttonsIdx]?.payload as { buttons: { value: string }[] }).buttons.map((b) => b.value)).toEqual(['qz:A', 'qz:B', 'qz:C', 'qz:D'])

    expect(res).toContain('CORRECT ANSWER')
    expect(res).toContain('B')
    expect(res).toContain('multiple-choice')
  })

  it('dedups across calls and reports completion, then resets', async () => {
    const { api } = createMockValleyApi({ files: { [source]: jsonl } })
    const t = tool(api, 'quiz_next')
    const first = text(await t.run({ source }, channelOpts))
    const second = text(await t.run({ source }, channelOpts))
    // Two distinct problems were served (briefs name different ids).
    expect(first.includes('p_mc')).not.toBe(second.includes('p_mc'))
    const third = text(await t.run({ source }, channelOpts))
    expect(third.toLowerCase()).toContain('complete')
    const restart = text(await t.run({ source, reset: true }, channelOpts))
    expect(restart.toLowerCase()).not.toContain('complete')
  })

  it('shows the image but NO buttons for a free-input question (the user types)', async () => {
    const freeOnly = JSON.stringify(freeRecord)
    const { api, driverCalls } = createMockValleyApi({ files: { [source]: freeOnly } })
    const inApp = mockInApp()
    const res = text(await tool(api, 'quiz_next').run({ source }, { ...channelOpts, inApp }))

    // No answer buttons over the channel, and the in-app answer prompt is NOT armed.
    expect(driverCalls.some((c) => c.method === 'sendButtons')).toBe(false)
    expect(inApp.quizzed).toHaveLength(0)
    // The question image still shows inline.
    expect(inApp.posted).toEqual(['Meadow/img/q_free.jpg'])
    expect(res.toUpperCase()).toContain('FREE-INPUT')
  })

  it('serves a true/false claim with Wahr/Falsch buttons', async () => {
    const { api, driverCalls } = createMockValleyApi({ files: { [source]: JSON.stringify(trueFalseRecord) } })
    const inApp = mockInApp()
    await tool(api, 'quiz_next').run({ source }, { ...channelOpts, inApp })
    const buttons = (driverCalls.find((c) => c.method === 'sendButtons')?.payload as { buttons: { value: string }[] }).buttons
    expect(buttons.map((b) => b.value)).toEqual(['qz:Wahr', 'qz:Falsch'])
    expect(inApp.quizzed[0].choices.map((c) => c.value)).toEqual(['Wahr', 'Falsch'])
  })

  it('arms the in-app surface even with no channel (native chat / mirror)', async () => {
    // Use the MC record so the choice prompt is deterministically armed.
    const { api, driverCalls } = createMockValleyApi({ files: { [source]: JSON.stringify(mcRecord) } })
    const inApp = mockInApp()
    await tool(api, 'quiz_next').run({ source }, { inApp })
    // No channel → no remote sends, but the inline image + prompt are armed.
    expect(driverCalls.some((c) => c.method === 'sendButtons')).toBe(false)
    expect(inApp.posted.length).toBeGreaterThan(0)
    expect(inApp.quizzed).toHaveLength(1)
  })

  it('send_attachment shows an image inline in the chat surface', async () => {
    const { api } = createMockValleyApi({ files: { [source]: jsonl }, indexEntries })
    const inApp = mockInApp()
    const res = text(await tool(api, 'send_attachment').run({ path: 'Pilzdiagramm_x.jpg' }, { inApp }))
    expect(inApp.posted).toEqual(['Pilzdiagramm_x.jpg'])
    expect(res.toLowerCase()).toContain('inline')
  })

  it('send_attachment sends a solution image resolved from a basename', async () => {
    const { api, driverCalls } = createMockValleyApi({ files: { [source]: jsonl }, indexEntries })
    const res = text(await tool(api, 'send_attachment').run({ path: 'Pilzdiagramm_x.jpg' }, channelOpts))
    const photo = driverCalls.find((c) => c.method === 'sendAttachment')
    expect(photo?.payload).toMatchObject({ path: 'Pilzdiagramm_x.jpg', chatRef: '123' })
    expect(res).toContain('Sent')
  })
})
