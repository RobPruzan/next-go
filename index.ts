// bun run relay-server.ts   (Railway injects PORT)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

type Role = "host" | "client";
interface Meta { role?: Role; id?: string }

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();
const toHost: string[] = [];
const toClient = new Map<string, string[]>();

const log = (id: string, m: string) => console.log(`[relay] ${id}: ${m}`);

/* --- tiny viewer page -------------------------------------------------- */
const viewerHTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>
  <style>
    html,body{margin:0;height:100%;background:#111;color:#0f0;font-family:monospace}
    #view{width:100%;height:100%;border:none}
    #hud {position:fixed;top:8px;left:50%;transform:translateX(-50%);
          background:#000a;padding:6px 10px;border-radius:6px;font-size:12px}
    #log {position:fixed;bottom:0;left:0;right:0;max-height:45vh;overflow:auto;
          background:#000;margin:0;padding:6px 10px;font-size:11px;line-height:1.4}
  </style>
</head>
<body>
  <iframe id="view"></iframe>
  <div id="hud">connecting…</div>
  <pre   id="log"></pre>

<script type="module">
  const hud=document.getElementById('hud');
  const log=(...a)=>{logBox.textContent+=a.join(' ')+'\\n';logBox.scrollTop=1e9;};
  const logBox=document.getElementById('log');
  const step=s=>{hud.textContent=s;log('[status]',s);};

  const ws=new WebSocket(location.origin.replace(/^http/,'ws'));
  const pc=new RTCPeerConnection({iceServers:[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:global.stun.twilio.com:3478'}
  ]});

  let id=null;
  const pendingICE=[];                 // queue ICE until remote‑SDP set

  pc.onicecandidate=e=>{
    if(e.candidate&&id) ws.send(JSON.stringify({type:'ice',id,candidate:e.candidate}));
  };
  pc.onconnectionstatechange=()=>log('[pc]',pc.connectionState);
  pc.ondatachannel=ev=>{
    const dc=ev.channel;
    dc.onopen=()=>ws.send(JSON.stringify({type:'data-open',id}));
    dc.onmessage=ev2=>{
      const {kind,payload}=JSON.parse(ev2.data);
      if(kind==='html'){
        document.getElementById('view').srcdoc=payload;
        ws.send(JSON.stringify({type:'html-ack',id}));
        step('HTML applied ✓');
      }
    };
  };

  ws.onopen = ()=>ws.send(JSON.stringify({type:'join',role:'client'}));

  ws.onmessage=async ev=>{
    const m=JSON.parse(ev.data);

    if(m.type==='client-id'){ id=m.id; step('id '+id); return; }
    if(m.id!==id) return;

    if(m.type==='offer'){
      await pc.setRemoteDescription(m.offer);
      for(const cand of pendingICE) await pc.addIceCandidate(cand); // flush
      pendingICE.length=0;
      const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type:'answer',id,answer:ans}));
      step('answer sent');
    } else if(m.type==='ice'){
      if(pc.remoteDescription) await pc.addIceCandidate(m.candidate);
      else pendingICE.push(m.candidate);
    }
  };
</script>
</body>
</html>`;

/* --- Bun HTTP + WS ----------------------------------------------------- */
Bun.serve<Meta>({
  port: Number(process.env.PORT)||5050,

  fetch(req,srv){ if(srv.upgrade(req)) return;
    return new Response(viewerHTML,{headers:{'content-type':'text/html'}}); },

  websocket:{
    message(ws,raw){
      const txt=typeof raw==='string'?raw:raw.toString();
      const m=JSON.parse(txt);

      /* join */
      if(m.type==='join'){
        if(m.role==='host'){
          host=ws;ws.data={role:'host'};log('host','ws-connected');
          toHost.splice(0).forEach(p=>host!.send(p));
        }else{
          const id=nanoid(5);
          ws.data={role:'client',id};clients.set(id,ws);
          (toClient.get(id)||[]).forEach(p=>ws.send(p)); toClient.delete(id);
          ws.send(JSON.stringify({type:'client-id',id}));
          host ? host.send(JSON.stringify({type:'client-join',id}))
               : toHost.push(JSON.stringify({type:'client-join',id}));
          log(id,'ws-connected');
        }
        return;
      }

      /* proxy */
      if(ws.data?.role==='host'){
        const t=clients.get(m.id);
        if(t) t.send(txt); else (toClient.get(m.id)||toClient.set(m.id,[]).get(m.id))!.push(txt);
      }else{
        const id=ws.data!.id!;
        m.id=id;
        const payload=JSON.stringify(m);
        host?host.send(payload):toHost.push(payload);
      }
    },

    close(ws){
      if(ws===host){host=undefined;log('host','closed');return;}
      if(ws.data?.role==='client'){
        const id=ws.data.id!;
        clients.delete(id); toClient.delete(id);
        host?.send(JSON.stringify({type:'client-leave',id}));
      }
    }
  }
});
