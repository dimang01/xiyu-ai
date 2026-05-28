# 溪语 AI · Roadmap

## P0 · Core Companion Experience — ✅ Baseline Complete (2026-05)

**Goal:** Make the AI companion feel genuinely present and emotionally consistent.

### ✅ Completed in P0

| Area | Feature | Status |
|---|---|---|
| **Memory v2** | Layered memory schema (7 layers) | ✅ Done |
| **Memory v2** | Weight (0–5), status, source fields | ✅ Done |
| **Memory v2** | Pin / lock / archive / soft-delete | ✅ Done |
| **Memory v2** | Do-not-mention flag | ✅ Done |
| **Memory v2** | Sensitive content filter | ✅ Done |
| **Memory v2** | Decay score + recall ranking | ✅ Done |
| **Memory v2** | Deduplication (token similarity) | ✅ Done |
| **Memory v2** | Memory Control Panel (`/app/memories.html`) | ✅ Done |
| **Memory v2** | Full CRUD API with ownership checks | ✅ Done |
| **Persona Guard** | AI-disclosure pattern detection | ✅ Done |
| **Persona Guard** | Customer-service phrase filter | ✅ Done |
| **Persona Guard** | Stage-based intimacy guard | ✅ Done |
| **Persona Guard** | Self-third-person fix | ✅ Done |
| **Persona Guard** | Minor post-process + major regen | ✅ Done |
| **Persona Guard** | Integration in bot.mjs + Playground | ✅ Done |
| **Emotion State** | 7-dimension state table | ✅ Done |
| **Emotion State** | Rule-based update from user message | ✅ Done |
| **Emotion State** | Idle decay (missing / clingy) | ✅ Done |
| **Emotion State** | Emotion hint injected into system prompt | ✅ Done |
| **Emotion State** | Proactive also gets emotion context | ✅ Done |
| **Proactive v2** | Missing score computation | ✅ Done |
| **Proactive v2** | Motivation-based trigger selection | ✅ Done |
| **Proactive v2** | Anti-spam backoff (quiet/normal/clingy) | ✅ Done |
| **Proactive v2** | Record sent/replied timestamps | ✅ Done |
| **DX** | `npm run doctor` diagnostics | ✅ Done |
| **DB** | All migrations compatible, addColIfMissing pattern | ✅ Done |

---

## P1 · Stabilization + Intelligence Layer — ✅ Complete (2026-05)

**Goal:** Stabilize P0 gaps and add missing intelligence layers.

### ✅ Completed in P1

| Area | Feature | Status |
|---|---|---|
| **Memory Decay** | Scheduled writeback (`applyMemoryDecayBatch`) — 03:20 daily cron | ✅ Done |
| **Memory Decay** | `shouldWriteBackDecay` threshold guard (avoids redundant writes) | ✅ Done |
| **Reflection Engine** | `src/reflection.mjs` — AI-driven structured memory extraction | ✅ Done |
| **Reflection Engine** | `runDailyReflectionForCompanion` — triggers at 02:15 daily | ✅ Done |
| **Reflection Engine** | `runWeeklyReflectionForCompanion` — Pro users, Sunday 02:45 | ✅ Done |
| **Reflection Engine** | Confidence threshold (≥ 0.7), locked/pinned guard, sensitive filter | ✅ Done |
| **Semantic Dedup** | `findSimilarMemoryByEmbedding` — embedding cosine sim, fallback token | ✅ Done |
| **Semantic Dedup** | `addOrMergeMemory` — insert or merge into existing similar memory | ✅ Done |
| **Emotion History** | `companion_emotion_history` table with index | ✅ Done |
| **Emotion History** | `recordEmotionSnapshot` — rate-limited (15 min gap, 90-day cleanup) | ✅ Done |
| **Emotion History** | `GET /api/companions/:id/emotion-trend` | ✅ Done |
| **Emotion History** | Dashboard emotion trend chart (7-day, 4 dimensions) | ✅ Done |
| **Proactive v2** | `PROACTIVE_ENGINE=v2\|legacy` switch | ✅ Done |
| **Proactive v2** | v2 gate in `proactive.mjs` tick loop — error → fallback legacy | ✅ Done |
| **Prompt Debug** | `GET /api/companions/:id/prompt-debug` — sectioned prompt view | ✅ Done |
| **Prompt Debug** | `/app/debug-prompt.html` — section tabs, copy full prompt | ✅ Done |
| **AI Usage** | `GET /api/me/ai-usage?days=7` — user self-query | ✅ Done |
| **AI Usage** | `GET /api/admin/stats/ai-usage?days=7` — admin aggregate | ✅ Done |
| **AI Usage** | Dashboard AI usage card (7-day bar chart) | ✅ Done |
| **P0 Regression** | `scripts/p0_regression_check.mjs` + `npm run check:p0` | ✅ Done |
| **Docs** | README updated: check:p0, PROACTIVE_ENGINE, new pages | ✅ Done |

### 🔲 Remaining / Not in P1

| Area | Feature | Notes |
|---|---|---|
| **Emotion State** | AI-driven updates (not just rules) | Nuance requires AI call per message |
| **Semantic Recall** | Embedding-based recall (not just keyword) | Needs embedding provider always available |
| **Memory** | Embedding-based dedup requires embedding provider | Falls back to token similarity if unavailable |
| **TTS** | Voice reply synthesis | Needs TTS provider integration |
| **Safety Layer** | Content moderation for incoming + outgoing | Requires moderation API or local model |
| **Production Guide** | Nginx config, SSL, process manager docs | Deployment docs |
| **Cost Tracking** | `estimated_cost` per provider in usage dashboard | Needs pricing config per provider |

---

## P2 · Platform — Planned

- Plugin hooks (pre/post message)
- Webhook support for external integrations
- REST API versioning
- Companion memory import/export (JSON)
- Multi-companion management UI

---

*Last updated: 2026-05*
