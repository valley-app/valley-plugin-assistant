# Assistant plugin

- `/plan` runs the complete planning conversation and ends with Refine plan / Yes, implement it. Keep planning active through revisions; only explicit approval of the current proposal may enable execution. Enforce the restriction in tool execution, including indirect command/provider dispatch.

- Composer redesigns follow the user’s supplied reference: rounded input, visible permission label, compact model controls, and circular send/stop action, using Valley theme tokens. Keep implementation inside this plugin; wait for the other active UI tester to finish before using the managed Valley app.

- Assistant uses `Apache-2.0`, not MIT. Keep manifest, package metadata, LICENSE, and NOTICE aligned, and preserve bundled OpenAI and other third-party license notices.

- Assistant Properties uses compact Valley rows, never the full Settings layout. Keep harness selection out of the composer and project creation in the left sidebar. Narrow composer controls collapse to SVG icons without wrapping; keep typing available during runs. Full access is a saved on/off choice without expiry or visible timers. Verify actual input and output in the managed development app.

- Full access supports unattended channel control without approval popups for permitted actions. Verify Telegram-origin runs through the same policy resolver; explicit denies remain enforced. Vault only restricts native tools to the vault; Full access opens external files and terminal commands without a Project.

- Visually exercise sandbox form actions through their actual buttons and keyboard handlers; jsdom form submission alone does not prove a sandboxed Create or Save action works. Collapsed Properties sections must unmount host widgets so portal controls cannot remain visible.

- Markdown copy controls must be verified by pasting their result into the composer. Sandbox portal actions use the clicked element’s ownerDocument; the controller document is hidden and cannot own clipboard focus.

- The model selector uses the exact `LuBrain` glyph from `react-icons/lu` in both labeled and icon-only layouts; render its SVG through the injected React runtime to avoid bundling another React instance.

- Assistant message bubbles remain borderless. The composer follows the supplied reference: white fill, subtle gray border and soft shadow in light mode; gray fill and a quiet border in dark mode, unchanged on focus. Keep compact copy/time rows, subscribe to core date/time preferences, and show tool work as plain collapsible action rows with file/terminal icons rather than bordered cards.

- File drags cover the conversation below its header with a translucent Drop to attach overlay, without flickering across child elements. Keep a soft bottom fade above the composer and an accessible jump-to-latest arrow only while scrolled away; incoming output must preserve the user’s reading position.

- Assistant left navigation uses two 38px rows: Chat title and enabled Telegram/WhatsApp then Chat and time icons together on the same header line; persistent shared search field plus New chat or channel settings beneath it. Never place the source icons in a separate row. Time preferences are independent per source and never combine sources. All lists use 5px outer padding. Time mode groups previews by date; project mode uses collapsible folder rows and Recents in one scroll area. Selection stays neutral gray, and expanding a folder never creates a conversation.

- The optional subscription monitor is disabled by default and uses the exact IoMdSpeedometer glyph. Show only Codex/Claude subscription allowance remaining and Working/Needs input/Idle status; never substitute API billing, context usage, message contents, prompts, or responses. Missing or stale readings stay unavailable, never zero or idle.

- Left-sidebar titles and project rows use Valley’s standard small interface text, matching chat body size. Keep project folders unselected when a child is active; highlight a chat only once, preferring its visible project row and falling back to Recents when hidden. Limit each project to five chats until Show more is clicked, including search results. Keep 2px gaps between rounded rows and a 6px right inset for action buttons.

- Subscription reset dates use the provider timestamp and Valley’s live date-format and 12/24-hour preferences in local time. Show a compact date/time line, without countdowns; omit unknown reset timestamps.

- Subscription usage belongs in its own speedometer Properties tab beside Info and Conversation, never inside the Conversation form. Register it only while the optional monitor is enabled and remove it immediately on disable.

- Left-sidebar conversation previews render Markdown through the injected host renderer, preserving compact inline emphasis and code inside the two-line clamp. Keep the entire row as the chat-opening action; omit embedded media and interactive Markdown controls from previews.
- Chat-row keyboard outlines enclose the complete row, including its action button. Parse complete message Markdown before visually clamping previews; preserve KaTeX layout and fonts, bold, italics and highlights without adding independently scrolling or delayed preview overlays.

- Keep left-sidebar chat rows dense: 4px vertical and 10px horizontal content padding, including project rows and Show more. Preserve the 2px separation between hover backgrounds and the 6px right action inset; Markdown previews add only a 1px title gap.

- Left-sidebar chat and project row hover/selection backgrounds use a 3px radius. Sent user-message bubbles use 7px vertical / 9px horizontal padding, reduced to 6px / 8px at narrow widths; keep their borderless fill and 5px bubble radius.

- The Recents section heading includes the same accessible expand/collapse chevron as Projects; toggling it hides only recent chat rows and never changes the open conversation.

