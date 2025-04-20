// bun run relay-server.ts  (Railway sets PORT automatically)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

/** --------------------------------------------------------------
 *  Simple relay – one host, many clients                       
 * --------------------------------------------------------------*/
type Role = "host" | "client";
interface Meta { role?: Role; id?: string }

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

/* outgoing buffers while the target peer is offline */
const toHost: string[] = [];
const toClient: Record<string, string[]> = {};

/* helper for noisy logging */
function log(id: string, msg: string) {
  console.log(`[relay] ${id}: ${msg}`);
}

/** --------------------------------------------------------------
 *  Viewer HTML (served at https://next-go-production.up.railway.app)
 * --------------------------------------------------------------*/
const viewerHTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<title>Live Viewer</title>
<style>
  html, body {
    margin: 0;
    height: 100%;
    background: #111;
    color: #0f0;
    font-family: monospace;
  }
  #view {
    width: 100%;
    height: 100%;
    border: none;
  }
  #log {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 45vh;
    overflow: auto;
    background: #000;
    padding: 4px;
    font-size: 11px;
    line-height: 1.4;
  }
</style>
</head><body>
<iframe id="view"></iframe>
<pre id="log"></pre>
<script>
(function() {
  const logEl = document.getElementById('log');
  const log = (...a) => {
    logEl.textContent += a.join(' ') + '\\n';
    logEl.scrollTop = logEl.scrollHeight;
    console.log(...a);
  };

  const WS_URL = location.origin.replace(/^http/, 'ws');
  log('[ws] url', WS_URL);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });
  let id = null;
  let dc = null;

  pc.onconnectionstatechange = () => log('[pc] state', pc.connectionState);
  pc.onicecandidate = e => {
    if (e.candidate && id) {
      ws.send(JSON.stringify({type: 'ice', id, candidate: e.candidate}));
    }
  };

  pc.ondatachannel = ev => {
    dc = ev.channel;
    log('[data] channel', dc.label);
    dc.onopen = () => {
      log('[data] open');
      ws.send(JSON.stringify({type: 'data-open', id}));
    };
    dc.onmessage = ev2 => {
      const {kind, payload} = JSON.parse(ev2.data);
      log('[data] message', kind);
      if (kind === 'html') {
        document.getElementById('view').srcdoc = payload;
        ws.send(JSON.stringify({type: 'html-ack', id}));
        log('[view] html applied');
      }
    };
  };

  const ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    log('[ws] open');
    ws.send(JSON.stringify({type: 'join', role: 'client'}));
  };
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'client-id') {
      id = m.id;
      log('[id]', id);
      return;
    }
    if (m.id !== id) return;
    if (m.type === 'offer') {
      log('[sig] offer');
      await pc.setRemoteDescription(m.offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type: 'answer', id, answer: ans}));
      log('[sig] answer sent');
    } else if (m.type === 'ice') {
      await pc.addIceCandidate(m.candidate);
      log('[sig] ice');
    }
  };
})();
</script>
</body></html>`;

/** --------------------------------------------------------------
 *  Bun server (HTTP + WS)
 * --------------------------------------------------------------*/
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;           // handle WS later
    return new Response(viewerHTML, { headers:{'content-type':'text/html'} });
  },

  websocket: {
    message(ws, data) {
      const txt=typeof data==='string'?data:data.toString();
      const m=JSON.parse(txt);

      // --- join handshake ---------------------------------------
      if(m.type==='join'){
        if(m.role==='host'){
          host=ws;ws.data={role:'host'};log('host','ws-connected');
          toHost.splice(0).forEach(p=>ws.send(p));
        }else{
          const id=nanoid(5);
          ws.data={role:'client',id};clients.set(id,ws);toClient[id]=[];
          ws.send(JSON.stringify({type:'client-id',id}));
          const notice=JSON.stringify({type:'client-join',id});
          host?host.send(notice):toHost.push(notice);
          log(id,'ws-connected');
        }
        return;
      }

      // --- proxy logic -----------------------------------------
      if(ws.data?.role==='host'){
        const t=clients.get(m.id);
        if(t) t.send(txt); else toClient[m.id].push(txt);
        log(m.id,`relay->client:${m.type}`);
      }else{
        const id=ws.data!.id!;
        m.id=id;
        const payload=JSON.stringify(m);
        if(host) host.send(payload); else toHost.push(payload);
        log(id,`relay->host:${m.type}`);
      }
    },

    close(ws){
      if(ws===host){host=undefined;log('host','ws-closed');return;}
      if(ws.data?.role==='client'){
        const id=ws.data.id!;clients.delete(id);delete toClient[id];
        host?.send(JSON.stringify({type:'client-leave',id}));
        log(id,'ws-closed');
      }
    }
  }
});

console.log('relay + viewer running on', process.env.PORT||5050);
