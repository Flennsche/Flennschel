import { DurableObject } from "cloudflare:workers";

const enc = new TextEncoder();
const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: {"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const b64 = bytes => {
  let s=""; for (const b of new Uint8Array(bytes)) s+=String.fromCharCode(b);
  return btoa(s).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
};
const unb64 = s => {
  s=s.replaceAll("-","+").replaceAll("_","/"); while(s.length%4)s+="=";
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
};
const token = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const code = () => "TOGETHER-" + crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase();
async function hash(password,salt) {
  const k=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({name:"PBKDF2",salt:unb64(salt),iterations:100000,hash:"SHA-256"},k,256));
}
async function body(r){try{return await r.json()}catch{return {}}}

export default {
 async fetch(request, env) {
  const url=new URL(request.url);
  if(url.pathname==="/api/health") return json({ok:true,version:"1.0"});
  if(url.pathname.startsWith("/api/") || url.pathname==="/ws") {
   return env.CORE.get(env.CORE.idFromName("global")).fetch(request);
  }
  return env.ASSETS.fetch(request);
 }
};

export class TogetherCore extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;}
 async store(k){return (await this.ctx.storage.get(k))||{}}
 async currentUser(req){
  const a=req.headers.get("authorization")||"", t=a.startsWith("Bearer ")?a.slice(7):"";
  const sessions=await this.store("sessions"), id=sessions[t];
  const users=await this.store("users");
  return id && users[id] ? {user:users[id],token:t} : null;
 }
 async fetch(req){
  const url=new URL(req.url);
  try {
   if(url.pathname==="/ws" && req.headers.get("Upgrade")?.toLowerCase()==="websocket"){
    const t=url.searchParams.get("token")||"", sessions=await this.store("sessions"), id=sessions[t], users=await this.store("users"), u=users[id];
    if(!u)return new Response("Unauthorized",{status:401});
    const pair=new WebSocketPair(), [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server); server.serializeAttachment({uid:id});
    server.send(JSON.stringify({type:"READY",name:u.name}));
    return new Response(null,{status:101,webSocket:client});
   }
   if(url.pathname==="/api/register" && req.method==="POST"){
    const x=await body(req), name=String(x.name||"").trim(), email=String(x.email||"").trim().toLowerCase(), password=String(x.password||"");
    if(name.length<2)return json({error:"Name bitte mindestens 2 Zeichen."},400);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"Bitte eine gültige E-Mail eingeben."},400);
    if(password.length<8)return json({error:"Passwort muss mindestens 8 Zeichen haben."},400);
    const users=await this.store("users");
    if(Object.values(users).some(u=>u.email===email))return json({error:"E-Mail ist bereits registriert."},409);
    const id=crypto.randomUUID(), salt=b64(crypto.getRandomValues(new Uint8Array(16)));
    users[id]={id,name,email,salt,pass:await hash(password,salt),coupleId:null};
    await this.ctx.storage.put("users",users);
    const sessions=await this.store("sessions"), t=token();sessions[t]=id;await this.ctx.storage.put("sessions",sessions);
    return json({token:t,user:{id,name,email}});
   }
   if(url.pathname==="/api/login" && req.method==="POST"){
    const x=await body(req), email=String(x.email||"").trim().toLowerCase(), password=String(x.password||"");
    const users=await this.store("users"), u=Object.values(users).find(a=>a.email===email);
    if(!u || await hash(password,u.salt)!==u.pass)return json({error:"E-Mail oder Passwort falsch."},401);
    const sessions=await this.store("sessions"),t=token();sessions[t]=u.id;await this.ctx.storage.put("sessions",sessions);
    return json({token:t,user:{id:u.id,name:u.name,email:u.email}});
   }
   const auth=await this.currentUser(req);
   if(url.pathname==="/api/me"){
    return auth ? json({token:auth.token,user:{id:auth.user.id,name:auth.user.name,email:auth.user.email,coupleId:auth.user.coupleId}}) : json({error:"Nicht angemeldet"},401);
   }
   if(!auth)return json({error:"Bitte anmelden."},401);
   const {user}=auth;
   if(url.pathname==="/api/pair/create" && req.method==="POST"){
    const codes=await this.store("codes"), c=code(); codes[c]={uid:user.id,created:Date.now()};
    await this.ctx.storage.put("codes",codes);return json({code:c});
   }
   if(url.pathname==="/api/pair/join" && req.method==="POST"){
    const x=await body(req), c=String(x.code||"").trim().toUpperCase(), codes=await this.store("codes"), item=codes[c];
    if(!item || Date.now()-item.created>86400000)return json({error:"Code ungültig oder abgelaufen."},400);
    if(item.uid===user.id)return json({error:"Du kannst deinen eigenen Code nicht nutzen."},400);
    const users=await this.store("users"), host=users[item.uid];
    if(!host)return json({error:"Account zum Code nicht gefunden."},404);
    if((host.coupleId && user.coupleId && host.coupleId!==user.coupleId) || host.coupleId===user.id)return json({error:"Ein Account ist bereits gekoppelt."},409);
    const cid=host.coupleId||user.coupleId||crypto.randomUUID();host.coupleId=cid;user.coupleId=cid;
    users[host.id]=host;users[user.id]=user;await this.ctx.storage.put("users",users);
    delete codes[c];await this.ctx.storage.put("codes",codes);
    const packet=JSON.stringify({type:"PAIR_CONNECTED",name:user.name,from:user.id,at:Date.now()});
    for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment()||{};if(a.uid===host.id && ws.readyState===1)ws.send(packet);}
    return json({ok:true,coupleId:cid});
   }
   if(url.pathname==="/api/chat/history" && req.method==="GET"){
    const messages=(await this.store("messages"))[user.coupleId]||[];return json({messages});
   }
   if(url.pathname==="/api/chat/send" && req.method==="POST"){
    if(!user.coupleId)return json({error:"Verbinde zuerst eure Accounts."},400);
    const x=await body(req), text=String(x.text||"").trim().slice(0,2000);
    if(!text)return json({error:"Nachricht ist leer."},400);
    const all=await this.store("messages"), arr=all[user.coupleId]||[];
    const m={id:crypto.randomUUID(),text,from:user.id,name:user.name,at:Date.now()};
    arr.push(m);all[user.coupleId]=arr.slice(-200);await this.ctx.storage.put("messages",all);
    const packet=JSON.stringify({type:"CHAT",message:m});
    for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment()||{};if(a.uid===user.id)continue;const users=await this.store("users"), peer=users[a.uid];if(peer?.coupleId===user.coupleId && ws.readyState===1)ws.send(packet);}
    return json({ok:true,message:m});
   }
   return json({error:"Nicht gefunden."},404);
  } catch(e){return json({error:"Serverfehler: "+String(e?.message||e)},500);}
 }
 async webSocketMessage(ws,message){
  let p;try{p=JSON.parse(message)}catch{return;}
  const a=ws.deserializeAttachment()||{}, users=await this.store("users"), u=users[a.uid];
  if(!u?.coupleId || !["SHARED_PULSE","SHARED_LOVE","SHARED_CELEBRATE"].includes(p.type))return;
  const packet=JSON.stringify({...p,from:u.id,name:u.name,at:Date.now()});
  for(const peer of this.ctx.getWebSockets()){if(peer===ws||peer.readyState!==1)continue;const b=peer.deserializeAttachment()||{}, other=users[b.uid];if(other?.coupleId===u.coupleId)peer.send(packet);}
 }
 async webSocketClose(){} async webSocketError(){}
}
