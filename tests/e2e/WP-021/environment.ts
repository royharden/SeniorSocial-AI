export const E2E_ORG_ID='51000000-0000-4000-8000-000000000021';
export const E2E_STAFF_ID='51000000-0000-4000-8000-000000000022';
export const E2E_REVIEWER_ID='51000000-0000-4000-8000-000000000023';
export const E2E_RESIDENT_ID='51000000-0000-4000-8000-000000000024';
export const E2E_PEPPER='wp021-e2e-pepper-value-only';
export const E2E_STAFF_TOKEN='wp021-staff-session-token';
export const E2E_REVIEWER_TOKEN='wp021-reviewer-session-token';
export const E2E_RESIDENT_TOKEN='wp021-resident-session-token';

export function wp021E2eEnvironment() {
  if(process.env.WP021_E2E_ALLOWED!=='true') throw new Error('WP021_E2E_ALLOWED=true is required; WP-021 browser tests never skip');
  const ownerValue=process.env.WP021_E2E_OWNER_DATABASE_URL; if(!ownerValue) throw new Error('WP021_E2E_OWNER_DATABASE_URL is required; WP-021 browser tests never skip');
  const runId=process.env.WP021_E2E_RUN_ID; if(!runId || !/^[a-z0-9]{4,16}$/u.test(runId)) throw new Error('WP021_E2E_RUN_ID must be 4-16 lowercase letters or digits');
  const ownerUrl=new URL(ownerValue);
  if(!['postgres:','postgresql:'].includes(ownerUrl.protocol) || !['localhost','127.0.0.1'].includes(ownerUrl.hostname) || ownerUrl.pathname!=='/postgres') throw new Error('WP-021 E2E owner URL must target the local postgres maintenance database');
  const databaseName=`ss_wp021_e2e_${runId}`; const runtimeRole=`ss_wp021_rt_${runId}`; const runtimePassword=`WP021-${runId}-runtime`;
  const databaseUrl=new URL(ownerUrl); databaseUrl.pathname=`/${databaseName}`;
  const runtimeUrl=new URL(databaseUrl); runtimeUrl.username=runtimeRole; runtimeUrl.password=runtimePassword;
  return {ownerUrl:ownerUrl.toString(),databaseUrl:databaseUrl.toString(),runtimeUrl:runtimeUrl.toString(),databaseName,runtimeRole,runtimePassword};
}
