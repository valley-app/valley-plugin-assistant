# Assistant

Assistant provides Chat conversations and Projects. A Project shares selected working folders and instructions across conversations; folders can be outside the vault. Files are edited directly through core Guards. Removing a folder revokes access and stops its work. Deleting a project preserves files and converts its conversations to standalone Chats.

AI Providers and Usage & Tokens live in core Artificial Intelligence settings. MCP connections also live there: each remote or local connection has its own account identity and encrypted credentials. Assistant discovers lightweight command summaries with `command_list`, loads only a selected schema with `command_describe`, and calls its exact ID with `command_execute`. For MCP it first lists `mcp:connections`, selects the requested account, then discovers that connection’s `mcp:tools`. Remote tool names and content never override conversation instructions. Unknown write outcomes require reconciliation before retrying.

AI Providers and Usage & Tokens live in main Settings beside Accounts. Core owns provider requests, credentials, budgets, and global Guards; these remain available with Assistant disabled. Other plugins use the typed `api.ai` service. Assistant retains conversation and channel rules.

Every conversation uses the bundled DeepSeek-based coding harness with its selected model. Saved older harness selections do not change execution. New chats remain in memory until their first submitted message or queued turn; empty stored conversations are hidden without deleting their data. Native runtimes are available on supported Macs; every turn starts an isolated session reconstructed from retained history. Runtime-specific adapters live in this package and use core transport and guarded execution.

Assistant is a manually installed plugin, with the same sandbox and SDK contracts as other plugins. It uses manifest API 5 and SDK 6. Its data lives under `.valley/plugins/data/assistant/`: `attachment/`, `chats/`, `channels/`, `personalities/`, `evaluations/`, and `harnesses/`. Messages, memory, and tool activity use JSONL. Folder overrides remain empty when unset; effective defaults are resolved at use time. Clearing an override preserves a visibly empty input.

Uploads, pasted files, and messaging attachments share ownership and reference records. Deleting a chat stops processes and removes its records and unshared owned attachments. Source files, uncertain legacy attachments, project files, and modified attachments are preserved. Failed cleanup resumes at startup and reports its errors.

Each turn groups intermediate commentary and tool work in one collapsed stopwatch section with elapsed time and a scrollable timeline. Expanding it retains nested calls, approvals, failures, commands, stdout/stderr, exit status, file diffs, and paged redacted output. Final replies have one copy action and optional timestamps on hover or keyboard focus. Large arguments and results are stored separately from the shortened model context.

Native builds cover macOS Apple Silicon and Intel. `vendor/native/manifest.json` records the pinned sources and SHA-256 for every runtime artifact. DeepSeek uses commit `477b4f420553e8a52c2fbccc464d7561b239c443` with bundled Node 24.19.0. Only this runtime and its dependencies ship. Its small stdio adapter delegates model requests and tool effects to Valley: the command bus, guarded file operations, selected project folders, and terminal commands remain the integration points. Evaluation harnesses stay separate.

Licenses, dependency notices, and source provenance ship in `runtime/assets/native/`. Rebuild DeepSeek with `npm ci --ignore-scripts --prefix vendor/native/build` and `node vendor/native/build/deepseek.mjs /path/to/pinned/source`. After replacing binaries, run `node vendor/native/build/package.mjs`; the plugin build verifies these hashes before copying artifacts.

The compatibility `valley.text-embeddings` v1/v2 services forward to core AI. V2 includes a connection/endpoint source hash and optional model revision. Ollama revisions use its model digest; OpenAI revisions are unknown. Callers may require an expected identity to detect connection or digest changes around a request.

## Subscription monitor

Codex and Claude Code allowance and activity now live at the bottom of the local Home plugin’s right sidebar. Home uses Valley’s shared subscription service independently of Assistant and retains the existing export and lifecycle integration.

## One-time ownership transfer

Keep Valley closed. Complete the core vault-layout transfer first. `tooling/transfer-assistant.mjs` prepares a separate recovery backup containing every changed source and staged destination; it verifies encrypted values without printing them. Run preparation through the same Electron/Valley identity that can decrypt existing credentials:

```sh
/path/to/Electron tooling/transfer-assistant.mjs --vault=/explicit/vault --user-data=/explicit/device/profile --backup=/external/recovery/assistant-transfer
node tooling/transfer-assistant.mjs --apply --backup=/external/recovery/assistant-transfer
```

