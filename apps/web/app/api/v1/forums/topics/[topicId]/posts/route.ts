import { authenticated,objectBody,pageInput,problem,response,withForumRuntime } from '../../../_runtime';
export const dynamic='force-dynamic'; export const runtime='nodejs';
type Context={params:Promise<{topicId:string}>};
export async function GET(request:Request,context:Context){const identity=await authenticated(request);if(!identity)return problem(401,'session_required');const {topicId}=await context.params;return response(await withForumRuntime(service=>service.listPosts(identity,topicId,pageInput(request))));}
export async function POST(request:Request,context:Context){const identity=await authenticated(request);if(!identity)return problem(401,'session_required');const input=await objectBody(request);if(!input)return problem(422,'invalid_forum_input');const {topicId}=await context.params;return response(await withForumRuntime(service=>service.createPost(identity,topicId,input)),201);}
