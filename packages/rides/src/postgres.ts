import { RideConflict } from './state-machine.ts';
import type { AccessibilityCondition, CreateResult, RideRepository, RideRequest, RideState, RideTransition } from './types.ts';

export interface RideSql {
  query<T extends Record<string, unknown>>(text: string, values: readonly (string | boolean | null)[]): Promise<T[]>;
}
export type OrgTransaction = <T>(orgId: string, work: (sql: RideSql) => Promise<T>) => Promise<T>;

interface RideRow extends Record<string, unknown> {
  id: string; org_id: string; resident_id: string; requested_by_actor_id: string; purpose: string;
  mode: RideRequest['mode']; pickup_at: string; pickup_tz: string; pickup_location: string;
  destination_location: string; return_needed: boolean; send_state: RideRequest['sendState'];
  dispatch_reference: string | null; created_at: string; state: RideState;
}

export function createPostgresRideRepository(withOrg: OrgTransaction): RideRepository {
  async function hydrate(sql: RideSql, row: RideRow): Promise<RideRequest> {
    const conditions = await sql.query<{ code: AccessibilityCondition['code']; verbatim_label: string }>(
      'select code, verbatim_label from ride_accessibility_conditions where org_id = $1 and ride_id = $2 order by position', [row.org_id, row.id]);
    const transitions = await sql.query<{ id: string; actor_id: string; from_state: RideState; to_state: RideState; at: string; reason: string | null; provider_evidence: string | null; idempotency_key: string }>(
      'select id, actor_id, from_state, to_state, at::text, reason, provider_evidence, idempotency_key from ride_transitions where org_id = $1 and ride_id = $2 order by at, id', [row.org_id, row.id]);
    const history: RideTransition[] = transitions.map(item => ({ id: item.id, actorId: item.actor_id, from: item.from_state, to: item.to_state, at: item.at, reason: item.reason, providerEvidence: item.provider_evidence, idempotencyKey: item.idempotency_key }));
    const confirmed = history.findLast(item => item.to === 'confirmed_by') ?? null;
    return { id: row.id, orgId: row.org_id, residentId: row.resident_id, requestedByActorId: row.requested_by_actor_id,
      purpose: row.purpose, mode: row.mode, pickupAt: row.pickup_at, pickupTz: row.pickup_tz,
      pickupLocation: row.pickup_location, destinationLocation: row.destination_location, returnNeeded: row.return_needed,
      accessibilityConditions: conditions.map(item => ({ code: item.code, label: item.verbatim_label })), state: row.state,
      sendState: row.send_state, dispatchReference: row.dispatch_reference, createdAt: row.created_at,
      transitions: history, confirmedByActor: confirmed?.actorId ?? null, confirmedAt: confirmed?.at ?? null };
  }
  async function row(sql: RideSql, orgId: string, rideId: string): Promise<RideRow | null> {
    const rows = await sql.query<RideRow>(`select r.*, t.to_state as state from ride_requests r
      join lateral (select to_state from ride_transitions where org_id=r.org_id and ride_id=r.id order by at desc,id desc limit 1) t on true
      where r.org_id=$1 and r.id=$2`, [orgId, rideId]);
    return rows[0] ?? null;
  }
  async function audit(sql: RideSql, input: { orgId: string; actorId: string; action: 'ride.created' | 'ride.transitioned' | 'ride.send_failed'; rideId: string; outcome: 'allowed' | 'error'; reason: string; fields?: string[] }) {
    await sql.query(`insert into audit_events (actor,on_behalf_of,action,target,org_id,outcome,reason,fields)
      values ($1,null,$2,$3,$4,$5,$6,$7::text[])`, [`user:${input.actorId}`, input.action, `ride_request:${input.rideId}`, input.orgId, input.outcome, input.reason, `{${(input.fields ?? []).join(',')}}`]);
  }
  return {
    create: input => withOrg(input.orgId, async sql => {
      const existing = await sql.query<{ id: string; request_hash: string }>('select id,request_hash from ride_requests where org_id=$1 and resident_id=$2 and idempotency_key=$3 for update', [input.orgId, input.residentId, input.idempotencyKey]);
      if (existing[0]) {
        if (existing[0].request_hash !== input.requestHash) throw new RideConflict('Idempotency key reused with different request');
        const found = await row(sql, input.orgId, existing[0].id); if (!found) throw new Error('Ride idempotency row is corrupt');
        return { ride: await hydrate(sql, found), created: false };
      }
      await sql.query(`insert into ride_requests (id,org_id,resident_id,requested_by_actor_id,purpose,mode,pickup_at,pickup_tz,pickup_location,destination_location,return_needed,idempotency_key,request_hash)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [input.id,input.orgId,input.residentId,input.requestedByActorId,input.purpose,input.mode,input.pickupAt,input.pickupTz,input.pickupLocation,input.destinationLocation,input.returnNeeded,input.idempotencyKey,input.requestHash]);
      for (const [position, condition] of input.accessibilityConditions.entries()) await sql.query('insert into ride_accessibility_conditions (org_id,ride_id,position,code,verbatim_label) values ($1,$2,$3,$4,$5)', [input.orgId,input.id,String(position),condition.code,condition.label]);
      await sql.query(`insert into ride_transitions (org_id,ride_id,actor_id,from_state,to_state,at,reason,idempotency_key,request_hash)
        values ($1,$2,$3,'draft','requested',$4,'ride_request_submitted',$5,$6)`, [input.orgId,input.id,input.requestedByActorId,input.at,`create:${input.idempotencyKey}`,input.requestHash]);
      await audit(sql,{orgId:input.orgId,actorId:input.requestedByActorId,action:'ride.created',rideId:input.id,outcome:'allowed',reason:'ride_request_submitted',fields:['purpose','mode','pickup_at','pickup_tz','pickup_location','destination_location','return_needed','accessibility_conditions']});
      const created = await row(sql,input.orgId,input.id); if(!created) throw new Error('Ride create failed');
      return { ride: await hydrate(sql,created), created:true } satisfies CreateResult;
    }),
    find: (orgId,rideId) => withOrg(orgId,async sql => { const found=await row(sql,orgId,rideId); return found?hydrate(sql,found):null; }),
    listForResident: (orgId,residentId) => withOrg(orgId,async sql => {
      const rows=await sql.query<RideRow>(`select r.*,t.to_state as state from ride_requests r join lateral
        (select to_state from ride_transitions where org_id=r.org_id and ride_id=r.id order by at desc,id desc limit 1)t on true
        where r.org_id=$1 and r.resident_id=$2 order by r.created_at desc,r.id`,[orgId,residentId]);
      return Promise.all(rows.map(item=>hydrate(sql,item)));
    }),
    listQueue: orgId => withOrg(orgId,async sql => {
      const rows=await sql.query<RideRow>(`select r.*,t.to_state as state from ride_requests r join lateral
        (select to_state from ride_transitions where org_id=r.org_id and ride_id=r.id order by at desc,id desc limit 1)t on true
        where r.org_id=$1 and t.to_state in ('requested','waiting_for_dispatcher','confirmed_by') order by r.created_at,r.id`,[orgId]);
      return Promise.all(rows.map(item=>hydrate(sql,item)));
    }),
    recordDispatch: (orgId,rideId,actorId,result,at) => withOrg(orgId,async sql => {
      const found=await row(sql,orgId,rideId); if(!found) throw new Error('Ride not found');
      if(found.send_state==='sent') return hydrate(sql,found);
      if(result.outcome==='failed') {
        const changed=await sql.query<{id:string}>("update ride_requests set send_state='send_failed' where org_id=$1 and id=$2 and send_state='not_sent' returning id",[orgId,rideId]);
        if(changed[0]) await audit(sql,{orgId,actorId,action:'ride.send_failed',rideId,outcome:'error',reason:result.reason});
      } else {
        if(!result.evidence.trim()) throw new RideConflict('Dispatch evidence is required');
        const changed=await sql.query<{id:string}>("update ride_requests set send_state='sent',dispatch_reference=$3 where org_id=$1 and id=$2 and send_state<>'sent' returning id",[orgId,rideId,result.evidence]);
        if(changed[0]&&found.state==='requested') {
          await sql.query(`insert into ride_transitions (org_id,ride_id,actor_id,from_state,to_state,at,reason,provider_evidence,idempotency_key,request_hash)
            values ($1,$2,$3,'requested','waiting_for_dispatcher',$4,'dispatch_received',$5,$6,$7)`,[orgId,rideId,actorId,at,result.evidence,`dispatch:${result.evidence}`,result.evidence]);
          await audit(sql,{orgId,actorId,action:'ride.transitioned',rideId,outcome:'allowed',reason:'requested_to_waiting_for_dispatcher'});
        }
      }
      const updated=await row(sql,orgId,rideId); if(!updated) throw new Error('Ride dispatch update failed'); return hydrate(sql,updated);
    }),
    transition: (orgId,rideId,actorId,to,reason,evidence,at,idempotencyKey,requestHash) => withOrg(orgId,async sql => {
      const replay=await sql.query<{request_hash:string}>('select request_hash from ride_transitions where org_id=$1 and ride_id=$2 and idempotency_key=$3',[orgId,rideId,idempotencyKey]);
      if(replay[0]) {
        if(replay[0].request_hash!==requestHash) throw new RideConflict('Idempotency key reused with different transition');
        const found=await row(sql,orgId,rideId); return found?hydrate(sql,found):null;
      }
      const current=await sql.query<{state:RideState}>(`select t.to_state as state from ride_requests r join lateral
        (select to_state from ride_transitions where org_id=r.org_id and ride_id=r.id order by at desc,id desc limit 1)t on true
        where r.org_id=$1 and r.id=$2 for update of r`,[orgId,rideId]);
      const from=current[0]?.state; if(!from) return null;
      const allowed:Record<RideState,readonly RideState[]>={draft:['requested','cancelled'],requested:['waiting_for_dispatcher','cancelled'],waiting_for_dispatcher:['confirmed_by','cancelled','unable_to_fulfill'],confirmed_by:['completed','cancelled','unable_to_fulfill'],completed:[],cancelled:[],unable_to_fulfill:[]};
      if(!allowed[from].includes(to)||(to==='confirmed_by'&&!evidence)) throw new RideConflict(`Illegal ride transition: ${from} -> ${to}`);
      await sql.query(`insert into ride_transitions (org_id,ride_id,actor_id,from_state,to_state,at,reason,provider_evidence,idempotency_key,request_hash)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[orgId,rideId,actorId,from,to,at,reason,evidence,idempotencyKey,requestHash]);
      await audit(sql,{orgId,actorId,action:'ride.transitioned',rideId,outcome:'allowed',reason:`${from}_to_${to}`});
      const updated=await row(sql,orgId,rideId); return updated?hydrate(sql,updated):null;
    }),
  };
}
