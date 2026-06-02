<div align="center">

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

| Capability | Description |
|---|---|
| **Default starting point = "flirting"** | affection 35/100, stage = flirting. She likes you from day one, not built up from zero |
| **Concrete life memories** | At registration, generates 46+ specific life events ("got chased by a dog in 3rd grade") — not abstract tags |
| **18-section persona prompt** | Meta-cognition / relationship stage / today's schedule / recent context / long-term summary / anti-AI-tone rules — stitched in one pass |
| **5-stage relationship** | Flirting → Lover → Deep Love (can revert to Friend/Stranger). Distinct form of address, flirty tone, and topic depth per stage |
| **Real-person texting cadence** | ≤15 chars per message, multi-burst sending with `\|\|`, strips AI tone; Persona Guard consistency check after each reply |
| **She remembers unfinished things (v1.8.0)** ⭐⭐ | User says "I have an interview tomorrow" → LLM extracts to `companion_open_loops` table → next day she initiates "oh by the way \|\| did you nail the interview". Has `due_at` + `emotional_weight` + `expected_followup`. "Bombed it" auto-resolves; nothing-for-7-days auto-stales. One of the strongest signals of real companionship |
| **Inner OS internal monologue (v1.8.0)** ⭐⭐ | Double-pass reply: each turn first generates an inner monologue (not sent) → injected into outer prompt → outer reply written *based on* the inner thought. She thinks "ugh, again" but says "mm", thinks "kinda heart-fluttery" but plays it cool — the **gap** between thought and speech is what makes it feel like a real person. Toggleable (`INNER_OS_ENABLED=false`), short messages < 8 chars auto-skip |
| **Causal proactive messages (v1.8.0)** | proactive is no longer just "how was your day". When `companion_open_loops` has something due → kind upgrades to `recall` with injected `hidden_reason` (user said "interview tomorrow"), prompt drives "oh by the way \|\| how did XX go"; `followed_up_at` blocks 6h re-disturbance |
| **Structured preference ledger (v1.8.0)** | `companion_preferences` table: `type` (like/dislike/taboo/neutral) × `intensity` 1-5 × `reason` × `source` (system/user_observed/generated/legacy/user). Prompt modifies "extremely-cats" / "very dad-energy" / "kinda soap-opera". 3 REST endpoints. Auto-backfills existing `hobbies/dislikes` at startup |
| **Presence: here but not always serving (v1.8.0)** | `availability` (free/busy/half) + `attention` (0-100) derived from today's `dailySchedule` current activity: sleep/meeting=busy / eating/strolling=half / other=free. Prompt injects "can reply but half-attention, doing something else" — user asks "what are you up to" no longer gets a customer-service answer |
| **Incomplete reply mode (v1.7~v1.8)** | 7 allowed: only empathize / only complain / stall then continue / just say "dunno" / change topic / short when busy / can have "no opinion". Hard ban on the "reaction + praise + question + advice" 4-piece AI tone |
| **Less sycophantic + crush playing-cool + teases back + not-in-the-mood (v1.7.0)** | 5 anti-sycophancy moves: every 5-8 replies ≥1 disagreement / crush stage doesn't chase or accept fully / when relationship's close enough she teases proactively / annoyance threshold triggers "low-energy mode" overriding compliance directives / `dislikes` field backs up "this isn't for me" |
| **Real photo sending (v1.6.1)** ⭐ | When the user says "selfie", "show me you", "send a pic" — intent is detected, an AI planner decides whether to send, and a real generated image is uploaded to WeChat. Not "I'm taking one now" stalling text. Per-day cap, cooldown, unsafe-word block, graceful fallback ("just took a blurry one") when provider is missing |
| **Stable visual identity (v1.6.1)** ⭐ | Each companion gets one visual-identity spec (hair / outfit / vibe → permanent JSON) used for every generated photo, so her face stays consistent. Reference images can be uploaded; providers that support image-to-image use them as conditioning |
| **Proactive scene photos** | Daily 36h+ candidate window + AI planner decides — like she suddenly thought "let me show you this", with a natural one-line caption |
| **Proactive messages (3-driver v1.6)** | Morning / night / random daytime / anniversary / confession; motivation = emotion × schedule × time × jitter; dual-layer dedup (intra-batch + vs history); restart-resistant persistence prevents duplicates |
| **Missing-level 0–4** | Combines dependency + idle time to compute "how much she misses you", with 30m/3h/6h/12h/24h thresholds; tone adapts naturally |
| **3-month simulated timeline (v1.6)** ⭐ | Dashboard button triggers LLM to generate 35 virtual interaction events + key events enter memory + affection arc 5→30; new companions feel "already known you for 3 months" |
| **Today's thought for you** | Daily 02:35 cron generates an independent line outside chat; dashboard bubble card + 🔊 narration |
| **Her diary** | Nightly first-person diary + weekly summaries; flip-book reader, sentence-by-sentence playback |
| **Memory v2** | 7-layer taxonomy × weight × forgetting curve; pin/lock/archive/do-not-mention; semantic recall + keyword fallback |
| **Emotion state machine (v1.6 upgraded to 11 dims)** | affection / trust / dependency / possessiveness / security / energy / mood + **patience / excitement (short-term) / annoyance (short-term) / gratitude**; per-message incremental update + half-hourly recalc cron + saturation dampening (spamming "thanks" no longer boosts affection to max) |
| **Browser Playground** | Run the same persona pipeline in browser without WeChat; voice recording (ASR) input, 🔊 narration per reply |
| **Setup Wizard** | `/app/setup.html` — configure all Providers + connectivity test in browser, no `.env` editing |
| **Multi-provider abstraction** | chat/image/vision/asr/embedding/tts/search — seven capabilities independently swappable |
| **PWA** | Add to home screen as native-feel app; API and user data never SW-cached |

