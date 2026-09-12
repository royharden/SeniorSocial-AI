import { authenticated,pageInput,problem,response,withForumRuntime } from '../../forums/_runtime';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export async function GET(request:Request){const identity=await authenticated(request);if(!identity)return problem(401,'session_required');return response(await withForumRuntime(service=>service.listModeration(identity,pageInput(request))));}
