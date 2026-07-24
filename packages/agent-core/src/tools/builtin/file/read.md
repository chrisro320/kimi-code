Read a text file from the local filesystem.

If the user provides a concrete file path, call Read directly — do not `Glob`, `ls`, or otherwise pre-check known paths; missing or invalid paths return errors you can handle. Do not use Read for directories: use `ls` via Bash for a known directory, or Glob for name patterns (Glob lists files only, never directories). Use `Grep` only to search unknown content or locations.

Read several files in parallel: emit multiple `Read` calls in a single response instead of one file per turn.

- Relative paths resolve against the working directory; a path outside it must be absolute.
- Returns up to {{ MAX_LINES }} lines or {{ MAX_BYTES_KB }} KB per call, whichever comes first; lines longer than {{ MAX_LINE_LENGTH }} chars are truncated mid-line.
- Page with `line_offset` (1-based) and `n_lines`; omit `n_lines` for the {{ MAX_LINES }}-line cap. A negative line_offset reads from the end (-100 reads the last 100 lines); absolute value cannot exceed {{ MAX_LINES }}.
- Sensitive files (`.env` files, credential stores, SSH private keys, similar secrets) are refused; templates (`.env.example` / `.env.sample` / `.env.template`) and public SSH keys (`id_rsa.pub`) read normally.
- UTF-8 text only — non-UTF-8 encodings, binary files, and files with NUL bytes are refused; use `ReadMediaFile` for images/video, Bash or an MCP tool for other binary formats.
- Output format: `<line-number>\t<content>` per line. A `<system>...</system>` status block is appended after the file content; it summarizes line/byte counts, truncation, and line-ending notes, and is not part of the file.
- Pure CRLF files are displayed with LF; `Edit` matches this output and writes CRLF back. Mixed or lone carriage returns show as `\r` and require exact `Edit.old_string` escapes.
- After a successful `Edit`/`Write`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.