The first command stages only. The second verifies source baselines, writes and verifies destinations, removes transferred sources, and records completion last. Rerun the apply command to resume an interrupted transfer. Unchanged shipped provider packages are verified against their original hashes and retired into the recovery backup because core now supplies them. Changed sources, conflicting policies or credentials, and enabled custom provider packages require resolution before ownership switches; no legacy reader remains in the runtime. The recovery plan records original paths and hashes.

Existing IDs, model selections, explicit attachment destinations, and resolvable file links are retained. Attachment references with uncertain ownership are imported without deletion rights. Missing associations are listed in `transfer-report.json`. Startup imports the verified transfer records through Assistant's dataset service before admitting conversations.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface and background engine.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK/testkit/build tools and bundled native runtimes, licenses, source patches, and build inputs.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Chat appearance

The right sidebar has Chat, Telegram and WhatsApp icons beside Voice in its persistent top header. Its chat list, search, projects, conversation, voice and conversation settings work without opening the main workspace. Back returns to the list; drafts stay with their conversation.

The composer and messages use Valley’s shared light/dark theme directly. The background uses `--surface-color-alt`; messages use `--content-text`, `--content-muted`, and `--surface-raised`. Elevated inputs use `--input-elevated-{bg,border,placeholder,shadow}`, menus use `--menu-glass-{bg,border,shadow}`, and actions use `--hover-bg-strong`, `--button-contrast-{bg,text}`, and `--warning-strong-color`. These semantic tokens cross the sandbox style contract and remain theme-overridable. There is no separate plugin palette or duplicated color fallback. Message prose (prompts and replies, in the main page and the right sidebar) renders as Markdown in the host's embedded reading view with the note reading view's typography: font, size, line height, paragraph and heading spacing, heading sizes, inline code and tables follow the theme's Markdown settings, and a streaming reply uses the same font, size and line height. Work details (tool rows, commentary, command output), fenced code and the composer keep their compact sizes; bubble padding and composer geometry are unchanged.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.

The composer effort popover saves its selection per conversation. Low, High, and Max are the default choices; additional levels appear only for supported models. Reset uses the provider default. Changing models clears an incompatible effort. DeepSeek thinking continuation is retained privately with the conversation and returned to the same provider/model for tool calls. Model pickers include usable API-key connections and discovered local models; unavailable saved selections never silently switch providers.

Chat, Telegram, and WhatsApp have separate sidebar views. Connection status appears per conversation; remote chats are read-only mirrors with a compact connection strip. A green indicator requires a successful Telegram poll or authenticated WhatsApp webhook. Failed reply delivery appears in the mirrored conversation. Channel rows use equal 5px list insets, a renameable chat title and full last-chat date/time above the original channel identity. Time mode preserves date grouping. Projects and the ordinary New Chat button remain in Chat.

The Conversation sidebar and composer offer Vault only and Full access. Vault only confines file and terminal work to the vault. Full access enables external files, folders, and terminal commands directly in any conversation, including Desktop coding, without requiring a Project or folder picker. Explicit Guards and unsaved-editor protections still apply. Turning Full access off invalidates external access and stops affected processes. Projects continue to provide shared instructions and a preferred working directory; deleting one never deletes its files.

## Content Search

Global Content Search includes saved conversation titles and user/assistant messages. Select a result to reopen that conversation and continue chatting; searching does not start a model request. Settings → Search → Content Search controls inclusion. Tool output and system instructions are excluded. The plugin maintains a rebuildable `chat_search` dataset in its cache; JSONL chat histories remain the source of truth.

Chat Settings shows the active DeepSeek harness, current new-chat defaults, composer preferences, and a file-manager shortcut to stored chats. Evaluation packages remain separate. Projects are simple sidebar folders; their gear opens the exact project under Settings → Assistant → Projects for shared instructions, working folders, and deletion.

## Workflow integration

The backend explicitly registers its supported blocks through `registerWorkflowContribution`. Workflow calls the owning operations with their original authentication, cancellation, grants, revisions, and receipts. The catalogue publishes Draft-07 parameter and port contracts; credential administration and approval bypasses are excluded. Workflow availability is configured separately in Workflow → Plugins. Existing account, connection, and profile settings remain owned by this plugin.

Workflow output collections are explicit: `listChats` → `$.chats`, `readChat` → `$.thread.messages`, `readMemory` → `$.memory`. Selectors are relative to each execution item’s `json`. Session state contains queues, thread messages and attachments, so those snapshots have no collection selector. Telegram delivery IDs remain receipt metadata.
