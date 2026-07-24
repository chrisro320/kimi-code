Search file contents using regular expressions (powered by ripgrep).

Use Grep when the task is to find unknown content or unknown file locations. Do not use shell `grep` or `rg` directly; ALWAYS use Grep tool instead of running `grep` or `rg` from a shell — direct shell calls bypass workspace path policy, output limits, and sensitive-file filtering. If you already know a concrete file path and need its contents, use Read directly.

Patterns use ripgrep regex syntax, which differs from POSIX `grep` — for example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files (dotfiles such as `.gitlab-ci.yml` or `.eslintrc.json`) are searched by default. Set `include_ignored` to `true` to also search `.gitignore`-excluded files (such as `node_modules` or build outputs). Sensitive files (such as `.env`) are always skipped for safety, even when `include_ignored` is `true`.
