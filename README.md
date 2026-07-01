# opencode-goal-x

opencode-goal-x is an OpenCode plugin for managing persistent AI objectives across sessions. It adds confirmation-first goal drafting, guarded automatic continuations, OpenCode todo synchronization, compact TUI visibility, context preservation, and fail-closed completion audits.

Goal X is built directly on OpenCode server-plugin hooks, native sessions, command hooks, compaction hooks, custom tools, state files, and a target-exclusive TUI plugin module.

## Package Targets

This package keeps the default export compatible with existing server-plugin loading and also exposes explicit OpenCode targets:

- `opencode-goal-x` / `.`: server plugin compatibility export.
- `opencode-goal-x/server`: explicit server plugin target.
- `opencode-goal-x/tui`: TUI plugin target.

Current minimum assumed OpenCode/API version: `>=1.17.11` (`@opencode-ai/plugin` and `@opencode-ai/sdk` in this repo). Restart OpenCode after changing plugin code, package exports, or config; plugins are loaded at startup.

Publishing is handled by `.github/workflows/publish.yml` when a GitHub Release is published. The release tag must match `package.json` as `v<version>`.

For the first npm publish, publish once manually, then configure npm Trusted Publishing for `dogalyir/opencode-goal-x`, workflow file `publish.yml`, environment `npm`, with `npm publish` allowed. npm requires the package to exist before a trusted publisher can be attached.

## Features

- Persistent goal pool in `.opencode/goals/` with active markdown mirrors, archived markdown files, strict `state.json`, pending drafts, captured execution context, audit progress, and append-only `ledger.jsonl`.
- `/goal <topic>` is safe by default: it starts a draft/planning flow and never creates or executes a goal until explicit `/goal-confirm`.
- `/goal-set <objective>` is the explicit immediate-start shortcut.
- Active agent/model/provider/variant capture and forwarding for plugin-driven prompts. Non-default variants such as `xhigh` are preserved by default for continuations, compaction followups, and audits unless explicit auditor config overrides them.
- AutoContinue loop driven by `session.idle`, with budget guards for turns, runtime, tracked tokens, prompt failures, no-tool loops, low-progress loops, stale focus, and prompt failures.
- Compaction continuity through `experimental.session.compacting`, with focused goal, other open goals, task summary, latest audit/pause state, and recent ledger events. Goal X suppresses OpenCode's generic compaction auto-continue when it queues its own continuation.
- Schema-gated lifecycle tools: `get_goal`, `propose_goal_draft`, `propose_goal_tweak`, `complete_goal`, `pause_goal`, `abort_goal`, `propose_task_list`, `complete_task`, `skip_task`, `audit_goal_completion`, and `report_auditor_progress`.
- Fail-closed completion auditing through a child OpenCode session. Timeouts, API failures, missing markers, contradictory markers, and `<rejected/>` leave the goal open/paused.
- OpenCode native todo observation. Representable completed/cancelled todos can update matching goal tasks while goal-specific contracts/evidence remain in Goal X state.
- TUI target with dashboard route, command-palette helpers, prompt/sidebar/app status slots, audit rejection attention, and file-state fallback.

## Local Development

Install dependencies:

```bash
bun install
```

Run verification:

```bash
bun run check
bun test
bun run check:all
```

This repository includes `opencode.json` for local server-plugin development:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./src/server.ts"]
}
```

For the TUI target, configure OpenCode's TUI plugin loader to load the package/export path that resolves to `./src/tui.ts` during local development or `opencode-goal-x/tui` after publishing. The TUI module is target-exclusive and does not import the server plugin.

## Commands

Draft first; no goal is created yet:

```text
/goal make the test suite pass and verify it with bun test
```

After the assistant proposes a finalized draft with `propose_goal_draft`, confirm or reject explicitly. Raw `/goal <topic>` planning drafts are not confirmable until this finalized proposal exists:

```text
/goal-confirm
/goal-reject
```

Start immediately when you intentionally want execution without drafting:

```text
/goal-set make the test suite pass and verify it with bun test --max-turns 20
```

Inspect and manage:

```text
/goal-status
/goal-list
/goal-focus 1
/goal-pause waiting for credentials
/goal-resume
/goal-tweak add docs verification to the objective
/goal-abort obsolete after product direction changed
/goal-clear
```

Flags accepted by `/goal` and `/goal-set`:

- `--max-turns <n>`
- `--max-minutes <n>`
- `--max-duration-ms <n>`
- `--budget <n|1.5m|500k>` / `--max-tokens <n>`
- `--success "..."`
- `--constraints "..."`
- `--contract "..."`

## Plugin Options

Configure through OpenCode's plugin tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-goal-x/server",
      {
        "maxTurns": 80,
        "maxRuntimeMs": 28800000,
        "maxTokens": 2000000,
        "minDelayMs": 1000,
        "noProgressTurnsBeforePause": 4,
        "noToolCallTurnsBeforePause": 3,
        "noProgressTokenThreshold": 40,
        "maxPromptFailures": 3,
        "requireAudit": true,
        "auditTimeoutMs": 600000,
        "readonlyAuditor": true,
        "auditorModel": "anthropic/claude-sonnet-4-5",
        "auditorAgent": "plan",
        "auditorVariant": "xhigh",
        "todoSync": true,
        "maxTaskCount": 100,
        "maxSubtaskDepth": 3,
        "strictTaskContracts": true
      }
    ]
  ]
}
```

