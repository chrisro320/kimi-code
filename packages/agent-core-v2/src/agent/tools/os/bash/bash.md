Execute a `${SHELL_NAME}` command. Use for shell semantics — pipes, env, processes, git, package managers, build/test runners, interactive or multi-step work.

**Translate these to a dedicated tool instead:**
- `cat` / `head` / `tail` (known path) → `Read`
- `sed` / `awk` (in-place edit) → `Edit`
- `echo > file` / `cat <<EOF` → `Write`
- `find` / recursive `ls` by name pattern → `Glob` (plain `ls <known-directory>` is fine)
- `grep` / `rg` (file contents) → `Grep`
- `echo` / `printf` (talk to the user) → output text directly

Dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation — prefer them whenever one fits.

**Output:**
stdout and stderr are combined and returned as a string; may be truncated if long. If the command exits non-zero, the output ends with a `Command failed with exit code: N` line; a command killed by its timeout or interrupted by the user ends with its own message instead.

If `run_in_background=true`, the command is started as a background task and this tool returns a task ID instead of waiting for completion; you must provide a short `description`. Background commands default to a ${DEFAULT_BACKGROUND_TIMEOUT_S}s timeout and `timeout` is capped at ${MAX_BACKGROUND_TIMEOUT_S}s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes — default to returning control to the user instead of immediately waiting on it. Use `TaskOutput` only for a non-blocking status/output snapshot — do not set `block=true` to wait for a task you just launched, since its completion arrives automatically; reserve `block=true` for when the user explicitly asked you to wait. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the `/tasks` command, which opens an interactive panel; it has no subcommands.

**Guidelines for safety and security:**
- Fresh shell each call — vars, cwd, and history are not preserved. Use the `cwd` arg or absolute paths; do not rely on a prior `cd`.
- The tool call returns when the command finishes. Do not run interactive or forever-running commands. For possibly long-running foreground commands, set the `timeout` argument in seconds. Foreground commands default to ${DEFAULT_TIMEOUT_S}s and allow up to ${MAX_TIMEOUT_S}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.
- Avoid `..` to reach outside the working directory.
- Avoid modifying files outside the working directory unless explicitly instructed.
- Never run superuser commands unless explicitly instructed.

**Guidelines for efficiency:**
- `&&` only for genuinely dependent chains (e.g. `npm install && npm test`). Independent read-only commands → separate parallel Bash calls in one response, not one chained call (serializes execution and mixes output). Do not stitch outputs with `echo` separators.
- `;` — sequential regardless of success/failure
- `||` — run second only if first fails
- `|` and `>` / `>>` — pipe and redirect between commands
- Always quote paths with spaces in double quotes (e.g. `cd "/path with spaces/"`)
- Multi-step logic in one call: `if` / `case` / `for` / `while`.
- Prefer `run_in_background=true` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.

**Commands available:**
Usually available (host-dependent — `which <command>` when unsure):
- Nav/inspect: `ls`, `pwd`, `cd`, `stat`, `file`, `du`, `df`, `tree`
- Files: `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `chmod`, `chown`
- Text: `wc`, `sort`, `uniq`, `cut`, `tr`, `diff`, `xargs`
- Archives: `tar`, `gzip`, `gunzip`, `zip`, `unzip`
- Net: `curl`, `wget`, `ping`, `ssh`, `scp`
- VCS: `git`; GitHub PRs/issues/CI/API → prefer `gh` when installed (user auth + structured JSON)
- Process: `ps`, `kill`, `top`, `env`, `date`, `uname`, `whoami`
- Toolchains: `node`, `npm`, `pnpm`, `yarn`, `python`, `pip` (use what the project relies on)
