# opencode-goal-x

Durable goal mode for opencode.

Give opencode a long-running objective and let it keep iterating through idle turns, compaction, and context churn until the goal is complete, paused, aborted, or blocked by a real guard.

This is not a marker-only `/goal` wrapper. The plugin stores goals on disk, injects active goal context into system prompts and compaction, exposes schema-gated lifecycle tools, and requires a fail-closed independent audit before archiving completion by default.

## Features

- Persistent goal pool in `.opencode/goals/` with active markdown mirrors, archived markdown files, strict `state.json`, and append-only `ledger.jsonl`.
- Auto-continue loop driven by `session.idle`, with budget guards for turns, runtime, tracked tokens, prompt failures, no-tool loops, and low-progress loops.
- Compaction continuity through `experimental.session.compacting`, plus generic compaction auto-continue suppression to avoid racing the goal loop.
- Active goal system prompt injection with immutable objective rules, blocker handling, task workflow, and completion standards.
- Schema-gated tools: `get_goal`, `propose_goal_draft`, `propose_goal_tweak`, `complete_goal`, `pause_goal`, `abort_goal`, `propose_task_list`, `complete_task`, `skip_task`, and `audit_goal_completion`.
- Fail-closed completion auditing through a separate opencode child session. Missing verdicts, API failures, timeouts, and `<rejected/>` keep the goal open.
- Built-in command registration. Loading the plugin registers `/goal`, `/goal-set`, `/goal-status`, `/goal-list`, `/goal-focus`, `/goal-pause`, `/goal-resume`, `/goal-tweak`, `/goal-abort`, and `/goal-clear`.

## Local Development

Install dependencies:

```bash
bun install
```

Run verification:

```bash
bun run check:all
```

This repository includes `opencode.json` for local development:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./src/index.ts"]
}
```

Restart opencode after changing plugin code or config. opencode loads plugins at startup.

## Usage

Start a goal:

```text
/goal make the test suite pass and verify it with bun test
```

Start with explicit limits and contracts:

```text
/goal ship the release --max-turns 120 --max-minutes 240 --budget 3m --success "tests pass and changelog updated" --constraints "do not change public API" --contract "run bun test and inspect the generated package"
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

## Plugin Options

Configure options through opencode's plugin tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-goal-x",
      {
        "maxTurns": 80,
        "maxRuntimeMs": 28800000,
        "maxTokens": 2000000,
        "minDelayMs": 1000,
        "noProgressTurnsBeforePause": 4,
        "noToolCallTurnsBeforePause": 3,
        "maxPromptFailures": 3,
        "requireAudit": true,
        "auditTimeoutMs": 600000,
        "auditorModel": "anthropic/claude-sonnet-4-5"
      }
    ]
  ]
}
```

Useful options:

- `commandName`: command prefix, default `goal`.
- `stateDir`: state directory, default `.opencode/goals`.
- `maxTurns`: auto-continue turn budget, default `80`.
- `maxRuntimeMs`: runtime budget, default `8` hours.
- `maxTokens`: tracked token guard, default `2000000`.
- `requireAudit`: fail-closed external audit gate, default `true`.
- `auditorModel`: optional `provider/model` override for the audit child session.
- `auditorAgent`: optional opencode agent name for audit child sessions.

## Completion Contract

The executor must call `complete_goal` with `completionSummary` and `verificationSummary`. If audit is enabled, the plugin creates an independent child session with a skeptical auditor prompt.

The auditor must end with exactly one marker:

```text
<approved/>
```

or:

```text
<rejected/>
```

Only `<approved/>` archives the goal. Everything else pauses the goal with the audit reason.

## Current Scope

This first build is the server-side core. A richer TUI overlay can now be added on top of the stable state files and runtime hooks.
