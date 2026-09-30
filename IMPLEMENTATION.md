# Assistant architecture implementation

## Remaining work

1. Durable backend sessions, transactional queue/events, recovery, and renderer-independent execution.
2. Central tool registry and executor; guarded host capabilities and existing-tool parity.
3. Owned content-addressed attachments, PDF/vision/audio readers, and transfer tooling.
4. Channel normalization, durable deduplication/outbox, rich messages, and questions.
5. Context checkpoints, token metering, slash menu, queue tray, and Continue.
   `/plan` supports research and clarification, then a persisted proposal with Change plan / Yes, implement it; execution requires approval of that exact proposal.
6. Focused tests, package checks, installed development runtime and UI verification.

## Constraints

- Preserve the existing dirty changes in Assistant and Valley. No commits or resets.
- Use Node 24.19.0/npm 11.17.0 from `${HOME}/.nvm/versions/node/v24.19.0/bin`.
- Keep visible transcripts and existing attachment IDs/paths. SDK datasets own SQLite.
- Never access private vaults. Live channel sends require designated test recipients.
- The shared development UI must be coordinated before deployment/restart.

## Verification ledger

- Initial inspection: plugin and host contain pre-existing uncommitted work.
- Pinned Node/npm verified. No implementation checks run yet.
