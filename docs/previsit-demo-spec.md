# Child Psychology Previsit Demo Spec

Date: 2026-06-30  
Updated: 2026-07-11

## Goal

Build a standalone P0 demo for a child/adolescent psychology previsit system. The cognitive-assessment project is used only as a visual reference. The business core is independent and follows the project framework:

`Free Narrative -> InitialIntakeCoverage -> EvidenceUnit/EvidenceState -> Gap/OpenIssue -> NextQuestionDecisionLog -> PrevisitPacket`

## First Demo Slice

- Guardian flow: profile, a voice-first free narrative with no fixed complaint choices, adaptive one-question-at-a-time follow-ups, optional audio/video capture and upload, and completion based on coverage rather than a fixed turn count. Text input is a transcript correction and accessibility fallback.
- Child flow: a separate `/child` route with child-oriented visual/copy, guardian consent, child-specific questions, `speakerRole=child`, and the same audio/video capability.
- Core engine: fourteen shared, non-diagnostic initial-intake domains cover presenting problem, manifestations, course, frequency/severity, impact, context, sources/settings, physical/developmental history, prior help, family background, safety, goals, and strengths. Internal symptom tags organize the clinician packet but never enable or suppress questions.
- Dynamic follow-up: deterministic coverage, attempt, safety, and termination policy always prepares a fallback. In `dynamic` mode the LLM may choose only an eligible gap and phrase one question; hard validation rejects invented/exhausted targets, premature completion, safety bypasses, disposition advice, and wrong audience wording.
- Clinician flow: queue, structured previsit summary, evidence replay, risk markers, important abnormalities, and decision logs. The clinician decides what to ask during the formal interview.
- Clinician workbench shares the guardian/child warm outpatient design system. The first screen prioritizes patient overview, structured Pre-visit summary, risk/abnormal/missing information, and source differences or temporal changes. Multi-source timeline, evidence provenance, and coverage state are collapsed drill-down details; media appears only when records exist. Demo-data controls are collapsed, while agent execution, strategy logs, and model audits remain internal and are not shown to clinicians.
- Persistence: local SQLite database when bundled dependencies are available.
- UI separation: `/guardian`, `/child`, and `/clinician` are independent portals; `/` only routes to those three portals.

## P0.5 Stability Layer

- Demo seed cases retain six familiar internal scan-tag examples, while every case follows the same comprehensive initial-intake coverage.
- Demo reset clears all session-level tables while preserving complaint templates, and removes the media files referenced by the cleared records without allowing paths outside the configured media root.
- Session status values are `draft`, `in_progress`, `completed`, and `needs_clinician_review`.
- Clinician queue supports status filtering.
- `GET /api/previsit/packet/:sessionId` only reads the latest stored packet and does not create one; `POST /api/previsit/packet/:sessionId/generate` explicitly generates or regenerates it.
- Clinician reviews the structured summary of symptoms, course, functional impact, context, risk clues, important abnormalities, missing information, multi-source differences, and evidence sources, then independently decides what to ask. The product has no formal-interview-question generation API or UI.
- Decision logs show missing slots, candidate questions, selected question, selection reason, filtered candidates, and risk markers in a readable view.
- `npm run acceptance` validates seeded cases, packets, evidence units, decision logs, and risk-review rows in a temporary database.
- `npm run regression` covers comprehensive coverage, adaptive ordering, answer relevance, precise short answers, attempt/termination rules, safety priority, child wording, LLM target boundaries, evidence conflicts, and structured packet output without requiring SQLite.
- `npm run server:data-safety-smoke` verifies packet-read purity and media-reset path safety against a temporary server and database.

## LLM Modes

