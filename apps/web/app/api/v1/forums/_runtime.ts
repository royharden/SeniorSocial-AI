import { randomUUID } from 'node:crypto';
import { AiEventRepository } from '../../../../../../packages/audit/src/index.ts';
import { createDatabaseClient } from '../../../../../../packages/db/src/index.ts';
import { FlagRepository } from '../../../../../../packages/flags/src/index.ts';
import { createForums, createModerationClassifier, PostgresForumRepository, type ForumIdentity, type ForumsService, type ForumRateLimiter, type ModerationClassifier } from '../../../../../../packages/forums/src/index.ts';
import { createWp006Gateway, DurableRateLimiter, DurableReservationStore, FilePromptRegistry, FileRouter, InMemoryExactCache, loadPriceBook, StubProviderAdapter } from '../../../../../../packages/ai/src/index.ts';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared.ts';

export async function authenticated(request: Request): Promise<ForumIdentity | null> {
  const token = readCookie(request, SESSION_COOKIE); if (!token) return null;
  try {
    const orgId = configuredOrgId(request);
    const session = await withAuthService(orgId, service => service.session(orgId, token));
    return session ? { orgId: session.orgId, userId: session.userId, roles: session.roles, locale: readCookie(request, 'seniorsocial.locale.v1') === 'es' ? 'es' : 'en', requestId: request.headers.get('x-request-id') ?? randomUUID() } : null;
  } catch { return null; }
}

const windows = new Map<string, { start: number; count: number }>();
const forumLimiter: ForumRateLimiter = { consume: (identity, operation) => {
  const now = Date.now(); const key = `${identity.orgId}:${identity.userId}:${operation}`; const current = windows.get(key);
  const limit = operation === 'post' || operation === 'reply' ? 20 : 40;
  const next = !current || now-current.start >= 60_000 ? { start: now, count: 1 } : { ...current, count: current.count+1 };
  windows.set(key,next); return Promise.resolve({ allowed: next.count <= limit, retryAfterSeconds: Math.max(1,Math.ceil((next.start+60_000-now)/1000)) });
} };

async function classifier(client: ReturnType<typeof createDatabaseClient>): Promise<ModerationClassifier> {
  const flags = new FlagRepository(client);
  const router = await new FileRouter(undefined, 'stub').load(); const stub = new StubProviderAdapter();
  const gateway = createWp006Gateway(flags, new AiEventRepository(client), { prompts: new FilePromptRegistry(), router, providers: new Map([['stub',stub]]),
    rateLimiter: new DurableRateLimiter(client,20,200), reservations: new DurableReservationStore(client), cache: new InMemoryExactCache(),
    cacheBoundary: { describe: () => Promise.resolve({ cacheable:false,sourceContentVersionSet:[] }), reauthorize: () => Promise.resolve(false) }, prices: await loadPriceBook() });
  return createModerationClassifier(gateway, async orgId =>
    (process.env.AI_PROVIDER ?? 'stub') === 'stub'
      && await flags.effective('ai.master',orgId)
      && await flags.effective('ai.moderation',orgId));
}

export async function withForumRuntime<T>(work: (service: ForumsService) => Promise<T>): Promise<T> {
  const client=createDatabaseClient();
  try { return await work(createForums(new PostgresForumRepository(client),await classifier(client),forumLimiter)); }
  finally { await client.end(); }
}
export function problem(status:number,code:string,extra:Record<string,unknown>={}):Response { return Response.json({type:`urn:seniorsocial:problem:${code}`,title:status===401?'Authentication required':status===403?'Forbidden':status===422?'Unprocessable content':status===429?'Too many requests':'Not found',status,code,...extra},{status,headers:{'content-type':'application/problem+json','cache-control':'no-store',...(status===429&&typeof extra.retry_after==='number'?{'retry-after':String(extra.retry_after)}:{})}}); }
export function response(result:unknown,status=200):Response { if(result&&typeof result==='object'&&'status' in result&&typeof result.status==='number'){const value=result as {status:number;code?:string;retry_after?:number};return problem(value.status,value.code??'not_found',value.retry_after?{retry_after:value.retry_after}:{});} return Response.json(result,{status,headers:{'cache-control':'no-store'}}); }
export async function objectBody(request:Request):Promise<Record<string,unknown>|null>{ const length=Number(request.headers.get('content-length')??0);if(!Number.isFinite(length)||length>12_000)return null;try{const value:unknown=await request.json();return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;} }
export function pageInput(request:Request){const url=new URL(request.url);const raw=url.searchParams.get('limit');return {...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')!}:{}),...(raw?{limit:Number(raw)}:{})};}
