Find files by glob pattern, sorted by modification time (most recent first).

Powered by ripgrep. Respects `.gitignore`, `.ignore`, and `.rgignore` by default — set `include_ignored` to also match ignored files (e.g. build outputs, `node_modules`). Sensitive files (such as `.env`) are always filtered out. Matches are files only — directories are never listed; to find a directory, glob for a file inside it (e.g. `**/fixtures/**`).

Good patterns:
- `*.ts` — extension match at any depth below the search root (a bare pattern without `/` matches recursively)
- `src/*.ts` — files directly inside `src/` (one level, not recursive)
- `src/**/*.ts` — recursive walk with a subdirectory anchor and extension
- `**/*.py` — recursive walk from the search root for an extension
- `*.{ts,tsx}` / `{src,test}/**/*.ts` — brace expansion (cartesian supported)

Results are capped at the first 100 matching paths, with a truncation marker. Refine the pattern (extension, subdirectory) or call again with a narrower anchor when 100 is not enough.

Large-directory caveat — avoid recursing into dependency / build output even with an anchor, especially with `include_ignored`: `node_modules/**/*.js`, `.venv/**/*.py`, `__pycache__/**`, `target/**` can produce thousands of results that truncate at the cap and waste context. Prefer specific subpaths like `node_modules/react/src/**/*.js`.
