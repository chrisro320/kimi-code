---
"@moonshot-ai/kimi-code": minor
---

Split the web and desktop apps out of this repo into the code-app repo. `apps/kimi-web` and `apps/kimi-desktop` sources are removed, along with the desktop release CI (`desktop-build.yml`, the `desktop-artifacts` release job) and the `copy-web-assets.mjs` staging script; the `kimi-code` package build no longer builds the web bundle. The web UI bundle will ship as a committed `apps/kimi-code/dist-web` artifact synced from code-app (follow-up change), which is what the server and the SEA native bundle embed.
