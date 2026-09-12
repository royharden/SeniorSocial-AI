import { authenticated, sameOrigin, unavailable } from '../../_shared';
import { createResidentRepository } from '../../../../../../../../packages/notify/src/resident';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{notificationId: string}> }) {
  if (!sameOrigin(request)) return unavailable();
  return authenticated(request, async (identity, client, recheck) => {
    const { notificationId } = await context.params;
    await recheck();
    const found = await createResidentRepository(client).markRead(identity, notificationId);
    return found ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }) : unavailable();
  });
}
