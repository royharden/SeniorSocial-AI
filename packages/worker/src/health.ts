import { createServer, type Server } from 'node:http';

type WorkerState = 'starting' | 'ready' | 'stopping' | 'failed';

export interface WorkerHealth {
  listen(): Promise<void>;
  port(): number | null;
  ready(): void;
  stopping(): void;
  failed(): void;
  close(): Promise<void>;
}

export function createWorkerHealth(port: number): WorkerHealth {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('WORKER_HEALTH_PORT must be a valid port');
  let state: WorkerState = 'starting';
  let listening = false;
  const server: Server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'not_found' }));
      return;
    }
    const isReady = state === 'ready';
    response.writeHead(isReady ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: isReady ? 'ok' : 'unavailable',
      service: 'worker',
      state,
      checks: {
        pg_boss: isReady ? 'ready' : 'not_ready',
        notification_consumers: isReady ? 'ready' : 'not_ready',
        print_consumer: isReady ? 'ready' : 'not_ready',
      },
    }));
  });
  return {
    listen: () => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); listening = true; resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    }),
    port: () => {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : null;
    },
    ready: () => { if (state === 'starting') state = 'ready'; },
    stopping: () => { if (state !== 'failed') state = 'stopping'; },
    failed: () => { state = 'failed'; },
    close: () => new Promise<void>((resolve, reject) => {
      if (!listening) { resolve(); return; }
      server.close(error => {
        listening = false;
        if (error) reject(error); else resolve();
      });
    }),
  };
}