Useful options:

- `commandName`: command prefix, default `goal`.
- `stateDir`: project-relative state directory, default `.opencode/goals`; absolute paths, traversal, and NUL bytes are rejected.
- `maxTurns`, `maxRuntimeMs`, `maxTokens`, `minDelayMs`: autoContinue budgets.
- `noProgressTurnsBeforePause`, `noToolCallTurnsBeforePause`, `noProgressTokenThreshold`, `maxPromptFailures`: conservative loop guards.
- `requireAudit` / `completionAudit`: fail-closed audit gate, default `true`.
- `readonlyAuditor`: sends a read-only-oriented tool policy to the auditor prompt, default `true`.
- `auditorModel`, `auditorAgent`, `auditorVariant`: explicit auditor overrides. When unset, Goal X preserves the captured session context.
- `todoSync`: observe native OpenCode todo updates and mirror representable task completion/cancellation, default `true`.
- `maxTaskCount`, `maxSubtaskDepth`, `strictTaskContracts`: lifecycle validation gates.

## State Files

Goal X stores authoritative state under `.opencode/goals/`:

```text
.opencode/goals/
  state.json          # strict snapshot: goals, focus map, drafts, context, audit progress
  ledger.jsonl        # append-only operational ledger
  active/*.md         # editable active/paused goal mirrors
  archive/*.md        # completed/aborted goal mirrors
```

Before commands, lifecycle tools, audits, and continuations, the runtime reloads and reconciles disk state. External edits to `# Goal Prompt`, deleted active files, archived goals, and status changes win over stale memory. Writes are atomic and serialized with a local write lock; symlinked state directories/files are refused.

## Tasks and OpenCode Todos

Goal task lists can include nested subtasks, blocking completion policy, verification contracts, evidence, and skip reasons. OpenCode todos are flatter, so sync is intentionally lossy and conservative:

- Goal X keeps contracts/evidence in `.opencode/goals/`.
- Native todos update goal tasks only when they match a task id, exact title, or `[goal:<task-id>]` marker.
- `completed` todos mark pending tasks complete with todo evidence.
- `cancelled`/`canceled` todos mark pending tasks skipped with a skip reason.
- Nested task structure and verification contracts are never discarded.

## Completion and Audits

The executor must call `complete_goal` with both `completionSummary` and `verificationSummary`. Pending blocking tasks or unmet verification contracts reject completion before audit.

The auditor prompt requires skeptical, semantic, read-only-oriented inspection. The final line must contain exactly one marker:

```text
<approved/>
```

or:

```text
<rejected/>
```

Only a single final `<approved/>` archives the goal. Everything else pauses the goal with the rejection/error reason and stores audit output/progress for status and TUI display.

## TUI Target

The TUI target reads the same `.opencode/goals/` state files and is safe when the server plugin is unavailable. It provides:

- `goal-x.dashboard` route with focused/open/archive/draft overview.
- Command-palette helpers for dashboard, drafting, confirmation reminder, and status help.
- Host slot renderers for `session_prompt_right`, `sidebar_footer`, and `app_bottom` with compact focused-goal badge.
- Attention notification when an audit rejection is observed.
- Graceful fallback text if state cannot be read.

Dialog-backed confirmation/focus/settings flows depend on the active OpenCode TUI host APIs. Where a TUI dialog is unavailable, the server command fallback remains authoritative: `/goal-confirm`, `/goal-reject`, `/goal-focus`, `/goal-pause`, `/goal-resume`, and plugin options.

## Verification and Smoke Tests

Automated verification:

```bash
bun run check
bun test
bun run check:all
```

Manual OpenCode smoke tests before release:

1. Start OpenCode with this plugin loaded locally and restart after config changes.
2. Select a non-default model variant such as `xhigh`.
3. Run `/goal draft a small verified change`; verify no active goal appears before confirmation.
4. Confirm the draft with `/goal-confirm`; verify the same agent/model/variant remains selected.
5. Run `/goal-set make a trivial documented test fixture --max-turns 2`; verify immediate persistence and autoContinue.
6. Force/simulate compaction; verify Goal X context survives and generic compaction auto-continue does not race the goal loop.
7. Trigger `complete_goal` with weak evidence; verify the audit rejects and pauses.
8. Trigger `complete_goal` with real evidence; verify the audit approves and archives.
9. Open the TUI dashboard/status slots and verify goal state, tasks, focus, and audit progress render correctly.

## Known OpenCode API Limitations

- TUI plugins are a separate target; load `./server` and `./tui` through their respective OpenCode plugin mechanisms.
- No Browser UI plugin target is implemented because no analogous public BUI plugin API is currently exposed.
- The server plugin host currently types its client through the legacy SDK path, while current OpenCode SDK v2 types include `SessionPromptData.body.variant`; Goal X builds variant-aware prompt bodies against the current v2 type and passes the same compatible payload through the server client.
- Strong read-only auditor isolation may still require an OpenCode agent/permission configuration outside this plugin; Goal X sends read-only-oriented tool policy and prompt constraints by default.
