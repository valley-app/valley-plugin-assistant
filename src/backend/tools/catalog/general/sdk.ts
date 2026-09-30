import type { ValleyPluginApi } from '../../../../api'
import type { AiAttachment, AiToolDef } from '../../../../types'
import type { GuardFilesPolicy } from '@valley/plugin-sdk/guard/types'
import { AGENT_TOOL_PROVIDER_V1, agentToolProviderMetadata, matchAny, type AgentToolOutput, type AutomationWorkflow } from '@valley/plugin-sdk'
import type { ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import type { QuizChoice } from '../../../../types'
import { answerChoices, parseProblems, pickProblem, sessionFor, sessionKey, type QuizProblem } from '../../../../quiz'
import { parseSkillManifest, type SkillMeta } from '../../../../skills'

/**
 * The in-app chat surface a tool can push render-only content to (the store wires
 * this in). `postImage` injects an inline `![[path]]` bubble; `setQuiz` sets the
 * thread's tappable answer prompt. Both are no-ops over a pure channel turn with no
 * mirrored in-app thread — but in this app every channel turn also mirrors in-app,
 * so the quiz buttons/images show in both places.
 */
export interface InAppSurface {
  postImage(path: string): void
  setQuiz(source: string, choices: QuizChoice[], imagePath?: string): void
}

export type RunOpts = {
  approvalToken?: string
  conversationId?: string
  channel?: { channelId: string; chatRef: string } | null
  inApp?: InAppSurface
  /** The run's cancellation token — threaded into bus dispatches so cancelling
   *  a turn also cancels the command it is waiting on (reads race it). */
  cancellation?: ValleyCancellation
  activity?: { runId: string; callId: string }
}

/**
 * The neutral tool registry — the assistant's hands. Every capability maps onto
 * the existing plugin SDK (workspace, vault, drivers, data, commands, playback),
 * so the agent acts through the same gated surface every other plugin uses.
 * `sideEffect: 'write'` marks state-changing tools that the loop gates behind the
 * permission policy; read tools always run.
 *
 * `dispatch: 'bus'` marks a tool that itself dispatches command-bus commands.
 * The loop does **not** gate these by tool name —
 * it gates by the *underlying command id* (via `busCommandId`, when determinable)
 * and passes an approval token so the bus enforces without a second prompt (C6).
 * Dynamic provider tools return null and let the bus gate each underlying command.
 */
/**
 * A tool's result. A plain string is the text the model sees. Returning an object
 * lets a tool ALSO hand the model a binary — e.g. a page screenshot: the loop
 * appends `text` as the normal tool result and injects `attachment` as a provider-
 * visible `user` message (reusing the existing attachments→image-block mapping), so
 * vision works without any provider change and the text-only path is unaffected.
 */
export interface ToolRunResult {
  output?: string
  text: string
  attachment?: AiAttachment
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  sideEffect: 'read' | 'write'
  timeoutMs?: number
  drainOnCancel?: boolean
  /** Package that owns a provider-supplied implementation. */
  providerOwner?: string
  /** Marks a tool whose effect is a command-bus dispatch (gated by command id). */
  dispatch?: 'bus'
  /** The single underlying command id for this call, or null when it fans out. */
  busCommandId?: (args: Record<string, unknown>) => string | null
  run: (args: Record<string, unknown>, opts?: RunOpts) => Promise<string | ToolRunResult>
}

function providerOwnedTools(api: ValleyPluginApi): AgentTool[] {
  return api.interop.services.providers(AGENT_TOOL_PROVIDER_V1).flatMap((provider) => {
    const descriptors = agentToolProviderMetadata(provider)?.tools ?? []
    return descriptors.map((descriptor): AgentTool => ({
      ...descriptor,
      providerOwner: provider.owner,
      ...(descriptor.commandId || descriptor.commandDispatch === 'dynamic'
        ? {
            dispatch: 'bus' as const,
            busCommandId: descriptor.commandId
              ? () => `${provider.owner}:${descriptor.commandId}`
              : () => null
          }
        : {}),
      run: async (args, options) => {
        const result = await provider.invoke('execute', [
          descriptor.name,
          args,
          { approvalToken: options?.approvalToken, cancellation: options?.cancellation }
        ])
        if (!result.ok) {
          return `Provider ${provider.owner} could not run ${descriptor.name}: ${result.error.message}`
        }
        return result.value as AgentToolOutput
      }
    }))
  })
}

/**
 * Command-bus ids the assistant must never call, even with user permission —
 * pure "human intent" bookkeeping (no layout name means there is no evidence
 * the user requested it) that the user manages by hand via the workspace footer
 * button. Enforced in `loop.ts`'s `gateAndRun`, before any Guard prompt.
 */
/**
 * Whether the assistant may list/search/open/read a path under the files policy:
 * never a `blocked` path, and in `allow-listed-only` mode only an `allowedToVisit`
 * match. `search_vault` reads the renderer index (it never touches main's
 * enforced `files` driver), so it must apply this itself; `open_file`/`list_dir`
 * apply it too for parity (main re-enforces reads/writes authoritatively).
 */
export function isVisitable(path: string, policy: GuardFilesPolicy | null | undefined): boolean {
  if (!policy) return true
  if (matchAny(policy.blocked, path)) return false
  if (policy.visitMode === 'allow-listed-only' && !matchAny(policy.allowedToVisit, path)) return false
  return true
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const S = (description: string): Record<string, unknown> => ({ type: 'string', description })

/** Cap a tool result so a huge file/inbox can't blow the context window. */
export function clip(text: string, max = 6000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(${text.length - max} more chars truncated)` : text
}

// ── Teacher-Assistant quiz ────────────────────────────────────────────────────

/** Send a problem's question image(s) to the chat; returns the count actually sent. */
async function sendQuizImages(api: ValleyPluginApi, ch: { channelId: string; chatRef: string }, p: QuizProblem, caption: string): Promise<number> {
  let sent = 0
  for (let i = 0; i < p.images.length; i++) {
    try {
      await api.channels.sendAttachment(ch.channelId, ch.chatRef, p.images[i], i === 0 ? caption : undefined)
      sent++
    } catch {
      // skip an image that failed to send; the question text still reaches the model
    }
  }
  return sent
}

/** The model-facing brief for one served problem (answer/explanation are private). */
function quizBrief(p: QuizProblem, source: string, servedCount: number, total: number, delivered: string): string {
  const opts = p.options.length ? p.options.map((o) => `(${o.letter}) ${o.text}`).join('\n') : ''
  return [
    `Served question ${servedCount}/${total} from ${source} (id: ${p.id}).`,
    `Type: ${p.options.length ? 'multiple-choice' : 'free-text'}`,
    `Title: ${p.title}`,
    `Question:\n${p.problemText}`,
    opts ? `Options:\n${opts}` : '',
    `CORRECT ANSWER (private — never reveal until the user has answered): ${p.answerLetter ?? '(judge from the explanation below)'}`,
    `EXPLANATION (private):\n${p.explanation}`,
    p.solutionImages.length ? `Solution image(s) you can send if the user is stuck (send_attachment): ${p.solutionImages.join(', ')}` : '',
    delivered
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function runQuizNext(api: ValleyPluginApi, a: Record<string, unknown>, opts?: RunOpts): Promise<string> {
  const ch = opts?.channel
  const source = str(a.source).trim()
  if (!source) return 'Failed: provide a source (vault-relative path to a listli.jsonl file).'
  const res = await api.drivers.files.readFile(source)
  if (!res.ok) return `Failed to read ${source}: ${res.error}`
  const problems = parseProblems(res.data?.content ?? '')
  if (!problems.length) return `No quiz problems found in ${source}.`

  const filter = { multipleChoiceOnly: a.multipleChoiceOnly === true, subject: str(a.subject) || undefined }
  // In-app turns have no channel to push images to; key the session on a stable id.
  const key = ch ? sessionKey(ch.channelId, ch.chatRef) : 'in-app'
  const served = sessionFor(api, key, source, a.reset === true)
  const problem = pickProblem(problems, served, filter)
  if (!problem) return `Quiz complete — all ${problems.length} questions in ${source} have been served. Call quiz_next with reset=true to start over.`
  served.add(problem.id)

  // Answer buttons ONLY for a genuine choice question (multiple-choice / single-choice
  // / true-false). Free-input and multi-statement questions return [] → the user types.
  const choices = answerChoices(problem)
  const caption = `❓ Frage ${served.size}`

  // In-app (native chat AND remote-channel mirrors): show every question image inline,
  // and for a choice question arm the tappable answer prompt for this thread.
  for (const img of problem.images) opts?.inApp?.postImage(img)
  if (choices.length) opts?.inApp?.setQuiz(source, choices, problem.images[0])

  let delivered: string
  if (ch) {
    const sent = await sendQuizImages(api, ch, problem, caption)
    if (choices.length) {
      await api.channels.sendButtons(
        ch.channelId,
        ch.chatRef,
        'Deine Antwort:',
        choices.map((c) => ({ label: c.label, value: `qz:${c.value}` }))
      )
      delivered =
        `Delivered to the user: ${sent} question image(s) and ${choices.length} answer buttons (${choices.map((c) => c.label).join('/')}). ` +
        'The image and buttons are already shown — write ONLY the question text (do not re-list the options or ask them to type). ' +
        'Wait for their tap, then judge it; on a wrong answer explain briefly and offer the solution image. ' +
        'The question image is attached to their answer turn, so read the option letters from it to grade a letter tap.'
    } else {
      delivered =
        `Delivered to the user: ${sent} question image(s). This is a FREE-INPUT question (no answer buttons) — ` +
        'present the question and ask the user to TYPE their answer. Wait for their reply, then judge it against the explanation below.'
    }
  } else if (choices.length) {
    delivered =
      `The question image(s) and ${choices.length} answer buttons (${choices.map((c) => c.label).join('/')}) are already shown in the chat. ` +
      'Write ONLY the question text (do not re-list the options or ask them to type). ' +
      'The question image is attached to their answer turn, so read the option letters from it to grade a letter tap.'
  } else {
    delivered =
      'The question image is already shown in the chat. This is a FREE-INPUT question (no answer buttons) — ' +
      'present the question and ask the user to TYPE their answer. Then judge it against the explanation below.'
  }
  return quizBrief(problem, source, served.size, problems.length, delivered)
}

/** Resolve a basename (via the index) or a path-with-separator (as-is) to a vault path. */
function resolveAttachmentPath(api: ValleyPluginApi, ref: string): string | null {
  return ref.includes('/') ? ref : api.workspace.resolveWikilink(ref) || null
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i

/**
 * Send a vault file of any type to the current surface. Over a remote channel the
 * adapter type-routes it (photo/audio/video/document). In-app there is no channel:
 * open the file for the user and tell the model to reference it inline so the chat
 * bubble shows a clickable wikilink (`![[…]]` for images, `[[…]]` otherwise).
 */
async function runSendAttachment(api: ValleyPluginApi, a: Record<string, unknown>, opts?: RunOpts): Promise<string> {
  const ch = opts?.channel
  const ref = str(a.path).trim()
  if (!ref) return 'Failed: provide a file basename or vault-relative path.'
  const path = resolveAttachmentPath(api, ref)
  if (!path) return `Could not resolve "${ref}" in the vault.`
  const caption = str(a.caption) || undefined
  // Show an image inline in the chat deterministically; the model needn't embed it.
  if (IMAGE_EXT.test(path)) opts?.inApp?.postImage(path)
  if (!ch) {
    if (!IMAGE_EXT.test(path)) {
      api.workspace.openFile(path)
      return `Opened ${path} in the app. Reference it in your reply as [[${path}]] so the user sees it clickable.${caption ? ` Caption: ${caption}` : ''}`
    }
    return `Showed ${path} inline in the chat.${caption ? ` Caption: ${caption}` : ''}`
  }
  try {
    await api.channels.sendAttachment(ch.channelId, ch.chatRef, path, caption)
    return `Sent ${path} to the user.`
  } catch (err) {
    return `Failed to send attachment: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── Toolbox (capabilities as vault skills) ────────────────────────────────────

/** Read every Toolbox skill folder's `skill.md` front-matter into a list of metas. */
async function listSkills(api: ValleyPluginApi): Promise<SkillMeta[]> {
  return api.backend.call<SkillMeta[]>('skills.toolbox', { method: 'list' })
}

async function runRunSkill(api: ValleyPluginApi, a: Record<string, unknown>): Promise<string | ToolRunResult> {
  const name = str(a.name).trim()
  if (!name) return 'Failed: provide a skill name (from list_skills).'
  const source = await api.backend.call<string | null>('skills.toolbox', { method: 'read', name, file: 'skill.json' })
  const manifest = source ? parseSkillManifest(source) : null
  if (!manifest) return `Skill "${name}" has no runnable (skill.json). Read it with read_skill and follow its instructions instead.`
  const input = (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>
  const args: Record<string, string> = {}
  for (const key of manifest.argsFrom) {
    const v = input[key] ?? a[key]
    if (v != null) args[key] = str(v)
  }
  try {
    const result = await api.backend.call('skills.run', { runnable: manifest.runnable, args }) as { output: string }
    return { text: clip(result.output || '(no output)'), output: result.output || '(no output)' }
  } catch (error) { return `Failed: ${error instanceof Error ? error.message : String(error)}` }
}

export function toToolDefs(tools: AgentTool[]): AiToolDef[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

/**
 * Whether a tool result is an error the model should react to (the loop appends a
 * corrective hint and lets the model retry). Tool `run`s return errors as plain
 * text (never throw), so this matches the conventional prefixes/phrases they use.
 */
export function looksLikeFailure(result: string): boolean {
  const r = result.trim()
  return (
    /^(command error|provider .+ could not run|error|failed|blocked by policy)/i.test(r) ||
    /\bunknown command\b|\busage:/i.test(r)
  )
}

/**
 * A concise, actionable nudge appended to a failed tool result so a weak model
 * fixes the *next* call instead of repeating the broken one. Surfaces the real
 * valid command ids rather than a generic apology.
 */
export function failureHint(api: ValleyPluginApi, toolName: string, args: Record<string, unknown>, result: string): string {
  const r = result.toLowerCase()
  if (toolName === 'run_command' && /unknown|not found|no command|no such/.test(r)) {
    const id = str(args.id)
    const ns = id.includes(':') ? id.slice(0, id.indexOf(':')) : id
    const near = api.commands
      .list()
      .filter((c) => c.id.includes(ns) || c.label.toLowerCase().includes(ns.toLowerCase()))
      .slice(0, 8)
      .map((c) => c.id)
    return near.length
      ? `Hint: no command "${id}". Closest ids: ${near.join(', ')}. Use list_commands to find the right one.`
      : `Hint: no command "${id}". Call list_commands to find a valid command id.`
  }
  return ''
}

export function buildTools(api: ValleyPluginApi, getFilesPolicy?: () => GuardFilesPolicy | null): AgentTool[] {
  const filesPolicy = (): GuardFilesPolicy | null => getFilesPolicy?.() ?? null
  const fileReads = new Map<string, string>()
  const receiptKey = (path: string, opts?: RunOpts): string => JSON.stringify([opts?.conversationId, opts?.channel?.channelId, opts?.channel?.chatRef, path])
  const writeDocument = async (path: string, content: string, markdown = false, opts?: RunOpts): Promise<string> => {
    const key = receiptKey(path, opts)
    let revisionToken = fileReads.get(key)
    if (!revisionToken) {
      const snapshot = await api.drivers.files.readTextDocument(path)
      if (!snapshot.ok || !snapshot.data) return `Failed: ${snapshot.error || 'Cannot read file.'}`
      if (!snapshot.data.missing) return `Failed: Read ${path} with read_file before replacing its content.`
      revisionToken = snapshot.data.revisionToken
    }
    fileReads.delete(key)
    const result = markdown
      ? await api.drivers.notes.writeMarkdownGuarded({ relPath: path, content, revisionToken })
      : await api.drivers.files.writeTextDocumentGuarded(path, content, revisionToken)
    if (!result.ok) return `Failed: ${result.error}`
    if (!result.data?.ok) return `Failed: ${path} changed or could not be written. Read it again before editing.`
    if (result.data.editorConflict) return `Wrote ${path}, but newer editor changes were preserved as a conflict. Ask the user to resolve those edits before writing again.`
    if (result.data.revisionToken) fileReads.set(key, result.data.revisionToken)
    return `Wrote ${path}.`
  }
  const tools: AgentTool[] = [
    // ── Workspace / vault (read) ──────────────────────────────────────────
    {
      name: 'read_file',
      description: "Read any vault file's text by its vault-relative path (markdown, text, .jsonl, …).",
      parameters: obj(
        { path: S('Vault-relative path, e.g. "Notes/idea.md"'), maxChars: { type: 'number', description: 'Max characters to return (default 8000; raise to read a whole data file)' } },
        ['path']
      ),
      sideEffect: 'read',
      // Routed through the guarded `files` driver (not the ungated core `vault.readFile`,
      // which the user's own editor uses) so a blocked path (secrets, .git, …) is refused
      // authoritatively in main — closing the C2 read leak.
      run: async (a, opts) => {
        const path = str(a.path)
        const key = receiptKey(path, opts)
        fileReads.delete(key)
        const res = await api.drivers.files.readTextDocument(path)
        if (!res.ok || !res.data) return `Failed: ${res.error || 'Cannot read file.'}`
        while (fileReads.size >= 128) fileReads.delete(fileReads.keys().next().value!)
        fileReads.set(key, res.data.revisionToken)
        return { text: clip(res.data.content || (res.data.missing ? '(missing)' : '(empty)'), typeof a.maxChars === 'number' ? a.maxChars : 8000), output: res.data.content }
      }
    },
    {
      name: 'search_vault',
      description:
        'Fuzzy-search vault files by name/path (the quick-switcher engine). Supports #tag tokens in the query. Returns matching file paths.',
      parameters: obj({ query: S('Words (and optional #tags) to match against note titles and paths') }, ['query']),
      sideEffect: 'read',
      // Search runs through the core bus command, but the assistant must apply
      // its own visit policy — otherwise it would surface paths it is then
      // refused when it tries to read them.
      run: async (a) => {
        const result = await api.commands.execute('search:files', { query: str(a.query), limit: 50 })
        if (!result.ok) return `Search failed: ${result.error.message}`
        const policy = filesPolicy()
        const hits = (result.value as { relPath: string; title: string }[])
          .filter((h) => isVisitable(h.relPath, policy))
          .slice(0, 25)
          .map((h) => `- ${h.title} — ${h.relPath}`)
        return hits.length ? hits.join('\n') : 'No matches.'
      }
    },
    {
      name: 'search_content',
      description:
        'Full-text search across note bodies, PDFs, transcripts and data records (the supermode index). Returns paths with snippets.',
      parameters: obj(
        {
          query: S('Words to find in file contents'),
          limit: { type: 'number', description: 'Max results (default 15)' }
        },
        ['query']
      ),
      sideEffect: 'read',
      run: async (a) => {
        const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.min(Math.floor(a.limit), 50) : 15
        const result = await api.commands.execute('search:content', { query: str(a.query), limit })
        if (!result.ok) return `Search failed: ${result.error.message}`
        const policy = filesPolicy()
        const hits = (result.value as { relPath: string; line?: number; heading?: string; sourceType: string; recordId?: string; snippet: string }[])
          .filter((h) => isVisitable(h.relPath, policy))
          .map((h) => {
            const ref = h.heading ? `${h.relPath}#${h.heading}` : h.relPath
            const record = h.sourceType === 'jsonl' && h.recordId ? ` · record ${h.recordId}` : ''
            return `- [[${ref}]]${h.line ? ` · line ${h.line}` : ''}${record} — ${h.snippet.replace(/\s+/g, ' ')}`
          })
        return hits.length ? hits.join('\n') : 'No matches.'
      }
    },
    {
      name: 'open_file',
      description: 'Open a vault file in the main workspace for the user to see.',
      parameters: obj({ path: S('Vault-relative path to open') }, ['path']),
      sideEffect: 'read',
      run: async (a) => {
        const path = str(a.path)
        if (!isVisitable(path, filesPolicy())) return `Blocked by policy: "${path}" is outside the allowed files.`
        api.workspace.openFile(path)
        return `Opened ${path}.`
      }
    },
    {
      name: 'open_tab',
      description: 'Open a special tab: "graph" (knowledge graph), "settings", or "assistant".',
      parameters: obj({ target: { type: 'string', enum: ['graph', 'settings', 'assistant'], description: 'Which tab to open' } }, ['target']),
      sideEffect: 'read',
      run: async (a) => {
        const t = str(a.target)
        if (t === 'graph') api.workspace.openGraphTab()
        else if (t === 'settings') api.workspace.openSettings()
        else api.workspace.openMainTab()
        return `Opened ${t}.`
      }
    },
    // ── Files (read + write any type) ─────────────────────────────────────
    {
      name: 'list_dir',
      description: 'List files and folders in a vault directory (omit path for the vault root).',
      parameters: obj({ path: S('Vault-relative folder path; omit for the root') }),
      sideEffect: 'read',
      run: async (a) => {
        const res = await api.drivers.files.listDir(str(a.path) || undefined)
        if (!res.ok) return `Failed: ${res.error}`
        const policy = filesPolicy()
        const entries = (res.data?.entries ?? []).filter((e) => isVisitable(e.relPath, policy))
        return entries.length ? entries.map((e) => `${e.isDir ? '📁' : '📄'} ${e.relPath}`).join('\n') : '(empty)'
      }
    },
    {
      name: 'write_file',
      description: 'Create a vault file or replace a file previously read with read_file. Newer editor or disk changes are preserved. Supports markdown, text, and data (.jsonl, .json, .csv, …).',
      parameters: obj({ path: S('Vault-relative path, any extension'), content: S('Full file content') }, ['path', 'content']),
      sideEffect: 'write',
      run: (a, opts) => writeDocument(str(a.path), str(a.content), false, opts)
    },
    {
      name: 'delete_file',
      description: 'Delete ANY vault file (moves it to the vault trash; recoverable).',
      parameters: obj({ path: S('Vault-relative path to delete') }, ['path']),
      sideEffect: 'write',
      run: async (a) => {
        const res = await api.drivers.files.deleteFile(str(a.path))
        return res.ok ? `Deleted ${str(a.path)}.` : `Failed: ${res.error}`
      }
    },
    // ── Notes (write) ─────────────────────────────────────────────────────
    {
      name: 'write_note',
      description: 'Create a markdown (.md) note or replace a note previously read with read_file, preserving newer editor or disk changes.',
      parameters: obj({ path: S('Vault-relative .md path'), content: S('Full markdown content') }, ['path', 'content']),
      sideEffect: 'write',
      run: (a, opts) => writeDocument(str(a.path), str(a.content), true, opts)
    },
    {
      name: 'delete_note',
      description: 'Delete a markdown note (moves it to the vault trash; recoverable).',
      parameters: obj({ path: S('Vault-relative .md path to delete') }, ['path']),
      sideEffect: 'write',
      run: async (a) => {
        const res = await api.drivers.notes.deleteMarkdown({ relPath: str(a.path) })
        return res.ok ? `Deleted ${str(a.path)}.` : `Failed: ${res.error}`
      }
    },
    // ── Settings + commands ───────────────────────────────────────────────
    {
      name: 'set_setting',
      description:
        'Change a setting. Pass `pluginId` for a plugin setting, or `domain` for a system one (app, appearance, preferences, markdown, files, tags, template, search, design — everything changeable by hand in Settings). Writes are undoable (⌘Z).',
      parameters: obj(
        {
          pluginId: S('Plugin id (omit when using domain)'),
          domain: S('System settings domain, e.g. "appearance" (omit when using pluginId)'),
          key: S('Setting key'),
          value: S('New value (string/number/boolean/JSON as text)')
        },
        ['key', 'value']
      ),
      sideEffect: 'write',
      dispatch: 'bus',
      busCommandId: (a) => (str(a.domain) ? 'settings:set' : 'settings:plugin-set'),
      run: async (a, opts) => {
        const key = str(a.key)
        const ctx = { approvalToken: opts?.approvalToken, cancellation: opts?.cancellation }
        if (str(a.domain)) {
          const result = await api.commands.execute(
            'settings:set',
            { domain: str(a.domain), patch: { [key]: a.value } },
            ctx
          )
          return result.ok ? `Set ${str(a.domain)}.${key}.` : `Failed: ${result.error.message}`
        }
        const result = await api.commands.execute(
          'settings:plugin-set',
          { pluginId: str(a.pluginId), key, value: a.value },
          ctx
        )
        return result.ok ? `Set ${str(a.pluginId)}.${key}.` : `Failed: ${result.error.message}`
      }
    },
    {
      name: 'get_settings',
      description:
        'Read settings: {domain} for a system domain, {pluginId} for a plugin, or no input to list every domain and plugin id.',
      parameters: obj({
        domain: S('System settings domain to read'),
        pluginId: S('Plugin id to read')
      }),
      sideEffect: 'read',
      run: async (a) => {
        const domain = str(a.domain)
        const pluginId = str(a.pluginId)
        const id = domain ? 'settings:get' : pluginId ? 'settings:plugin-get' : 'settings:domains'
        const input = domain ? { domain } : pluginId ? { pluginId } : undefined
        const result = await api.commands.execute(id, input)
        return result.ok ? JSON.stringify(result.value, null, 2) : `Failed: ${result.error.message}`
      }
    },
    {
      name: 'list_commands',
      description: 'Discover app and plugin commands with schemas, ownership, side effects, preview and atomic support. Use nextOffset to fetch the next page.',
      parameters: obj({ filter: S('Optional substring in command id or label'), pluginId: S('Optional owning plugin id'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
      sideEffect: 'read',
      run: async (a) => {
        const q = str(a.filter).toLowerCase()
        const cmds = api.commands
          .list()
          .filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
          .filter((c) => !str(a.pluginId) || c.pluginId === str(a.pluginId))
          .filter((c) => c.agentVisibility === 'discoverable')
        const offset = Math.max(0, Number.isSafeInteger(a.offset) ? Number(a.offset) : 0)
        const limit = Math.max(1, Math.min(200, Number.isSafeInteger(a.limit) ? Number(a.limit) : 50))
        return JSON.stringify({ commands: cmds.slice(offset, offset + limit), total: cmds.length, ...(offset + limit < cmds.length ? { nextOffset: offset + limit } : {}) })
      }
    },
    {
      name: 'describe_command',
      description: 'Inspect the structured input schema, usage, side effect and automation support for a command before using it.',
      parameters: obj({ id: S('Full namespaced command id') }, ['id']),
      sideEffect: 'read',
      run: async (a) => {
        const command = api.commands.describe(str(a.id))
        return JSON.stringify(command?.agentVisibility === 'discoverable' ? { ok: true, value: command } : { ok: false, error: { kind: 'unknown-id', message: 'Command is unavailable.' } })
      }
    },
    {
      name: 'preview_workflow',
      description: 'Preview 1–100 ordered command steps without running them. Each step has id, command and optional input. An input value may reference an earlier result using {"$ref":{"stepId":"earlier","path":"/id"}}. Sequential workflows stop on failure; atomic mode requires concrete inputs and commands explicitly supporting atomic writes. The opaque preview expires after five minutes and can be used once.',
      parameters: obj({ workflow: { type: 'object', properties: { mode: { type: 'string', enum: ['sequential', 'atomic'] }, steps: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { id: S('Unique step id'), command: S('Full command id'), input: { description: 'Structured command input or earlier-result references' } }, required: ['id', 'command'], additionalProperties: false } } }, required: ['steps'], additionalProperties: false } }, ['workflow']),
      sideEffect: 'read',
      run: async (a) => JSON.stringify(await api.commands.previewWorkflow(a.workflow as AutomationWorkflow))
    },
    {
      name: 'start_workflow',
      description: 'Start the exact previewed workflow asynchronously. Returns a run id; use workflow_status to inspect progress and results. Every command still uses app permissions and may await user approval. Do not restart a run after losing a response; inspect its status.',
      parameters: obj({ previewId: S('Opaque id from preview_workflow'), workflow: { type: 'object', additionalProperties: true, description: 'The exact workflow passed to preview_workflow' } }, ['previewId', 'workflow']),
      sideEffect: 'write', dispatch: 'bus', busCommandId: () => null,
      run: async (a) => JSON.stringify(await api.commands.startRun(a.workflow as AutomationWorkflow, { previewId: str(a.previewId) }))
    },
    {
      name: 'workflow_status',
      description: 'Get an asynchronous workflow run, including approval waiting state, completed results and any failure.',
      parameters: obj({ runId: S('Run id from start_workflow') }, ['runId']),
      sideEffect: 'read',
      run: async (a) => JSON.stringify(api.commands.getRun(str(a.runId)) ?? { error: 'No such automation run in this vault session.' })
    },
    {
      name: 'cancel_workflow',
      description: 'Cancel a workflow before its next action. A write already in progress finishes safely; completed sequential steps are retained.',
      parameters: obj({ runId: S('Run id from start_workflow') }, ['runId']),
      sideEffect: 'write', dispatch: 'bus', busCommandId: () => null,
      run: async (a) => JSON.stringify({ cancelled: api.commands.cancelRun(str(a.runId)) })
    },
    {
      name: 'run_command',
      description:
        'Run an app command by id through the command bus (find ids with list_commands). Pass `input` for commands that take arguments, e.g. {"id":"plugin-id:command","input":{"value":"example"}}. The structured result is returned directly.',
      parameters: obj(
        {
          id: S('Full namespaced command id, e.g. "plugin-id:command"'),
          input: { type: 'object', description: 'Optional structured input for the command', additionalProperties: true }
        },
        ['id']
      ),
      sideEffect: 'write',
      dispatch: 'bus',
      busCommandId: (a) => str(a.id) || null,
      run: async (a, opts) => {
        const result = await api.commands.execute(str(a.id), a.input, {
          approvalToken: opts?.approvalToken,
          cancellation: opts?.cancellation,
          autonomous: true
        })
        if (!result.ok) {
          const hint = result.error.hint ? `\n${result.error.hint}` : ''
          return `Command error (${result.error.kind}): ${result.error.message}${hint}`
        }
        return result.value == null
          ? `Ran ${str(a.id)}.`
          : typeof result.value === 'string'
            ? result.value
            : JSON.stringify(result.value)
      }
    },
    {
      name: 'preview_command_batch',
      description:
        'Preview an ordered batch of explicitly atomic write commands. Returns an expiring, single-use proposal bound to command implementations, arguments, order, and available target revisions. Other actions use preview_workflow in sequential mode.',
      parameters: obj({
        calls: {
          type: 'array',
          description: 'Ordered write-command calls to preview',
          items: {
            type: 'object',
            properties: {
              id: S('Full English command id'),
              input: { type: 'object', description: 'Structured command input', additionalProperties: true }
            },
            required: ['id'],
            additionalProperties: false
          }
        }
      }, ['calls']),
      sideEffect: 'read',
      run: async (a) => {
        const calls = Array.isArray(a.calls)
          ? a.calls.flatMap((value) => {
              const call = value && typeof value === 'object' ? value as Record<string, unknown> : null
              const id = str(call?.id).trim()
              return id ? [{ id, input: call?.input }] : []
            })
          : []
        const result = await api.commands.previewBatch(calls)
        return JSON.stringify(result)
      }
    },
    {
      name: 'run_command_batch',
      description:
        'Execute an exact previewed batch of explicitly atomic local writes as one transaction and undo entry. External side effects and writes without undo support must use a sequential workflow.',
      parameters: obj({
        previewId: S('Exact proposal id returned by preview_command_batch'),
        calls: {
          type: 'array',
          description: 'The exact ordered calls used for the preview',
          items: {
            type: 'object',
            properties: {
              id: S('Full English command id'),
              input: { type: 'object', description: 'Structured command input', additionalProperties: true }
            },
            required: ['id'],
            additionalProperties: false
          }
        }
      }, ['previewId', 'calls']),
      sideEffect: 'write',
      dispatch: 'bus',
      busCommandId: () => null,
      run: async (a, opts) => {
        const calls = Array.isArray(a.calls)
          ? a.calls.flatMap((value) => {
              const call = value && typeof value === 'object' ? value as Record<string, unknown> : null
              const id = str(call?.id).trim()
              return id ? [{ id, input: call?.input }] : []
            })
          : []
        const result = await api.commands.executeBatch(calls, {
          previewId: str(a.previewId),
          approvalToken: opts?.approvalToken,
          cancellation: opts?.cancellation
        })
        return JSON.stringify(result)
      }
    },
    // ── Assistant self-management ─────────────────────────────────────────
    {
      name: 'read_instructions',
      description: 'Read your own standing instructions and rules (the Orchestra config).',
      parameters: obj({}),
      sideEffect: 'read',
      run: async () => {
        const res = await api.assistant.getConfig()
        const cfg = res.data
        if (!cfg) return 'No config.'
        const rules = cfg.rules.map((r) => `### rule: ${r.name}\n${r.content}`).join('\n\n')
        return { text: clip(`# instructions\n${cfg.instructions}\n\n${rules}`), output: `# instructions\n${cfg.instructions}\n\n${rules}` }
      }
    },
    {
      name: 'write_rule',
      description: 'Create or update one of your own rule files (rules/<name>.md).',
      parameters: obj({ name: S('Rule name (no slashes)'), content: S('Markdown content') }, ['name', 'content']),
      sideEffect: 'write',
      run: async (a) => {
        const res = await api.assistant.writeRule(str(a.name), str(a.content))
        return res.ok ? `Saved rule "${str(a.name)}".` : `Failed: ${res.error}`
      }
    },
    {
      name: 'memory_summarize',
      description:
        "Save a stable, long-term fact about the user or this work to this chat's memory. Use sparingly, only for durable facts (preferences, ongoing projects, key context) — never for transient chat details. Memory survives /clear, so the fact persists after the conversation is reset.",
      parameters: obj(
        {
          summary: S('One concise fact to remember (a single sentence)'),
          confidence: { type: 'number', description: 'Your confidence the fact is durable, 0..1 (optional)' }
        },
        ['summary']
      ),
      sideEffect: 'write',
      run: async (a, opts) => {
        const chatId = opts?.conversationId ?? null
        if (!chatId) return 'No active conversation to attach memory to.'
        const summary = str(a.summary).trim()
        if (!summary) return 'Nothing to remember (empty summary).'
        const entry = {
          id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          summary,
          createdAt: Date.now(),
          sourceChatId: chatId,
          ...(typeof a.confidence === 'number' ? { confidence: a.confidence } : {})
        }
        const res = await api.assistant.appendMemory(chatId, entry)
        return res.ok ? `Remembered: "${summary}".` : `Failed: ${res.error}`
      }
    },
    // ── Attachments (send any vault file to the current surface) ──────────
    {
      name: 'send_attachment',
      description:
        'Send a vault file of ANY type (image, pdf, mp3, mp4, docx, …) to the current chat. Over a remote channel it is delivered as the right kind of attachment (photo/audio/video/document). In-app an image is shown inline automatically; a non-image is opened and you should reference it in your reply as [[path]] so it shows clickable. Pass a bare basename (resolved in the vault) or a full vault-relative path.',
      parameters: obj({ path: S('File basename (e.g. "Loesung.jpg") or vault-relative path'), caption: S('Optional caption') }, ['path']),
      sideEffect: 'read',
      run: (a, opts) => runSendAttachment(api, a, opts)
    },
    // ── Toolbox (capabilities authored as vault skills) ───────────────────
    {
      name: 'list_skills',
      description: 'List the Toolbox skills (capabilities authored as vault files under .valley/plugins/data/assistant/toolbox). Returns each skill name + what it does. Read one with read_skill, run a runnable one with run_skill.',
      parameters: obj({}),
      sideEffect: 'read',
      run: async () => {
        const skills = await listSkills(api)
        return skills.length ? skills.map((s) => `- ${s.id} — ${s.description || s.name}`).join('\n') : 'No Toolbox skills found.'
      }
    },
    {
      name: 'read_skill',
      description: "Read a Toolbox skill's instructions (its skill.md) so you can follow how/when to use it.",
      parameters: obj({ name: S('Skill folder name from list_skills') }, ['name']),
      sideEffect: 'read',
      run: async (a) => {
        const name = str(a.name).trim()
        if (!name) return 'Failed: provide a skill name (from list_skills).'
        const content = await api.backend.call<string | null>('skills.toolbox', { method: 'read', name, file: 'skill.md' })
        if (!content) return `No skill "${name}". Call list_skills to see the available skills.`
        return { text: clip(content), output: content }
      }
    },
    {
      name: 'run_skill',
      description: "Run a Toolbox skill's declared runnable (a vetted command, e.g. markitdown to convert a file to markdown). Pass the skill name and any inputs it needs, e.g. {\"name\":\"MARKITDOWN\",\"input\":{\"path\":\"docs/report.pdf\"}}. Assistant validates the declared runnable and requests approval for the installed tool and input file.",
      parameters: obj(
        {
          name: S('Skill folder name from list_skills'),
          input: { type: 'object', description: 'Inputs the skill declares (e.g. { path })', additionalProperties: true }
        },
        ['name']
      ),
      sideEffect: 'write',
      timeoutMs: 120_000,
      run: (a) => runRunSkill(api, a)
    },
    // ── Teacher-Assistant quiz (thin selection primitive) ─────────────────
    {
      name: 'quiz_next',
      description:
        'Serve the next quiz question from a listli.jsonl file to the current chat. It shows the question image(s) inline. For a CHOICE question (multiple-choice, single-choice, or true/false) it also shows tappable answer buttons (Wahr/Falsch, or the option letters); for a FREE-INPUT or multi-statement question there are no buttons and the user must TYPE the answer. The tool returns the question plus the CORRECT ANSWER and EXPLANATION for your eyes only — never reveal them until the user has answered. The tool result tells you whether buttons were shown or the user must type — follow it. Call again for the next question; pass reset=true to start a fresh quiz. To send a worked-solution image when the user is stuck, use send_attachment.',
      parameters: obj(
        {
          source: S('Vault-relative path to a listli.jsonl, e.g. "Fungi/season2/FungiSurvey/listli.jsonl"'),
          reset: { type: 'boolean', description: 'Start a new quiz, clearing which questions were already served' },
          multipleChoiceOnly: { type: 'boolean', description: 'Only serve problems that have (A)–(D) options' },
          subject: S('Optional: only serve problems whose subject matches this text')
        },
        ['source']
      ),
      sideEffect: 'read',
      run: (a, opts) => runQuizNext(api, a, opts)
    }
  ]
  return [...tools, ...providerOwnedTools(api)]
}
