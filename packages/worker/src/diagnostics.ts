export type DiagnosticWriter = (message: string) => unknown;

export function reportWorkerStartupFailure(_error: unknown, write: DiagnosticWriter = message => process.stderr.write(message)): void {
  write('Worker startup failed\n');
  process.exitCode = 1;
}
