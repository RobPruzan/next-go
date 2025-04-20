// bun run relay-server.ts      (Railway injects PORT)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

type Role = "host" | "client";
type Meta = { role?: Role; id?: string };

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();
const toHost: string[]                 = [];
const toClient: Record<string,string[]> = {};
const statusMap = new Map<string,string>();

function setStatus(id: string, s: string) {
  statusMap.set(id, s);
  console.log(`[relay] ${id}: ${s}`);
}

/* ------------------------------------------------ viewer HTML ---------- */
const viewerHTML = /*html*/`
<!doctype html><html><head><meta charset="utf-8"/>
<title>Live Viewer</title>
<style>html,body{margin:0;height:100%;background:#111}
#view{width:100%;height:100%;border:none}</style></head><body>
<iframe id="view"></iframe>
<script type="module">
  const WS_URL = location.origin.replace(/^http/, "ws");
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  let myId=null, ch=null;
  pc.ondatachannel = ev=>{
    ch = ev.channel;
    ch.onopen   = ()=> ws.send(JSON.stringify({type:"data-open",id:myId}));
    ch.onmessage=ev2=>{
      const {kind,payload}=JSON.parse(ev2.data);
      if(kind==="html"){
        document.getElementById("view").srcdoc=payload;
        ws.send(JSON.stringify({type:"html-ack",id:myId}));
      }
    };
  };
  const ws=new WebSocket(WS_URL);
  ws.onopen = ()=> ws.send(JSON.stringify({type:"join",role:"client"}));
  ws.onmessage=async ev=>{
    const m=JSON.parse(ev.data);
    if(m.type==="client-id"){myId=m.id;return}
    if(m.id!==myId) return;
    if(m.type==="offer"){
      await pc.setRemoteDescription(m.offer);
      const ans=await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type:"answer",id:myId,answer:ans}));
    }else if(m.type==="ice"){
      await pc.addIceCandidate(m.candidate);
    }
  };
  pc.onicecandidate=e=>{
    if(e.candidate && myId)
      ws.send(JSON.stringify({type:"ice",id:myId,candidate:e.candidate}));
  };
</script></body></html>`;

/* ------------------------------------------------ Bun serve ------------ */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response(viewerHTML, { headers:{ "content-type":"text/html"}});
  },

  websocket: {
    message(ws, raw) {
      const txt = typeof raw==="string"?raw:raw.toString();
      const m   = JSON.parse(txt);

      /* ---- join ------------------------------------------------------- */
      if(m.type==="join"){
        if(m.role==="host"){
          ws.data={role:"host"};
          host=ws; setStatus("host","connected");
          toHost.splice(0).forEach(p=>ws.send(p));
        }else{
          const id=nanoid(6);
          ws.data={role:"client",id};
          clients.set(id,ws); toClient[id]=[];
          ws.send(JSON.stringify({type:"client-id",id}));
          const notice=JSON.stringify({type:"client-join",id});
          host ? host.send(notice) : toHost.push(notice);
          setStatus(id,"ws-connected");
        }
        return;
      }

      /* ---- proxy / queue --------------------------------------------- */
      if(ws.data?.role==="host"){
        const t=clients.get(m.id);
        (t ?? toClient[m.id].push(txt)) && t?.send(txt);
        setStatus(m.id,`relay->client:${m.type}`);
      }else{ // from client
        const id=ws.data!.id!;
        m.id=id;
        const payload=JSON.stringify(m);
        host ? host.send(payload) : toHost.push(payload);
        setStatus(id,`relay->host:${m.type}`);
      }
    },

    close(ws){
      if(ws===host){host=undefined;setStatus("host","disconnected");}
      else if(ws.data?.role==="client"){
        const id=ws.data.id!;
        clients.delete(id); delete toClient[id];
        host?.send(JSON.stringify({type:"client-leave",id}));
        setStatus(id,"ws-closed");
      }
    }
  }
});
console.log("🛰️  relay & viewer ready");
