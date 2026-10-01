import chartsCss from './charts/Charts.css'
import loadingCss from './charts/core/shells/LoadingCircle.css'
import projectsCss from './ProjectMode.css'
import mathCss from 'katex/dist/katex.min.css'
/**
 * Plugin styles, injected once. Uses the real Notes design tokens
 * (src/renderer/src/styles/tokens.css) so the assistant matches the app under
 * both light and dark themes — never invents variable names.
 */
const STYLE_ID = 'assistant-plugin-styles'

const CSS = `
.assistant-project-form { padding-top:14px; }
.assistant-project-form > .settings-description { margin-bottom:14px; }
.assistant-project-section { padding:18px 0; border-bottom:1px solid var(--border-light); }
.assistant-project-section-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; color:var(--title-color); }
.assistant-project-section-head > svg { width:18px; height:18px; color:var(--text-secondary); flex:none; }
.assistant-project-section-head h4 { margin:0; font:inherit; font-weight:500; }
.assistant-project-section-head > button { margin-left:auto; }
.assistant-project-section > .settings-description { margin:0 0 12px; }
.assistant-project-section > textarea { min-height:140px; }
.assistant-project-empty { padding:14px; border:1px dashed var(--border-medium); border-radius:var(--radius-sm); color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-project-folder { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border-light); border-radius:var(--radius-sm); margin-top:6px; }
.assistant-project-folder > svg { flex:none; color:var(--text-secondary); }
.assistant-project-folder > div { flex:1; min-width:0; }
.assistant-project-folder strong, .assistant-project-folder span { display:block; overflow-wrap:anywhere; }
.assistant-project-folder strong { font-weight:500; }
.assistant-project-folder span { margin-top:3px; font-size:var(--smaller-font-size); color:var(--text-secondary); }
.assistant-project-manage { display:flex; gap:8px; padding-top:10px; }
.assistant-project-delete { color:var(--tint-red); }

.assistant-error-notice { width:100%; box-sizing:border-box; }
.assistant-error-notice details { margin-top:8px; }
.assistant-error-notice summary { cursor:pointer; color:var(--text-secondary); font-size:var(--smaller-font-size); }
.assistant-error-notice pre { max-height:160px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:var(--smaller-font-size); font-family:var(--mono-font); padding-top:8px; }

.assistant-connection-footer { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:16px 0 20px; }
.assistant-connection-save { padding:7px 18px; border:1px solid var(--positive-color); border-radius:var(--radius-sm); background:var(--positive-color); color:var(--accent-button-text); font:inherit; cursor:pointer; }
.assistant-connection-save:disabled { opacity:.5; cursor:default; }
.assistant-connection-save:focus-visible { outline:2px solid var(--positive-color); outline-offset:3px; }
.assistant-connection-saved { color:var(--positive-color); font-size:var(--small-font-size); }
.assistant-connection-error { flex-basis:100%; margin:0; color:var(--tint-red); overflow-wrap:anywhere; font-size:var(--small-font-size); }

.assistant-panel { container-type:inline-size; container-name:assistant-sidebar; font-size:var(--small-font-size); line-height:1.45; display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; box-sizing:border-box; }
.assistant-panel-head { flex:0 0 auto; margin:0; height:var(--app-bar-height); box-sizing:border-box; border-bottom:1px solid var(--border-light); padding:0 var(--space-3); }
.assistant-panel-head .panel-title { text-transform:none; letter-spacing:normal; font-size:inherit; font-weight:500; }
.assistant-sidebar-toolbar { display:flex; align-items:center; gap:6px; flex:0 0 auto; height:var(--app-bar-height); box-sizing:border-box; border-bottom:1px solid var(--border-light); padding:0 var(--space-3); color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-source-filters { display:flex; align-items:center; margin-left:auto; min-width:0; gap:4px; -webkit-app-region:no-drag; }
.assistant-source-filters .assistant-iconbtn { align-items:center; justify-content:center; padding:4px; font:inherit; flex:0 0 auto; border-radius:3px; }
.assistant-source-filters [aria-pressed="true"] { background:var(--hover-bg); color:var(--title-color); }
.assistant-sidebar-toolbar.search-field-row { padding:0 var(--search-field-inline-inset); }
.assistant-sidebar-toolbar > .search-field { flex:1; min-width:0; }
.assistant-sidebar-toolbar > .assistant-iconbtn { flex-shrink:0; }
.assistant-sidebar-empty { text-align:center; }
.assistant-mobile { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; color:var(--content-text); background:var(--surface-color-alt); font-size:var(--small-font-size); }
.assistant-mobile-content { flex:1; min-height:0; min-width:0; overflow:hidden; }
.assistant-mobile-list { height:100%; min-height:0; }
.assistant-mobile-list[hidden] { display:none; }
.assistant-mobile-head { display:flex; align-items:center; background:var(--container-color); }
.assistant-mobile-head .panel-title { font-size:inherit; font-weight:500; }
.assistant-mobile-head .assistant-iconbtn { width:24px; height:24px; box-sizing:border-box; }
.assistant-mobile-head .assistant-iconbtn svg { width:16px; height:16px; }
.assistant-mobile-sources { display:flex; align-items:center; gap:4px; }
.assistant-mobile :is(button, input):focus-visible { outline:2px solid var(--accent-color); outline-offset:-2px; }
.assistant-mobile .assistant-mobile-chat-head { display:grid; grid-template-columns:28px minmax(0,1fr) 28px; gap:4px; padding:0 6px; }
.assistant-mobile-chat-head .assistant-page-title-wrap { position:static; pointer-events:auto; min-width:0; }
.assistant-mobile-chat-actions { display:flex; align-items:center; justify-content:flex-end; gap:4px; }
.assistant-mobile-chat-head .assistant-iconbtn, .assistant-mobile-details-head .assistant-iconbtn { align-items:center; justify-content:center; width:28px; height:28px; box-sizing:border-box; }
.assistant-mobile .assistant-message-content { padding:14px 10px; gap:14px; }
.assistant-mobile .assistant-composer-dock { padding:8px; }
.assistant-mobile .assistant-channel-banner { padding:8px; gap:6px; }
.assistant-mobile .assistant-row-actions { opacity:1; }
.assistant-mobile .assistant-channel-row .assistant-row-actions { pointer-events:auto; }
.assistant-mobile-details { display:flex; flex-direction:column; height:100%; min-height:0; }
.assistant-mobile-details-head { display:flex; align-items:center; gap:8px; flex:none; height:var(--app-bar-height); box-sizing:border-box; padding:0 6px; border-bottom:1px solid var(--border-light); color:var(--title-color); }
.assistant-mobile-details-head > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-mobile-details-body { flex:1; min-height:0; }
.assistant-mobile-details .right-panel-body { height:auto; overflow:visible; }
.assistant-sidebar-scroll { flex:1; min-height:0; overflow-y:auto; padding:5px; }
.assistant-thread-time { display:block; margin-top:1px; font-size:var(--smaller-font-size); color:var(--text-tertiary); line-height:1.4; font-variant-numeric:tabular-nums; }
.assistant-chat-section { display:flex; flex-direction:column; gap:2px; margin:0 0 20px; }
.assistant-chat-section h3 { display:flex; align-items:center; gap:6px; margin:0; padding:16px 10px 8px; font-size:inherit; font-weight:400; color:var(--text-secondary); }
.assistant-thread-open { display:block; min-width:0; flex:1; width:100%; padding:4px 10px; border:none; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:3px; }
.assistant-thread-line { display:flex; align-items:center; gap:5px; min-width:0; }
.assistant-thread-line > svg { flex:0 0 auto; width:14px; height:14px; color:var(--text-secondary); }
.assistant-thread-project { flex:0 1 auto; min-width:0; max-width:35%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); }
.assistant-thread-preview { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-top:1px; color:var(--text-secondary); font-size:var(--smaller-font-size); line-height:1.4; overflow-wrap:anywhere; }
.assistant-thread-preview :is(strong,b) { color:inherit; font-weight:600; }
.assistant-thread-preview code { color:inherit; background:none; padding:0; font-size:inherit; font-family:var(--mono-font); white-space:normal; }
.assistant-thread-preview mark { color:inherit; background:var(--accent-tint-bg); border-radius:2px; padding:0 1px; }
.assistant-thread-math { display:inline-block; max-width:100%; vertical-align:baseline; }
.assistant-thread-math .katex { font-size:1em; white-space:normal; }
.assistant-thread-row:has(> button:focus-visible) { outline:2px solid var(--accent-color); outline-offset:-2px; }
.assistant-panel .assistant-thread-row > button:focus-visible { outline:none; box-shadow:none; }
.assistant-row-actions { flex:0 0 auto; opacity:0; }
.assistant-thread-row:hover .assistant-row-actions, .assistant-thread-row:focus-within .assistant-row-actions, .assistant-project-tree-row:hover .assistant-row-actions, .assistant-project-tree-row:focus-within .assistant-row-actions { opacity:1; }
.assistant-thread-row.has-preview { align-items:flex-start; }
.assistant-thread-row:not(.assistant-channel-row) .assistant-row-actions { align-self:flex-start; margin-block:6px; }
.assistant-ico { color:var(--text-secondary); flex:0 0 auto; }
.assistant-quick { display:flex; flex-direction:column; gap:6px; }
.assistant-quick-input, .assistant-composer-input, .assistant-input, .assistant-textarea, .assistant-select {
  background:var(--surface-color); color:var(--text-color); border:1px solid var(--border-medium);
  border-radius:var(--radius-sm); padding:6px 8px; font:inherit; resize:vertical; box-sizing:border-box; width:100%;
}
.assistant-select { width:auto; }
/* Model/parser pickers are the shared SelectField: it owns border, background
   and caret, so the plugin rule above must not also paint them. */
.assistant-input.select-field { width:100%; min-height:32px; padding:6px 8px; }
.assistant-textarea.assistant-mono { font-family:var(--mono-font); font-size:var(--smaller-font-size); }
.assistant-thread-list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
.assistant-thread-row { display:flex; align-items:center; justify-content:space-between; gap:6px;
  padding:0 6px 0 0; border-radius:3px; color:var(--title-color); }
.assistant-thread-row:hover { background:var(--hover-bg); }
.assistant-thread-row.active { background:color-mix(in srgb,var(--container-color) 90%,var(--title-color)); color:var(--title-color); }
.assistant-thread-working { display:inline-flex; flex:none; color:var(--text-muted); }
.assistant-thread-working svg { width:12px; height:12px; }
.assistant-thread-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; font-size:inherit; }
.assistant-channel-row { position:relative; padding:0; }
.assistant-channel-row .assistant-thread-title { flex:1; }
.assistant-channel-meta { display:flex; align-items:center; gap:8px; min-width:0; margin-top:1px; padding-right:24px; color:var(--text-tertiary); font-size:var(--smaller-font-size); line-height:1.4; }
.assistant-channel-identity { display:flex; align-items:center; gap:5px; flex:1; min-width:0; }
.assistant-channel-identity > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-channel-row .assistant-thread-line .assistant-thread-time { flex:0 0 auto; margin:0; white-space:nowrap; }
.assistant-channel-row .assistant-row-actions { position:absolute; right:6px; bottom:2px; pointer-events:none; }
.assistant-channel-row:hover .assistant-row-actions, .assistant-channel-row:focus-within .assistant-row-actions { pointer-events:auto; }
.assistant-thread-del { opacity:0; }
.assistant-thread-row:hover .assistant-thread-del { opacity:1; }
.assistant-empty, .assistant-welcome { color:var(--text-secondary); font-size:0.8125rem; padding:8px; }
.assistant-iconbtn { background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:4px;
  border-radius:var(--radius-sm); display:inline-flex; }
.assistant-iconbtn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-btn { display:inline-flex; align-items:center; gap:6px; background:var(--accent-color); color:var(--accent-button-text);
  border:none; border-radius:var(--radius-sm); padding:6px 12px; cursor:pointer; font:inherit; }
.assistant-btn:disabled { opacity:.5; cursor:default; }
.assistant-btn-sm { padding:4px 10px; font-size:0.75rem; }
.assistant-activity-expand, .assistant-activity-body > .assistant-btn { align-self:flex-start; }
.assistant-btn-ghost { background:transparent; color:var(--text-secondary); border:1px solid transparent; }
.assistant-btn-ghost:hover:not(:disabled) { background:var(--hover-bg); color:var(--text-color); }
.assistant-stop { background:var(--container-color-alt); color:var(--text-color); border:1px solid var(--border-medium); }
.assistant-quiz-choices { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 4px; }
.assistant-quiz-choices .assistant-btn { min-width:44px; justify-content:center; }

.assistant-page { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; box-sizing:border-box; background:var(--surface-color-alt); color:var(--content-text);
  container-type:inline-size; container-name:assistant-page; }
.assistant-page-head { position:relative; display:flex; align-items:center; justify-content:space-between; gap:12px;
  height:var(--app-bar-height); box-sizing:border-box; flex:0 0 auto; padding:0 calc(var(--plugin-actions-offset, 0px) + 18px) 0 18px; border-bottom:1px solid var(--border-light); background:var(--container-color-alt); }
.assistant-page-title-wrap { position:absolute; inset-inline:max(48px,calc(var(--plugin-navigation-offset, 0px) + 18px),calc(var(--plugin-actions-offset, 0px) + 18px)); top:0; bottom:0; min-width:0; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:1px; text-align:center; pointer-events:none; }
.assistant-page-title { display:block; max-width:100%; font-weight:500; color:var(--title-color);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.25; }
.assistant-page-source-icon { width:25px; height:25px; flex:0 0 25px; margin-left:var(--plugin-navigation-offset, 0px); }
.assistant-page-head > .assistant-connection-indicator { margin-left:auto; }
.assistant-connection-dot, .assistant-connection-indicator { display:inline-block; width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:var(--text-tertiary); }
.assistant-connection-dot, .assistant-connection-indicator.is-connected { background:var(--positive-color); }
.assistant-page-subtitle { font-size:0.6875rem; color:var(--text-tertiary); }
.assistant-live-pill { display:inline-flex; align-items:center; flex:0 0 auto; height:24px; padding:0 9px;
  border:1px solid var(--border-light); border-radius:999px; background:var(--surface-color); color:var(--text-secondary);
  font-size:0.75rem; }
.assistant-page :is(button, summary):focus-visible, .assistant-panel [role="button"]:focus-visible {
  outline:2px solid var(--accent-color); outline-offset:2px;
}
.assistant-welcome { width:100%; max-width:520px; box-sizing:border-box; margin:auto; padding:var(--space-4) 0; }
.assistant-welcome-mark { display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-3); color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-welcome h2 { margin:0 0 var(--space-2); color:var(--title-color); font-size:var(--h2-font-size); font-weight:500; line-height:1.3; }
.assistant-welcome p { margin:0; line-height:1.6; }
.assistant-starters { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:var(--space-2); margin-top:var(--space-4); }
.assistant-starter { display:flex; flex-direction:column; align-items:flex-start; gap:var(--space-3); padding:var(--space-3); text-align:left; font:inherit; color:var(--text-secondary); background:transparent; border:1px solid var(--border-light); border-radius:var(--radius-sm); cursor:pointer; }
.assistant-starter:hover:not(:disabled) { background:var(--hover-bg); color:var(--text-color); border-color:var(--border-medium); }
.assistant-starter:disabled { opacity:.5; cursor:default; }
.assistant-starter span { line-height:1.4; }
.assistant-page-controls { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.assistant-routebar { padding:4px 14px; font-size:0.6875rem; color:var(--text-secondary); border-bottom:1px solid var(--border-light); }
.assistant-route-reason { opacity:.7; }
.assistant-chat-body { position:relative; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; isolation:isolate; }
.assistant-messages { flex:1; min-height:0; min-width:0; overflow:hidden; }
.assistant-message-content { min-height:100%; box-sizing:border-box; padding:18px clamp(16px,4cqi,48px); display:flex; flex-direction:column; gap:16px; }
.assistant-composer-dock { position:relative; flex:0 0 auto; min-width:0; background:var(--surface-color-alt); }
.assistant-slash-menu { position:absolute; z-index:10; left:0; right:0; bottom:calc(100% + 8px); padding:6px; max-height:340px; overflow:auto; border:1px solid var(--border-light); border-radius:20px; background:var(--surface-raised); box-shadow:var(--shadow-md); }
.assistant-slash-menu > button { display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; border:0; border-radius:16px; text-align:left; color:var(--text-color); background:transparent; font:inherit; }
.assistant-slash-menu > button[aria-selected="true"], .assistant-slash-menu > button:hover { background:var(--hover-bg); }
.assistant-slash-menu > button > span:last-child { color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-plan-mode { display:inline-flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:var(--small-font-size); white-space:nowrap; }
.assistant-plan-mode svg { width:16px; height:16px; }
.assistant-plan-review { display:flex; flex-wrap:wrap; align-items:center; gap:8px; position:relative; padding:10px 12px; margin-bottom:8px; border-radius:16px; background:var(--surface-raised); }
.assistant-plan-review > span { flex:1 1 100%; min-width:0; font-size:var(--small-font-size); color:var(--text-secondary); }
.assistant-plan-review > span:nth-child(2) { display:flex; flex-wrap:wrap; gap:4px; }
.assistant-plan-review > button:last-child { margin-left:auto; }
.assistant-composer-dock > .assistant-voice-entry { padding:0 clamp(16px,4cqi,48px) 6px; }
.assistant-composer-dock > .assistant-voice-panel { margin:8px clamp(16px,4cqi,48px); }
.assistant-composer-dock::before { content:''; position:absolute; pointer-events:none; height:40px; left:0; right:0; bottom:100%; background:linear-gradient(to bottom,transparent,var(--surface-color-alt)); }
.assistant-jump-latest { position:absolute; z-index:1; top:-48px; left:50%; transform:translateX(-50%); display:flex; align-items:center; justify-content:center; width:32px; height:32px; padding:0; border:1px solid var(--border-medium); border-radius:50%; background:var(--container-color); color:var(--title-color); box-shadow:0 2px 10px #0002; cursor:pointer; }
.assistant-jump-latest svg { width:20px; height:20px; }
.assistant-jump-latest:hover { background:var(--surface-raised); }
.assistant-jump-latest:focus-visible { outline:2px solid var(--accent-color); outline-offset:2px; }
.assistant-drop-overlay { position:absolute; inset:0; z-index:5; display:grid; place-items:center; pointer-events:none; background:color-mix(in srgb,var(--accent-color) 26%,transparent); }
.assistant-drop-overlay > span { padding:8px 14px; border-radius:var(--radius-lg); background:var(--accent-color); color:var(--accent-button-text); box-shadow:0 4px 20px #0003; font-size:var(--font-size); }
/* No centered reading column: assistant text + tool blocks always start at the
   far left (full width), user bubbles always hug the right. */
.assistant-msg { min-width:0; max-width:100%; display:flex; flex-direction:column; gap:4px; width:100%;
  }
.assistant-msg.mine { align-items:flex-end; }
.assistant-msg.theirs { align-items:flex-start; }
.assistant-bubble { width:100%; min-width:0; max-width:100%; white-space:pre-wrap; word-break:break-word; color:var(--content-text); font-family:var(--body-font);
  font-size:0.875rem; line-height:1.6; background:transparent; padding:0; border-radius:0; border:none;
  -webkit-user-select:text; user-select:text; }
.assistant-msg.mine .assistant-bubble {
  background:var(--surface-raised); border:none;
  border-radius:5px; padding:7px 9px; max-width:85%; color:var(--content-text); box-sizing:border-box;
}
/* Copy + timestamp shown once, at the end of an assistant turn. The row reserves
   its height (placeholder) so revealing the controls on hover never shifts the
   layout below. */
.assistant-msg-meta { display:flex; align-items:center; gap:4px; min-height:20px; margin-top:0; padding:0; font-size:0.6875rem; line-height:1; }
/* My own (right-aligned) messages mirror the meta row → date then copy, copy nearest the edge. */
.assistant-msg.mine .assistant-msg-meta { flex-direction:row-reverse; }
.assistant-msg-meta > * { opacity:0; transition:opacity 120ms var(--ease-out); }
.assistant-msg.theirs .assistant-msg-meta > .assistant-copy-btn, .assistant-msg:hover .assistant-msg-meta > *, .assistant-msg-meta:focus-within > * { opacity:1; }
.assistant-copy-btn { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; min-width:20px; min-height:20px;
  padding:0; border:none; border-radius:var(--radius-sm); background:transparent; color:var(--text-secondary); cursor:pointer;
  transition:background 120ms var(--ease-out), color 120ms var(--ease-out); }
.assistant-copy-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-copy-btn:focus { outline:none; }
.assistant-copy-btn:focus-visible { outline:2px solid var(--accent-color); outline-offset:1px; }
.assistant-msg-meta .assistant-copy-btn > .assistant-copy-icon { width:12px; height:12px; flex:0 0 12px; }
.assistant-msg-meta .assistant-msg-time { font-size:inherit; line-height:1; color:var(--text-secondary); user-select:none; }
.assistant-wikilink, .assistant-bubble-md a.wikilink { color:var(--accent-color); text-decoration:none;
  cursor:pointer; font-weight:500; }
.assistant-wikilink:hover, .assistant-bubble-md a.wikilink:hover { background:var(--accent-tint-bg); }
/* Rendered Markdown inside a chat bubble: reset the bubble's pre-wrap, tighten the
 * shared .markdown-body rhythm so blocks sit snug in the small bubble. */
.assistant-bubble-md { --text-color:var(--content-text); --title-color:var(--content-text); white-space:normal; -webkit-user-select:text; user-select:text; }
.assistant-msg.mine .assistant-bubble-md { --text-color:var(--content-text); --title-color:var(--content-text); }
.assistant-bubble-md > :first-child { margin-top:0; }
.assistant-bubble-md > :last-child { margin-bottom:0; }
.assistant-bubble-md p { margin:0 0 8px; }
.assistant-bubble-md p:last-child { margin-bottom:0; }
.assistant-bubble-md ul, .assistant-bubble-md ol { margin:4px 0; padding-left:20px; }
.assistant-bubble-md li { margin:1px 0; }
.assistant-bubble-md h1, .assistant-bubble-md h2, .assistant-bubble-md h3,
.assistant-bubble-md h4, .assistant-bubble-md h5, .assistant-bubble-md h6 { margin:8px 0 4px; line-height:1.3; }
.assistant-bubble-md pre { margin:6px 0; padding:8px 10px; border-radius:var(--radius-sm); overflow:auto;
  background:var(--container-color-alt); border:1px solid var(--border-light); font:12px/1.5 var(--mono-font); }
.assistant-bubble-md code { font:12px/1.5 var(--mono-font); }
.assistant-bubble-md .code-block { margin:10px 0; min-width:0; border:1px solid var(--border-light); border-radius:var(--radius-sm); overflow:hidden; background:var(--container-color-alt); }
.assistant-bubble-md .code-block-header { display:flex; align-items:center; justify-content:space-between; gap:8px; height:var(--app-bar-height,38px); box-sizing:border-box; padding:0 10px; border-bottom:1px solid var(--border-light); color:var(--text-secondary); font-size:var(--smaller-font-size); }
.assistant-bubble-md .code-block-lang, .assistant-bubble-md .code-block-actions { display:inline-flex; align-items:center; gap:6px; }
.assistant-bubble-md .code-block-icon, .assistant-bubble-md .code-block-icon svg { display:block; width:14px; height:14px; }
.assistant-bubble-md .code-copy { display:flex; align-items:center; justify-content:center; width:26px; height:26px; padding:5px; border:0; border-radius:var(--radius-sm); background:transparent; color:var(--text-secondary); cursor:pointer; }
.assistant-bubble-md .code-copy:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-bubble-md .code-copy:focus-visible { outline:2px solid var(--accent-color); outline-offset:1px; }
.assistant-bubble-md .code-copy svg { width:14px; height:14px; }
.assistant-bubble-md .code-check-icon, .assistant-bubble-md .code-copy.copied .code-copy-icon { display:none; }
.assistant-bubble-md .code-copy.copied .code-check-icon { display:block; }
.assistant-bubble-md .code-block-scroll { overflow:auto; max-height:360px; }
.assistant-bubble-md .code-block-content { display:flex; align-items:stretch; min-width:max-content; }
.assistant-bubble-md .code-block-highlights { display:none; }
.assistant-bubble-md .code-block-line-numbers { flex:none; white-space:pre; padding:10px 0 10px 10px; color:var(--text-secondary); text-align:right; user-select:none; font:12px/1.5 var(--mono-font); }
.assistant-bubble-md .code-block pre { flex:1; border:0; border-radius:0; margin:0; padding:10px; overflow:visible; }

.assistant-bubble-md :not(pre) > code { padding:1px 4px; border-radius:4px; background:var(--container-color-alt); }
.assistant-bubble-md blockquote { margin:6px 0; padding:2px 0 2px 10px; border-left:3px solid var(--border-medium);
  color:var(--text-secondary); }
.assistant-bubble-md table { display:block; max-width:100%; overflow-x:auto; border-collapse:collapse; margin:6px 0; font-size:0.78125rem; }
.assistant-bubble-md th, .assistant-bubble-md td { border:1px solid var(--border-light); padding:4px 8px; }
.assistant-bubble-md a { color:var(--accent-color); }
.assistant-msg.mine .assistant-bubble-md pre,
.assistant-msg.mine .assistant-bubble-md :not(pre) > code {
  background: color-mix(in srgb, var(--container-color) 60%, transparent);
}
.assistant-bubble-image { display:block; max-width:100%; max-height:320px; margin:6px 0 2px; border-radius:var(--radius);
  border:1px solid var(--border-light); cursor:pointer; }
.assistant-bubble-image:hover { border-color:var(--accent-color); }
.assistant-attach-chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; }
.assistant-attach-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:var(--radius-sm);
  background:var(--container-color-alt); border:1px solid var(--border-light); color:var(--text-secondary); font-size:0.75rem; }
.assistant-attach-chip { max-width:100%; min-width:0; }
.assistant-message-files { display:flex; flex-wrap:wrap; gap:6px; max-width:100%; justify-content:flex-end; }
.assistant-attachment-warning { display:flex; align-items:center; gap:4px; color:var(--negative-color); font-size:var(--smaller-font-size); }
.assistant-attach-chip > img { width:36px; height:36px; object-fit:cover; border-radius:4px; }
.assistant-attach-chip > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-attach-chip button { background:none; border:none; color:var(--text-secondary); cursor:pointer; padding:0; line-height:1; }
.assistant-attach-chip button:hover { color:var(--accent-color); }
.assistant-attach-btn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; flex:0 0 auto;
  border-radius:var(--radius-sm); border:none; background:transparent; color:var(--text-secondary); cursor:pointer; }
.assistant-attach-btn:hover:not(:disabled) { color:var(--title-color); background:var(--hover-bg); }
.assistant-attach-btn:disabled { opacity:.4; cursor:default; }

.assistant-perm { position:static; display:inline-flex; flex:0 1 auto; min-width:0; }
.assistant-hand-btn { display:inline-flex; align-items:center; justify-content:center; height:28px; flex:0 1 auto; min-width:0;
  gap:var(--space-2); padding:0 var(--space-2); width:auto; max-width:100%; border-radius:var(--radius-lg); border:none; background:transparent; color:var(--content-text); font:inherit; font-size:var(--font-size); cursor:pointer; }
.assistant-hand-btn:hover:not(:disabled), .assistant-hand-btn.is-open { background:var(--hover-bg-strong); }
.assistant-hand-btn:disabled { opacity:.4; cursor:default; }
/* Self-contained chrome — intentionally NOT sharing .assistant-menu, whose
   position:fixed (declared later in this sheet) would override these and push the
   popover off-screen, and whose button/svg rules would out-specify the perm items. */
.assistant-perm-menu { position:absolute; bottom:100%; left:0; margin-bottom:6px; min-width:240px; max-width:300px;
  z-index:1001; padding:4px; background:var(--surface-color); border:1px solid var(--border-light);
  border-radius:var(--radius); box-shadow:0 4px 16px rgba(0,0,0,.12); }
.assistant-perm-item { display:flex; align-items:center; gap:9px; width:100%; padding:7px 9px; background:none;
  border:none; border-radius:12px; color:var(--content-text); font:inherit; text-align:left; cursor:pointer; }
.assistant-perm-item:hover, .assistant-perm-item:focus-visible { background:var(--hover-bg-strong); outline:none; }
.assistant-perm-ico { display:inline-flex; flex:0 0 auto; margin-top:0; color:var(--content-muted); }
.assistant-perm-ico svg { width:15px; height:15px; }
.assistant-perm-chevrons { font-size:15px; line-height:1; font-weight:700; width:15px; justify-content:center; }
.assistant-perm-text { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }
.assistant-perm-label { font-size:var(--font-size); font-weight:400; color:inherit; }
.assistant-perm-desc { font-size:var(--small-font-size); line-height:1.35; color:var(--content-muted); white-space:normal; }
.assistant-perm-check { width:14px; height:14px; flex:0 0 auto; margin-top:0; color:inherit; }
.assistant-perm-item.is-danger .assistant-perm-ico,
.assistant-perm-item.is-danger .assistant-perm-label,
.assistant-perm-item.is-danger .assistant-perm-desc,
.assistant-perm-item.is-danger .assistant-perm-check,
.assistant-hand-btn.is-danger { color:var(--warning-strong-color); }
.assistant-permission-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-hand-btn svg { flex:0 0 auto; }
.assistant-streaming { position:relative; }
.assistant-stream-caret { display:inline-block; width:6px; height:1.1em; margin-left:2px; vertical-align:-2px;
  border-right:2px solid var(--accent-color); animation:assistant-stream-blink 1s steps(2,start) infinite; }
.assistant-run-status { width:100%; align-self:flex-start; display:flex; align-items:flex-start;
  padding:4px 0; color:var(--text-secondary); animation:assistant-message-in 180ms var(--ease-out); }
.assistant-run-label { color: var(--text-tertiary); font-size:0.8125rem; font-weight: 400; }
.assistant-run-sub { display: none; }
.assistant-think-dots::after {
  content: '';
  animation: assistant-think-dots 1.2s steps(4, end) infinite;
}
@keyframes assistant-think-dots {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
  100% { content: ''; }
}
@keyframes assistant-message-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
@keyframes assistant-stream-blink { 0%,45% { opacity:1; } 46%,100% { opacity:0; } }
.assistant-tg-ico { color:#2aabee; flex:0 0 auto; }
.assistant-wa-ico { color:#25d366; flex:0 0 auto; }
.assistant-activity { width:100%; align-self:flex-start; color:var(--text-secondary);
  }
/* Group an assistant turn (text + tool steps + more text) tightly, while the
   16px flex gap still separates distinct user/assistant turns. */
.assistant-msg.theirs + .assistant-activity,
.assistant-activity + .assistant-activity,
.assistant-activity + .assistant-msg.theirs { margin-top:-8px; }
.assistant-activity summary { list-style:none; display:flex; align-items:flex-start; gap:7px; min-height:22px;
  padding:2px 0; border:none; border-radius:0; background:transparent; cursor:pointer; user-select:none;
  box-sizing:border-box; }
.assistant-activity-text { display:flex; flex-direction:row; align-items:baseline; gap:5px; min-width:0; flex:1; }
.assistant-activity summary::-webkit-details-marker { display:none; }
.assistant-activity summary:hover .assistant-activity-title { color:var(--title-color); }
.assistant-activity[open] summary { border:none; border-radius:0; }
.assistant-activity-caret { width:12px; height:12px; margin-top:3px; flex:0 0 auto; color:var(--text-tertiary); transition:transform var(--duration-fast) var(--ease-out); }
.assistant-activity[open] .assistant-activity-caret { transform:rotate(90deg); }
/* Title never shrinks (shown in full); only the parenthetical meta ellipsizes.
   max-width:100% caps the title so that IF it alone exceeds the row it still
   ellipsizes instead of overflowing — at which point the meta is squeezed to 0. */
.assistant-activity-title { flex:0 0 auto; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-tertiary); font-size:0.78125rem; font-weight:400; }
.assistant-activity-meta { min-width:0; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--text-tertiary); font-size:0.75rem; }
.assistant-activity-body { position:relative; display:flex; flex-direction:column; gap:0; padding:4px 0 2px 26px;
  border:none; border-radius:0; background:transparent; }
.assistant-activity-step { position:relative; padding:6px 0 11px 6px; border:none; border-radius:0; background:transparent; }
/* Connector runs icon-center → next-icon-center: only downward from each node, so
   no line ever sits above the first icon, and the last node (Done) has none below.
   left:-14px aligns to the icon center; top/bottom:15px is the 16px icon's half-height. */
.assistant-activity-step:not(:last-child)::before { content:''; position:absolute; left:-14px; top:15px; bottom:-15px;
  width:1px; background:var(--border-medium); }
.assistant-activity-step-head { display:flex; align-items:center; gap:8px; min-width:0; }
.assistant-activity-step-ico { position:absolute; left:-22px; top:7px; width:16px; height:16px;
  display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; color:var(--text-tertiary);
  background:var(--container-color-alt); }
.assistant-activity-step-ico svg { width:13px; height:13px; }
.assistant-activity-step-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--title-color); font-size:0.78125rem; font-weight:600; }
/* Terminal "Done" node — a quiet end-cap; the check inherits the same gray
   (--text-tertiary) and 13px size as every other step glyph, so it blends in. */
.assistant-activity-done .assistant-activity-step-title { color:var(--text-secondary); font-weight:500; }
.assistant-activity-args { margin:7px 0 0; padding:8px; max-height:180px; overflow:auto; border:1px solid var(--border-light);
  border-radius:var(--radius-sm); background:var(--container-color-alt); color:var(--text-secondary); white-space:pre-wrap;
  word-break:break-word; font:11px/1.45 var(--mono-font); }
.assistant-activity-output { margin-top:5px; padding:0; max-height:240px; overflow:auto; border:none; border-radius:0;
  background:transparent; color:var(--text-secondary); white-space:pre-wrap; word-break:break-word;
  font-size:0.78125rem; line-height:1.5; }
.assistant-approval { align-self:stretch; background:var(--accent-tint-bg); border:1px solid var(--accent-color);
  border-radius:var(--radius-sm); padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.assistant-approval-text { color:var(--text-color); font-size:0.8125rem; }
.assistant-approval-target { color:var(--text-secondary); }
.assistant-approval-args { margin:6px 0 0; padding:8px 10px; border-radius:var(--radius-sm); background:var(--container-color-alt);
  font-family:var(--mono-font); font-size:var(--smaller-font-size); color:var(--text-secondary); white-space:pre-wrap; word-break:break-word; }
.assistant-approval-actions { display:flex; flex-wrap:wrap; gap:8px; }
.assistant-approval-details > summary { cursor:pointer; font-size:0.75rem; color:var(--text-secondary); }
.assistant-btn-danger { background:var(--negative-color); color:var(--accent-button-text); }
.assistant-btn-ghost.assistant-btn-danger { background:transparent; color:var(--negative-color); }
/* Temporary permission bypass ("dangerous mode") — always-visible elevated state. */
.assistant-danger-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:999px;
  border:1px solid var(--accent-color); background:var(--accent-tint-bg); color:var(--accent-color);
  font-size:0.6875rem; font-weight:600; cursor:pointer; }
.assistant-danger-chip:hover { background:var(--accent-color); color:var(--accent-button-text); }
.assistant-danger-warning { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:var(--radius);
  background:var(--accent-tint-bg); border:1px solid var(--accent-color); color:var(--accent-color);
  font-size:0.75rem; font-weight:600; }
.assistant-danger-off { margin-left:auto; padding:2px 8px; border-radius:var(--radius-sm); border:1px solid var(--accent-color);
  background:transparent; color:var(--accent-color); font:inherit; font-size:0.6875rem; cursor:pointer; }
.assistant-danger-off:hover { background:var(--accent-color); color:var(--accent-button-text); }
.assistant-composer { position:relative; display:flex; flex-direction:column; gap:10px; margin:10px clamp(16px,4cqi,48px) 14px;
  flex:0 0 auto; min-width:0; box-sizing:border-box; padding:8px; border:1px solid var(--input-elevated-border); border-radius:24px; background:var(--input-elevated-bg); box-shadow:var(--input-elevated-shadow); }
.assistant-composer:focus-within { outline:none; }
.assistant-composer-input { width:100%; border:none; background:transparent; padding:6px 3px 0; resize:none; box-sizing:border-box;
  color:var(--content-text); font:var(--font-size)/1.45 var(--interface-font); line-height:1.45; min-height:42px; max-height:220px; overflow-y:auto; }
.assistant-composer-input:focus { outline:none; box-shadow:none; }
.assistant-composer-input::placeholder { color:var(--input-elevated-placeholder); opacity:1; }
.assistant-composer-toolbar { display:flex; align-items:center; gap:var(--space-2); min-width:0; }
.assistant-composer-left { display:flex; align-items:center; gap:6px; flex:0 1 auto; min-width:0; margin-right:auto; }
.assistant-composer-right { display:flex; align-items:center; justify-content:flex-end; flex:1; gap:6px; min-width:0; }
.assistant-model-wrap { display:flex; align-items:center; flex:0 1 auto; min-width:0; max-width:240px; }
.assistant-harness-select { width:130px; min-width:65px; max-width:100%; flex:0 1 130px; }
.assistant-harness-field { width:100%; min-width:0; border:0; background:transparent; padding:3px; color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-harness-field:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-model-select { display:flex; align-items:center; justify-content:flex-end; gap:var(--space-2); background:transparent; border:none; border-radius:var(--radius-sm); padding:3px;
  color:var(--content-text); font:inherit; font-size:var(--font-size); cursor:pointer; width:100%; max-width:240px; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; -webkit-appearance:none; -moz-appearance:none; appearance:none; }
.assistant-model-select:hover:not(:disabled), .assistant-model-select[aria-expanded="true"] { background:var(--hover-bg-strong); }
.assistant-model-select > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-popover-dismiss { position:fixed; inset:0; z-index:1000; }
.assistant-composer-popover { position:absolute; bottom:44px; right:44px; width:256px; max-width:calc(100% - 16px); max-height:min(420px,60vh); z-index:1001; box-sizing:border-box; overflow:auto; border:1px solid var(--menu-glass-border); border-radius:17px; background:linear-gradient(var(--menu-glass-bg),var(--menu-glass-bg)),var(--surface-color-alt); color:var(--content-text); box-shadow:var(--menu-glass-shadow); }
.assistant-model-wrap .assistant-composer-popover { max-width:calc(100% - 52px); }
.assistant-perm .assistant-composer-popover { left:8px; right:auto; width:440px; }
.assistant-composer-menu-title { margin:0; padding:10px 12px 4px; color:var(--content-muted); font-size:var(--font-size); font-weight:400; }
.assistant-permissions-list { padding:3px 4px 5px; }
.assistant-effort-menu { padding:12px; text-align:center; }
.assistant-effort-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.assistant-effort-heading > svg { width:15px; height:15px; color:var(--content-muted); }
.assistant-effort-heading strong { color:var(--accent-color); font-size:1rem; font-weight:500; }
.assistant-effort-reset { border:0; background:transparent; color:var(--content-muted); padding:0; width:20px; height:20px; font-size:1.5rem; line-height:1; cursor:pointer; }
.assistant-effort-reset:disabled { opacity:.4; cursor:default; }
.assistant-effort-model { display:flex; align-items:center; justify-content:center; gap:3px; width:100%; margin:2px 0 14px; padding:0; border:0; background:transparent; color:var(--content-muted); font:inherit; cursor:pointer; }
.assistant-effort-model svg { width:12px; height:12px; }
.assistant-effort-slider { appearance:none; box-sizing:border-box; display:block; width:100%; height:24px; margin:0; padding:0; border:1px solid var(--menu-glass-border); border-radius:999px; background:linear-gradient(to right,var(--accent-color) var(--slider-fill),var(--hover-bg-strong) var(--slider-fill)); cursor:pointer; }
.assistant-effort-slider::-webkit-slider-thumb { appearance:none; width:28px; height:28px; border:1px solid #0001; border-radius:50%; background:var(--accent-button-text,#fff); box-shadow:0 1px 2px #0002; }
.assistant-effort-levels { display:flex; align-items:start; justify-content:space-between; gap:3px; margin-top:7px; }
.assistant-effort-levels button { border:0; border-radius:3px; background:transparent; padding:2px; color:var(--content-muted); font:inherit; font-size:0.65rem; cursor:pointer; }
.assistant-effort-levels button[aria-pressed="true"] { color:var(--accent-color); }
.assistant-effort-levels button:disabled { opacity:.35; cursor:default; }
.assistant-effort-levels button:hover:not(:disabled) { background:var(--hover-bg-strong); }
.assistant-effort-unavailable { margin:4px 0 0; color:var(--content-muted); font-size:var(--small-font-size); }
.assistant-model-effort { color:var(--content-muted); }
.assistant-model-menu { width:100%; color:var(--content-text); font:var(--font-size)/1.4 var(--interface-font); }
.assistant-model-menu .search-field-row { height:var(--app-bar-height); box-sizing:border-box; border-bottom:1px solid var(--border-light); padding:calc(var(--space-3) / 2); }
.assistant-model-menu .search-field { width:100%; min-width:0; height:var(--search-field-height); box-sizing:border-box; padding:0 var(--space-2); color:var(--content-text); font:inherit; background:var(--hover-bg-strong); border:0; border-radius:var(--radius-sm); outline:none; }
.assistant-model-options { max-height:320px; overflow-y:auto; padding:calc(var(--space-3) / 2); }
.assistant-model-option { display:flex; align-items:center; gap:var(--space-2); width:100%; box-sizing:border-box; padding:6px 8px; min-height:29px; border:0; border-radius:12px; background:transparent; color:inherit; text-align:left; font:inherit; cursor:pointer; }
.assistant-model-option:hover, .assistant-model-option:focus-visible { background:var(--hover-bg-strong); outline:none; }
.assistant-model-option > span { display:grid; gap:2px; flex:1; min-width:0; }
.assistant-model-option strong { font-weight:400; color:inherit; overflow-wrap:anywhere; }
.assistant-model-option small { color:var(--content-muted); font-size:var(--small-font-size); overflow-wrap:anywhere; }
.assistant-model-option svg { flex:0 0 auto; color:var(--content-muted); }
.assistant-model-empty { margin:var(--space-3); color:var(--text-secondary); }
.assistant-model-chevron { width:13px; height:13px; flex:0 0 auto; color:var(--text-tertiary); pointer-events:none; transform:rotate(90deg); }
.assistant-route-caption { font-size:0.6875rem; color:var(--text-secondary); opacity:.8; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.assistant-send-round { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:50%; border:none; background:var(--button-contrast-bg); color:var(--button-contrast-text); cursor:pointer; }
.assistant-send-round:disabled { opacity:.4; cursor:default; }
.assistant-send-stop rect { fill:currentColor; stroke:none; }
.assistant-send-round svg { width:20px; height:20px; }
.assistant-send-round:hover:not(:disabled) { filter:brightness(.9); }

.assistant-channel-banner { display:flex; align-items:center; gap:8px; margin:10px clamp(16px,4cqi,48px) 16px; padding:9px 10px;
  border:1px solid var(--border-light); border-radius:var(--radius-sm); background:var(--container-color); color:var(--text-secondary); font-size:0.78125rem;
  min-width:0; }
.assistant-channel-banner > svg { width:20px; height:20px; flex:0 0 20px; }
.assistant-channel-banner > div { display:grid; gap:3px; min-width:0; }
.assistant-channel-banner span { overflow-wrap:anywhere; min-width:0; }
.assistant-channel-banner span + span { font-size:var(--smaller-font-size); color:var(--text-tertiary); }
/* Width-responsive layout keyed to the chat's OWN width (container query), so a
   narrow pane / sidebar reflows the same as a narrow window — a viewport @media
   can't see a narrow pane inside a wide window. cqi units track inline size too. */
@container assistant-page (max-width:720px) {
  .assistant-message-content { padding:14px 12px; }
  .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; width:auto; }
  .assistant-activity-meta { max-width:100%; }
  .assistant-composer, .assistant-channel-banner { margin-left:12px; margin-right:12px; }
}

/* Phone-width tier: squeeze chrome so nothing clips at sidebar widths. */
@container assistant-page (max-width:460px) {
  .assistant-page-head { padding:0 calc(var(--plugin-actions-offset, 0px) + 12px) 0 12px; gap:8px; }
  .assistant-message-content { padding:12px 10px; gap:10px; }
  .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; }
  .assistant-bubble { font-size:0.8125rem; }
  .assistant-msg.mine .assistant-bubble { padding:6px 8px; border-radius:5px; max-width:92%; }
  .assistant-composer { margin-left:10px; margin-right:10px; }
  .assistant-channel-banner { margin-left:10px; margin-right:10px; }
  .assistant-composer-toolbar { flex-wrap:nowrap; gap:4px; }
  .assistant-composer-right { flex:1; justify-content:flex-end; }
  .assistant-model-select { width:28px; height:28px; padding:6px; }
  .assistant-model-select > svg:first-child { display:block; }
  .assistant-model-select > span, .assistant-model-chevron, .assistant-permission-label { display:none; }
  .assistant-route-caption { display:none; }
  .assistant-welcome { padding:var(--space-3) 0; }
  .assistant-starters { grid-template-columns:1fr; }
  .assistant-starter { flex-direction:row; align-items:center; gap:var(--space-2); }
  .assistant-perm-menu { min-width:200px; }
}

/* Fallback for engines without container-query support: track the viewport. */
@supports not (container-type:inline-size) {
  @media (max-width:720px) {
    .assistant-message-content { padding:14px 12px; }
    .assistant-msg, .assistant-msg.mine, .assistant-activity, .assistant-run-status { max-width:100%; width:auto; }
    .assistant-activity-meta { max-width:100%; }
    .assistant-composer, .assistant-channel-banner { margin-left:12px; margin-right:12px; }
  }
}

@media (prefers-reduced-motion:reduce) {
  .assistant-msg, .assistant-activity, .assistant-run-status { animation:none; }
  .assistant-stream-caret { animation:none; }
}

.assistant-thread-group-label { display:flex; align-items:center; gap:6px; margin:10px 4px 2px; padding:0 4px;
  font-size:0.6875rem; font-weight:600; letter-spacing:.02em; color:var(--text-secondary); }

.assistant-source-btn { background:none; border:none; border-radius:var(--radius-sm); padding:4px; cursor:pointer;
  color:var(--text-secondary); display:inline-flex; align-items:center; justify-content:center; }
.assistant-source-btn:hover { background:var(--hover-bg); color:var(--text-color); }
.assistant-source-btn.active { background:var(--hover-bg); }
.assistant-source-btn.active.assistant-tg-btn { color:#2aabee; }
.assistant-source-btn.active.assistant-wa-btn { color:#25d366; }
.assistant-source-btn.active:not(.assistant-tg-btn):not(.assistant-wa-btn) { color:var(--accent-color); }

.assistant-thread-rename { flex:1; min-width:0; background:var(--surface-color); color:var(--text-color);
  border:1px solid var(--accent-color); border-radius:var(--radius-sm); padding:1px 6px; font:inherit; font-size:0.8125rem;
  outline:none; box-sizing:border-box; }

.assistant-instruction-list .settings-list-row { padding:12px 8px; border-bottom:1px solid var(--border-light); border-radius:3px; }
.assistant-instruction-list .settings-list-sub { white-space:normal; line-height:1.5; }
.assistant-instruction-editor { display:flex; flex-direction:column; gap:12px; min-width:0; padding:8px 0 16px; }
.assistant-instruction-editor > .settings-description { margin:0; line-height:1.5; }
.assistant-instruction-label { display:flex; flex-direction:column; gap:8px; font-size:var(--small-font-size); color:var(--text-secondary); }
.assistant-instruction-text { box-sizing:border-box; width:100%; min-height:260px; max-height:520px; resize:vertical; padding:12px; border:1px solid var(--border-light); border-radius:4px; background:var(--bg-primary); color:var(--text-primary); font:inherit; line-height:1.6; }
.assistant-instruction-text:focus-visible { outline:2px solid var(--accent-color); outline-offset:2px; }
.assistant-instruction-actions, .assistant-instruction-source, .assistant-instruction-link { display:flex; align-items:center; gap:8px; min-width:0; }
.assistant-instruction-actions, .assistant-instruction-source { flex-wrap:wrap; }
.assistant-instruction-count { margin-left:auto; color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-instruction-source { border-top:1px solid var(--border-light); padding-top:10px; color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-instruction-source > span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-instruction-links { color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-instruction-links summary { cursor:pointer; padding:4px 0; }
.assistant-instruction-link { margin-top:6px; }
.assistant-instruction-link > span { flex:1; overflow-wrap:anywhere; }
.assistant-instruction-link > :first-child { min-width:0; flex:1; }
.assistant-instruction-path { font-size:var(--small-font-size); color:var(--text-secondary); overflow-wrap:anywhere; }
.assistant-property-section { border-bottom:1px solid var(--border-light); }
.assistant-property-heading { display:flex; align-items:center; gap:8px; width:100%; min-height:38px; padding:6px 2px; border:0; background:transparent; color:var(--text-primary); font:inherit; font-size:var(--small-font-size); text-align:left; cursor:pointer; border-radius:3px; }
.assistant-property-heading:hover { background:var(--hover-bg); }
.assistant-property-heading > svg { width:14px; height:14px; flex-shrink:0; transition:transform 120ms ease; }
.assistant-property-heading > svg.expanded { transform:rotate(90deg); }
.assistant-property-body { padding:0 0 10px; min-width:0; }
.assistant-instruction-editor.compact { gap:8px; padding-bottom:0; }
.assistant-instruction-editor.compact .assistant-instruction-text { min-height:160px; padding:8px; }
.assistant-instruction-editor.compact .settings-description { font-size:var(--small-font-size); }
.assistant-attachment-defaults > .settings-row-control { width:100%; }
.assistant-preference-section { margin:0 0 var(--space-4); min-width:0; }
.assistant-preference-section > .settings-label { margin:var(--space-3) 0 var(--space-2); font-size:var(--small-font-size); color:var(--text-secondary); }
.settings-row-control > .assistant-native-field { flex:1 1 150px; width:auto; min-width:0; }
.assistant-preference-control { gap:6px; }
.assistant-preference-stack { display:flex; flex-direction:column; gap:6px; width:min(320px,50%); min-width:min(180px,50%); }
.assistant-preference-stack > .settings-row-control { width:100%; min-width:0; }
.assistant-settings button > span:has(> svg) { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.assistant-settings button svg { width:16px; height:16px; flex-shrink:0; }
.assistant-danger-row { margin-top:var(--space-4); padding-bottom:var(--space-4); border-top:1px solid var(--border-light); }
.assistant-settings { padding:4px 0; color:var(--text-color); }
.assistant-settings:has(> .settings-listpage) { padding-block:0; }
.assistant-settings .settings-list > .assistant-empty { padding-inline:10px; }
.assistant-settings > .settings-label { font-size:var(--small-font-size); color:var(--text-secondary); margin:var(--space-3) 0 var(--space-2); }
.assistant-empty { color:var(--text-secondary); font-size:0.8125rem; padding:10px 2px; }
.assistant-error-notice { display:flex; align-items:flex-start; gap:10px; box-sizing:border-box; width:100%; padding:12px; margin:10px 0; border:1px solid color-mix(in srgb,var(--tint-red-text) 35%,transparent); border-radius:5px; background:var(--tint-red-bg); color:var(--tint-red-text); font-size:var(--small-font-size); line-height:1.5; }
.assistant-error-notice > svg { flex:0 0 16px; width:16px; height:16px; margin-top:2px; }
.assistant-error-notice-content { flex:1; min-width:0; }
.assistant-error-notice-content > strong { display:block; font-weight:600; color:var(--tint-red-text); }
.assistant-error-notice-content > p { margin:3px 0 0; color:var(--text-color); white-space:pre-wrap; overflow-wrap:anywhere; }
.assistant-set-err { color:var(--tint-red-text); }

/* Chat-row context menu (right-click: Rename / Pin / Clear / Delete). */
.assistant-menu { position:fixed; z-index:1000; min-width:180px; padding:4px;
  background:var(--surface-color); border:1px solid var(--border-light); border-radius:var(--radius);
  box-shadow:0 4px 16px rgba(0,0,0,.12); }
.assistant-menu button { display:flex; align-items:center; gap:8px; width:100%; padding:5px 8px;
  background:none; border:none; border-radius:var(--radius-sm); color:var(--text-color); font:inherit; font-size:0.8125rem;
  cursor:pointer; text-align:left; }
.assistant-menu button:hover { background:var(--hover-bg); }
.assistant-menu button.danger { color:var(--tint-red-text, #b91c1c); }
.assistant-menu button svg { width:13px; height:13px; flex-shrink:0; color:var(--text-tertiary); }
.assistant-menu button.danger svg { color:inherit; }
.assistant-menu-sep { height:1px; margin:4px 6px; background:var(--border-light); }

/* Small pin glyph shown inline in pinned chat rows. */
.assistant-thread-pin { display:inline-flex; width:11px; height:11px; flex:0 0 auto;
  color:var(--text-tertiary); margin-right:2px; }
.assistant-composer-toolbar { flex-wrap:nowrap; }
.assistant-send-round { flex:0 0 28px; }
.assistant-composer :is(.assistant-attach-btn,.assistant-model-select) { height:28px; border-radius:999px; }
.assistant-composer .assistant-attach-btn { color:var(--content-text); padding:5px; }
.assistant-composer .assistant-attach-btn svg { width:18px; height:18px; }
.assistant-composer .assistant-attach-btn:hover:not(:disabled) { background:var(--hover-bg-strong); }
.assistant-hand-btn { border-radius:999px; }
.assistant-model-select { padding:0 8px; }
.assistant-model-select > svg { flex-shrink:0; color:inherit; }
@container assistant-page (min-width:461px) {
  .assistant-model-select > svg:first-child { display:none; }
}
.assistant-composer-input:disabled { opacity:1; }
.assistant-run-status { display:flex; align-items:center; gap:8px; padding:8px 0; color:var(--text-secondary); }
.assistant-think-dots { display:inline-block; }
.assistant-queue { display:grid; gap:4px; border-bottom:1px solid var(--border-light); padding-bottom:8px; max-height:180px; overflow:auto; }
.assistant-queue-heading { display:flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:var(--small-font-size); }
.assistant-queue-heading > span { flex:1; }
.assistant-queued-message { display:flex; gap:4px; align-items:center; min-width:0; }
.assistant-queued-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--small-font-size); }
.assistant-queued-message form { display:flex; width:100%; gap:4px; }
.assistant-queued-message textarea { flex:1; min-width:0; color:var(--text-color); background:var(--control-bg); border:1px solid var(--control-border); border-radius:var(--control-radius); font:inherit; }
.assistant-properties { padding:0 var(--space-3); }
.assistant-property-row { display:flex; align-items:center; min-height:38px; padding:6px 0; gap:12px; border-bottom:1px solid var(--border-light); box-sizing:border-box; }
.assistant-property-label { flex:0 0 34%; min-width:0; color:var(--text-secondary); font-size:var(--small-font-size); overflow-wrap:anywhere; }
.assistant-property-control { flex:1; min-width:0; display:flex; justify-content:flex-end; }
.assistant-property-control > *, .assistant-property-control .settings-row-control { min-width:0; max-width:100%; }
.assistant-property-control .settings-row-control { width:100%; }
.assistant-property-control .assistant-harness-select { width:100%; flex:1; }
.assistant-property-control :is(input,button) { font-size:var(--small-font-size); }
.assistant-properties-advanced > summary { cursor:pointer; padding:12px 0; font-size:var(--small-font-size); color:var(--text-secondary); }
.assistant-properties-advanced .assistant-property-row { display:none; }
.assistant-activity-group { border:none; border-radius:0; width:100%; min-width:0; box-sizing:border-box; }
.assistant-activity-group > summary { display:flex; align-items:center; gap:8px; cursor:pointer; color:var(--text-secondary); font-size:calc(0.875rem - 1px); padding:4px 0; min-height:28px; box-sizing:border-box; list-style:none; }
.assistant-work-stopped { margin-left:4px; padding:1px 7px; border:1px solid var(--border-color); border-radius:4px; font-size:calc(0.875rem - 2px); }
.assistant-composer-status { padding:0 8px 8px; color:var(--text-secondary); font-size:calc(0.875rem - 1px); }
.assistant-activity-group > summary::-webkit-details-marker { display:none; }
.assistant-activity-group > summary > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-activity-group > summary:hover, .assistant-activity > summary:hover { color:var(--title-color); }
.assistant-activity-group > summary > svg { flex:0 0 auto; }
.assistant-activity-group > summary > .assistant-activity-caret { opacity:1; margin:0; }
.assistant-activity-group:hover > summary > .assistant-activity-caret, .assistant-activity-group:focus-within > summary > .assistant-activity-caret, .assistant-activity-group[open] > summary > .assistant-activity-caret { opacity:1; }
.assistant-activity-group[open] > summary > .assistant-activity-caret { transform:rotate(90deg); }
.assistant-work-duration { display:inline-flex; align-items:center; gap:7px; font-variant-numeric:tabular-nums; }
.assistant-work-duration > svg { width:14px; height:14px; flex:0 0 14px; }
.assistant-activity-group-body { margin:6px 0 8px; padding:0 8px 0 0; scrollbar-width:thin; border-radius:3px;
  background:linear-gradient(var(--surface-color-alt) 30%,transparent) center top / 100% 28px local,
    linear-gradient(transparent,var(--surface-color-alt) 70%) center bottom / 100% 28px local,
    radial-gradient(farthest-side at 50% 0,color-mix(in srgb,var(--text-secondary) 18%,transparent),transparent) center top / 100% 10px scroll,
    radial-gradient(farthest-side at 50% 100%,color-mix(in srgb,var(--text-secondary) 18%,transparent),transparent) center bottom / 100% 10px scroll;
  background-repeat:no-repeat; }
.assistant-activity-group-body:focus-visible { outline:1px solid var(--border-medium); outline-offset:3px; }
.assistant-work-timeline { list-style:none; margin:0; padding:4px 0 4px 6px; }
.assistant-work-timeline > li { position:relative; margin:0; padding:0 0 2px 19px; border-left:1px solid var(--border-medium); min-width:0; }
.assistant-work-timeline > li::before { content:''; position:absolute; top:9px; left:-3px; width:5px; height:5px; border-radius:50%; background:var(--text-secondary); box-shadow:0 0 0 3px var(--surface-color-alt); }
.assistant-work-timeline > li:last-child { padding-bottom:0; border-color:transparent; }
.assistant-work-timeline > li:last-child::after { content:''; position:absolute; top:0; left:-1px; width:1px; height:7px; background:var(--border-medium); }
.assistant-activity-commentary { color:var(--text-secondary); font-size:calc(0.875rem - 1px); padding:4px 0; }
.assistant-activity-group .assistant-activity { margin:0; padding:0; max-width:100%; width:100%; box-sizing:border-box; }
.assistant-activity > summary { display:flex; gap:8px; align-items:center; padding:2px 0; min-height:22px; color:var(--text-secondary); font-size:calc(0.875rem - 1px); }
.assistant-activity > summary > svg { flex-shrink:0; }
.assistant-activity > summary > .assistant-activity-caret { margin:0; opacity:0; }
.assistant-activity:hover > summary > .assistant-activity-caret, .assistant-activity:focus-within > summary > .assistant-activity-caret { opacity:1; }
.assistant-activity[open] > summary > .assistant-activity-caret { opacity:1; transform:rotate(90deg); }
.assistant-activity-label { display:flex; gap:4px; align-items:baseline; min-width:0; overflow:hidden; }
.assistant-activity-label > span:first-child { flex-shrink:0; }
.assistant-activity-detail { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-activity-file { display:inline; min-width:0; padding:0; border:none; background:none; color:inherit; font:inherit; text-decoration:underline dotted; text-underline-offset:3px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.assistant-activity-file:hover { color:var(--title-color); }
.assistant-activity-body { padding:4px 0 8px 24px; }
.assistant-activity-args, .assistant-activity-output { margin:5px 0 0; padding:0; border:none; border-radius:0; background:transparent; font-family:var(--mono-font); line-height:1.5; }
.assistant-activity-meta { font-size:inherit; }
.assistant-activity-body pre, .assistant-approval-args { max-height:220px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:calc(0.875rem - 1px); }
.assistant-approval { background:var(--surface-color); border:1px solid var(--border-medium); border-radius:var(--radius); padding:12px; box-shadow:none; }
.assistant-approval-actions { gap:6px; }
.assistant-approval-actions button { font-size:var(--small-font-size); padding:5px 8px; }
.assistant-error { display:flex; gap:8px; align-items:flex-start; color:var(--negative-color); }
.assistant-error > svg { flex-shrink:0; margin-top:3px; }
.assistant-error .assistant-markdown { min-width:0; overflow-wrap:anywhere; }
.assistant-sidebar-projects { flex:0 1 auto; min-height:0; max-height:55%; overflow:auto; border-bottom:1px solid var(--border-light); }
.assistant-panel .assistant-project-toolbar { padding:0 6px; gap:4px; }
.assistant-panel .assistant-project-content { max-height:none; padding:8px; }
.assistant-panel .assistant-project-create { flex-wrap:wrap; padding:8px; }
.assistant-panel .assistant-project-create input { flex-basis:100%; }
@media (prefers-reduced-motion:reduce) { .assistant-think-dots { animation:none; } }



`

export function injectStyles(): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = mathCss + CSS + chartsCss + loadingCss + projectsCss
  return () => {
    if (document.getElementById(STYLE_ID) === el) el.remove()
  }
}
