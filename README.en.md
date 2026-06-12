<div align="center">

<img src="./assets/cover.png" alt="Xiyu AI · an open-source AI-girlfriend companion framework" width="100%" />

# Xiyu AI · 溪语 AI

**An open-source AI-girlfriend companion framework — she starts already crushing on you, not as a stranger.**

She already secretly likes you — your starting relationship is not "stranger", it's "flirting".
She'll text you, miss you, write a diary about you, and read her thoughts aloud to you.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status: Experimental](https://img.shields.io/badge/Status-Experimental-orange.svg)](#known-limitations)
[![Docker](https://img.shields.io/badge/Docker-GHCR-2496ED.svg?logo=docker&logoColor=white)](https://github.com/dimang01/xiyu-ai/pkgs/container/xiyu-ai)
[![Releases](https://img.shields.io/github/v/release/dimang01/xiyu-ai?color=FF8FB8)](https://github.com/dimang01/xiyu-ai/releases)

[简体中文](./README.md) | **English**

[Quick Start](#-30-second-quick-start) · [Features](#what-it-does) · [Providers](#multi-provider-support) · [Deploy](#deploy) · [Security](#security)

</div>

---

## ⚡ 30-Second Quick Start

Don't want to read docs? Copy-paste one line and it runs:

```bash
docker run -d -p 3000:3000 -v xiyu-data:/app/data --name xiyu-ai \
  ghcr.io/dimang01/xiyu-ai:latest
```

Open <http://localhost:3000/app/setup.html> → create a local account → pick a Provider and fill in your API Key → start chatting.

**No need** to install Node, clone the repo, edit `.env`, set up email, or configure WeChat credentials. If Docker is installed, that's it.
For first-time setup we recommend DeepSeek (sign-up bonus credits) or Zhipu GLM-4-Flash (free tier) to walk through the flow.

For detailed startup methods (Compose / local bare-metal / Docker image tags), see [Deploy](#deploy).

---

## What It Does

**Core positioning**: not a chatbot — a framework that organizes an LLM into "a girl who already secretly likes you".

> **Design philosophy (governs every feature decision)**: realism = **subtraction**, not addition. AI-flavor comes from being "too good" — too prompt, too compliant, too perfect. The north star is "**willing to give you warmth in the gaps of a real life**": less, precise, light — never filling every moment. Tone red lines: no yandere / darkness / NSFW / doom-scrolling-bait — NSFW is never a selling point. Prompts alone can't suppress strong model defaults, so every product rule ships with a **deterministic backstop** (outbound scrubbing / hard injection / state-machine-fed values). See [CONTRIBUTING](./CONTRIBUTING.md).

### Who she is

| Capability | One-liner |
|---|---|
| Default start = flirting | affection 35/100 — she likes you from day one, not raised from stranger-zero |
| Concrete life memories | 46+ specific life events generated at creation ("chased by a dog in 3rd grade"), not abstract tags |
| 5-stage relationship | Flirting → Lover → Deep Love (revertible); affection is fed by time — the lover gate needs days known + a daily cap, you can't grind it |
| Confessions have real pacing | Yours gets accepted only when it's earned, deflected gracefully when not; she may confess too — stammering, circling, beautifully clumsy, not polished lines |
| 18-section persona prompt | Meta-cognition / stage / schedule / long-term digest / anti-AI-tone rules stitched in one pass; a separate visual identity keeps her looks consistent |
| 3-month simulated timeline | One click generates 90 days of virtual interaction history — she's "known you for three months" on first open |
| Portable persona | Export / import JSON across deployments; runtime state (affection / emotion / safe mode) deliberately does not migrate |

### She has a life of her own

| Capability | One-liner |
|---|---|
| She sleeps | Default 00:30–07:30 (small daily jitter); once truly asleep both WeChat and web go silent; goodnight leaves a "stay a little longer" grace window; 📞 calling wakes her — grumpily |
| Daily schedule | 8–12 life segments generated each day (class / cooking / zoning out); proactive messages anchor to life's gaps, not even spacing |
| Present but not always serving | availability / attention derived from her current schedule — "can reply but you'll have to wait" in a meeting, distracted while out shopping |
| Texts like a real person | ≤15-char bursts, multi-message sends, typing indicator; when you rapid-fire 2–3 messages she waits for you to stop and replies once |
| Incomplete replies | Allowed to just empathize / just vent / just not know / reply short when busy — rejects the "react + praise + question + advice" 4-piece AI combo |

### She has real emotions and boundaries

| Capability | One-liner |
|---|---|
| 11-dimension emotion machine | trust / dependency / possessiveness / security / patience / annoyance… incremental per message + half-hourly recalc + anti-grind damping; moods have intensity and inertia — one sentence can't flip anger to joy |
| Inner OS monologue | Every turn first generates an inner thought (never sent) then the outer reply — thinks "ugh, again", says "mm". **The gap between thought and speech** is the core of feeling human |
| Neglect changes her, step by step | missing → probing → disappointed → withdrawn; three attachment styles (secure / anxious / avoidant) set the pacing; reunions follow a day-by-day repair arc |
| Conflict & repair arc ⭐ | Hitting her taboos / harsh words create **relationship events**: an explicit hurt → cold → withdrawing → repairing state machine. Wounds need a real apology to unlock repair (a dismissive "stop being mad" repairs slowly); distance heals from the reunion itself; withdrawal has a hard time cap — **cold war can never be permanent**; reconciliations enter long-term memory ("you promised not to check my phone last time"). Design doc: [docs/CONFLICT_ARC.md](./docs/CONFLICT_ARC.md) |
| Not sycophantic | At least 1 disagreement every 5–8 replies; plays it cool while flirting; teases you once you're close; repeated poking escalates one-way without flip-flopping |
| Low-energy mode | Annoyance / exhausted patience triggers "not in the mood today" — short replies, no elaboration; sometimes her silence is asking you to reach for her |

### She remembers you

| Capability | One-liner |
|---|---|
| Memory v2 | 7 layers × weights × forgetting curve; pin / lock / do-not-mention; semantic recall with keyword fallback; a nightly reflection engine distills new memories |
| Remembers unfinished things | You say "interview tomorrow" → next day she asks "hey \|\| how did it go"; auto-resolves when it falls through |
| You can shape her | Teach her nicknames / catchphrases / taboos / pacts / inside jokes — all recorded and binding in her prompt |
| Structured preference ledger | like / dislike / taboo × intensity — "extremely cat-person", "slightly tired of soap operas", with receipts |
| Her diary + relational diary | Nightly first-person diary plus "today's memory about you"; book-style reading, read-aloud |
| Time capsules / offline letters | Write something to unlock in the future — "present her" reads it and writes back; she can also write you a signed offline letter |
| Shared history from day one | A week of backstory is generated on creation; after 10 messages or a WeChat bind, it quietly extends to "we met three months ago" |
| Anniversaries | Auto-registers "100 days since we met / one year together" and initiates wishes on the day |

### She reaches out first

| Capability | One-liner |
|---|---|
| Three-driver proactive | motivation = emotion × schedule × time-of-day × jitter; double-gated morning/goodnight dedup, paraphrase-collision detection, pre-injection of her recent lines |
| Material-level no-repeat | Once she's used a bit (that cat, that little story), it cools down for 14 days — even reworded next-day retells get caught by the ledger |
| Reads the room | Shuts up after 3 unanswered sends; a light "you there?" right before the session window closes; a dignity cap per attachment style — she never clings |
| Cause-driven | Not just "how was your day" — when an open loop is due it upgrades to "oh right \|\| did that thing work out" |
| Converges during conflicts | Lower frequency while fighting, no aegyo / photos / confessions; may offer one olive-branch message while repairing |

### Multimodal

| Capability | One-liner |
|---|---|
| Real photo sending ⭐ | "send a selfie" → intent detection + AI planner + an actually generated photo: shot mode routed by context (selfie / environmental selfie / what-she's-doing POV / scenery, portrait 3:4), lighting consistent with time-of-day and chat, anti-airbrush realistic skin, daily caps and cooldowns |
| Stable looks | One visual identity per companion; pick-your-favorite from 4 candidate selfies to lock a reference; i2i anchors the same face in every later photo |
| Voice emotion recognition | Inbound WeChat voice isn't just transcribed — she hears "gentle / pouty / impatient" and responds to the tone |
| Web read-aloud | Diary / daily line / chat replies via TTS (outbound voice on WeChat is blocked by the iLink protocol — see Known Limitations) |
| Stickers | Emotion-tag matched sending (repo ships no assets; bring your own licensed images) |

### Safety & bottom lines

| Capability | One-liner |
|---|---|
| Crisis intervention | Self-harm signals → she steps out of character immediately and gives hotline resources; top priority even mid-cold-war — she never gives attitude to someone who's not okay |
| Minor protection | Detected self-disclosed minor → sticky safe mode (friend persona / no romance / neutral photos), **no off switch**, released only via explicit age attestation |
| Privacy filter | Passwords / IDs / bank-card-grade content never enters long-term memory; phones / addresses redacted — mounted on every long-term storage entry point |
| Conflict red lines | Never breakup threats / blocking / guilt-tripping, never weaponizing what you confided — all enforced by deterministic outbound scanning, not model goodwill |
| Persona leak guard | Post-reply consistency checks plus deterministic prompt-injection interception |

Full feature inventory (incl. DB tables) in [`docs/FEATURES.txt`](./docs/FEATURES.txt); per-version evolution in [Releases](https://github.com/dimang01/xiyu-ai/releases).

> This is research / personal-use oriented open source, **not a turnkey product**. Read [Security](#security) and [Compliance](#compliance) before going public.

---

## After It Starts Running

```
1. http://localhost:3000
2. /app/auth.html       Email signup (dev mode prints code to log)
3. /app/create.html     4-step wizard to create an AI character
4. Pick a chat entry:
   · /app/playground.html   Chat in browser (any chat provider works)
   · /app/bind.html         WeChat QR binding (requires iLink approval)
5. /app/dashboard.html  Live view of affection, relationship stage, missing-level, "what she's doing now"
```

### Key Pages

| Path | Purpose |
|---|---|
| `/app/setup.html` | First-time setup wizard (Chat/Vision/ASR/TTS/Search Provider + connectivity test) |
| `/app/auth.html` | Email signup / login |
| `/app/create.html` | Create AI character (4-step wizard) |
| `/app/dashboard.html` | Main dashboard + ⚙ Model Settings drawer + Reset-to-crush button |
| `/app/playground.html` | In-browser chat + 🎙️ voice recording + 🔊 narration |
| `/app/memories.html` | 7-layer memory filter, CRUD, pin/lock/archive |
| `/app/diary.html` | Her diary, flip-book style, sentence-by-sentence narration |
| `/app/bind.html` | WeChat QR binding |
| `/app/admin.html` | Admin panel (password in `.admin-credentials`) |

---

## Multi-Provider Support

Switch providers in `/app/setup.html` — no code edits, no `.env` editing. Seven capabilities switch independently:

| Capability | Providers | Notes |
|---|---|---|
| **Chat** (11) | DeepSeek · OpenAI · Anthropic · Gemini · xAI · Zhipu · Doubao · Qwen · Kimi · Ernie · OpenAI-compatible custom gateway | Gateway covers OpenRouter / SiliconFlow / Ollama / LM Studio etc. |
| **Image** (6) | Zhipu · Qwen · Doubao · Ernie · OpenAI · OpenRouter / 302.ai (chat modality) | 302/OpenRouter support i2i reference for face locking; per-provider best-fit output aspect |
| **Vision** (8) | Zhipu GLM-4V · OpenAI · Qwen VL · Doubao · Claude · Kimi · StepFun · MiniMax | Image understanding |
| **ASR** (7 impl.) | Gemini · OpenAI Whisper · Qwen paraformer · Groq · MiniMax · Azure · Doubao | Xunfei / Tencent are placeholders awaiting PRs |
| **TTS** (5) | MiniMax · OpenAI · Azure · Doubao · Qwen CosyVoice | Read-aloud works on web only |
| **Embedding** (4) | OpenAI · Gemini · Zhipu · Qwen | Semantic memory recall |
| **Search** (4) | Tavily · Brave · SerpAPI · SearXNG | Web search |

> ⚠️ Not every provider is production-verified; self-test with the Setup Wizard's "test connection" before going live.

**Key reuse**: one MiniMax key covers TTS/ASR/Vision; OpenAI covers Chat/Vision/ASR/TTS/Embedding; DashScope (Qwen) covers Chat/Vision/ASR/Embedding; Azure Speech handles both TTS/STT. Doubao TTS/ASR use different clusters and need separate config.

---
## WeChat Integration

### Path 1: In-browser QR (recommended)

Follow [After It Starts Running](#after-it-starts-running) to step 4. **No need** to pre-fill `ILINK_BOT_TOKEN` / `ILINK_BOT_ID`, no need to run `npm run ilink:login` beforehand.

The backend calls `ilink/bot/get_bot_qrcode` on `POST /api/wechat/bind-session` to issue a fresh QR; on success it auto-writes to the table and hot-registers to the polling pool.

> **About iLink approval**: whether the QR scan returns a `bot_token` depends on whether your WeChat account has obtained developer approval from Tencent's iLink/ClawBot platform. Without approval, you can still use `/app/playground.html` in the browser for the full experience — just not pushed to WeChat.

### Path 2: Terminal QR (VPS / headless container)

```bash
npm run ilink:login
```

On success, credentials are written to `./.weixin-credentials.json` (mode 0600, gitignored).

### What WeChat Can / Cannot Do

| Action | Status |
|---|---|
| Send/receive text | ✅ |
| Send images / files / video | ✅ |
| **User asks for "selfie / photo / show me you" → real image sent** | ✅ Intent detected + AI planner decides + visual identity keeps her face stable |
| Daytime proactive scene photos (≥36h candidate window, AI decides) | ✅ |
| Proactive messages + typing indicator | ✅ |
| Receive user voice → ASR | ✅ (also works in playground) |
| **Bot sending voice in WeChat** | ❌ Forbidden by iLink protocol (HTTP 200 returned but message silently dropped, Tencent's anti-abuse) |

So **voice synthesis / narration features only work in the web/PWA client**. SILK encoding pipeline code is kept in reserve in case Tencent opens it up. See the Sprint 2 post-mortem at the end of [`docs/voice-sprint-plan.md`](./docs/voice-sprint-plan.md) (Chinese).

---

## Deploy

### Path A: Docker Compose (recommended for production)

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
docker compose up -d
# Open http://localhost:3000/app/setup.html
```

- SQLite goes to `./data` volume, persists across restarts
- `restart: unless-stopped` is already in compose, no extra systemd needed
- Custom port: `HOST_PORT=8080 docker compose up -d`
- View logs: `docker compose logs -f xiyu-ai`

### Path B: Bare-metal (recommended for getting started)

```bash
git clone https://github.com/dimang01/xiyu-ai.git
cd xiyu-ai
npm install        # Node ≥ 20
npm run setup      # Generates minimal .env + pre-checks better-sqlite3 toolchain
npm start
```

`npm run setup` provides OS-specific fix commands when build tools are missing.

### Path C: One-line `docker run`

```bash
docker run -d -p 3000:3000 -v xiyu-data:/app/data \
  --name xiyu-ai ghcr.io/dimang01/xiyu-ai:latest
```

The image is auto-built and pushed to GHCR on each v\* tag, supporting `linux/amd64` and `linux/arm64`. Available tags: `latest` / `1.4` / `1.4.2` (pin a specific version recommended).

Trim the image: pass `--build-arg WITH_VOICE=0 --build-arg WITH_IMAGE=0` to drop ffmpeg / wx-voice bulk.

### Reverse Proxy / systemd / Backup

`deploy/` provides templates:

| File | Purpose |
|---|---|
| [`deploy/xiyu-ai.service`](./deploy/xiyu-ai.service) | systemd unit with `NoNewPrivileges` / `PrivateTmp` / `ProtectSystem` hardening |
| [`deploy/nginx.conf.example`](./deploy/nginx.conf.example) | nginx reverse proxy: HTTPS + HSTS + long-polling timeouts + AI crawler routes |
| [`deploy/README.md`](./deploy/README.md) | clone → production step-by-step |
| `scripts/backup-db.sh` | Starting point for SQLite trio backup (`bot.db` + `-wal` + `-shm`) |

### nginx dual-directory deploy gotcha (common in self-hosting)

If your nginx `root` points to a **separate** frontend directory (e.g. `/var/www/xxx/frontend/`) instead of the project's own `public/`, then after every `git pull` you **must rsync `public/` over** — otherwise frontend changes (html/css/js) won't take effect but API changes will, leading to confusing "frontend calls new API and errors out" symptoms.

Minimal sync script (preserves assets unique to the nginx dir):

```bash
rsync -av --exclude='.gitkeep' /opt/xiyu-ai-new/public/ /var/www/xxx/frontend/
systemctl restart zhaohy-wechat
```

If your nginx `root` points directly at the project's `public/` (recommended), ignore this section.

### Self-Check / Diagnostics

```bash
npm run doctor          # Node/SQLite/keys/iLink/port/service-health in one command
npm run check:p0        # P0/P1 regression — 126 checks (incl. proactive guard since v1.10.0)
npm run check:imports   # ESM cycle / dead-import check
npm run check:field-drift  # daily_summary field-name drift
npm run smoke           # Release smoke test — 10 checks
bash scripts/opensource_check.sh   # 6-item open-source compliance
```

`npm run doctor` does not print key contents — only character count and placeholder detection.

### Single-User Mode

If you self-host on your own machine / LAN / behind a reverse proxy with its own access control, you can **skip the login page entirely**:

```bash
# add to .env
SINGLE_USER=true
```

Effects:
- Any page visit lands directly in the dashboard — no login/signup form
- First boot auto-creates an `owner` account (random placeholder password, never used)
- If accounts already exist, the lowest-ID one (typically the admin) is used as the default identity
- "Logout" button in dashboard is hidden (logging out would just auto-log back in)

⚠️ **Do NOT enable this when**:
- The service is directly exposed to the public internet without nginx Basic Auth / Cloudflare Access / IP allowlist
- Multiple people share the deployment (each should have a separate account)

When enabled, **all chat history, memories, and bound credentials are accessible to anyone who can reach the URL**. Defaults to OFF; multi-user mode is fully backward-compatible.

---

## Ops Toolbox

Self-hosting isn't "start it and forget it" — every production scar in this repo became a tool:

```bash
npm run doctor          # Node/SQLite/keys/iLink/port/service health, one-shot diagnosis
npm run lint            # ESLint: catches "silent runtime explosions" (const reassignment etc.) at lint time
npm run check:p0        # 127 P0/P1 regression assertions
npm run arc:digest      # Ops daily report (read-only): error-signature grouping (new signatures
                        # pinned & screaming) / relationship-event & apology streams /
                        # red-line hits / crisis takeovers / photo aspect distribution
npm run smoke           # release smoke; bash scripts/opensource_check.sh — 6 OSS compliance checks
```

- **Error-signature report**: last-24h error logs grouped by normalized signature (count / delta / first-seen), new signatures highlighted — silent failures get loud immediately
- **Proactive dead-man switch**: hourly heartbeat; active users present but proactive sends all dead → CRITICAL + email alert (`ADMIN_ALERT_EMAIL`), alert-only with zero self-healing
- **emotion-debug panel** (`/app/emotion-debug.html`, admin): arc state / event stream / per-message emotion deltas with reasons — emotional causality is inspectable, never voodoo
- **Annotation tool** (`/app/annotate.html`, admin): label real replies good/bad with tags (AI-flavour / lab-report tone / brilliant…) as you read them; `scripts/export-corpus.mjs` exports JSONL — a fine-tuning corpus pipeline that turns "reading" into "collecting"
- **31 CI gates**: syntax / lint / field-drift reconciliation / release consistency / feature smokes / red-line guards — every new gate is "red-tested" (must fail against a known-bad version)
- **Ops clamp**: `ARC_MAX_STATE` can temporarily cap conflict states (a no-rollback fuse for production mishaps; the opposite of minor protection — that one is an uncloseable safety floor)

---
## Architecture

```
                ┌────────────────────────────────────────────────┐
                │   Web Dashboard / Playground   /   WeChat user  │
                └───────────────────┬─────────────────────────────┘
                                    │
   ┌──────────────────────────────────────────────────────────────┐
   │  Express (index.mjs) — multi-tenant iLink polling pool       │
   │  ┌─────────────┬──────────────┬───────────────────────────┐  │
   │  │  api.mjs    │  auth.mjs    │  Setup Wizard / Dashboard │  │
   │  └─────────────┴──────────────┴───────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  bot.mjs (WeChat in)    playground.mjs (Web in)        │  │
   │  │           ↓                          ↓                  │  │
   │  │  shared reply pipeline: buildSystemPrompt + recallMemory│  │
   │  │           ↓                                             │  │
   │  │  ai.mjs → providers/ → chat/image/vision/asr/tts/...   │  │
   │  │           ↓                                             │  │
   │  │  memory_v2.mjs · emotion_state.mjs · proactive.mjs     │  │
   │  │  · persona_guard.mjs · companion.mjs · diary.mjs       │  │
   │  └────────────────────────────────────────────────────────┘  │
   │  ┌────────────────────────────────────────────────────────┐  │
   │  │  db.mjs (better-sqlite3 + WAL)                         │  │
   │  └────────────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘
```

### Key Design

- **Provider facade**: business layer only sees generic methods like `chatComplete()` / `ttsSynthesize()`; vendor differences hidden in `src/providers/*.mjs`
- **Shared reply pipeline**: WeChat entry and playground entry use the same pipeline; only iLink dispatch differs
- **Proactive de-duplication**: before sending, character 3-gram Jaccard against last 5 assistant messages; ≥ 0.6 similarity triggers regeneration
- **Schedule self-healing**: if 00:30 cron fails, proactive tick detects the missing schedule and regenerates on demand (30-minute debounce)
- **Persona Guard**: post-reply consistency check; auto-detects "I'm an AI" / customer-service tone / stage violations; minor issues post-processed, major ones regenerated

### Directory Layout

```
.
├── index.mjs                Express entry + iLink polling pool
├── src/
│   ├── ai.mjs               Business-layer AI facade
│   ├── providers/           chat / image / vision / asr / tts / embedding / web_search
│   ├── api.mjs              REST routes (3000+ lines)
│   ├── bot.mjs              WeChat message handler
│   ├── playground.mjs       Browser chat
│   ├── companion.mjs        18-section system prompt assembler
│   ├── memory_v2.mjs        7-layer memory + semantic recall + forgetting curve
│   ├── emotion_state.mjs    11-dim emotion state machine + presence
│   ├── inner_os.mjs         Inner OS monologue + conflict-arc structured detection
│   ├── open_loops.mjs       She remembers unfinished things
│   ├── proactive.mjs        Proactive messages + scene-photo scheduling
│   ├── photo_intent.mjs     User photo-request intent detector
│   ├── photo_planner.mjs    Photo AI planner + shot-mode/aspect routing
│   ├── photo_sender.mjs     Generate → aspect-aware transcode → upload
│   ├── visual_identity.mjs  Stable visual identity + reference images
│   ├── security/netguard.mjs SSRF-safe URL download
│   ├── relationship_arc.mjs Conflict & repair arc state machine (+_runtime IO layer)
│   ├── moderation.mjs       Crisis intervention + conflict red-line outbound guard
│   ├── minor_guard.mjs      Minor protection (sticky safe mode)
│   ├── privacy_filter.mjs   Long-term storage privacy filter
│   ├── persona_guard.mjs    Post-reply consistency check
│   ├── reflection.mjs       Daily/weekly AI reflection
│   ├── diary.mjs            Diary generation
│   ├── thoughts.mjs         "Today's thought for you"
│   ├── voice_pipeline.mjs   mp3 → SILK transcoding
│   ├── plan_tasks.mjs       Cron schedules (daily / weekly / monthly)
│   ├── ilink.mjs            iLink protocol wrapper
│   └── db.mjs               SQLite + all migrateXxx() registration points
├── public/app/              17 frontend pages (dashboard / playground / emotion-debug …)
├── deploy/                  systemd + nginx templates
├── scripts/                 80+ scripts: setup / doctor / arc-digest / smokes / sandbox acceptance / ...
├── docs/
│   ├── FEATURES.txt         Full feature list (the authoritative source)
│   ├── HANDOFF.md           New-conversation handoff prompt
│   ├── CONFLICT_ARC.md      Conflict & repair arc design doc
│   ├── ROADMAP.md           Route status + 2026-06 review
│   └── voice-sprint-plan.md Voice sprint plan
└── data/                    Runtime data (gitignored)
```

---

## Security

### Credentials and Sensitive Files

- `.env` / `.env.*` / `.auth-secret` / `.admin-secret` / `.admin-credentials` / `.weixin-credentials.json` / `data/bot.db*` / `data/user_memories/` — all gitignored
- Admin password is auto-generated as a 20-char random string on first start into `.admin-credentials` (0600); delete the file to regenerate if you forget
- `AUTH_SECRET` left empty auto-generates but regenerates each restart (which invalidates all tokens). **In production, explicitly set ≥32 random chars**
- `/api/health` only outputs provider name / whether iLink is configured / email mode; never outputs tokens / user data
- iLink `bot_token` is never logged; the QR login script only shows masked `bot_id` / `user_id`
- CORS is closed by default; default rate limit (`src/ratelimit.mjs`) is sized for personal use — front public services with a WAF

### v1.6.1 hardening

- **SSRF protection**: every user-supplied URL we download from (e.g. "set avatar from URL") goes through `src/security/netguard.mjs` — http/https only, DNS resolves are validated address-by-address, all RFC1918 / loopback / link-local / 100.64/10 carrier-NAT / IPv6 ULA & link-local / multicast ranges are rejected, ≤5 MB body cap, ≤3 redirect hops, 15 s timeout
- **Rate-limit IP source**: `req.ip` is now derived through Express trust-proxy chain instead of trusting client-supplied `X-Forwarded-For` (forgeable). For reverse-proxy setups set `TRUST_PROXY=true` or a specific IP / CIDR
- **First-time setup token**: `POST /api/setup/local-account` is localhost-only by default. For remote one-shot bootstrap, set `XIYU_SETUP_TOKEN=<random>` and have the caller send `xiyu-setup-token: <same>` — comparison uses `crypto.timingSafeEqual` to dodge timing leaks
- **Admin auth tightening**: `/api/admin/ilink-status` now requires `requireAdmin`; response fields are stripped of tokens, error messages are clamped to 80 chars, and bot IDs are masked
- **IDOR fix**: `/api/companions/user/:uid` verifies the companion belongs to the requesting account
- **Setup chat-test**: `/api/setup/test-chat` is now `softAuth`; anonymous calls are restricted to the "first-boot + localhost + zero accounts" allow-list

### Data and Content

- SQLite at `data/bot.db` by default, containing chat history / memories / user profiles. Self-hosted: data is entirely on your machine
- Chat history retained 60 days by default (`runHourlyCleanup`), adjustable; account deletion clears all data for the corresponding companion
- **Use extra caution for minors / high mental health risk users**, see [Issue #3](https://github.com/dimang01/xiyu-ai/issues/3)

### Reporting Security Issues

- Email: `xiyuai@proton.me`
- GitHub Security Advisories: <https://github.com/dimang01/xiyu-ai/security/advisories/new>
- Details in [SECURITY.md](./SECURITY.md)

---

## Compliance

**The MIT license only covers the code — it does not cover the content you produce, the third-party services you call, or your operational behavior. Public deployment is the operator's own responsibility.**

A 7-item operator self-check list (not legal advice):

| Dimension | What you need to do |
|---|---|
| Privacy policy / Terms of Service | `terms.html` / `privacy.html` are blank templates, **do not use as-is** |
| AI-generated content labeling | China's "Interim Measures for Generative AI Services", EU AI Act, etc. all require visible labeling |
| Minor protection | Current version has no built-in age verification / content rating |
| Personal data protection | PIPL / GDPR / CCPA, etc. — you must declare collection purpose and provide a delete interface |
| Content safety moderation | Repo currently only has a simple blocklist; integrate a cloud vendor moderation API before public exposure |
| Crisis intervention | Currently does not detect self-harm / suicide risk in inputs; please add crisis detection |
| Provider ToS | Each LLM/image provider has its own terms (whether virtual persona / emotional companionship / commercial use is allowed) — verify before switching |

### About the "Companion" Positioning

The framework does not prescribe character personality / NSFW content / boundary-crossing interactions. **The persona of registered characters is decided by the deployer or end user.** All persona templates in the repo are neutral examples. Whether to provide emotional companionship for adult users, and whether to allow certain types of characters, is your product and compliance decision — own the consequences.

---

## Known Limitations

| Limitation | Status / Tracking |
|---|---|
| **Bot sending voice in WeChat** | Permanent — iLink protocol forbids outbound voice; works fine in web/PWA |
| Xunfei / Tencent ASR are stubs | WebSocket + HMAC protocol complex, PR welcome |
| Content-moderation API left to the operator | Crisis intervention and minor protection are built in; public deployments should add a moderation service |
| Production deployment guide incomplete | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| WeChat integration depends on Tencent iLink/ClawBot approval | Upstream condition |
| Real-time voice calls | Not possible at the protocol layer |

---

## Version History

Release cadence / full changelog at [GitHub Releases](https://github.com/dimang01/xiyu-ai/releases); incremental index in [`docs/FEATURES.txt`](./docs/FEATURES.txt); the 2026-06 route review in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

The mainline, one line each:

- **v1.21.x Conflict & repair arc + engineering hardening**: a relationship-event state machine (she can genuinely get hurt; making up has inertia) consolidating all "she's cold to you" logic; post-incident "make silent failures loud" (ESLint / error-signature report / dead-man switch); photo aspect fix; immersion hygiene (the word "user" does not exist in her world, material-level anti-repeat, auto-generated shared history); photo-promise fulfilment chain (feasibility gate before promising, deferred makeup when uncapturable, moon-phase anchoring to kill fabricated full moons); photo-category calibration (sharing photos like a real relationship: food as a first-class category, sky anchored to a sun_times sunset window, "saw this and thought of you", a guardrail against fabricating real book covers; the audit-first pass also surfaced and fixed a 1.5-day silent photo outage P0)
- **v1.20.x Safety wrap-up**: minor protection (sticky safe mode), privacy filter on every storage entry, release-consistency CI, photo realism v2 (anti-airbrush texture finally reaching production)
- **v1.14 → v1.19 Realism depth**: graduated neglect + attachment styles, retention funnel (last-call / warm-up / read-the-room / icebreaker), the photo realism overhaul (environmental selfies / i2i face-lock / shot-mode routing), first-love traits
- **v1.6 → v1.13 Experience foundation**: real photo pipeline, anti-sycophancy series, Inner OS, open-loop memory, the sleep system, burst coalescing, relationship pacing (time feeds affection), zh/EN bilingual
- **v1.0 → v1.5 Framework taking shape**: persona engine, Memory v2, emotion state machine, proactive messaging, diaries, the multi-provider abstraction

---
## Contributing & Roadmap

- Found a bug? → [Open an Issue](https://github.com/dimang01/xiyu-ai/issues/new)
- Roadmap → [Issues](https://github.com/dimang01/xiyu-ai/issues) tagged with `enhancement` / `help wanted` / `good first issue` are best for first-time contributors
- Want to contribute code: fork → PR; keep changes small and focused, include motivation
- Acknowledgments in [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)

---

## License

[MIT](./LICENSE) © 2026 Xiyu AI Contributors

The repo **does not include** any third-party sticker images. `assets/stickers/` only contains the loading and tag-matching mechanism; to enable stickers, please prepare your own legally-licensed material.

---

<div align="center">

[⬆ Back to top](#xiyu-ai--溪语-ai) · [简体中文](./README.md)

</div>
