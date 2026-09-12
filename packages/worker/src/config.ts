export interface WorkerConfiguration {
  connectionString: string;
  orgId: string;
  healthPort: number;
}

export function workerConfiguration(environment: NodeJS.ProcessEnv): WorkerConfiguration {
  const connectionString = environment.WORKER_DATABASE_URL;
  if (!connectionString) throw new Error('WORKER_DATABASE_URL is required for pg-boss');
  const orgId = environment.SENIORSOCIAL_ORG_ID;
  if (!orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error('SENIORSOCIAL_ORG_ID is required');
  }
  const healthPort = Number(environment.WORKER_HEALTH_PORT ?? '9100');
  if (!Number.isSafeInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
    throw new Error('WORKER_HEALTH_PORT must be a valid port');
  }
  return { connectionString, orgId, healthPort };
}
