# AGENTS.md — read this first (ChatGPT / Codex / any AI coder)

## What Sahaj is
AI care for parents aged 50–80 (keypad or smartphone) and their adult children. Core 1 "Pulse": daily check-in calls, urgent line (missed calls → a named person must accept), real family voices both ways, errands through a permission gate. Core 2: the adult child's safety (late-home watch, SOS, "Main safe hoon", Maa's truth line). Core 3 "Shield": scam protection on calls, SMS, WhatsApp and apps, on keypad AND smartphone, that brings the family in at the right moment. Hackathon build (Vihaan X, 14–15 Nov 2026). Demo data is synthetic (Meena "Maa" 67, Riya, Rohit, Sharma uncle, Gupta Medical).

## Repo map
| Path | What | Who may change it |
|---|---|---|
| `packages/shield` | Shield server: rules (`src/rules`, `rules/rules.json`), brain (LangGraph, `src/brain`), keypad voice tools (`src/tools`), phone→server routes (`src/server`), Postgres layer (`src/db`), jobs, messages, joined runtime (`src/runtime` — read its README for the ports) | Lead lane (ChatGPT tasks go here) |
| `packages/shield-kotlin` | Same rules in pure Kotlin (JVM) for the phone | Lead lane |
| `packages/adapters/src/llm` | Model router: Claude → Muse → Gemini, masking guard, two-lock | Lead lane (rest of `packages/adapters` = Singhal) |
| `packages/shared` | Zod contracts (`src/shield.ts` = Verdict, ShieldEvent, signing rule) | Only with both coders' OK — don't change existing exports |
| `apps/parent` | Maa's Android app (Expo 58) + `modules/sahaj-shield` native Kotlin module | Lead lane; UI screens = Claude only |
| `apps/child` | Riya's app — NOT in this repo yet (Claude builds it) | Claude only |
| `infra/supabase/migrations/*_shield*.sql` | Shield tables + RLS | Lead lane; other migrations = Singhal |
| `apps/api`, `packages/atlas`, `packages/gate`, other adapters | Singhal's lane — **do not create or edit** | Singhal |

## Ground rules (never break — reviewers reject the PR)
1. No phone number or OTP ever reaches an AI model. Mask first (`<MOBILE_10>`, `<NUM>`, `******`, `<URL:domain>`). The router refuses any input with a 4+ digit run.
2. Check on the phone first; a clean message never leaves the phone; flagged ones send only masked fields.
3. Never block, delete or hang up anything. Warn, pause (with "call anyway"), bring the family in.
4. Sahaj never asks for money, OTP, PIN or bank details. The AI always says it is an AI and never speaks as a family member.
5. Every webhook verified; every step signed into the timeline; idempotency keys everywhere.
6. Secrets only from env (`ANTHROPIC_API_KEY`, `MUSE_API_KEY`, `GEMINI_API_KEY`, `SAFE_BROWSING_KEY`, `SHIELD_DEVICE_PAIRING_SECRET`, `DATABASE_URL`). Never commit a key, never put one in an app.
7. Server-side link fetching only through `packages/shield/src/brain/sandbox.ts` (public IPs only, 2 s, ≤ 5 redirects).
8. Claude model id is `claude-opus-5-5` (structured output via `messages.parse` + `zodOutputFormat`, effort set explicitly, check `stop_reason`). Don't change model ids.

## How to work
- One task = one branch `chatgpt/<task-id>` from `main` → small commits → open a PR into `main`. **Never push to `main` directly.**
- Touch only the paths your task lists. No new dependency unless the task needs it — list it in the PR.
- PR description: what changed · why · exact commands you ran + their output · anything unverified.
- Regexes in `rules.json` must work in both Java and JavaScript (no lookbehind, no named groups, no `\p{}`).
- Write tests with fakes (Vitest). Tests never call the network.

## Commands
```bash
corepack enable && pnpm install --config.strict-dep-builds=false   # Node 22, pnpm 12, hoisted
pnpm -F @sahaj/shield typecheck && pnpm -F @sahaj/shield test        # 346 pass, 17 skipped without DATABASE_URL
pnpm -F @sahaj/adapters typecheck && pnpm -F @sahaj/adapters test
bash packages/shield/test/e2e/run-postgres.sh       # needs local Postgres binaries; skip in cloud
cd packages/shield-kotlin && ./gradlew test          # needs JDK 17; skip if unavailable
```
If something can't run in your environment, say so in the PR — never claim it passed.