- Show icon-only Telegram/WhatsApp source filters only when enabled in Settings, plus Chat, at every sidebar width. Chat, Telegram, and WhatsApp remain strictly separate; selecting the current source never mixes them. Composer Add/model controls share the permission control’s hover background and radius, with the theme’s bright title foreground.

- Never report a subscription provider as working from mocked transport tests alone. Verify a real allowance reading separately; credential lookup failures do not prove the provider app is signed out. Prefer the provider’s documented usage export when available, and keep quota and lifecycle integrations separate.

- Deploying an Assistant package does not repair a core subscription adapter. Unconnected Claude usage must explain the required status-line export rather than repeatedly asking the user to sign in.

- Composer reference matching includes the input border, shadow, corner radius, and internal spacing in both modes; do not apply the message bubbles’ borderless treatment to the input. Keep bubble padding and fonts unchanged for color-only requests.

- Preserve the current appearance using Valley’s shared semantic theme tokens directly. Token names describe visual roles only, never chat, Assistant, or AI; do not introduce feature-prefixed aliases or duplicate hardcoded color fallbacks.

- Composer placeholder colors belong in the shared semantic token registry too. Effort choices must persist per conversation and reach a supported provider request; never add decorative choices that are silently ignored.

- Assistant contributes chat titles and user/assistant message content to global Content Search through its own searchable dataset and result-card opener, like Email; results open the existing chat without starting a model turn.

- Telegram and WhatsApp connection lists align empty-state text with the Connections heading. Use the shared SVG plus glyph in a centered square add button, and remove wrapper top padding so the button and header match Backup.

- Subscription allowance and Codex/Claude Code activity now belong to the local Home plugin’s right sidebar. Do not restore the former Assistant subscription tab or settings.

- Assistant uses the bundled DeepSeek harness for conversations. Thinking controls default to Low, High, and Max, expose only supported model levels, and persist real provider effort values. New chats remain unsaved until a message or queued turn is submitted.

- Assistant remains an installed plugin. Desktop access means files and folders plus guarded terminal commands through Valley’s SDK and command bus; it does not add app/window automation.

- Assistant exposes only Vault only and Full access in its access controls, including the right sidebar. Full access enables external files, folders, and terminal commands directly in Chat without a Project or folder-picker prerequisite. Turning it off revokes that external scope; explicit Guards still apply.
- Full access coding runs in the background and reports file/terminal activity in the conversation, without native command-confirmation windows.

- Chat Settings describes the active conversation harness and real new-chat defaults; keep conversation history in Chat and expose its storage with a file-manager button. Projects remain simple sidebar folders with a gear opening the selected project in Settings. Put shared instructions, folder grants, and deletion only on that settings page. Group intermediate commentary and tool events once per turn behind a collapsed stopwatch disclosure with recorded elapsed time; show one final-response copy action and reveal timestamps on hover or keyboard focus.

- Work details use a compact timeline with a capped, internally scrollable height and theme-aware edge shadows. Show Working for / Worked for with actual elapsed time; keep copy glyphs and timestamps smaller than chat body text, with a compact metadata row.

- Telegram and WhatsApp conversations are read-only mirrors with a compact connection strip, no composer or send button, and per-chat connection indicators. A running transport alone is not evidence of a connected channel; show green only after a successful poll or authenticated webhook. Surface failed reply delivery in the mirrored conversation.

- Telegram and WhatsApp lists omit Recents outside time mode and use equal 5px top/left/right list padding. Preserve date grouping when the time icon is enabled and show the last-chat date/time below each channel title or preview using live core date/time preferences. Expanded work-timeline rows stay compact with a 2px inter-row gap.

- Telegram and WhatsApp rows share a renameable per-chat title at top left and full last-chat date/time at top right, including today; omit the redundant platform icon. Keep the connected dot and original channel/contact identity below, separate from the title; renaming must preserve identity, history and last-chat time.

- Action timeline labels and expanded input/output details use text 1px smaller than chat messages. Keep both input and output blocks transparent with matching spacing; never give only the input block a filled background.

- Assistant configuration and contextual behavior live in linked Markdown notes; preserve manually named chats and channel identities. Receive and preserve stickers independently of preview, interpretation, and sending support. Plan approvals bind all saved artifacts and the validated instruction snapshot; neither messages, audio, stickers nor attachment contents implicitly approve implementation.

- Compile explicit instruction includes atomically with an 8,192 UTF-8-byte limit including attribution; show invalid include chains and retain only the applicable last-valid snapshot. Persist inbound media IDs/jobs before acknowledgment, acquire ephemeral media promptly outside inference queues, and promote durable originals before creating turns. Apply vault conventions and reporting per resolved target path; external repositories retain their own conventions. Speech uses host-owned binary transport with bounded queues and generation-scoped playback cancellation, never high-frequency JSON IPC.

- Read Assistant-owned configuration through declared SDK metadata storage. Apply vault file Guards to user-linked vault notes; never relax global metadata restrictions merely to make canonical instruction notes readable.

