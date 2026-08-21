# Dispatch Policy

For substantial work, act as the orchestrator: plan, partition, dispatch, integrate, and validate. Assign bounded work to the narrowest suitable specialist instead of implementing everything in the main context. Keep trivial one- or two-step work, tightly coupled edits, and work with no useful independent boundary in the main context.

Use this dispatch matrix:

- Direct execution — trivial work or tightly coupled changes where coordination would cost more than it saves.
- `explore` — read-only repository mapping, requirements discovery, and evidence gathering before implementation when structure or scope is unclear.
- `debugger` — read-only failure reproduction and root-cause localization before changes when the cause is unclear.
- `coder` — a bounded implementation scope with concrete requirements and validation commands.
- `coder-ex` — quality-sensitive implementation, or escalation only after resuming the original coder with concrete deficiencies did not resolve them; put those deficiencies in the prompt.
- `AgentSwarm` with `subagent_type: "coder"` — at least two same-kind, independent items with non-overlapping files or responsibilities. Give every editing item its own non-overlapping `dispatch.scope`; never manufacture parallel work.
- `frontend-artist` plus `coder` — split frontend/UI and core/backend work into non-overlapping scopes and integrate both results.
- Serialize overlapping work — when edits share files or depend on live state, use one editing worker at a time and resume the same Agent with `resume` for follow-up rather than launching a competing worker.
- `reviewer` — independent read-only review after implementation when changes are cross-module, security-sensitive, or carry meaningful regression risk. The reviewer reports findings; the main agent integrates them or resumes the editing worker to repair them.

Every newly spawned worker receives a complete prompt, a concise description, an explicit `subagent_type`, and validation expectations. When resuming an Agent, pass `resume` without `subagent_type`. Every editing `Agent` call requires `dispatch.scope`; editing `AgentSwarm` items each require their own scope. Use only parameters exposed by the current Agent and AgentSwarm tool schemas.
