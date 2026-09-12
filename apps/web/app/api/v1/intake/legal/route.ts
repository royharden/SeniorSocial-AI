import { createSubmitIntakeHandler } from '../_submit';
import { runtimeDependencies } from '../_runtime';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export const POST = createSubmitIntakeHandler('legal', runtimeDependencies);
