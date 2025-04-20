// bun run relay-server.ts               (Railway sets PORT)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

/* ───────── types & in‑memory state ───────── */
type Role = "host" | "client";
interface Meta { role?: Role; id?: string }

let host: ServerWebSocket<Meta> | undefined;
const clients = new Map<string, ServerWebSocket<Meta>>();

/* message buffers while the target is offline */
const toHost: string[]                 = [];
const toClient: Record<string, string[]> = {};

const log = (id: string, msg: string) => console.log(`[relay] ${id}: ${msg}`);

/* ───────── viewer page (served over HTTPS) ───────── */
const viewerHTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>
  <style>
    html,body { margin:0; height:100%; background:#111; color:#0f0; font-family:monospace }
    #view     { width:100%; height:100%; border:none }
    #hud      { position:fixed; top:8px; left:8px; background:#0009; padding:6px 8px;
                border-radius:6px; font-size:12px; line-height:1.4; max-width:60vw }
    #log      { position:fixed; bottom:0; left:0; right:0; max-height:45vh; overflow:auto;
                background:#000; margin:0; padding:6px 8px; font-size:11px; line-height:1.4 }
  </style>
</head>
<body>
  <iframe id="view"></iframe>
  <div id="hud">connecting…</div>
  <pre id="log"></pre>

  <script type="module">
    const hud = document.getElementById('hud');
    const logBox = document.getElementById('log');
    const log = (...a) => {
      logBox.textContent += a.join(' ') + '\\n';
      logBox.scrollTop = logBox.scrollHeight;
      console.log(...a);
    };
    const step = s => { hud.textContent = s; log('[status]', s); };

    /* ---------- signalling ---------- */
    const WS_URL = location.origin.replace(/^http/, 'ws');
    log('[ws] url', WS_URL);
    const ws = new WebSocket(WS_URL);

    /* ---------- peer connection ------ */
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    pc.onconnectionstatechange = () => log('[pc] state', pc.connectionState);

    let myId = null;

    /* ICE → relay */
    pc.onicecandidate = e => {
      if (e.candidate && myId)
        ws.send(JSON.stringify({ type: 'ice', id: myId, candidate: e.candidate }));
    };

    /* incoming data channel */
    pc.ondatachannel = ev => {
      const dc = ev.channel;
      log('[data] channel', dc.label);

      dc.onopen = () => {
        log('[data] open');
        step('data‑channel open – waiting for HTML…');
        ws.send(JSON.stringify({ type: 'data-open', id: myId }));
      };

      dc.onmessage = ev2 => {
        const { kind, payload } = JSON.parse(ev2.data);
        log('[data] message', kind);
        if (kind === 'html') {
          document.getElementById('view').srcdoc = payload;
          ws.send(JSON.stringify({ type: 'html-ack', id: myId }));
          step('HTML applied ✔');
        }
      };
    };

    /* WebSocket flow */
    ws.onopen = () => {
      log('[ws] open');
      step('WebSocket open – joining…');
      ws.send(JSON.stringify({ type: 'join', role: 'client' }));
    };

    ws.onmessage = async ev => {
      const m = JSON.parse(ev.data);

      if (m.type === 'client-id') {
        myId = m.id;
        step('client id: ' + myId);
        return;
      }
      if (m.id !== myId) return;

      if (m.type === 'offer') {
        step('offer received');
        await pc.setRemoteDescription(m.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', id: myId, answer }));
        step('answer sent');
      } else if (m.type === 'ice') {
        await pc.addIceCandidate(m.candidate);
        log('[sig] ice');
      }
    };
  </script>
</body>
</html>
`;

/* ───────── Bun server (HTTP + WS) ───────── */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  /* HTTP → serve viewer page */
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response(viewerHTML, { headers: { "content-type": "text/html" } });
  },

  websocket: {
    /* ── message handler ─────────────────────────────────────────────── */
    message(ws, raw) {
      const txt = typeof raw === "string" ? raw : raw.toString();
      const msg = JSON.parse(txt);

      /* ----- join handshake ----- */
      if (msg.type === "join") {
        if (msg.role === "host") {
          host = ws;
          ws.data = { role: "host" };
          log("host", "ws-connected");
          toHost.splice(0).forEach(p => host!.send(p));
        } else {
          const id = nanoid(5);
          ws.data = { role: "client", id };
          clients.set(id, ws);

          /* flush anything already queued for this client */
          (toClient[id] ?? []).forEach(p => ws.send(p));
          toClient[id] = [];

          ws.send(JSON.stringify({ type: "client-id", id }));
          const notice = JSON.stringify({ type: "client-join", id });
          host ? host.send(notice) : toHost.push(notice);
          log(id, "ws-connected");
        }
        return;
      }

      /* ----- forward or buffer ----- */
      if (ws.data?.role === "host") {
        /* host → specific client */
        const target = clients.get(msg.id);
        if (target) target.send(txt);
        else (toClient[msg.id] ||= []).push(txt);
        log(msg.id, "relay→client:" + msg.type);
      } else {
        /* client → host */
        const id = ws.data!.id!;
        msg.id = id;
        const payload = JSON.stringify(msg);
        host ? host.send(payload) : toHost.push(payload);
        log(id, "relay→host:" + msg.type);
      }
    },

    /* ── cleanup on close ────────────────────────────────────────────── */
    close(ws) {
      if (ws === host) {
        host = undefined;
        log("host", "ws-closed");
      } else if (ws.data?.role === "client") {
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
