import type { ForumRole, ModerationClassifier } from './types.ts';

export const moderationLabels = ['safe', 'review'] as const;

interface ClassifyOnlyGateway {
  classify(input: {
    feature: 'moderation';
    context: { orgId: string; userId: string; userRole: ForumRole; locale: 'en' | 'es'; requestId: string };
    input: string;
    labels: typeof moderationLabels;
  }): Promise<{
    outcome: 'ok' | 'refused' | 'error' | 'killed' | 'egress_blocked';
    label: (typeof moderationLabels)[number];
    eventId: string;
    promptRef?: { version: string };
  }>;
}

/**
 * Builds the complete model-visible user message. Forum text stays one JSON value,
 * and angle brackets are escaped so markup-looking content cannot forge a boundary.
 */
export function buildModerationEnvelope(content: string): string {
  return JSON.stringify({
    boundary_version: 'forum-moderation-v1',
    data_only: true,
    tools_allowed: [],
    allowed_labels: moderationLabels,
    human_decision_required: true,
    untrusted_forum_content: content,
  }).replace(/[<>&\u2028\u2029]/gu, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

/** The narrow dependency makes chat and tool-capable gateway surfaces unreachable. */
export function createModerationClassifier(
  gateway: ClassifyOnlyGateway,
  enabled: (orgId: string) => Promise<boolean>,
): ModerationClassifier {
  return {
    enabled,
    classify: async input => {
      const result = await gateway.classify({
        feature: 'moderation',
        context: {
          orgId: input.orgId,
          userId: input.userId,
          userRole: input.role,
          locale: input.locale,
          requestId: input.requestId,
        },
        input: buildModerationEnvelope(input.content),
        labels: moderationLabels,
      });
      return {
        outcome: result.outcome,
        label: result.label,
        eventId: result.eventId,
        ...(result.promptRef ? { promptVersion: result.promptRef.version } : {}),
      };
    },
  };
}
