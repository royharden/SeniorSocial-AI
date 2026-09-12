import { authenticated,objectBody,problem,response,withForumRuntime } from '../../../_runtime';
export const runtime='nodejs'; type Context={params:Promise<{postId:string}>};
export async function POST(request:Request,context:Context){const identity=await authenticated(request);if(!identity)return problem(401,'session_required');const input=await objectBody(request);if(!input)return problem(422,'invalid_forum_input');const {postId}=await context.params;return response(await withForumRuntime(service=>service.createReply(identity,postId,input)),201);}
