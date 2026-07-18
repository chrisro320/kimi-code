# statusline.command examples

`quota-cache-ttl.sh` reproduces kimi-code's built-in statusline row
(quota 7d/5h + cache-hit ratio + token count + TTL countdown) as a
standalone script — copy it, point `~/.kimi-code/tui.toml` at it, done.
No kimi-code source access or rebuild needed.

## Install

```toml
# ~/.kimi-code/tui.toml
[statusline]
enabled = true
command = "/path/to/quota-cache-ttl.sh"
```

Requires `bash`, `jq`, `awk`, and GNU `date` (`date +%s%3N`) on `PATH`.

## How it works

kimi-code spawns `command` via `/bin/sh -c` roughly every 2s, piping one
line of JSON state on stdin, and prints whatever the script writes to
stdout (first line only) as the statusline row verbatim — see the
comment header in `quota-cache-ttl.sh` for the exact payload shape.
Any failure (non-zero exit, 1s timeout, empty stdout) just hides the
row; nothing surfaces as an error in the TUI, so it's safe to iterate on
your own script without breaking the rest of the UI.
