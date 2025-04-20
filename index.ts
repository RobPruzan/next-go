// bun run relay-server.ts      (Railway injects PORT)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

/** ------------------------------------------------------------------
 *  Types & globals
 * ------------------------------------------------------------------ */
type Role = "host" | "client";
interface Meta {
  role?: Role;
  id?: string;
}

/* host (desktop) + many clients (phones) */
let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

/* per‑client outgoing buffers when the target is offline */
const toHost: string[] = [];
const toClient: Record<string, string[]> = {};

/* status bookkeeping (just an in‑memory map + console logs) */
const statusMap = new Map<string, string>();
function setStatus(id: string, s: string) {
  statusMap.set(id, s);
  console.log(`[relay] ${id}: ${s}`);
}

/** ------------------------------------------------------------------
 *  Viewer HTML (served at https://<domain>)
 *      – connects as "client" automatically
 *      – shows status log on screen
 * ------------------------------------------------------------------ */
const viewerHTML = /*html*/ `
<!doctype html><html><head><meta charset="utf-8"/>
<title>Live Viewer</title>
<style>
 html,body{margin:0;height:100%;background:#111;color:#0f0;font-family:monospace}
 #view{width:100%;height:100%;border:none}
 #log{position:fixed;bottom:0;left:0;right:0;max-height:45vh;overflow:auto;background:#000a;padding:4px;font-size:11px;line-height:1.35}
</style></head><body>
 <iframe id="view"></iframe>
 <pre id="log"></pre>

 <script type="module">
  const logEl = document.getElementById('log');
  const log = (...a)=>{logEl.textContent += a.join(' ') + "\n"; logEl.scrollTop=logEl.scrollHeight; console.log(...a);} 

  const WS_URL = location.origin.replace(/^http/, 'ws');
  log('[viewer] connecting WS', WS_URL);

  const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  let myId=null; let dc=null;

  pc.onconnectionstatechange = () => log('[pc] state', pc.connectionState);
  pc.onicecandidate = e=>{
    if(e.candidate && myId) ws.send(JSON.stringify({type:'ice',id:myId,candidate:e.candidate}));
  };

  pc.ondatachannel = ev => {
    dc = ev.channel;
    log('[data] channel', dc.label);
    dc.onopen = ()=>{
      log('[data] open');
      ws.send(JSON.stringify({type:'data-open',id:myId}));
    };
    dc.onmessage = ev2 => {
      const {kind,payload} = JSON.parse(ev2.data);
      log('[data] message kind', kind);
      if(kind==='html'){
        document.getElementById('view').srcdoc = payload;
        ws.send(JSON.stringify({type:'html-ack',id:myId}));
        log('[view] html applied & ack sent');
      }
    };
  };

  const ws = new WebSocket(WS_URL);
  ws.onopen = ()=>{ log('[ws] open'); ws.send(JSON.stringify({type:'join',role:'client'})); };
  ws.onmessage = async ev => {
    const m = JSON.parse(ev.data);
    if(m.type==='client-id'){ myId=m.id; log('[id]', myId); return; }
    if(!m.id || m.id!==myId) return;

    if(m.type==='offer'){
      log('[sig] offer');
      await pc.setRemoteDescription(m.offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      ws.send(JSON.stringify({type:'answer',id:myId,answer:ans}));
      log('[sig] answer sent');
    } else if(m.type==='ice'){
      log('[sig] ice'); await pc.addIceCandidate(m.candidate); }
  };
 </script>
</body></html>`;

/** ------------------------------------------------------------------
 *  Bun HTTP + WebSocket relay (single process)
 * ------------------------------------------------------------------ */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;           // -> WebSocket path
    return new Response(viewerHTML, { headers:{'content-type':'text/html'} });
  },

  websocket: {
    message(ws, data) {
      const txt = typeof data==='string'?data:data.toString();
      const m   = JSON.parse(txt);

      /* -- join handshake -- */
      if(m.type==='join'){
        if(m.role==='host'){
          host = ws; ws.data={role:'host'}; setStatus('host','ws-connected');
          toHost.splice(0).forEach(p=>ws.send(p));
        } else {
          const id = nanoid(5);
          ws.data = { role:'client', id }; clients.set(id, ws); toClient[id]=[];
          ws.send(JSON.stringify({type:'client-id',id}));
          const notice = JSON.stringify({type:'client-join', id});
          host ? host.send(notice) : toHost.push(notice);
          setStatus(id,'ws-connected');
        }
        return;
      }

      /* -- routing -- */
      if(ws.data?.role==='host'){
        const tar = clients.get(m.id);
        (tar ?? toClient[m.id].push(txt)) && tar?.send(txt);
        setStatus(m.id,`relay->client:${m.type}`);
      } else {
        const id = ws.data!.id!;
        m.id = id;
        const payload = JSON.stringify(m);
        setStatus(id,`relay->host:${m.type}`);
        host ? host.send(payload) : toHost.push(payload);
      }
    },

    close(ws) {
      if(ws===host){host=undefined;setStatus('host','ws-closed');return;}
      if(ws.data?.role==='client'){
        const id=ws.data.id!; clients.delete(id); delete toClient[id];
        host?.send(JSON.stringify({type:'client-leave',id}));
        setStatus(id,'ws-closed');
      }
    }
  }
});

console.log('🛰️ relay + viewer running on', process.env.PORT||5050);
