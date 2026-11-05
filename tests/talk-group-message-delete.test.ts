import {afterEach,expect,test} from "bun:test";
import {createTalkController} from "../src/talk-controller.ts";
import {observedInitAck} from "./talk-read-fixture.ts";
import type {TalkContact,TalkMessage} from "../src/api.ts";
const session={hostUrl:"https://group-delete.example",product:"yurume" as const,accessToken:"synthetic-session",tokenType:"Bearer",createdAt:"2026-11-05T00:00:00Z"};
const me=session.hostUrl+"/users/me",group:TalkContact={type:"community",ap_id:session.hostUrl+"/groups/opaque%2Fgroup",preferred_username:"friends",name:"Friends",icon_url:null,last_message:null,last_message_at:null,unread_count:0};
const mine:TalkMessage={id:session.hostUrl+"/objects/opaque%2Fone",content:"Original group body",created_at:"2026-11-05T00:00:00Z",sender:{ap_id:me,preferred_username:"me",name:"Me"}};
const path=`/api/communities/${encodeURIComponent(group.ap_id)}/messages/${encodeURIComponent(mine.id)}`,rev="group-message-v1:"+"a".repeat(64),next="group-message-v1:"+"b".repeat(64);
const originalFetch=globalThis.fetch,subjects:ReturnType<typeof createTalkController>[]=[];
afterEach(()=>{subjects.splice(0).forEach(x=>x.dispose());globalThis.fetch=originalFetch});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return{promise,resolve}}
function subject(){const c=createTalkController({session,actorApId:me,refreshHome:async()=>{},observedMessageIds:()=>[],receive:{isForeground:()=>true,schedule:()=>()=>{}}});subjects.push(c);return c}
function transport(handler?:(url:URL,init?:RequestInit)=>Response|Promise<Response>|undefined,capability:unknown={version:1,precondition:"group-message-v1"}){
 let current:TalkMessage|undefined={...mine},revision=rev;
 const calls:Array<{path:string;method:string}>=[];
 globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(String(input));expect(url.origin).toBe(session.hostUrl);expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-session");expect(url.pathname.startsWith("/api/dm/messages/")).toBe(false);calls.push({path:url.pathname,method:init?.method??"GET"});const handled=handler?.(url,init);if(handled)return handled;
  if(url.pathname.endsWith("/read-observed/init"))return observedInitAck();
  if(url.pathname.endsWith("/messages"))return Response.json({messages:current?[current]:[],has_more:false});
  if(url.pathname===path){if(!init?.method)return current?Response.json({community_ap_id:group.ap_id,message:current,revision,...(capability===null?{}:{message_actions:{delete:capability}})}):Response.json({error:"owned_group_message_not_found",code:"owned_group_message_not_found"},{status:404});
   if(init.method==="DELETE"){expect(new Headers(init.headers).get("if-match")).toBe(JSON.stringify(revision));current=undefined;return Response.json({success:true,community_ap_id:group.ap_id,message_id:mine.id})}}
  throw Error("unexpected "+url.pathname)
 }) as typeof fetch;
 return{calls,setCurrent(content:string|undefined,author=me){current=content===undefined?undefined:{...mine,content,sender:{...mine.sender,ap_id:author}};revision=next}};
}
test("Group delete confirms a fresh supported message and cancellation causes no write",async()=>{
 const t=transport(),c=subject();await c.open(group);c.setDraft("Keep compose");await c.beginMessageDelete(mine.id);
 expect(c.state().messageAction?.kind).toBe("delete");expect(c.state().messageAction?.canSave).toBe(true);expect(c.state().messageAction?.serverContent).toBe("Original group body");
 expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(0);c.cancelMessageAction();expect(c.state().messageAction).toBeUndefined();expect(c.state().content).toBe("Keep compose");
});
test("confirmed Group deletion uses the community path and exact revision once",async()=>{
 const t=transport(),c=subject();await c.open(group);c.setDraft("Keep compose");await c.beginMessageDelete(mine.id);await c.confirmMessageDelete();
 expect(c.state().messages).toHaveLength(0);expect(c.state().messageAction).toBeUndefined();expect(c.state().content).toBe("Keep compose");expect(t.calls.filter(x=>x.method==="DELETE")).toEqual([{path,method:"DELETE"}]);
});

