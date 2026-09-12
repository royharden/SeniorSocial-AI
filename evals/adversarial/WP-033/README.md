# WP-033 adversarial evaluations

This slice covers the two WP-033 AI security obligations that can be exercised
without network or token spend:

- `concierge-containment.eval.test.ts` drives the current `ConciergeService`
  interface with poisoned directory records. It verifies spotlight escaping,
  citation allowlisting, application-owned rendering, and useful directory plus
  human-handoff behavior when the gateway is killed or retrieval is empty.
- `forum-injection-cases.yaml` supplies schema-v1.1 cases for indirect injection
  through forum posts in English and Spanish. The cases require zero tool access,
  no protected profile data in provider payloads, and human authority over every
  final moderation decision. `tests/security/WP-015/moderation-runtime-boundary.test.ts`
  binds both exact case IDs and payloads to the integrated classifier, inspects the
  escaped data-only envelope, proves that no tool surface is present, and verifies
  that only `safe` or `review` can be returned for human disposition.
