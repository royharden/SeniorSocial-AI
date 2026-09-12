# AI register

Status: **gateway built; feature integration varies; none of this table alone establishes release readiness**.

The closed capability set comes from `packages/contracts/gateway-interface.ts`. Prompt versions come from `packages/ai/prompts/registry.json`; configured model routes come from `packages/ai/routing.json`. All eight configured routes name provider `anthropic-api`, model `claude-haiku-4-5`, prompt `v1`. Actual app runtime compositions for concierge, moderation, and translation register only `stub` / `test-stub` and disable AI when `AI_PROVIDER` is not `stub`. The Anthropic adapter is package-only, not a user-wired paid capability. `AI_PROVIDER=stub` is the safe automated-test path.

| Feature | Boundary / input data class | Human authority and AI-off route | Integrated caller | Default / readiness |
|---|---|---|---|---|
| `concierge` | `chat` receives resident text (potentially sensitive) and authorized public directory evidence; RAG `embed` handles service text/version/fingerprint | Person chooses; app performs search or creates a native assistance handoff. AI cannot send or dispatch | Product chat caller: `apps/web/app/concierge/core.ts`. Package-only embed caller: `packages/rag/src/service.ts` | Flag on in dev/staging/production, off in test. Chat caller is stub-only. RAG is not app-composed, its flag is off, and the configured Anthropic adapter has no embedding capability |
| `moderation` | `classify` receives forum text, an untrusted sensitive user-content class; message reports have a native human moderation path | Human staff/admin makes every moderation decision; reports still queue when killed | `packages/forums/src/moderation.ts` and forum runtime integration | Flag on in dev/staging/production, off in test. Stub-only app composition; forum/security hardening open |
| `translation_assist` | `translate` receives English content; source version is retained locally in the result; output is machine-draft content | Qualified reviewer approves current version; queue accepts manual drafts when killed | `packages/i18n/src/translation-workflow.ts`; admin translation route runtime | Flag on in dev/staging/production, off in test. Stub-only app composition; Spanish/release hardening open |
| `triage` | `classify` contract for resident assistance wording into closed labels; potentially sensitive service-need text | Resident’s native Priority Assistance submission and standing emergency guidance; staff decides handling | No gateway caller found outside the AI package at this base | Registered only; flag on in dev/staging/production, off in test; integration gap |
| `intake_routing` | `classify` contract for legal/health intake wording into closed partner category; sensitive intake data | Rules-based native routing and staff/partner workflow; model cannot submit | No gateway caller found outside the AI package at this base | Registered only; flag on in dev/staging/production, off in test; integration gap |
| `event_rerank` | `chat`/classification capability over supplied public event records only | Rules-only recommendations | No gateway caller found | Off in every environment; registered capability, not enabled/release-ready |
| `conversation_starters` | `chat` capability over supplied public, non-sensitive context | User writes messages without suggestions | No gateway caller found | Off in every environment; registered capability, not enabled/release-ready |
| `summaries` | `summarize` receives supplied record text plus `baseVersion`; may contain resident/staff data depending on future caller | Staff reads raw record; stale output must never overwrite newer human work | No gateway caller found | Off in every environment; registered capability, not enabled/release-ready |

## Shared control record

- Kill switches: `ai.master` AND `ai.<feature>` are evaluated at global and org scope (`global AND org`). Turning either off returns `killed` and a feature-specific `humanRoute`.
- Prompt identity: every registered feature uses `v1`; the runtime computes SHA-256 from the prompt file and writes version/hash to `ai_events` when a prompt is loaded. Early killed outcomes have no prompt identity because the prompt is not loaded.
- Provider/model: all routes name `anthropic-api` / `claude-haiku-4-5`; local/CI automation uses `stub` / `test-stub`. CLI bridges are rejected by the router.
- Data sent: caller-supplied model messages, registered system prompt, and operation-specific schemas/tool definitions. Concierge can include resident chat text, which may be sensitive, as well as public directory evidence; it is not public-only input. The Anthropic adapter checks serialized outbound canaries/server-fixture keys on each send. No paid transport is composed into the app at this base, and no model has direct database access.
- Logging: metadata, prompt identity, provider/model, token usage, latency, role/on-behalf-of, outcome, cost, and reservation are recorded. The event schema does not require storing raw prompt/user bodies.
- Cost and rate: paid calls reserve cost before send; per-user/feature limits and per-org/per-feature caps are durable boundaries.
- Cache: the gateway supports eligible exact-match calls with a caller-provided eligibility and reauthorization boundary. All three app compositions currently return `cacheable: false` and deny cache reauthorization; durable cache support is package-only. Do not assume a future boundary automatically excludes sensitive data.
- Authority: AI output is advisory/draft. Humans or native policy-checked endpoints make every consequential write.

## Default state and release limitation

The executable migration `0030_wp-006_audit_flags.sql` seeds `ai.master`, `concierge`, `moderation`, `translation_assist`, `triage`, and `intake_routing` true in dev/staging/production and false in test. `event_rerank`, `conversation_starters`, and `summaries` are false everywhere. These are seed defaults, not a reading of deployed flags. A true flag does not establish a paid-provider integration or release readiness. Operators must inspect effective flags before enabling any future paid transport.

Gateway fallback hints include `/assistance`, `/report`, `/language-help`, and `/support`, which have no page adapters at this base. Product callers must translate these hints into supported native workflows (for example `/help`); they are not guaranteed working browser links.

## Source anchors

`packages/contracts/gateway-interface.ts`; `packages/ai/prompts/registry.json`; `packages/ai/prompts/*/v1.md`; `packages/ai/routing.json`; `packages/ai/src/gateway.ts`; `packages/ai/src/config.ts`; `packages/flags/src/index.ts`; `packages/db/migrations/0030_wp-006_audit_flags.sql`; `packages/db/migrations/0160_wp-008_ai_gateway.sql`; caller files named above; `tests/unit/WP-008`; `tests/security/WP-008`.
