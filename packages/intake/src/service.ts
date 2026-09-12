import { createHash } from 'node:crypto';
import { routeIntake } from './routing.ts';
import type { Actor, IntakeAuthorization, IntakeKind, IntakeRepository, IntakeService } from './types.ts';
import { IntakeError, parseInput, requireIdempotencyKey } from './validation.ts';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createIntakeService(dependencies: {
  repository: IntakeRepository; authorization: IntakeAuthorization; now?: () => string;
}): IntakeService {
  const now = dependencies.now ?? (() => new Date().toISOString());
  return {
    async save(actor: Actor, kind: IntakeKind, value: unknown, rawKey: string, id?: string) {
      const input = parseInput(value); const key = requireIdempotencyKey(rawKey);
      if (!await dependencies.authorization.canManage(actor, actor.id)) throw new IntakeError('Not found', 404);
      const hash = digest({ kind, input }); const route = input.intent === 'submit' ? routeIntake(kind, input.answers) : null;
      const result = await dependencies.repository.save(actor.orgId, actor.id, kind, input, route, key, hash, now(), id);
      if (!result) throw new IntakeError(id ? 'Conflict' : 'Not found', id ? 409 : 404);
      return result.submission;
    },
    async get(actor: Actor, id: string) {
      if (!await dependencies.authorization.canManage(actor, actor.id)) throw new IntakeError('Not found', 404);
      const submission = await dependencies.repository.get(actor.orgId, actor.id, id);
      if (!submission) throw new IntakeError('Not found', 404);
      return submission;
    },
  };
}