- Render full chat messages with the SDK MarkdownView so KaTeX layout, active code blocks, embeds, code-copy actions and authenticated shared links remain intact. Raw rendered HTML in the sandbox is not an equivalent Markdown surface. Check superscripts and compact voice/plan controls visually in the installed app.

- Assistant sidebar empty messages are horizontally centered at their existing vertical position. Use one square-and-pencil Compose glyph for standalone and project chat creation, including Recents; expanded projects use an open-folder glyph. Cancel and delete confirmations include X and trash icons.
- Assistant Settings uses native preference and connection controls backed by the existing Markdown records, with long-form instructions in linked notes. General, Chat, Projects, channels, and Evaluations have distinct content. Preserve Markdown bodies, advanced configuration, histories, credentials, and folders; localize configuration links by stable IDs.

- Grouped native Settings fields use the shared settings-row-control wrapper so sandboxed widgets fit beside labels. Icon/text button content carries its own inline alignment because host-widget portals do not retain the Assistant wrapper ancestor.

- Keep sidebar empty-state centering on a dedicated class beside sidebar styles so removing obsolete Settings styles cannot remove it; verify both empty and no-results messages in the installed app.

- Put standalone native dropdowns and number fields inside settings-row-control wrappers. Do not override sandbox widget placeholder flex bases or widths: this can make host controls overlap labels. Verify the exact final deployed bundle at both widths after every layout correction; earlier screenshots do not validate a later patch.

- Keep Evaluations out of the left Settings navigation; preserve its packages, histories, and backend capabilities.

- Assistant errors use compact, themed alerts with a clear title and actionable message. Strip repeated Error/IPC wrappers, explain missing credentials at the connection, and never show duplicate raw transport errors.

- Message text and its rows scroll together in a shared host ScrollPanel. Collapsed work details unmount Markdown widgets; verify collapse, fast scrolling, growing output and jump-to-latest in the installed app. Never animate message position across the sandbox boundary.
- Connection forms have one green Save action beneath the fields, with saved feedback and red error text at the bottom; never put feedback above the connection heading.

- Generate chat names with the model selected for the active conversation, using two to four words and at most 40 characters. Center the title in the pane header, preserve manual titles, and explain Vault only restrictions accurately instead of claiming Full access tools do not exist.

- Chat failures render as an Error box with a concise explanation and collapsed technical details. Normalize stored message errors too, and strip tool-registry metadata before forwarding tool definitions to the shared AI API.

- Project settings show a clear folder section and an inline shared-instructions editor, with one bottom Save action. Keep source-note details and deletion collapsed under Manage project; visually exercise the final installed form.

- Stopped status belongs beside the most recent work duration, with a compact composer status only when there is no work row. Markdown wheel input must scroll the conversation natively when hovering text or links, in both directions.
- Stop feedback belongs to the current turn only; when it has no work row, show the composer status instead of labeling a previous completed turn.

- Verify Telegram with a real inbound message and accepted reply, including recovery after a failed or stopped turn. A new authenticated message must not stay trapped in a paused queue; /clear supersedes queued earlier messages without replaying interrupted tools.

- Keep independent chats running when navigating between them; Stop cancels only its conversation. Verify concurrent real model replies. Runtime text events are full snapshots, never append them; reconcile the final completion if streamed events are missing, and never silently finish with an empty reply.
- Conversation and channel-delivery errors stay scoped to their conversation, including restored failed sessions; never promote a background chat failure into a global chat alert.
- Channel final answers are delivered automatically once. Keep receipt IDs and delivery confirmations out of ordinary replies; /start welcomes the user without resetting their history.
- Assistant Footer details uses the shared selectable, reorderable provider. Status follows the selected conversation's real execution state, including Thinking, Writing, Working, Finished, Stopped and Error; keep model selection, message/queue counts and running-chat count optional.

- Voice orbs keep gentle motion in every visible state and stronger flowing motion while thinking. Keep their center and canvas footprint fixed, blend state changes, honor reduced motion, and stop animation when hidden or unmounted.

- Chat-row three-dot buttons use equal 6px top and right insets from the row background, including preview rows; keep the entire action hit area inside that spacing.

- Composer access, effort and model menus declare their own host-widget occlusion bounds and use an opaque theme surface. Verify that Markdown text and copy controls cannot paint over the open menus, and reappear after dismissal, in the installed development app.

- A fresh typed message recovers a failed or stopped chat just like voice and authenticated channel input. Clear the current failure and start the new turn without replaying the failed turn, including while its final save is still pending; opening a chat alone must not resume it.

- The right-sidebar Assistant is self-contained: mobile-style Chat/Telegram/WhatsApp navigation, searchable chat/project lists, conversation, voice and conversation settings stay inside the sidebar. Opening or creating a chat there never switches the main workspace; retain drafts and list state when going back.
- Right-sidebar Chat, Telegram and WhatsApp are icon buttons in the persistent top header beside Voice, matching the left-sidebar controls. Never place them in bottom tabs; keep them available in the list, conversation and settings screens.
