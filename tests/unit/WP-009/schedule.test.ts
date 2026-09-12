import { describe,expect,it,vi } from 'vitest';
import { AssistanceScheduleUnavailableError, createAssistanceScheduleSource } from '../../../packages/assistance/src/index.ts';
import { createRegisteredScheduleSource,printableHtml,type RegisteredSchedule } from '../../../packages/notify/src/index.ts';
import { RideScheduleUnavailableError, createRideScheduleSource, isRideScheduleUnavailableError, type RideScheduleRequest } from '../../../packages/rides/src/index.ts';
import { identity } from './fixture.ts';

describe('WP-009 registered printable schedule sources',()=>{
  const ride = (changes: Partial<RideScheduleRequest> = {}): RideScheduleRequest => ({
    id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',orgId:identity.orgId,residentId:identity.userId,
    purpose:'Clinic visit',mode:'partner_van',pickupAt:new Date('2027-01-20T15:00:00.000Z'),pickupTz:'America/New_York',
    pickupLocation:'Resident lobby',destinationLocation:'Community clinic',returnNeeded:true,
    accessibilityDetails:[],state:'unable_to_fulfill',...changes,
  });

  // what_bug_this_catches: the public ride adapter leaks another resident,
  // tenant, or week, trusts caller ordering, or derives a stale state instead
  // of retaining the repository's authoritative transition projection.
  it('scopes and deterministically versions resident rides for the requested week',async()=>{
    const rows = [
      ride({id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',pickupAt:new Date('2027-01-20T14:00:00.000Z'),state:'confirmed_by'}),
      ride(),
      ride({id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',residentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}),
      ride({id:'ffffffff-ffff-4fff-8fff-ffffffffffff',orgId:'22222222-2222-4222-8222-222222222222'}),
      ride({id:'99999999-9999-4999-8999-999999999999',pickupAt:new Date('2027-01-25T00:00:00.000Z')}),
    ];
    const listForWeek = vi.fn(() => Promise.resolve(rows));
    const first = await createRideScheduleSource({listForWeek},()=>new Date('2027-01-18T12:00:00.000Z')).source.read(identity,'2027-01-18');
    const second = await createRideScheduleSource({listForWeek},()=>new Date('2027-01-18T13:00:00.000Z')).source.read(identity,'2027-01-18');
    expect(listForWeek).toHaveBeenCalledWith(identity,new Date('2027-01-18T00:00:00.000Z'),new Date('2027-01-25T00:00:00.000Z'));
    expect(first.items).toEqual([
      expect.objectContaining({id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',kind:'ride',state:'confirmed_by',accessibility_details:[]}),
      expect.objectContaining({id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',kind:'ride',state:'unable_to_fulfill',accessibility_details:[]}),
    ]);
    expect(first.source_version).toMatch(/^rides:v1:[a-f0-9]{64}$/);
    expect(second.source_version).toBe(first.source_version);
    expect(JSON.stringify(first)).not.toContain('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(JSON.stringify(first)).not.toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(JSON.stringify(first)).not.toContain('99999999-9999-4999-8999-999999999999');
  });

  // what_bug_this_catches: printable rides omit structured accessibility,
  // reorder it, infer it from prose, or fail to include it in source provenance.
  it('preserves persisted accessibility pairs and includes them in the deterministic version',async()=>{
    const details = [
      {code:'wheelchair' as const,label:'Uses a 24-inch wheelchair'},
      {code:'needs_an_arm' as const,label:'Please offer your left arm'},
    ];
    const withDetails = ride({accessibilityDetails:details});
    const first = await createRideScheduleSource({listForWeek:()=>Promise.resolve([withDetails])},
      ()=>new Date('2027-01-18T12:00:00.000Z')).source.read(identity,'2027-01-18');
    const changed = await createRideScheduleSource({listForWeek:()=>Promise.resolve([
      ride({accessibilityDetails:[details[0]!,{...details[1]!,label:'Please offer your right arm'}]}),
    ])},()=>new Date('2027-01-18T12:00:00.000Z')).source.read(identity,'2027-01-18');
    expect(first.items).toEqual([expect.objectContaining({accessibility_details:details})]);
    expect(changed.source_version).not.toBe(first.source_version);

    const duplicate = ride({accessibilityDetails:[details[0]!,details[0]!]});
    await expect(createRideScheduleSource({listForWeek:()=>Promise.resolve([duplicate])}).source.read(identity,'2027-01-18'))
      .rejects.toThrow('invalid ride schedule accessibility details');
  });

  // what_bug_this_catches: malformed JSON, an unknown code, or a label that
  // could corrupt printable layout is accepted as persisted accessibility.
  it('rejects malformed accessibility details without inferring needs from prose',async()=>{
    const read = (accessibilityDetails: unknown) => createRideScheduleSource({listForWeek:()=>Promise.resolve([
      {...ride({purpose:'Wheelchair transport to oxygen clinic'}),accessibilityDetails} as RideScheduleRequest,
    ])}).source.read(identity,'2027-01-18');
    const invalid = [
      null,
      {code:'wheelchair',label:'Uses a wheelchair'},
      [{code:'unknown',label:'Unknown need'}],
      [{code:'wheelchair',label:''}],
      [{code:'wheelchair',label:'   '}],
      [{code:'wheelchair',label:'Unsafe\nprint line'}],
      [{code:'wheelchair',label:'x'.repeat(121)}],
      [{code:'wheelchair',label:'First'},{code:'wheelchair',label:'Second'}],
    ];
    for (const details of invalid) await expect(read(details)).rejects.toThrow(/invalid ride schedule accessibility detail/u);
    const zero = await read([]);
    expect(zero.items).toEqual([expect.objectContaining({purpose:'Wheelchair transport to oxygen clinic',accessibility_details:[]})]);
  });

  // what_bug_this_catches: malformed authority/week input or an expected ride
  // outage is confused with an unexpected repository/programming failure.
  it('exposes a typed ride outage without swallowing unexpected failures',async()=>{
    const unexpected = new Error('unexpected ride repository defect');
    const registration = createRideScheduleSource({listForWeek:()=>Promise.reject(unexpected)});
    await expect(registration.source.read(identity,'2027-01-18')).rejects.toBe(unexpected);
    await expect(registration.source.read({...identity,userId:'not-a-user'},'2027-01-18')).rejects.toBeInstanceOf(RideScheduleUnavailableError);
    await expect(registration.source.read(identity,'2027-02-30')).rejects.toBeInstanceOf(RideScheduleUnavailableError);

    const composed = (error: Error) => createRegisteredScheduleSource([
      {key:'rides',source:{read:()=>Promise.reject(error)},isUnavailableError:isRideScheduleUnavailableError},
    ],()=>new Date('2027-01-18T12:00:00.000Z'),['rides']);
    const partial = await composed(new RideScheduleUnavailableError()).read(identity,'2027-01-18') as RegisteredSchedule;
    expect(partial.sources).toEqual([{key:'rides',status:'unavailable',source_version:null,as_of:null,item_count:0}]);
    await expect(composed(unexpected).read(identity,'2027-01-18')).rejects.toBe(unexpected);
    const forged = Object.assign(new Error('forged ride outage'),{code:'ride_schedule_unavailable'});
    await expect(composed(forged).read(identity,'2027-01-18')).rejects.toBe(forged);
  });

  // what_bug_this_catches: the ride source requires Monday even though the
  // public print contract treats any valid date as the seven-day start.
  it('uses a valid non-Monday week_of as the exact seven-day ride window',async()=>{
    const inside = ride({pickupAt:new Date('2026-08-07T23:59:59.999Z')});
    const atEnd = ride({id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',pickupAt:new Date('2026-08-08T00:00:00.000Z')});
    const listForWeek = vi.fn(() => Promise.resolve([atEnd,inside]));
    const snapshot = await createRideScheduleSource({listForWeek},()=>new Date('2026-08-01T12:00:00.000Z'))
      .source.read(identity,'2026-08-01');
    expect(listForWeek).toHaveBeenCalledWith(identity,new Date('2026-08-01T00:00:00.000Z'),new Date('2026-08-08T00:00:00.000Z'));
    expect(snapshot.items).toEqual([expect.objectContaining({id:inside.id,pickup_at:'2026-08-07T23:59:59.999Z'})]);
  });

  // what_bug_this_catches: a connected producer is discarded by the placeholder
  // source, or an absent/failed producer is falsely represented as no plans.
  it('composes versioned items and truthfully labels missing and unavailable sources',async()=>{
    const events = {read:vi.fn(() => Promise.resolve({as_of:'2026-09-10T10:41:00.000Z',source_version:'events:v7',items:[{id:'event-1',title:'Synthetic lunch'}]}))};
    const assistance = {read:vi.fn(() => Promise.reject(new Error('adapter unavailable')))};
    const source = createRegisteredScheduleSource([{key:'events',source:events},{key:'assistance',source:assistance}],
      () => new Date('2026-09-10T10:42:37.000Z'));
    const snapshot = await source.read(identity,'2026-09-07') as RegisteredSchedule;
    expect(snapshot.as_of).toBe('2026-09-10T10:42:00.000Z');
    expect(snapshot.source_version).toMatch(/^schedule:registered-sources:v1:[a-f0-9]{64}$/);
    expect(snapshot.items).toEqual([{id:'event-1',title:'Synthetic lunch',schedule_source:'events',schedule_source_version:'events:v7',schedule_source_as_of:'2026-09-10T10:41:00.000Z'}]);
    expect(snapshot.sources).toEqual([
      {key:'events',status:'available',source_version:'events:v7',as_of:'2026-09-10T10:41:00.000Z',item_count:1},
      {key:'rides',status:'not_registered',source_version:null,as_of:null,item_count:0},
      {key:'assistance',status:'unavailable',source_version:null,as_of:null,item_count:0},
    ]);
    const html = printableHtml(snapshot);
    expect(html).toContain('events: available'); expect(html).toContain('rides: not_registered');
    expect(html).toContain('assistance: unavailable'); expect(html).toContain('not evidence that you have no plans');
  });

  // what_bug_this_catches: duplicate source registration makes composition
  // order-dependent and silently hides one producer.
  it('rejects duplicate or malformed registrations',()=>{
    const source = {read:() => Promise.resolve({as_of:'2026-09-10T10:42:00.000Z',source_version:'v1',items:[]})};
    expect(()=>createRegisteredScheduleSource([{key:'events',source},{key:'events',source}])).toThrow('Duplicate');
    expect(()=>createRegisteredScheduleSource([{key:'Events!',source}])).toThrow('Invalid');
  });

  // what_bug_this_catches: the assistance outage boundary swallows an
  // unexpected programming or authorization error and publishes a partial
  // schedule as if the adapter had reported an expected outage.
  it('isolates only the typed assistance unavailable signal',async()=>{
    const event = {id:'event-typed',title:'Synthetic event'};
    const unavailable = (error: unknown) => error instanceof AssistanceScheduleUnavailableError
      && error.code === 'assistance_schedule_unavailable';
    const source = (error: Error) => createRegisteredScheduleSource([
      {key:'events',source:{read:()=>Promise.resolve({as_of:'2026-09-10T10:41:00.000Z',source_version:'events:v1',items:[event]})}},
      {key:'assistance',source:{read:()=>Promise.reject(error)},isUnavailableError:unavailable},
    ],()=>new Date('2026-09-10T10:42:37.000Z'));

    const isolated = await source(new AssistanceScheduleUnavailableError()).read(identity,'2026-09-07') as RegisteredSchedule;
    expect(isolated.items).toEqual([expect.objectContaining({id:'event-typed',schedule_source:'events'})]);
    expect(isolated.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'events',status:'available'}),
      expect.objectContaining({key:'rides',status:'not_registered'}),
      expect.objectContaining({key:'assistance',status:'unavailable'}),
    ]));

    const unexpected = new Error('unexpected assistance defect');
    await expect(source(unexpected).read(identity,'2026-09-07')).rejects.toBe(unexpected);
    const forged = Object.assign(new Error('forged outage'),{code:'assistance_schedule_unavailable'});
    await expect(source(forged).read(identity,'2026-09-07')).rejects.toBe(forged);
    const wrongCode = new AssistanceScheduleUnavailableError();
    Object.defineProperty(wrongCode,'code',{value:'unexpected_assistance_error'});
    await expect(source(wrongCode).read(identity,'2026-09-07')).rejects.toBe(wrongCode);
  });

  // what_bug_this_catches: the assistance adapter blanket-wraps a database,
  // mapping, clock, or programming defect as an expected source outage, which
  // lets the public schedule return a misleading partial-success response.
  it('propagates an unexpected assistance read-port failure unchanged',async()=>{
    const unexpected = new Error('unexpected assistance repository defect');
    const registration = createAssistanceScheduleSource({
      listPending: () => Promise.reject(unexpected),
    });
    await expect(registration.source.read(identity,'2026-09-07')).rejects.toBe(unexpected);
  });
});
