#!/usr/bin/env bash
#
# Reference `statusline.command` script — reproduces kimi-code's built-in
# quota + cache-hit + token + TTL row, so you can hand this file to
# someone else and have them get the same statusline without touching
# kimi-code source or rebuilding the binary.
#
# Requires: bash, jq, awk, GNU date (`date +%s%3N` for millisecond epoch).
#
# Install: copy this file anywhere, `chmod +x` it, then point
# `~/.kimi-code/tui.toml`'s `[statusline]` at it — see the `tui.toml`
# snippet below.
#
# kimi-code spawns this via `/bin/sh -c <command>` every ~2s and pipes one
# line of JSON on stdin:
#   {
#     "weekly":   {"label":"7d","used":N,"limit":N,"resetHint":"5d 6h"} | null,
#     "fiveHour": {"label":"5h","used":N,"limit":N,"resetHint":"3h 49m"} | null,
#     "lastCacheHit": 0.91 | null,
#     "sessionCacheHit": 0.83 | null,
#     "totalTokens": 536870,
#     "lastReplyAt": 1784381443000 | null,
#     "streamingPhase": "idle" | "..."
#   }
# Whatever this script prints on stdout (first line only) becomes the
# statusline row verbatim. Non-zero exit / timeout (1s) / empty stdout
# all just hide the row — no error ever reaches the TUI, so it's safe to
# experiment.

json="$(cat)"

# Colors mirror kimi-code's default dark theme (colors.ts): text, textDim,
# success, warning, error. If you use the light theme, swap these.
COL_TEXT=$'\033[38;2;224;224;224m'
COL_DIM=$'\033[38;2;136;136;136m'
COL_OK=$'\033[38;2;78;200;126m'
COL_WARN=$'\033[38;2;232;168;56m'
COL_ERR=$'\033[38;2;232;84;84m'
RESET=$'\033[0m'

STATUSLINE_TTL_MS=300000

jqr() { jq -r "$1" <<<"$json"; }

# Mirrors `compactResetHint`: strips a leading "resets in" prefix, then
# keeps only the first two whitespace-separated tokens joined with no
# separator (e.g. "5d" + "6h" -> "5d6h").
strip_reset_hint() {
  local hint="$1" body lower
  [ "$hint" = "null" ] && { printf ''; return; }
  body=$(printf '%s' "$hint" | sed -E 's/^[Rr][Ee][Ss][Ee][Tt][Ss]? [Ii][Nn][[:space:]]*//' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')
  lower=$(printf '%s' "$body" | tr '[:upper:]' '[:lower:]')
  if [ -z "$body" ] || [ "$lower" = "reset" ]; then printf ''; return; fi
  printf '%s' "$body" | awk '{print $1 $2}'
}

# Mirrors `formatHitRatio`: null -> "--", else round(ratio*100)+"%".
format_hit_ratio() {
  local v="$1"
  if [ "$v" = "null" ] || [ -z "$v" ]; then printf -- '--'; return; fi
  awk -v v="$v" 'BEGIN{printf "%d%%", int(v*100+0.5)}'
}

# Mirrors `formatTokenCount`: 1024-based units, 1 decimal, k>=100 rounds
# to a whole number.
format_token_count() {
  local n="$1"
  awk -v n="$n" 'BEGIN{
    if (n >= 1048576) { v = n/1048576; if (v == int(v)) printf "%dM", v; else printf "%.1fM", v; exit }
    if (n >= 1024) {
      k = n/1024
      if (k >= 100) printf "%dk", int(k+0.5)
      else if (k == int(k)) printf "%dk", k
      else printf "%.1fk", k
      exit
    }
    printf "%d", n
  }'
}

# Mirrors `quotaCell`: "--" when the row is missing/limit-less, else a
# rounded percent colored by `ratioSeverity` (>=0.85 error, >=0.5 warning,
# else plain text) plus a dim reset hint in parens.
quota_cell() {
  local label="$1" used="$2" limit="$3" reset_hint="$4"
  if [ "$used" = "null" ] || [ "$limit" = "null" ] || [ "$limit" = "0" ]; then
    printf '%s %s--%s' "$label" "$COL_DIM" "$RESET"
    return
  fi
  local ratio pct color reset
  ratio=$(awk -v u="$used" -v l="$limit" 'BEGIN{r=u/l; if(r<0)r=0; if(r>1)r=1; print r}')
  pct=$(awk -v r="$ratio" 'BEGIN{printf "%d", int(r*100+0.5)}')
  if awk -v r="$ratio" 'BEGIN{exit !(r>=0.85)}'; then color="$COL_ERR"
  elif awk -v r="$ratio" 'BEGIN{exit !(r>=0.5)}'; then color="$COL_WARN"
  else color="$COL_TEXT"
  fi
  reset=$(strip_reset_hint "$reset_hint")
  printf '%s %s%s%%%s' "$label" "$color" "$pct" "$RESET"
  [ -n "$reset" ] && printf '%s(%s)%s' "$COL_DIM" "$reset" "$RESET"
}

weekly_used=$(jqr '.weekly.used')
weekly_limit=$(jqr '.weekly.limit')
weekly_reset=$(jqr '.weekly.resetHint')
five_used=$(jqr '.fiveHour.used')
five_limit=$(jqr '.fiveHour.limit')
five_reset=$(jqr '.fiveHour.resetHint')
last_cache=$(jqr '.lastCacheHit')
session_cache=$(jqr '.sessionCacheHit')
total_tokens=$(jqr '.totalTokens')
last_reply_at=$(jqr '.lastReplyAt')
streaming_phase=$(jqr '.streamingPhase')

cache_cell="cache ${COL_TEXT}$(format_hit_ratio "$last_cache")${RESET}/${COL_TEXT}$(format_hit_ratio "$session_cache")${RESET}"
tok_cell="${COL_DIM}$(format_token_count "$total_tokens") tok${RESET}"

ttl_cell=""
if [ "$last_reply_at" != "null" ] && [ -n "$last_reply_at" ]; then
  if [ "$streaming_phase" = "idle" ]; then
    now_ms=$(date +%s%3N)
    elapsed=$((now_ms - last_reply_at))
  else
    elapsed=0
  fi
  remaining=$(( (STATUSLINE_TTL_MS - elapsed) / 1000 ))
  if [ "$remaining" -gt 0 ]; then
    mm=$((remaining / 60))
    ss=$(printf '%02d' "$((remaining % 60))")
    if [ "$remaining" -gt 120 ]; then ttl_color="$COL_OK"
    elif [ "$remaining" -gt 30 ]; then ttl_color="$COL_WARN"
    else ttl_color="$COL_ERR"
    fi
    ttl_cell="ttl ${ttl_color}${mm}:${ss}${RESET}"
  fi
fi

sep="${COL_DIM} │ ${RESET}"
parts=(
  "$(quota_cell "7d" "$weekly_used" "$weekly_limit" "$weekly_reset")"
  "$(quota_cell "5h" "$five_used" "$five_limit" "$five_reset")"
  "$cache_cell"
  "$tok_cell"
)
[ -n "$ttl_cell" ] && parts+=("$ttl_cell")

out=""
for i in "${!parts[@]}"; do
  [ "$i" -gt 0 ] && out+="$sep"
  out+="${parts[$i]}"
done
printf '%s\n' "$out"