- `.env` controls `PREVISIT_LLM_MODE`, `PREVISIT_LLM_PROVIDER`, `PREVISIT_LLM_BASE_URL`, `PREVISIT_LLM_API_KEY`, and `PREVISIT_LLM_MODEL`.
- The default local configuration is `dynamic` with `deepseek-v4-pro` through `https://api.deepseek.com`, using non-thinking JSON output for short per-turn structured generation. Remote Ollama on SSH host `a001-4` remains an optional configuration.
- In `dynamic` mode, extraction, evidence/state updates, risk markers, eligible-gap scoring, attempt limits, termination checks, and a rule next-question fallback are produced first. A successful model output may select an eligible non-rejected gap and phrase exactly one question. Provider errors, invalid output, unknown or exhausted targets, premature completion, safety-topic mismatch, disposition advice, duplicate wording, or adult language for a child leave the rule fallback in place.
- In `shadow` mode, rule planning remains primary and LLM extraction/clarification calls are retained only for clinician-side comparison and audit; they do not replace the user-visible rule question.
- Each guardian turn runs `llm_extract_shadow` in the background when `PREVISIT_LLM_MODE=shadow`.
- In `off` mode, the system runs the local rule flow without LLM calls.
- LLM output is validated as JSON with `complaints`, `slots`, `risk_signals`, and `open_issues`.
- Calls are written to `model_audit_log` with provider, model, prompt version, input/output hashes, latency, status, error, and validated output.
- Clinician decision logs show rule EvidenceUnit extraction next to LLM shadow extraction for comparison.

## Boundaries

- No diagnosis labels or differential diagnosis conclusions for guardians.
- No medication, treatment, dosage, stop/change medication, or crisis instruction output.
- The structured clinician summary must not contain diagnosis conclusions, risk tiers, treatment plans, medication instructions, or generated formal-interview questions.
- Generating or regenerating a clinician packet never changes interview status; only the core termination decision can complete a session.
- Risk input is saved as `risk_signal` and highlighted for clinician review only. No risk score or high/middle/low risk tier.
- After required consent and device checks, guardian/child sessions continuously capture one audio-video stream from chief-complaint entry through normal completion or explicit stop. Explicit stop generates a clinician packet from evidence collected so far. Media files remain local under `server/data/media/<sessionId>/`, while SQLite stores metadata and the clinician workbench provides playback.
- No HIS/EMR integration, login, mandatory LLM-provider lock-in, or vector store in this demo.
- DeepSeek calls leave the local machine; only synthetic or properly de-identified demo content may be used until privacy, consent, security, and data-governance review is complete.

## Architecture

- `core/`: pure rule-based previsit engine and templates.
- `server/`: API and persistence.
- `web/`: browser demo UI for guardian and clinician views.
- `scripts/`: local dependency linking and smoke checks.

## API

- `POST /api/previsit/sessions`
- `GET /api/previsit/sessions/:sessionId`
- `POST /api/previsit/turns`
- `GET /api/previsit/doctor/queue`
- `GET /api/previsit/packet/:sessionId` — read the latest stored packet only; returns no packet when none exists.
- `POST /api/previsit/packet/:sessionId/generate` — explicitly generate or regenerate the packet.
- `GET /api/previsit/evidence/:sessionId`
- `GET /api/previsit/admin/decision-logs/:sessionId`
- `GET /api/previsit/demo/cases`
- `POST /api/previsit/demo/reset`
- `POST /api/previsit/demo/seed`

## LLM Configuration

```bash
PREVISIT_LLM_MODE=dynamic
PREVISIT_LLM_PROVIDER=openai_compatible
PREVISIT_OLLAMA_SSH_HOST=
PREVISIT_OLLAMA_TUNNEL_LOCAL_PORT=11435
PREVISIT_OLLAMA_REMOTE_PORT=11434
PREVISIT_LLM_BASE_URL=https://api.deepseek.com
PREVISIT_LLM_API_KEY=replace-with-your-deepseek-api-key
PREVISIT_LLM_MODEL=deepseek-v4-pro
PREVISIT_LLM_CLARIFY_MODEL=deepseek-v4-pro
PREVISIT_LLM_THINKING=disabled
PREVISIT_LLM_TIMEOUT_MS=30000
PREVISIT_LLM_CLARIFY_TIMEOUT_MS=20000
PREVISIT_LLM_RETRY_ATTEMPTS=1
PREVISIT_LLM_TEMPERATURE=0.2
PREVISIT_LLM_MAX_TOKENS=700
```

Set `PREVISIT_LLM_MODE=shadow` to keep LLM extraction in the audit path, or
`PREVISIT_LLM_MODE=off` to run without model calls. The local `.env` file is
ignored by git and must be the only place where the real API key is stored.
