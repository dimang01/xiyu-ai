# 溪语 AI · Roadmap

## P0 · Core Companion Experience — 🚧 Implementation Started (2026-05)

**Goal:** Make the AI companion feel genuinely present and emotionally consistent.

### ✅ Completed in this cycle

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

### 🔲 Pending / Future

| Area | Feature | Notes |
|---|---|---|
| **Memory v2** | Semantic dedup using embeddings | Needs embedding provider |
| **Memory v2** | Scheduled decay job (cron) | Update `decay_score` periodically |
| **Memory v2** | Memory reflection / auto-upgrade layer | AI-driven, needs extractStructuredInfo |
| **Persona Guard** | Fine-tune intimacy rules per companion | More per-companion config |
| **Emotion State** | AI-driven update (not just rules) | Optional: call AI for nuanced updates |
| **Proactive v2** | User feedback learning (skip if ignored) | Track user-reply-to-proactive ratio |
| **Playground** | Persona Guard visual indicator | Show when guard fired |

---

## P1 · Polish & Reliability — Planned

- Multi-user companion support
- Admin emotion state viewer
- Memory import/export (JSON)
- Companion mood history chart

## P2 · Platform — Planned

- Plugin hooks (pre/post message)
- Webhook support for external integrations
- REST API versioning

---

*Last updated: 2026-05*
