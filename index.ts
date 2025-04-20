// bun run relay-server.ts        (Railway sets PORT automatically)
import type { ServerWebSocket } from "bun";

/* ------------------------------------------------------------------ */
/*  Minimal in‑memory “one host + one client” hub                     */
/* ------------------------------------------------------------------ */
type Role = "host" | "client";
type UserMeta = { role?: Role };

let host:   ServerWebSocket<UserMeta> | undefined;
let client: ServerWebSocket<UserMeta> | undefined;

/* ------------------------------------------------------------------ */
/*  HTML page the phone will load (viewer)                            */
/* ------------------------------------------------------------------ */
function viewerHTML() {
  return /* html */ `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>
  <style>
    html,body{margin:0;height:100%;background:#111}
    #view{width:100%;height:100%;border:none}
  </style>
</head>
<body>
  <iframe id="view"></iframe>

  <script type="module">
    const WS_URL = location.origin.replace(/^http/, "ws");  // -> wss://…
    const pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}]});

    /* incoming data‑channel delivers the HTML string */
    pc.ondatachannel = ev => {
      ev.channel.onmessage = m => {
        const {kind, payload} = JSON.parse(m.data);
        if (kind === "html") document.getElementById("view").srcdoc = payload;
      };
    };

    const ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type:"join", role:"client" }));

    ws.onmessage = async ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "offer") {
        await pc.setRemoteDescription(msg.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type:"answer", answer }));
      } else if (msg.type === "ice") {
        await pc.addIceCandidate(msg.candidate);
      }
    };
  </script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Bun HTTP + WS server                                              */
/* ------------------------------------------------------------------ */
Bun.serve<UserMeta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    if (srv.upgrade(req)) return;                      // ⇢ WebSocket
    return new Response(viewerHTML(), {
      headers: { "content-type": "text/html" },
    });
  },

  websocket: {
    /* first message: {type:"join", role:"host"|"client"} */
    message(ws, raw) {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "join") {
        ws.data = { role: msg.role };
        if (msg.role === "host")   host   = ws;
        if (msg.role === "client") client = ws;
        return;
      }

      /* forward everything else */
      const target = ws.data?.role === "host" ? client : host;
      target?.send(raw);
    },

    close(ws) {
      if (ws === host)   host   = undefined;
      if (ws === client) client = undefined;
    },
  },
});

console.log("🛰️  relay + viewer ready");
