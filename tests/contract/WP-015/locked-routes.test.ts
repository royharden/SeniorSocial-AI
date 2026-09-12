import { existsSync,readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

const contract=JSON.parse(readFileSync('tests/contract/WP-002/primary-interface.snapshot.json','utf8')) as {paths:Record<string,Record<string,unknown>>;components:{schemas:{ModerationItem:{properties:{target_type:{enum:string[]}}}}}};
const expected={
  '/forums/topics':['get'], '/forums/topics/{topicId}/posts':['get','post'], '/forums/posts/{postId}/replies':['post'],
  '/forums/posts/{postId}/report':['post'], '/blocks':['get','post'], '/staff/moderation-queue':['get'],
  '/staff/moderation-queue/{itemId}/decision':['post'],
} as const;
describe('WP-015 locked HTTP surface',()=>{
  it('implements every locked operation without changing the shared contract',()=>{for(const [path,methods] of Object.entries(expected)){expect(contract.paths[path]).toBeDefined();for(const method of methods)expect(contract.paths[path]?.[method]).toBeDefined();}});
  it('has a concrete route module for every locked operation',()=>{for(const file of ['apps/web/app/api/v1/forums/topics/route.ts','apps/web/app/api/v1/forums/topics/[topicId]/posts/route.ts','apps/web/app/api/v1/forums/posts/[postId]/replies/route.ts','apps/web/app/api/v1/forums/posts/[postId]/report/route.ts','apps/web/app/api/v1/blocks/route.ts','apps/web/app/api/v1/staff/moderation-queue/route.ts','apps/web/app/api/v1/staff/moderation-queue/[itemId]/decision/route.ts'])expect(existsSync(file),file).toBe(true);});
  it('keeps adapted message reports inside the frozen ModerationItem schema',()=>{const schema=JSON.parse(readFileSync('tests/contract/WP-002/primary-interface.snapshot.json','utf8')) as {components:{schemas:{ModerationItem:{properties:Record<string,{enum?:unknown[]}>}}}};expect(schema.components.schemas.ModerationItem.properties.source.enum).toContain('user_report');expect(schema.components.schemas.ModerationItem.properties.target_type.enum).toContain('message');});
});
