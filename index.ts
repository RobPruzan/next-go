// bun run relay-server.ts   – deploy on Railway (PORT is set for you)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

type Role = "host" | "client";
interface Meta { role?: Role; id?: string }

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

const toHost: string[] = [];
const toClient = new Map<string, string[]>();

const log = (id: string, msg: string) => console.log(`[relay] ${id}: ${msg}`);

/* ───── viewer page ───── */
const viewerHTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>
  <style>
    html,body{margin:0;height:100%;background:#111;color:#0f0;font-family:monospace}
    #view{width:100%;height:100%;border:none}
    #hud{position:fixed;top:8px;left:50%;transform:translateX(-50%);
         background:#000a;padding:6px 10px;border-radius:6px;font-size:12px}
    #log{position:fixed;bottom:0;left:0;right:0;max-height:45vh;overflow:auto;
         background:#000;margin:0;padding:6px 10px;font-size:11px;line-height:1.4}
  </style>
</head>
<body>
  <iframe id="view"></iframe>
  <div id="hud">connecting…</div>
  <pre id="log"></pre>

  <script type="module">
    const logBox=document.getElementById('log');
    const hud=document.getElementById('hud');
    const log=(...a)=>{logBox.textContent+=a.join(' ')+'\\n';logBox.scrollTop=1e9;console.log(...a)};
    const step=s=>{hud.textContent=s;log('[status]',s);};

    const WS_URL=location.origin.replace(/^http/,'ws');
    const ws=new WebSocket(WS_URL);
    const pc=new RTCPeerConnection({iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      // {urls:'turn:TURN_HOST:3478',username:'user',credential:'pass'}
    ]});

    let id=null;

    pc.onconnectionstatechange=()=>log('[pc] state',pc.connectionState);
    pc.onicecandidate=e=>e.candidate&&id&&ws.send(JSON.stringify({type:'ice',id,candidate:e.candidate}));
    pc.ondatachannel=ev=>{
      const dc=ev.channel;
      dc.onopen=()=>{log('[data] open');ws.send(JSON.stringify({type:'data-open',id}));};
      dc.onmessage=ev2=>{
        const {kind,payload}=JSON.parse(ev2.data);
        if(kind==='html'){document.getElementById('view').srcdoc=payload;ws.send(JSON.stringify({type:'html-ack',id}));step('HTML applied ✓');}
      };
    };

    ws.onopen = ()=>{log('[ws] open');ws.send(JSON.stringify({type:'join',role:'client'}));};
    ws.onmessage=async ev=>{
      const m=JSON.parse(ev.data);
      if(m.type==='client-id'){id=m.id;step('client id: '+id);return;}
      if(m.id!==id) return;
      if(m.type==='offer'){
        step('offer received');await pc.setRemoteDescription(m.offer);
        const ans=await pc.createAnswer();await pc.setLocalDescription(ans);
        ws.send(JSON.stringify({type:'answer',id,answer:ans}));step('answer sent');
      }else if(m.type==='ice'){await pc.addIceCandidate(m.candidate);}
    };
  </script>
</body>
</html>
`;

/* ───── Bun server ───── */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response(viewerHTML, { headers: { "content-type": "text/html" } });
  },

  websocket: {
    message(ws, raw) {
      const txt = typeof raw === "string" ? raw : raw.toString();
      const m = JSON.parse(txt);

      /* join ----------------------------------------------------------- */
      if (m.type === "join") {
        if (m.role === "host") {
          host = ws; ws.data = { role: "host" };
          log("host", "ws-connected");
          toHost.splice(0).forEach(p => host!.send(p));
          return;
        }
        /* client */
        const id = nanoid(5);
        ws.data = { role: "client", id };
        clients.set(id, ws);
        /* flush any queued traffic */
        (toClient.get(id) || []).forEach(p => ws.send(p));
        toClient.delete(id);
        ws.send(JSON.stringify({ type: "client-id", id }));
        const notice = JSON.stringify({ type: "client-join", id });
        host ? host.send(notice) : toHost.push(notice);
        log(id, "ws-connected");
        return;
      }

      /* proxy ---------------------------------------------------------- */
      if (ws.data?.role === "host") {
        const target = clients.get(m.id);
        if (target) target.send(txt);
        else (toClient.get(m.id) || toClient.set(m.id, []).get(m.id))!.push(txt);
        log(m.id, "relay→client:" + m.type);
      } else {
        const id = ws.data!.id!;
        m.id = id;
        const payload = JSON.stringify(m);
        host ? host.send(payload) : toHost.push(payload);
        log(id, "relay→host:" + m.type);
      }
    },

    close(ws) {
      if (ws === host) { host = undefined; log("host", "ws-closed"); return; }
      if (ws.data?.role === "client") {
        const id = ws.data.id!;
        clients.delete(id); toClient.delete(id);
        host?.send(JSON.stringify({ type: "client-leave", id }));
        log(id, "ws-closed");
      }
    },
  },
});

console.log("relay & viewer running on", process.env.PORT || 5050);
