# Permission Policy Decision Tables

R-C2 (Case 10, `07-22-guard-bucket4-calibration-authority`): every `PermissionPolicy` in this directory gets one section here with the same eight fields — protected asset, authoritative evidence, weak signal(s), trigger example, non-trigger example (a normal case that *looks* like a violation but isn't), indeterminate-state handling, minimal blocked effect, and recovery/override path. This is a documentation pass only — no policy's runtime behavior changed while writing it, except where a section explicitly flags a finding for follow-up.

Policies are evaluated in the order `PermissionManager` registers them (see `policies/index.ts`); the first matching result wins. A section with several fields marked "N/A — unconditional by design" is a deliberately simple baseline policy (mode gate, tool allowlist, or terminal fallback), not an omission.

---

## agent-swarm-exclusive-deny.ts — `AgentSwarmExclusiveDenyPermissionPolicy`

- **Protected asset**: structural invariant that one model response contains at most one `AgentSwarm` call, alone.
- **Authoritative evidence**: the response's own `toolCalls` array — a hard count, not inferred intent.
- **Weak signal**: none; this is a deterministic count check, not a heuristic.
- **Trigger example**: two `AgentSwarm` calls in one response; or one `AgentSwarm` call alongside a `Read` call in the same response.
- **Non-trigger example**: a single `AgentSwarm` call as the only tool call in the response.
- **Indeterminate state**: none possible — the count is always exact.
- **Minimal blocked effect**: denies the whole batch of tool calls in that response (the model must resubmit correctly); does not touch any other turn or agent state.
- **Recovery / override**: none needed — this is a format contract, not a risk judgment; the model simply reissues one `AgentSwarm` call by itself.

## agora-confirmation-ask.ts — `AgoraConfirmationAskPermissionPolicy`

- **Protected asset**: launching the Agora multi-peer packet (spends quota across multiple external/internal backends) and, separately, the two independent one-time overrides (`necessity.force_after_decline`, `reference_audit_gate.risk_override_confirmed`).
- **Authoritative evidence**: a user approval response from `agent.rpc.requestApproval`, bound to a hash of the exact packet args (`hashAgoraExecutionEnvelope`) so the executed packet cannot silently drift from what was shown.
- **Weak signal**: none used for the ask decision itself — every `Agora` call always asks. The "weak signal" surface lives inside the packet's own necessity fields (`impact_if_wrong`/`uncertainty_or_disagreement`/...), which are advisory inputs to the *user's* decision, not something this policy judges automatically.
- **Trigger example**: any `Agora` tool call, including ordinary first-round packets.
- **Non-trigger example**: none — there is no "safe enough to skip" packet; this is Agora's only gate.
- **Indeterminate state**: no session approval surface available (`agent.rpc.requestApproval === undefined`) → **deny**, not ask (an ask nobody can answer must fail closed, not hang).
- **Minimal blocked effect**: only this `Agora` call; other tools in the same turn are unaffected.
- **Recovery / override**: the two overrides are separate, hash-bound, one-time approvals the model must request and the user must grant explicitly — a generic packet approval never silently covers them.

## asset-pipeline-confirmation-ask.ts — `AssetPipelineConfirmationAskPermissionPolicy`

- **Protected asset**: executing a prepared asset batch (`action: 'prepare_execution'`) — writes/promotes files based on a candidate list the model assembled.
- **Authoritative evidence**: a hash of the exact `{run_id, candidates, confirmation, policies}` tuple (`hashAssetBatchConfirmation`), bound at approval time.
- **Weak signal**: none — every `prepare_execution` action asks; other `AssetPipeline` actions (discovery, listing) are untouched by this policy.
- **Trigger example**: `AssetPipeline({action: 'prepare_execution', ...})` with a well-formed batch.
- **Non-trigger example**: `AssetPipeline({action: 'discover', ...})` or any non-`prepare_execution` action — not evaluated by this policy at all.
- **Indeterminate state**: malformed batch (missing `run_id`/`candidates`/`candidate_policies`/`confirmation`, or hash construction throws) → **deny** with a specific message, not ask; no approval surface (`requestApproval` undefined) → **deny**. Both fail closed because there's nothing coherent to ask the user to approve.
- **Minimal blocked effect**: only this `AssetPipeline` call.
- **Recovery / override**: model resubmits a complete, well-formed batch; no override path — this is a data-completeness gate, not a risk judgment to override.

## auto-mode-approve.ts — `AutoModeApprovePermissionPolicy`

- **Protected asset**: N/A — unconditional by design (a mode-scoped default-approve fallback).
- **Authoritative evidence**: `agent.permission.mode === 'auto'`.
- **Weak signal**: N/A.
- **Trigger example**: any tool call not already resolved by an earlier, more specific policy, while in `auto` mode.
- **Non-trigger example**: N/A.
- **Indeterminate state**: N/A.
- **Minimal blocked effect**: N/A (this policy only approves, never blocks).
- **Recovery / override**: N/A.

## auto-mode-ask-user-question-deny.ts — `AutoModeAskUserQuestionDenyPermissionPolicy`

- **Protected asset**: the `auto`-mode contract that the model proceeds autonomously instead of pausing to ask the human.
- **Authoritative evidence**: `agent.permission.mode === 'auto'` combined with `toolCall.name === 'AskUserQuestion'` — both exact.
- **Weak signal**: none.
- **Trigger example**: `AskUserQuestion` called while in `auto` mode.
- **Non-trigger example**: `AskUserQuestion` called in `ask`/`manual`/`yolo` mode — untouched by this policy.
- **Indeterminate state**: none.
- **Minimal blocked effect**: only the `AskUserQuestion` call; the message tells the model to decide and continue instead.
- **Recovery / override**: switch out of `auto` mode if human input is genuinely required for this session.

## default-tool-approve.ts — `DefaultToolApprovePermissionPolicy`

- **Protected asset**: N/A — unconditional by design (allowlist of tools with no side effects on the world: reads, lists, goal/todo bookkeeping, `select_tools` loading).
- **Authoritative evidence**: static membership in `DEFAULT_APPROVE_TOOLS`.
- **Weak signal**: N/A.
- **Trigger example**: `Read`, `Grep`, `TaskList`, `WebSearch`, etc.
- **Non-trigger example**: N/A.
- **Indeterminate state**: N/A.
- **Minimal blocked effect**: N/A (approve-only).
- **Recovery / override**: N/A.

## deny-all.ts — `DenyAllPermissionPolicy`

- **Protected asset**: N/A — a constructor-supplied blanket deny used to close off an entire permission surface for a specific caller (e.g. a side-question sub-context).
- **Authoritative evidence**: caller-supplied `message`; the policy itself makes no judgment.
- **Weak signal**: N/A.
- **Trigger example**: any tool call reaching an agent instantiated with this policy.
- **Non-trigger example**: N/A — this policy has no conditional branch.
- **Indeterminate state**: N/A.
- **Minimal blocked effect**: every tool call for that agent instance; scope is fixed by the caller who chose to install this policy, not by this file.
- **Recovery / override**: none — by construction this agent instance is not meant to call tools at all.

## dispatch-mode-guard.ts — `DispatchModeGuardPermissionPolicy`

- **Protected asset**: preventing an unattended `Agent`/`AgentSwarm` dispatch decision under `ask`/`off` dispatch mode (the runtime cannot distinguish a model-initiated dispatch from one the user actually asked for).
- **Authoritative evidence**: `agent.dispatchMode.mode` (explicit session state) plus the resolved profile's editing-capability (`isEditingCapableProfile`).
- **Weak signal**: `off` mode confirms every `Agent`/`AgentSwarm` call regardless of shape (deliberately blunt — the whole point of `off` is "always ask"). In `ask` mode, "more than one `Agent` call in the same response" is used as a proxy for an unreviewed multi-dispatch decision.
- **Trigger example**: `ask` mode + `AgentSwarm` call; `ask` mode + a second `Agent` call in the same response; `off` mode + any `Agent`/`AgentSwarm` call.
- **Non-trigger example**: `ask` mode + a single read-only `Agent` call alone in the response (the common, low-risk case is let through even in `ask` mode); `Agent(resume=...)` in any mode (continuing an already-approved worker is not a new dispatch decision).
- **Indeterminate state**: an unresolvable subagent profile fails safe toward **requiring confirmation** (`resolveIsEditingCapable` returns `true` — editing-capable — when the profile can't be found), not toward silently approving.
- **Minimal blocked effect**: only the `Agent`/`AgentSwarm` call under review; asks, does not deny outright.
- **Recovery / override**: user approves the ask; or switch dispatch mode to `auto` if the friction is unwanted.

## exit-plan-mode-review-ask.ts — `ExitPlanModeReviewAskPermissionPolicy`

- **Protected asset**: leaving plan mode without the user actually reviewing the plan content.
- **Authoritative evidence**: `agent.planMode.isActive` plus a `plan_review`-kind display carrying non-empty plan text.
- **Weak signal**: none — this always asks when the preconditions hold; `auto` mode is explicitly exempted at the top (plan review would contradict `auto`'s "don't block on confirmation" contract).
- **Trigger example**: `ExitPlanMode` called while plan mode is active, with a non-empty plan.
- **Non-trigger example**: `auto` mode (skipped entirely); plan mode not active; an empty plan (falls through to `plan-mode-tool-approve.ts`'s auto-approve path instead, since there's nothing to review).
- **Indeterminate state**: user response other than `approved` (`cancelled`, `rejected`, feedback-only) all resolve to a **synthetic non-error result** that keeps plan mode active or exits it per the specific decision — none of them silently approve.
- **Minimal blocked effect**: only the `ExitPlanMode` call; the model gets a structured result (approved-with-selection, revise-with-feedback, or rejected) instead of a bare denial.
- **Recovery / override**: user can select "Revise" (stay in plan mode, give feedback) or "Reject and Exit" (leave plan mode without executing).

## fallback-ask.ts — `FallbackAskPermissionPolicy`

- **Protected asset**: N/A — the terminal catch-all when no earlier policy resolved the call; ensures every tool call gets an explicit decision rather than silently falling through undecided.
- **Authoritative evidence**: N/A (unconditional).
- **Weak signal**: N/A.
- **Trigger example**: any tool call none of the more specific policies matched.
- **Non-trigger example**: N/A.
- **Indeterminate state**: this policy *is* the indeterminate-state handler for the whole chain — its answer is always "ask", never "deny", which is the correct default per Case 10 (an unrecognized case is not proof of a violation).
- **Minimal blocked effect**: only the one unresolved call.
- **Recovery / override**: user approves or denies via the ask surface.

## file-access-ask.ts — two policies

### `SensitiveFileAccessAskPermissionPolicy`

- **Protected asset**: files matching `isSensitiveFile` (credentials, keys, similar — see `tools/policies/sensitive.ts`).
- **Authoritative evidence**: the tool call's own declared file accesses (`context.execution.accesses`), not a guess about intent.
- **Weak signal**: path pattern matching (`isSensitiveFile`) is itself a heuristic — a differently-named secret file could slip through, and a benign file with a secret-like name could false-positive.
- **Trigger example**: `Read`/`Write`/`Edit` on `.env`, an SSH key path, etc.
- **Non-trigger example**: a file named `environment-notes.md` that merely *mentions* env vars in prose — not matched by the path-based check, so not asked (this is the false-negative side of a path-only heuristic, accepted as a known limit rather than expanded into content scanning here).
- **Indeterminate state**: N/A — `isSensitiveFile` is a deterministic pattern match; there's no partial-match branch to handle.
- **Minimal blocked effect**: only the specific file access flagged.
- **Recovery / override**: user approves if the access is legitimate.

### `GitControlPathAccessAskPermissionPolicy`

- **Protected asset**: `.git` internals (refs, hooks, config) and any git-worktree control directory — mutating these can corrupt repo state or bypass version control entirely.
- **Authoritative evidence**: an access path containing a literal `.git` path component, or falling under the resolved worktree's `dotGitPath`/`controlDirPath` (`findGitWorkTreeMarker`).
- **Weak signal**: none — path containment is exact, not fuzzy.
- **Trigger example**: `Write` to `.git/hooks/pre-commit`; `Edit` inside a linked worktree's control directory.
- **Non-trigger example**: a file or directory literally named `gitignore-notes` (no `.git` path segment) — not matched.
- **Indeterminate state**: `cwd` empty or no file accesses declared → skipped (returns `undefined`, falls through to later policies) rather than asking about nothing.
- **Minimal blocked effect**: only the specific git-control-path access.
- **Recovery / override**: user approves if the git-internals write is genuinely intended (rare, e.g. a deliberate hook install).

## git-cwd-write-approve.ts — `GitCwdWriteApprovePermissionPolicy`

- **Protected asset**: N/A — this is an auto-*approve* narrowing, not a guard; it exists to skip a redundant ask for writes already inside a known-safe git working tree.
- **Authoritative evidence**: POSIX path class, a non-empty `cwd`, every write access within the workspace (`isWithinWorkspace`), and a confirmed git worktree marker at `cwd` (`findGitWorkTreeMarker`).
- **Weak signal**: none — every condition is an exact check; any one failing just falls through to the next policy (no ask is skipped incorrectly).
- **Trigger example**: `Write`/`Edit` inside the workspace of a real git working tree on POSIX.
- **Non-trigger example**: Windows path class (`pathClass() !== 'posix'`) — deliberately excluded and falls through, not auto-approved; a write outside the workspace root also falls through (still subject to `file-access-ask.ts`/other policies).
- **Indeterminate state**: any missing precondition → fall through (`return` with no result), never a false approve.
- **Minimal blocked effect**: N/A (approve-only, and only narrows which calls skip the ask — never widens denial).
- **Recovery / override**: N/A.

## goal-start-review-ask.ts — `GoalStartReviewAskPermissionPolicy`

- **Protected asset**: starting a goal, which turns the agent loose on autonomous multi-turn work under a chosen permission mode.
- **Authoritative evidence**: `context.execution.display?.kind === 'goal_start'` — the same menu the `/goal` command itself shows.
- **Weak signal**: none — `auto` mode is explicitly exempted (goals in `auto` mode are pre-approved upstream and never reach this policy at all).
- **Trigger example**: `CreateGoal` in `ask`/`manual`/`yolo` mode.
- **Non-trigger example**: `CreateGoal` in `auto` mode (already approved before reaching here); `CreateGoal` without the `goal_start` display kind.
- **Indeterminate state**: any decision other than `approved` creates no goal (denial-by-default), and the tool call is blocked with the standard rejection — no silent goal creation on ambiguous input.
- **Minimal blocked effect**: only the `CreateGoal` call.
- **Recovery / override**: the approval response itself selects which permission mode the goal runs under — approval and mode choice are the same step.

## plan-mode-guard-deny.ts — `PlanModeGuardDenyPermissionPolicy`

- **Protected asset**: the plan-mode invariant that only the plan file itself may be written while planning, and that scheduled/background mutations (`TaskStop`, `CronCreate`, `CronDelete`) don't silently take effect mid-plan.
- **Authoritative evidence**: `agent.planMode.isActive` plus the resolved `planFilePath`.
- **Weak signal**: none — every check is an exact tool-name/path match.
- **Trigger example**: `Write`/`Edit` to any path other than the plan file while planning; `TaskStop`/`CronCreate`/`CronDelete` while planning.
- **Non-trigger example**: `Write`/`Edit` to exactly the plan file path while planning (allowed); any of these tools when plan mode is inactive (this policy is a no-op).
- **Indeterminate state**: plan mode active but no plan file path resolved yet → **deny** the write (fail closed — there is no file to compare against, so nothing can be judged safe).
- **Minimal blocked effect**: only the specific mutating call; read-only tools are unaffected by this policy.
- **Recovery / override**: call `ExitPlanMode` first, then retry the mutation outside plan mode.

## plan-mode-tool-approve.ts — `PlanModeToolApprovePermissionPolicy`

- **Protected asset**: N/A — a narrow auto-approve carve-out inside plan mode (entering plan mode itself, writing only the plan file, and exiting when there's nothing to review).
- **Authoritative evidence**: exact tool name (`EnterPlanMode`/`Write`/`Edit`/`ExitPlanMode`) plus, for writes, an exact plan-file-path match.
- **Weak signal**: none.
- **Trigger example**: `EnterPlanMode` (always approved); `Write` to the exact current plan file while planning; `ExitPlanMode` when plan mode isn't active, or the display isn't a plan review, or the plan text is empty.
- **Non-trigger example**: `Write` to a non-plan-file path while planning — falls through to `plan-mode-guard-deny.ts`, which denies it.
- **Indeterminate state**: N/A — every branch is an exact match; anything not matched falls through with no result.
- **Minimal blocked effect**: N/A (approve-only).
- **Recovery / override**: N/A.

## pre-tool-call-hook.ts — `PreToolCallHookPermissionPolicy`

- **Protected asset**: N/A — a pass-through to the user-configured `PreToolUse` hook system, not a runtime-authored judgment.
- **Authoritative evidence**: the hook's own block decision (`agent.hooks.triggerBlock('PreToolUse', ...)`).
- **Weak signal**: N/A — whatever heuristic the *user's* hook script implements is outside this policy's scope.
- **Trigger example**: any tool call where the configured hook returns a block reason.
- **Non-trigger example**: any tool call where the hook is absent or returns no block.
- **Indeterminate state**: N/A — the hook's result is binary (block reason present or not).
- **Minimal blocked effect**: only the flagged call; message is exactly the hook's own reason text.
- **Recovery / override**: whatever the user's hook configuration allows (this policy has no independent override).

## reference-audit-override-ask.ts — `ReferenceAuditOverrideAskPermissionPolicy`

- **Protected asset**: overriding a reference-audit risk finding (bypassing a flagged external reference/asset) for Agora or an editing dispatch.
- **Authoritative evidence**: a hash of the exact `{reference_hash, audit_run_id, purpose, operation_id, reason}` tuple (`hashReferenceAuditOverride`), bound at approval time.
- **Weak signal**: none — every well-formed `ReferenceAuditOverride` call asks.
- **Trigger example**: `ReferenceAuditOverride` with a complete, valid challenge.
- **Non-trigger example**: any other tool call — this policy only ever matches `ReferenceAuditOverride`.
- **Indeterminate state**: missing/malformed fields, or no approval surface available → **deny** (fails closed; an override challenge with a missing operation id or reason has nothing coherent for the user to evaluate).
- **Minimal blocked effect**: only this override call.
- **Recovery / override**: model resubmits a complete challenge; approval is one-time and hash-bound to that exact challenge, not reusable for a different reference/operation.

## session-approval-history.ts — `SessionApprovalHistoryPermissionPolicy`

- **Protected asset**: N/A — an auto-*approve* shortcut for a tool call the user already approved once this session ("always allow for this session" style rules), not a new guard.
- **Authoritative evidence**: `agent.permission.sessionApprovalRulePatterns`, populated only by a prior explicit user approval in this session.
- **Weak signal**: the underlying `matchPermissionRule` pattern matching (exact vs. prefix/glob strategy) — see that module for its own accuracy tradeoffs; this policy just consumes the match result.
- **Trigger example**: a tool call matching a pattern the user approved earlier in the same session.
- **Non-trigger example**: the first occurrence of a call before any session rule exists for it — falls through to whichever policy would normally ask.
- **Indeterminate state**: N/A (approve-only; no match means no effect).
- **Minimal blocked effect**: N/A.
- **Recovery / override**: N/A — this policy only ever narrows *how many times* the user is asked, never denies.

## swarm-mode-agent-swarm-approve.ts — `SwarmModeAgentSwarmApprovePermissionPolicy`

- **Protected asset**: N/A — a narrow auto-approve for `AgentSwarm` specifically while an active swarm-mode session is already underway (the user already opted into swarm orchestration for this session).
- **Authoritative evidence**: `agent.swarmMode.isActive`.
- **Weak signal**: none.
- **Trigger example**: `AgentSwarm` call while swarm mode is active.
- **Non-trigger example**: `AgentSwarm` call while swarm mode is inactive — falls through to `dispatch-mode-guard.ts`/other policies.
- **Indeterminate state**: N/A.
- **Minimal blocked effect**: N/A (approve-only).
- **Recovery / override**: N/A.

## task-output-resolution-ask.ts — `TaskOutputResolutionAskPermissionPolicy`

- **Protected asset**: resolving a retained editing candidate's scope-expansion state (`approve_scope_expansion`/`deny_scope_expansion`) — mutates durable task state and, on approval, the workspace.
- **Authoritative evidence**: the specific `action` value; task/candidate identity is carried in the `reason` payload for the manager to re-verify (hash + exact scope) after approval, not trusted from the ask alone.
- **Weak signal**: none — any of the two resolution actions always asks.
- **Trigger example**: `TaskOutput({action: 'approve_scope_expansion', ...})` or `'deny_scope_expansion'`.
- **Non-trigger example**: `TaskOutput({action: 'inspect', ...})` or any other read/status action — not matched by this policy.
- **Indeterminate state**: an unresolvable `task_id` still reaches "ask" (task status reported as `null` in the reason) rather than silently failing — the manager's own re-validation after approval is the real backstop, not this policy pre-filtering.
- **Minimal blocked effect**: only this specific resolution call.
- **Recovery / override**: user approves or denies the specific resolution; the manager independently re-checks the candidate hash and requested scope before acting, so a stale/mismatched approval still fails safe.

## task-stop-confirmation-ask.ts — `TaskStopConfirmationAskPermissionPolicy`

- **Protected asset**: a running background task or subagent — stopping it may be unrecoverable (see `agent-core/runtime.md`'s "Destructive cancellation contract").
- **Authoritative evidence**: the task's own status (`isBackgroundTaskTerminal`) — not elapsed time, output silence, or any other proxy signal.
- **Weak signal**: explicitly *not* used — this policy exists precisely because long elapsed time / quiet output is not evidence a task is stuck (see runtime.md); the reason payload does surface `task_elapsed_ms`/`task_timeout_ms` for the *human* to weigh, but the policy itself never auto-decides on them.
- **Trigger example**: model-issued `TaskStop` on a task that is not yet terminal.
- **Non-trigger example**: `TaskStop` on a task that already reached a terminal status — skipped (nothing destructive left to confirm).
- **Indeterminate state**: unresolvable `task_id` still asks (`task_status: null` in the reason) rather than assuming safe-to-stop.
- **Minimal blocked effect**: only this `TaskStop` call; internal timeout/shutdown/safety paths bypass this policy entirely by calling `BackgroundManager.stop()` directly (they are not model-issued decisions).
- **Recovery / override**: user approves the stop; there is no silent auto-approve path even in `auto`/`yolo` mode (see class doc comment).

## user-configured-rules.ts — three policies sharing `UserConfiguredPermissionPolicy`

All three share evidence and weak-signal characteristics; they differ only in which rule `decision` they look for and what result they return.

- **Protected asset**: honoring the user's own configured permission rules (`turn-override`/`project`/`user` scope) as authoritative over runtime defaults.
- **Authoritative evidence**: `agent.permission.data().rules`, filtered to user-configured scopes, matched via `matchPermissionRule`.
- **Weak signal**: the rule matching strategy itself (exact vs. broader pattern match, tracked in `match.strategy`) — a broad pattern rule could match more than the user intended; this is inherent to how permission rules are authored, not something these policies add.
- **Trigger example** (`UserConfiguredDenyPermissionPolicy`): a tool call matching a user `deny` rule. (`Allow`): matching an `allow` rule. (`Ask`): matching an `ask` rule.
- **Non-trigger example**: a tool call that matches no configured rule at all — falls through to the next policy in the chain.
- **Indeterminate state**: N/A — `matchPermissionRule` either matches or doesn't; there's no partial-match branch here.
- **Minimal blocked effect**: only the matched call; `Deny` includes the rule's own `reason` text (and a sub-agent-specific "don't retry" hint) so the model understands *why*, not just that it failed.
- **Recovery / override**: the user's own rule configuration is the override mechanism — editing or removing the rule changes future outcomes; there is no separate runtime override for a rule the user explicitly wrote.

## yolo-mode-approve.ts — `YoloModeApprovePermissionPolicy`

- **Protected asset**: N/A — unconditional by design (mode-scoped default-approve fallback, mirroring `auto-mode-approve.ts` for `yolo` mode).
- **Authoritative evidence**: `agent.permission.mode === 'yolo'`.
- **Weak signal**: N/A.
- **Trigger example**: any tool call not already resolved by an earlier, more specific policy, while in `yolo` mode.
- **Non-trigger example**: N/A.
- **Indeterminate state**: N/A.
- **Minimal blocked effect**: N/A (approve-only).
- **Recovery / override**: N/A.

---

## Findings surfaced while writing this (not acted on here — see prd.md Notes)

- None of the 26 policies reviewed here appeared to violate "indeterminate signal → warn/quarantine, not deny" as a blocking default. The closest calls (`asset-pipeline-confirmation-ask.ts`, `reference-audit-override-ask.ts` denying on a malformed/incomplete request) are denying *malformed input*, not an ambiguous-but-well-formed request — judged in scope for a hard fail, not a Case 10 violation.
- `sensitive-file-access-ask.ts`'s path-pattern matching is a known false-negative surface (a secret in a file whose name doesn't match the pattern) — noted above under its own section rather than flagged as a defect, since content-based scanning is a materially larger feature, not a decision-table gap.