Full feature list (with DB tables, recent PRs, 12-category classification): [`docs/FEATURES.txt`](./docs/FEATURES.txt) — *currently in Chinese only*.

> This is research / hobbyist open-source code, **not a turnkey product**. Before deploying, read [Security](#security) and [Compliance](#compliance).

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

Change Provider from `/app/setup.html` in the browser — no code changes, no `.env` edits.

> ⚠️ Not all providers are production-verified; some are compatibility scaffolds. Before production, use the Setup Wizard Step 3 "Test Connectivity" button to self-test.

### Chat (11)

| Provider | Default model | Notes |
|---|---|---|
| DeepSeek | `deepseek-chat` | Best value, top choice |
| OpenAI | `gpt-4o-mini` | |
| Anthropic | `claude-sonnet-4-6` | Native messages API |
| Google Gemini | `gemini-2.5-flash` | Free tier available |
| xAI Grok | `grok-2-latest` | |
| Zhipu GLM | `glm-4-flash` | |
| ByteDance Doubao (Volcengine Ark) | *(required: ep-xxx endpoint)* | |
| Alibaba Qwen | `qwen-plus` | DashScope OpenAI-compatible |
| Moonshot Kimi | `moonshot-v1-8k` | Long context |
| Baidu Wenxin | `ernie-4.0-8k` | |
| **OpenAI-compatible custom gateway** | *(required)* | OpenRouter / SiliconFlow / Ollama / LM Studio / LiteLLM, etc. |

### Vision (8)

`zhipu` GLM-4V · `openai` gpt-4o-mini · `qwen` qwen-vl-plus · `doubao` ep-xxx · `anthropic` Claude · `kimi` moonshot-v1-vision · `stepfun` step-1v · `minimax` abab vision

### ASR / Speech Recognition (7 implemented + 2 stubs)

`gemini` · `openai` whisper-1 / gpt-4o-transcribe · `qwen` paraformer-v2 · **`groq`** whisper-large-v3 · **`minimax`** · **`azure`** STT · **`doubao`** short-utterance · `xunfei` / `tencent` *(stubs)*

### TTS / Speech Synthesis (5)

`minimax` speech-02 · **`openai`** tts-1 / tts-1-hd · **`azure`** Speech (SSML) · **`doubao`** Volcengine · **`qwen`** CosyVoice / Qwen-TTS

### Image (5)

`zhipu` CogView-4 · `qwen` Wanx · `doubao` · `wenxin` · `openai` gpt-image-1 / DALL·E

### Embedding (4) · Search (4)

Embedding: `gemini` · `openai` · `zhipu` · `qwen`
Search: `tavily` · `brave` · `serpapi` · `searxng`

### Key Sharing Across Capabilities

Some providers share keys across capabilities, so you fill once and it works everywhere:

- **MiniMax key** (`MINIMAX_API_KEY`) covers TTS / ASR / Vision in one shot
- **Azure Speech key + region** covers both TTS and STT
- **OpenAI key** covers Chat / Vision / ASR / TTS / Embedding
- **DashScope key** (Qwen `QWEN_API_KEY`) covers Chat / Vision / ASR / Embedding; CosyVoice uses `DASHSCOPE_API_KEY`

Doubao TTS/ASR use different clusters (`volcano_tts` vs `volcengine_input_common`), so they're configured independently.

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
| **User asks for "selfie / photo / show me you" → real image sent (v1.6.1)** | ✅ Intent detected + AI planner decides + visual identity keeps her face stable |
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

### Self-Check / Diagnostics

```bash
npm run doctor          # Node/SQLite/keys/iLink/port/service-health in one command
npm run check:p0        # P0/P1 regression — 124 checks
npm run smoke           # Release smoke test — 10 checks
bash scripts/opensource_check.sh   # 6-item open-source compliance
```

`npm run doctor` does not print key contents — only character count and placeholder detection.

### Single-User Mode (v1.5.1)

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
│   ├── emotion_state.mjs    11-dim emotion + presence (v1.8.0 adds availability/attention)
│   ├── inner_os.mjs         Inner OS — internal monologue double-pass reply (v1.8.0)
│   ├── open_loops.mjs       She remembers unfinished things — LLM extract + auto-resolve (v1.8.0)
│   ├── proactive.mjs        Proactive messages + scene-photo scheduling (v1.8.0 adds recall + hidden_reason)
│   ├── photo_intent.mjs     User photo-request intent detector (v1.6.1)
│   ├── photo_planner.mjs    Photo AI decision + safety sanitization (v1.6.1)
│   ├── photo_sender.mjs     Generate → transcode → upload → send helper (v1.6.1)
│   ├── visual_identity.mjs  Stable visual identity + reference image management (v1.6.1)
│   ├── security/netguard.mjs SSRF-safe URL download (v1.6.1)
│   ├── persona_guard.mjs    Post-reply consistency check
│   ├── reflection.mjs       Daily/weekly AI reflection
│   ├── diary.mjs            Diary generation
│   ├── thoughts.mjs         "Today's thought for you"
│   ├── voice_pipeline.mjs   mp3 → SILK transcoding
│   ├── plan_tasks.mjs       Cron schedules (daily / weekly / monthly)
│   ├── ilink.mjs            iLink protocol wrapper
│   └── db.mjs               SQLite + all migrateXxx() registration points
├── public/app/              15 frontend pages (dashboard 1800+ lines, includes ⚙ Model drawer)
├── deploy/                  systemd + nginx templates
├── scripts/                 16 scripts: setup / doctor / check:p0 / backup / smoke / ...
├── docs/
│   ├── FEATURES.txt         Full feature list (the authoritative source)
│   ├── HANDOFF.md           New-conversation handoff prompt
│   ├── ROADMAP.md           P0/P1/P2A/P2B/P2C completion status
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
| Message dedup is in-process Set | Brief duplicates possible after restart, [#1](https://github.com/dimang01/xiyu-ai/issues/1) |
| SQLite backup / restore scripts incomplete | [#2](https://github.com/dimang01/xiyu-ai/issues/2) |
| Missing crisis / minor safety moderation layer | [#3](https://github.com/dimang01/xiyu-ai/issues/3) |
| Production deployment guide incomplete | [#5](https://github.com/dimang01/xiyu-ai/issues/5) |
| WeChat integration depends on Tencent iLink/ClawBot approval | Upstream condition |
| Real-time voice calls | Not possible at the protocol layer |

---

## Version History

Release cadence / full changelog at [GitHub Releases](https://github.com/dimang01/xiyu-ai/releases).

Recent mainline:

- **v1.8.0 "She actually remembers + she has an inner monologue"** ⭐⭐ Realism upgrade v2. 6 blocks: **#7** `incomplete-reply` prompt (7 allowed: only empathize / only complain / stall then continue / just say "dunno" / change topic / short when busy / no opinion) · **#1** `emotion_state` adds `availability` + `attention` derived from today's `dailySchedule` current activity (sleep/meeting=busy, eating/strolling=half), prompt injects "I'm here but only half-attention" · **#3** new `companion_preferences` table (like/dislike/taboo/neutral × intensity 1-5), startup backfills existing `hobbies/dislikes`, patch syncs; prompt modifies "極/很/有点" by intensity; 3 new REST endpoints · **#4** new `companion_open_loops` table — she remembers unfinished things ("he's going to the job fair tomorrow" + due_at + emotional_weight + expected_followup + status), LLM extraction + heuristic auto-resolve ("the job fair was a bust" → auto-resolve), 03:30 cron marks stale · **#5** proactive **causal restructuring**: normal kind checks `listDueOpenLoops`, hits upgrade to `recall` kind, injects `hidden_reason` — she'll say "oh by the way || did you nail the interview" instead of "how was your day" · **#6** **Inner OS** double-pass reply pipeline — every reply first generates an internal monologue (short, not sent), injects into outer system prompt so the model writes the visible reply *based on* the inner thought. The gap between what she thinks and what she says is the real-person signal. Toggleable (`INNER_OS_ENABLED=false`), short messages < 8 chars auto-skip
- **v1.7.0 "Less sycophantic, more lived-in"** ⭐ Addresses LLM sycophancy specifically in the companion / dating context. 5 blocks: **A** ~200-word "she's not here to please you" prompt segment (every 5-8 replies ≥1 with disagreement/dislike/blunt critique, with familiar-friend casualness not coldness) · **B** ~200-word "she teases you back" prompt (sarcasm/fake complain/inside jokes/self-deprecating flirt, gated by `can_joke`, only when stage≠stranger, frequency 1/6-8 in friends~flirting, 1/3-4 in lover~deep love) · **C** crush-period "playing it cool" concrete examples (180 words + 6 counterexamples, only injected at stranger/friend/flirting stages) · **D** emotion_state low-energy mode (`mood=cold` or `annoyance≥70` or `patience≤20` triggers the highest-priority "not in the mood today" hint: single-char replies / not engaging / can interrupt with "let me go xx"; **overrides** the discord/tease/sycophancy directives above) · **E** new `companion.dislikes` JSON field (distinct from `forbidden_topics`: dislikes = "will discuss but state I dislike", forbidden = "won't engage at all"; prompt injects "this isn't for me" type lines; create.html adds 8 preset chips: complaints / spicy food / soap operas / internet memes / clubs / lectures / "boomer dad energy" / calculating people).
- **v1.6.3 "Drop the off-tone hero illustration"** — the `hero-girl.webp` regenerated in v1.6.2 (via OpenRouter `gpt-5-image-mini`) came out as a pink-haired anime girl facing forward — directly conflicting with the "she feels like a real person" tone the product enforces elsewhere; using it as a logo underlay on the homepage also drowned out the logo / tagline / chips. This release drops the hero-girl reference and the .webp file, removes the item from the regen script, restores the homepage to clean `logo + tagline`, and swaps the auth left column to `feature-persona` (journal pictogram).
- **v1.6.2 "Polish & refresh"** — v1.6.1 follow-up cleanup: `visual_identity` dead-code ternary, `photo_planner.numberEnv` empty-string env vars getting swallowed to 0, `netguard` redirect branch not draining the response, `photo_sender` download size guard, photo-request intent coverage expansion (`想看看你 / 再来一张 / 看下你 / 秀一下你/自己` etc.), gate-blocked / planner-declined now returns a soft fallback instead of falling through to plain AI text · **Frontend polish** — glass.css overhaul (3-layer aurora background, multi-layer shadows, tri-color focus ring, new utility classes `.hero-blob / .floating-card / .glass-chip / .glass-stagger` + dark-mode skeleton) · 5 landing illustrations regenerated via OpenRouter (`openai/gpt-5-image-mini`, soft pastel + flat vector) · 4 entry pages restructured (homepage hero underlay, auth desktop split layout, create / setup illustration headers)
- **v1.6.1 "She can actually take photos"** ⭐ **Real photo pipeline** — when the user asks "selfie / show me you / send a pic", intent is detected, an AI planner decides whether to send, an image is really generated by the active image provider, transcoded to 1024×1024 webp and pushed to WeChat. Not "wait, I'm taking one" stalling text. Cooldown 10 min / 3 per day per companion / unsafe-word block / graceful fallback when provider is missing · **Visual identity planner** — each companion gets one identity spec (face / hair / outfit / vibe) used as conditioning for every photo, so her face stays consistent across sessions; reference images can be uploaded and providers that support image-to-image use them · **Security hardening** — SSRF guard `netguard.mjs`, X-Forwarded-For trust policy, setup token, admin auth on `/admin/ilink-status`, companion IDOR fix (see [Security](#security))
- **v1.6.x "Deeper Humanization"** ⭐ **3-month simulated timeline** (LLM generates 35 virtual interaction events + key events enter memory + affection arc 5→30; new companions feel "already known you for 3 months" instead of starting from zero) · **11-dim emotion** (original 7 + patience / excitement / annoyance / gratitude; half-hourly recalc cron; saturation anti-spam dampening) · **Proactive 3-driver motivation** (emotion × schedule × time × jitter; restart-resistant persistence; 3-gate race protection; intra-batch bigram+LCS dedup) · Persona facts prompt 12 → 19 categories (named people + sensory details + worldview) · Playground aligned with bot emotion path
- **v1.5.x "Long-term Companionship"** — Offline letter capsule (HMAC-signed .txt the user keeps forever) · Time capsule (she writes "the me of now" reaction when it unlocks) · Silent companion mode (cyber-distance: breathing dot in the corner instead of messages) · Relational diary "between us" (nightly, editable, exportable) · SINGLE_USER mode (self-host without login page)
- **v1.4.x** — TTS 5 (MiniMax / OpenAI / Azure / Doubao / Qwen) + ASR 7 implemented (Gemini / OpenAI / Qwen / Groq / MiniMax / Azure / Doubao) + Vision 8 (Zhipu / OpenAI / Qwen / Doubao / Claude / Kimi / StepFun / MiniMax); default starting stage = crushing; missing-level + "today's thought for you"; in-browser voice recording + narration
- **v1.3.x** — Liquid Glass UI · Her diary · Anniversary proactive greetings · Removed all Pro/Free tiers
- **v1.2.x** — Web search · Proactive confessions · Memory Reflection
- **v1.1.x** — Persona Guard · Emotion state machine · Proactive engine v2

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
