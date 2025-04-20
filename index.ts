// bun run relay-server.ts
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

/* ------------------------------------------------------------------ */
/*  State and helpers                                                 */
/* ------------------------------------------------------------------ */
type Role = "host" | "client";
interface Meta { role?: Role; id?: string }

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

/* outgoing buffers while the receiver is offline */
const toHost: string[] = [];
const toClient: Record<string, string[]> = {};

function log(id: string, msg: string) {
  console.log(`[relay] ${id}: ${msg}`);
}

/* ------------------------------------------------------------------ */
/*  Pretty viewer HTML served at https://next-go-production.up...     */
/* ------------------------------------------------------------------ */
const viewerHTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>

  <style>
    html,body { margin:0; height:100%; background:#111; color:#0f0; font-family:monospace }
    #view     { width:100%; height:100%; border:none }
    #hud      { position:fixed; top:8px; left:8px; background:#0009; padding:6px 8px;
                border-radius:6px; font-size:12px; line-height:1.4; max-width:60vw }
    #log      { position:fixed; bottom:0; left:0; right:0; max-height:45vh; overflow:auto;
                background:#000; margin:0; padding:6px 8px; font-size:11px; line-height:1.4 }
    #log code { color:#8f8; }
  </style>
</head>
<body>
  <iframe id="view"></iframe>
  <div id="hud">connecting…</div>
  <pre id="log"></pre>

  <script type="module">
    /* ---------------- small console helper ----------------------------- */
    const logEl = document.getElementById('log');
    function log(...a) {
      const line = a.join(' ');
      logEl.insertAdjacentHTML('beforeend', line + '\\n');
      logEl.scrollTop = logEl.scrollHeight;
      console.log(...a);
    }
    const hud = document.getElementById('hud');
    const step = (s) => { hud.textContent = s; log('[status]', s); };

    /* ---------------- signalling -------------------------------------- */
    const WS_URL = location.origin.replace(/^http/, 'ws');
    log('[ws] url', WS_URL);
    const ws = new WebSocket(WS_URL);

    /* ---------------- peer connection --------------------------------- */
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pc.onconnectionstatechange = () => log('[pc] state', pc.connectionState);

    /* outgoing ICE */
    function sendICE(cand) {
      if (clientId) ws.send(JSON.stringify({ type: 'ice', id: clientId, candidate: cand }));
    }
    pc.onicecandidate = (e) => e.candidate && clientId && sendICE(e.candidate);

    /* data‑channel handlers */
    let clientId = null;
    pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      log('[data] channel', dc.label);
      dc.onopen = () => {
        log('[data] open');
        step('data‑channel open – waiting for HTML…');
        ws.send(JSON.stringify({ type: 'data-open', id: clientId }));
      };
      dc.onmessage = (ev2) => {
        const { kind, payload } = JSON.parse(ev2.data);
        log('[data] message', kind);
        if (kind === 'html') {
          document.getElementById('view').srcdoc = payload;
          ws.send(JSON.stringify({ type: 'html-ack', id: clientId }));
          step('HTML applied ✔︎');
        }
      };
    };

    /* ---------------- WebSocket --------------------------------------- */
    ws.onopen = () => {
      log('[ws] open');
      step('websocket open – joining…');
      ws.send(JSON.stringify({ type: 'join', role: 'client' }));
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.type === 'client-id') {
        clientId = msg.id;
        step('client id: ' + clientId);
        return;
      }
      if (msg.id !== clientId) return; // ignore others

      if (msg.type === 'offer') {
        step('offer received');
        await pc.setRemoteDescription(msg.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', id: clientId, answer }));
        step('answer sent');
      } else if (msg.type === 'ice') {
        await pc.addIceCandidate(msg.candidate);
        log('[sig] ice');
      }
    };
  </script>
</body>
</html>
`;

/* ------------------------------------------------------------------ */
/*  Bun server (HTTP + WebSocket)                                     */
/* ------------------------------------------------------------------ */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  /* ---------- HTTP ---------------------------------------------------- */
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response(viewerHTML, { headers: { "content-type": "text/html" } });
  },

  /* ---------- WebSocket ---------------------------------------------- */
  websocket: {
    message(ws, data) {
      const txt = typeof data === "string" ? data : data.toString();
      const msg = JSON.parse(txt);

      /* --- join handshake --------------------------------------------- */
      if (msg.type === "join") {
        if (msg.role === "host") {
          host = ws;
          ws.data = { role: "host" };
          log("host", "ws-connected");
          toHost.splice(0).forEach(p => host!.send(p));
        } else {
          /* new client */
          const id = nanoid(5);
          ws.data = { role: "client", id };
          clients.set(id, ws);
          toClient[id] = [];
          ws.send(JSON.stringify({ type: "client-id", id }));
          const notice = JSON.stringify({ type: "client-join", id });
          host ? host.send(notice) : toHost.push(notice);
          log(id, "ws-connected");
        }
        return;
      }

      /* --- proxy or buffer -------------------------------------------- */
      if (ws.data?.role === "host") {
        /* from host → to ONE client */
        const target = clients.get(msg.id);
        if (target) {
          target.send(txt);
        } else {
          (toClient[msg.id] ||= []).push(txt);
        }
        log(msg.id, `relay→client:${msg.type}`);
      } else {
        /* from client → host*/
        const id = ws.data!.id!;
        msg.id = id;                       // tag sender
        const payload = JSON.stringify(msg);
        if (host) host.send(payload); else toHost.push(payload);
        log(id, `relay→host:${msg.type}`);
      }
    },

    close(ws) {
      if (ws === host) {
        host = undefined;
        log("host", "ws-closed");
        return;
      }
      if (ws.data?.role === "client") {
        const id = ws.data.id!;
        clients.delete(id);
        delete toClient[id];
        host?.send(JSON.stringify({ type: "client-leave", id }));
        log(id, "ws-closed");
      }
    },
  },
});

console.log("relay & viewer running on", process.env.PORT || 5050);
