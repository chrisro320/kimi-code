# Subagent Profiles and Routing

## 1. Scope / Trigger

This spec governs built-in subagent profiles and the `/subagent` route configuration in Kimi Code. Update it whenever a profile, tool boundary, route shape, external CLI backend, or deployment procedure changes.

The implementation spans:

- `packages/agent-core/src/profile/default/*.yaml`
- `packages/agent-core/src/profile/default.ts`
- `apps/kimi-code/src/tui/commands/subagent.ts`
- `~/.kimi-code/config.toml` for persistent user routing

## 2. Signatures

### Slash command

```text
/subagent [coder|explore|frontend-artist|plan|reviewer]
```

- No argument: open the profile picker, then the route picker.
- A profile argument: open its route picker directly.
- A route selection persists through `setConfig({ subagent: { routing: { [profile]: route } } })` and reloads the current session.

### Route payload

```ts
type SubagentRoute = {
  backend: string;
  model?: string;
};
```

- Internal Kimi route: `{ backend: "kimi", model: "<configured model alias>" }`.
- External CLI route: `{ backend: "<configured backend>" }`, or include `model` when the backend args contain `{model}`.

### Built-in profiles

| Profile | Capability | Required boundary | Default persistent route |
| --- | --- | --- | --- |
| `coder` | General software engineering | Existing coder tool set | User-configured |
| `explore` | Codebase exploration | Read-only | User-configured |
| `plan` | Planning and architecture | Read-only; no Bash | `kimi` / `kimi-code/k3` |
| `reviewer` | Code review and risk analysis | Read-only; no Write/Edit/Agent | `kimi` / `pixelai-model` |
| `frontend-artist` | Frontend plus visual/art/media work | Coder-level edit/execute/test tools | `kimi` / `kimi-code/k3` |

## 3. Contracts

### Profile registry

`packages/agent-core/src/profile/default.ts` must import each bundled YAML, register it in `PROFILE_SOURCES`, and include it in `DEFAULT_AGENT_PROFILES`. `agent.yaml` must declare every selectable built-in profile under `subagents`.

### Reviewer contract

`reviewer` may inspect source, diffs, history, tests, documentation, and media. It must not modify files, create files, run mutating commands, commit, or push. Findings are ordered by severity and include exact location, concrete problem, impact, and minimal fix direction. It must not invent fixed coverage or complexity targets.

### Frontend-artist contract

`frontend-artist` must inspect existing architecture, design tokens, responsive behavior, accessibility patterns, dependencies, and tests before changing UI. It uses `frontend-design` when available and `art-asset` for art/media work. It must verify media output by reading it back, confirm generators/CLIs exist before use, and report unavailable audio/music tooling instead of claiming success.

### Persistent user assets and routes

- The generic `art-asset` skill lives at `~/.kimi-code/skills/art-asset/` and includes `SKILL.md` plus `scripts/matte.py`; project-specific prompts do not belong there.
- Persistent routes live under `[subagent.routing.<profile>]` in `~/.kimi-code/config.toml`.
- Adding a route must preserve all unrelated config, hooks, external backends, statusline settings, and existing routes.

### Native deployment contract

The native build requires Node `>=24.15.0`. Build output is smoke-tested before deployment. Install a new patched binary under a new filename and update the user wrapper only after the new binary passes `--version`, `doctor config`, and native smoke. Do not overwrite the prior statusline binary.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| `/subagent` receives spaces in its argument | Show usage including all built-in profiles; do not write config. |
| Unknown profile | Show an unknown-profile error; do not write config. |
| No configured models/backends | Show an error; do not mount a route picker. |
| External backend uses `{model}` but no aliases exist | Show an error; do not write config. |
| Picker cancelled | Restore editor; do not write config. |
| Route saved | Persist only the selected profile route, reload session/view, refresh autocomplete and app model state. |
| Reviewer receives a write request | Refuse the mutation and report the read-only boundary. |
| Media generator/CLI unavailable | Do not claim success; report the limitation and leave no fabricated asset. |
| Native config invalid | Stop deployment; fix config before switching wrapper. |

## 5. Good / Base / Bad Cases

- **Good:** `/subagent reviewer` selects internal `pixelai-model`; reviewer returns severity-ranked findings without changing files.
- **Good:** `/subagent frontend-artist` selects `kimi-code/k3`; the agent reuses project UI conventions, calls available skills, and reads generated media back before handoff.
- **Base:** Existing `coder`, `explore`, and `plan` routes remain unchanged while new profile routes are added.
- **Bad:** Copy a Claude-only agent prompt containing unavailable tools such as `context-manager`, or hard-code Next.js/Tailwind rules into a framework-neutral profile.
- **Bad:** Give `reviewer` `Write`/`Edit`, or deploy by replacing the previous statusline binary in place.

## 6. Tests Required

- `packages/agent-core/test/profile/default-agent-profiles.test.ts`
  - New profiles render from embedded sources.
  - `reviewer` lacks `Skill` and goal tools as intended.
  - `frontend-artist` has `Skill` and no goal tools.
- `packages/agent-core/test/profile/agent-profile-loader.test.ts`
  - Root `agent.subagents` references both profile objects.
  - Reviewer has no `Write` or `Edit`; frontend-artist has `Write`.
- `apps/kimi-code/test/tui/commands/subagent.test.ts`
  - Picker contains `reviewer` and `frontend-artist`.
  - Internal and external route persistence remains correct.
  - Cancellation remains non-mutating.
- Before deployment:
  - Run the two profile test files and the subagent command test.
  - Run agent-core and kimi-code typechecks with Node `24.15.0`.
  - Run native smoke, `kimi --version`, and `kimi doctor config`.
  - Run `git diff --check`.

## 7. Wrong vs Correct

### Wrong

```yaml
name: reviewer
tools:
  - Read
  - Write
  - Edit
```

This permits the reviewer to alter the code it is supposed to assess.

### Correct

```yaml
name: reviewer
tools:
  - Bash
  - FetchURL
  - Glob
  - Grep
  - Read
  - ReadMediaFile
  - WebSearch
```

The prompt also explicitly forbids mutating shell commands, file edits, commits, and pushes.

### Future update rule

Future changes to these profiles or routes must update this spec first or in the same change, then extend the nearest existing tests. Treat this file as the implementation contract for subsequent Trellis-guided work; do not recreate the profiles from memory or overwrite unrelated user configuration.