for(const capability of [null,{version:2,precondition:"group-message-v1"},{version:1,precondition:"dm-v1"},true]){
 test(`Group delete never mutates a host without the exact conditional-delete contract ${JSON.stringify(capability)}`,async()=>{
  const t=transport(undefined,capability),c=subject();await c.open(group);await c.beginMessageDelete(mine.id);
  expect(c.state().messageAction?.canSave).toBe(false);expect(c.state().messageAction?.canCancel).toBe(true);expect(c.state().messageAction?.error).toContain("安全なグループ削除");
  await c.confirmMessageDelete();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(0);expect(c.state().messages).toHaveLength(1);c.cancelMessageAction();expect(c.state().messageAction).toBeUndefined();
 });
}
for(const ack of ["broken","wrong-community","wrong-id"]){
 test(`Group delete unknown ${ack} ACK reconciles supported absence without resend`,async()=>{
  const t=transport((url,init)=>{if(url.pathname===path&&init?.method==="DELETE"){t.setCurrent(undefined);return ack==="broken"?new Response("{"):Response.json({success:true,community_ap_id:ack==="wrong-community"?"other":group.ap_id,message_id:ack==="wrong-id"?"other":mine.id})}}),c=subject();
  await c.open(group);await c.beginMessageDelete(mine.id);await c.confirmMessageDelete();
  expect(c.state().messageAction?.needsReadback).toBe(true);expect(c.state().messageAction?.canSave).toBe(false);expect(c.state().messageAction?.canCancel).toBe(false);
  await c.confirmMessageDelete();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
  c.back();await c.open(group);expect(c.state().messageAction?.needsReadback).toBe(true);
  await c.reconcileMessageAction();expect(c.state().messageAction).toBeUndefined();expect(c.state().messages).toHaveLength(0);expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
 });
}
test("Group delete conflict keeps the changed message and requires another explicit confirmation",async()=>{
 let reject=true;const t=transport((url,init)=>{if(reject&&url.pathname===path&&init?.method==="DELETE"){reject=false;t.setCurrent("Other device body");return Response.json({error:"message_changed"},{status:409})}}),c=subject();
 await c.open(group);await c.beginMessageDelete(mine.id);await c.confirmMessageDelete();expect(c.state().messageAction?.needsReadback).toBe(true);
 await c.confirmMessageDelete();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
 await c.reconcileMessageAction();expect(c.state().messageAction?.serverContent).toBe("Other device body");expect(c.state().messageAction?.canSave).toBe(true);expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
 await c.confirmMessageDelete();expect(c.state().messageAction).toBeUndefined();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(2);
});
test("revoked Group access can close a denied delete, but unknown404 readback is not deletion proof",async()=>{
 let denied=false;const t=transport((url,init)=>{if(url.pathname===path&&init?.method==="DELETE"){denied=true;return Response.json({error:"unreadable"},{status:403})}if(denied&&url.pathname===path&&!init?.method)return Response.json({error:"not found"},{status:404})}),c=subject();
 await c.open(group);await c.beginMessageDelete(mine.id);await c.confirmMessageDelete();expect(c.state().messageAction?.canCancel).toBe(true);await c.reconcileMessageAction();
 expect(c.state().messageAction?.needsReadback).toBe(true);expect(c.state().messages).toHaveLength(1);expect(c.state().messageAction?.unavailable).toBe(false);c.cancelMessageAction();expect(c.state().messageAction).toBeUndefined();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
});
test("pending Group delete is single-flight and a changed account ignores its late ACK",async()=>{
 const entered=deferred<void>(),held=deferred<Response>();let signal:AbortSignal|undefined;
 const t=transport((url,init)=>{if(url.pathname===path&&init?.method==="DELETE"){signal=init.signal??undefined;entered.resolve();return held.promise}}),c=subject();
 await c.open(group);await c.beginMessageDelete(mine.id);const work=c.confirmMessageDelete();await entered.promise;await c.confirmMessageDelete();expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(1);
 c.updateSession({...session,accessToken:"other-synthetic-session"});expect(signal?.aborted).toBe(true);held.resolve(Response.json({success:true,community_ap_id:group.ap_id,message_id:mine.id}));await work;expect(c.state().messageAction).toBeUndefined();expect(c.state().messages).toHaveLength(0);
});

test("a delayed Group delete ACK changes only its original conversation",async()=>{
 const other={...group,ap_id:session.hostUrl+"/groups/other"},otherMessage={...mine,id:"other-message",content:"Other group"};
 const entered=deferred<void>(),held=deferred<Response>();
 const t=transport((url,init)=>{if(url.pathname===path&&init?.method==="DELETE"){entered.resolve();return held.promise}if(url.pathname===`/api/communities/${encodeURIComponent(other.ap_id)}/messages`)return Response.json({messages:[otherMessage],has_more:false})}),c=subject();
 await c.open(group);await c.beginMessageDelete(mine.id);const work=c.confirmMessageDelete();await entered.promise;c.back();await c.open(other);
 t.setCurrent(undefined);held.resolve(Response.json({success:true,community_ap_id:group.ap_id,message_id:mine.id}));await work;
 expect(c.state().selected?.ap_id).toBe(other.ap_id);expect(c.state().messages).toEqual([otherMessage]);expect(c.state().messageAction).toBeUndefined();
 c.back();await c.open(group);expect(c.state().messages).toHaveLength(0);expect(c.state().messageAction).toBeUndefined();expect(t.calls.filter(x=>x.method==="DELETE")).toEqual([{path,method:"DELETE"}]);
});

test("Group author-only actions never fetch or delete another author's message",async()=>{
 const t=transport(),c=subject();t.setCurrent("Another author",session.hostUrl+"/users/other");await c.open(group);await c.beginMessageDelete(mine.id);
 expect(c.state().messageAction).toBeUndefined();expect(t.calls.filter(x=>x.path===path)).toHaveLength(0);expect(t.calls.filter(x=>x.method==="DELETE")).toHaveLength(0);
});
