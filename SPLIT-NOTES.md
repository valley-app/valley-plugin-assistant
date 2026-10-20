# assistant-split (15 Oct 2026 06:30Z)

APFS clone of assistant-turnbudget (lane Assistant v8 port + turn-reserve-and-cancel), plus Part A's split backend from
Work/wt-assistant-release-partA (release f744849, a3f3bbaa):
- src/backend/entry.ts copied unchanged: a host timer ends the guest turn before zod, yaml, the backend graph and register.
- build.mjs: backend entry point src/backend/index.ts -> src/backend/entry.ts (splitting was already on).
- tests/backendCompiler.test.ts: the startup-graph test now starts from entry.ts, whose static graph must be entry.ts only.
  The index.ts graph must still exclude typescript and pdfjs. Part A's "ends the guest turn before each backend loading
  stage" test added (4 zero-delay timers before register).
Host side: pluginRuntimeBootstrap.ts awaits module.register, so an async register is accepted.
Results: typecheck 0, npm test 78 files / 731 tests passed, build 0 (24 runtime files).
Not yet measured: guest CPU per turn at backend start. Checked in candidate 7's launches (backendStatus), where 25 of 46
candidate 6 launches hit the 1000 ms limit. Pack 10:30-11:30Z.
