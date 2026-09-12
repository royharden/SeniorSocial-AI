import { authenticated, json, sameOrigin, unavailable } from '../../notifications/_shared';
import { createPostgresRepository } from '../../../../../../../packages/notify/src/postgres';
import { createRuntime } from '../../../../../../../packages/notify/src/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticated(request, async (identity, client, recheck) => {
    const preferences = await createPostgresRepository(client).transaction(identity, tx => tx.preferences());
    await recheck();
    return json(preferences);
  });
}
export async function PUT(request: Request) {
  if (!sameOrigin(request)) return unavailable();
  return authenticated(request, async (identity, client, recheck) => {
    const input: unknown = await request.json();
    await recheck();
    const notify = createRuntime(client, { enqueue: () => Promise.reject(new Error('Queue unavailable')) });
    const result = await notify.replace(identity, input);
    await recheck();
    return result.status === 'saved' ? json(result.preferences) : unavailable();
  });
}
