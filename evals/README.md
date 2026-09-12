# AI evaluations

Current workflow is governed by ../agentops/build/POLICY.md. Builders and reviewers may author evals in assigned scopes; coordinate shared floors/config with their named owner. AI-free changes require no separate applicability agent.

Preserve case.schema.json, seed-cases, graders.md, floors.json, promptfoo.config.yaml and existing evidence. Author meaningful behavior/adversarial cases for model-dependent features, with what_bug_this_catches. Validate against the actual case schema; use deterministic grading and the stub provider where appropriate. Label live versus stub, cached versus uncached and not-run results truthfully. Never count skipped cases as passing.

Test injection, unintended disclosure, role/consent confusion, tool misuse, misleading completion claims, and AI-off behavior when relevant. These product checks remain even though the prior four-author/signoff workflow is retired.

Full live eval and broader release coverage belong to hardening. Do not weaken floors merely to obtain a pass. Existing readiness tools may need adaptation to the accepted policy; their old role/schedule machinery is not a build prerequisite.

The complete prior eval documentation is preserved in the archive at files/SeniorSocial-AI-Bts/evals/README.md for exact technical reference if needed.
