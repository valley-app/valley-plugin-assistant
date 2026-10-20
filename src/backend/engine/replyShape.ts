import type { MessageContent, MessageDestination } from '../../contracts/channel'
import type { AiMessage } from '../../types'

/** Every surface gets the same reply shape: a short opening line saying what will happen, then the work, then a summary. */
export const replyShapeInstruction = 'Reply shape, on every surface: start every reply with one short sentence saying what you will do, written before any tool call. When you are finished, end with a short summary of what you did and the result. For a short direct answer, the answer itself can be both.'
/** Same on every surface: when the request is unclear, offer the likely meanings as buttons instead of guessing. */
export const stoppedNote = '[The user stopped this request before it finished. Do not continue or repeat it now; act on it only if the user asks for it again.]'

/** Model view of the history: a stopped request carries a note instead of the internal flag. */
export const modelMessages = <T extends { role: string; content: string; stopped?: boolean }>(messages: T[]): Omit<T, 'stopped'>[] => messages.map(({ stopped, ...message }) => stopped && message.role === 'user' ? { ...message, content: `${message.content}\n\n${stoppedNote}` } : message)

export const clarifyInstruction = 'When you are not sure what the user means, or the request could reasonably mean different things that lead to different actions, do not guess: call ask_user with one short question and 2 to 5 choices with short labels, so the user can tap an answer here, in Telegram or in WhatsApp. Their tap or typed answer continues this turn. Do not ask when one meaning is clearly the most likely or a sensible default exists; then act and say which you chose. An explicit request does not become unclear because of what is already open or what an earlier turn did: asked to open something in a new tab, open a new tab even when one is already open.'
export const openingFallback = 'Working on it.'

/** A failed turn ends with a plain reply saying so, in the app and on Telegram and WhatsApp, so a failure is never silent. */
export function failureReply(runId: string | null, error: unknown): AiMessage {
  const raw = String(error)
  return { id: `failure:${runId ?? crypto.randomUUID()}`, role: 'assistant', content: `This request failed and did not finish: ${raw.replace(/^Error:\s*/, '')}`, failure: raw, error: true, ts: Date.now() }
}

type Send = (input: { id: string; conversationId: string; destination: MessageDestination; content: MessageContent }) => Promise<unknown>
type Signal = (content: MessageContent) => Promise<unknown>

/**
 * Telegram and WhatsApp cannot show the in-app thinking animation or streamed text, so a channel turn shows the
 * provider's typing indicator while it runs and sends the opening line as its own message as soon as the model has
 * written it, before the first tool runs. The final answer, with its summary, is still delivered at the end.
 */
export function channelPresence(input: { runId: string; destination: MessageDestination; messageId?: string; send: Send; signal: Signal }) {
  const { destination } = input
  let opened = false, stopped = false
  const typing = () => {
    if (stopped || (destination.kind === 'whatsapp' && !input.messageId)) return
    void input.signal({ type: 'activity', action: 'typing', ...(input.messageId && destination.kind === 'whatsapp' ? { messageId: input.messageId } : {}) }).catch(() => undefined)
  }
  typing()
  const timer = setInterval(typing, destination.kind === 'whatsapp' ? 20000 : 4500)
  return {
    async open(text: string | undefined) {
      if (opened || stopped) return
      opened = true
      const line = text?.trim() || openingFallback
      await input.send({ id: `opening:${input.runId}`, conversationId: destination.conversationId, destination, content: { type: 'text', text: line } })
    },
    stop() { stopped = true; clearInterval(timer) }
  }
}
