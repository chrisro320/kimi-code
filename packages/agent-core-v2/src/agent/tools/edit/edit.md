Perform exact replacements in existing files.

- Edit is mandatory for every incremental change, even small ones — DO NOT use Write or Bash `sed`.
- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed `old_string`.
- Take `old_string` and `new_string` from the Read output view: drop the line-number prefix and tab; match only file content.
- `old_string` must be unique unless `replace_all` is set. If ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.
- Multiple Edit calls in one response only when they do not target the same file. DO NOT issue consecutive Edit calls on the same file — a previous Edit can invalidate a later `old_string` (`old_string not found`); Read the file again first. A write lock serializes same-file edits in response order, but serialization does not make stale `old_string` valid.
- Pure CRLF files: Read shows LF — use LF in `old_string` and `new_string`; Edit writes CRLF back. Mixed endings or lone carriage returns: Read shows `\r` — include actual `\r` escapes in those positions.
