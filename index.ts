// bun run relay-server.ts   (Railway injects PORT)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

type Role = "host" | "client";
type Meta = { role?: Role; id?: string };

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

/* buffers while the other side is offline -------------------------------- */
let toHost: string[] = [];
const toClient: Record<string, string[]> = {};

/* ------------------------------------------------------------------------ */
/* Viewer page (mobile)                                                     */
/* ------------------------------------------------------------------------ */
const viewerHTML = /*html*/ `
<!doctype html><html><head><meta charset="utf-8"/>
<title>Live Viewer</title>
<style>html,body{margin:0;height:100%;background:#111}#view{width:100%;height:100%;border:none}</style>
</head><body>
<iframe id="view"></iframe>
<script type="module">
  const WS_URL = location.origin.replace(/^http/, "ws");
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  let myId = null;

  pc.ondatachannel = ev => {
    ev.channel.onmessage = ({data})=>{
      const {kind,payload} = JSON.parse(data);
      if(kind==="html") document.getElementById("view").srcdoc = payload;
    };
  };

  const ws = new WebSocket(WS_URL);
  ws.onopen = ()=>ws.send(JSON.stringify({type:"join",role:"client"}));

  ws.onmessage = async ev=>{
    const m = JSON.parse(ev.data);
    if(m.type==="client-id"){ myId = m.id; return; }
    if(m.id && m.id!==myId) return;          // ignore foreign traffic

    if(m.type==="offer"){
      await pc.setRemoteDescription(m.offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type:"answer",id:myId,answer:ans}));
    }else if(m.type==="ice"){
      await pc.addIceCandidate(m.candidate);
    }
  };

  pc.onicecandidate = e=>{
    if(e.candidate && myId)
      ws.send(JSON.stringify({type:"ice",id:myId,candidate:e.candidate}));
  };
</script>
</body></html>`;

/* ------------------------------------------------------------------------ */
/* Relay logic                                                              */
/* ------------------------------------------------------------------------ */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response(viewerHTML, { headers: { "content-type": "text/html" } });
  },

  websocket: {
    message(ws, raw) {
      const txt = typeof raw === "string" ? raw : raw.toString();
      const msg = JSON.parse(txt);

      /* ------- Join ----------------------------------------------------- */
      if (msg.type === "join") {
        if (msg.role === "host") {
          ws.data = { role: "host" };
          host = ws;
          /* flush any waiting messages */
          toHost.forEach(p => ws.send(p));
          toHost = [];
        } else { // client
          const id = nanoid(6);
          ws.data = { role: "client", id };
          clients.set(id, ws);
          toClient[id] = [];

          /* tell client its id */
          ws.send(JSON.stringify({ type: "client-id", id }));
          /* notify host */
          const notice = JSON.stringify({ type: "client-join", id });
          host ? host.send(notice) : toHost.push(notice);
        }
        return;
      }

      /* ------- Proxy / queue ------------------------------------------- */
      if (ws.data?.role === "host") {
        const target = clients.get(msg.id);
        (target ?? (toClient[msg.id] ||= [])).push(txt);
      } else { // sender is a client
        msg.id = ws.data!.id;                      // tag with sender id
        const payload = JSON.stringify(msg);
        host ? host.send(payload) : toHost.push(payload);
      }
    },

    open() {},

    close(ws) {
      if (ws === host) {
        host = undefined;
      } else if (ws.data?.role === "client") {
        const id = ws.data.id!;
        clients.delete(id);
        delete toClient[id];
        host?.send(JSON.stringify({ type: "client-leave", id }));
      }
    },
  },
});

console.log("🛰️  relay & viewer ready on :", process.env.PORT || 5050);
