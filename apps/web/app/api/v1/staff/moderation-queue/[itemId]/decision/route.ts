import { authenticated,objectBody,problem,response,withForumRuntime } from '../../../../forums/_runtime';
export const runtime='nodejs'; type Context={params:Promise<{itemId:string}>};
export async function POST(request:Request,context:Context){const identity=await authenticated(request);if(!identity)return problem(401,'session_required');const input=await objectBody(request);if(!input)return problem(422,'invalid_forum_input');const {itemId}=await context.params;return response(await withForumRuntime(service=>service.decide(identity,itemId,input)));}
