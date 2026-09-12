import { createHash } from 'node:crypto';
import type { MutationMetadata } from './types.ts';
export class AdminConflict extends Error{}
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(typeof value==='object'&&value!==null)return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));return value;}
export function requestHash(operation:string,payload:unknown):string{return createHash('sha256').update(JSON.stringify({operation,payload:canonical(payload)})).digest('hex');}
export function mutationMetadata(operation:string,payload:unknown,idempotencyKey:string,expectedVersion?:number):MutationMetadata{const key=idempotencyKey.trim();if(!/^[A-Za-z0-9._~-]{1,160}$/u.test(key))throw new Error('Idempotency-Key is invalid');return{ idempotencyKey:key,requestHash:requestHash(operation,payload),...(expectedVersion===undefined?{}:{expectedVersion})};}
export function assertReplay(existing:{operation:string;requestHash:string},incoming:{operation:string;requestHash:string}):void{if(existing.operation!==incoming.operation||existing.requestHash!==incoming.requestHash)throw new AdminConflict('idempotency key reused with a different request');}
export function assertVersion(expected:number,actual:number):void{if(!Number.isSafeInteger(expected)||expected<1||expected!==actual)throw new AdminConflict('stale version');}
