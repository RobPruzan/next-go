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
    console.log("Viewer script starting...");
    const WS_URL = location.origin.replace(/^http/, "ws");  // -> wss://…
    console.log("WebSocket URL:", WS_URL);
    const pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
    console.log("RTCPeerConnection created");

    /* incoming data‑channel delivers the HTML string */
    pc.ondatachannel = ev => {
      console.log("Data channel received:", ev.channel.label);
      ev.channel.onmessage = m => {
        console.log("Message received on data channel");
        const {kind, payload} = JSON.parse(m.data);
        console.log("Message kind:", kind);
        if (kind === "html") {
          console.log("Setting HTML content to iframe");
          document.getElementById("view").srcdoc = payload;
        }
      };
    };

    const ws = new WebSocket(WS_URL);
    console.log("WebSocket connection initiated");
    
    ws.onopen = () => {
      console.log("WebSocket connection opened, joining as client");
      ws.send(JSON.stringify({ type:"join", role:"client" }));
    };

    ws.onmessage = async ev => {
      console.log("WebSocket message received");
      const msg = JSON.parse(ev.data);
      console.log("Message type:", msg.type);
      
      if (msg.type === "offer") {
        console.log("Processing offer from host");
        await pc.setRemoteDescription(msg.offer);
        console.log("Remote description set");
        
        const answer = await pc.createAnswer();
        console.log("Answer created");
        
        await pc.setLocalDescription(answer);
        console.log("Local description set");
        
        ws.send(JSON.stringify({ type:"answer", answer }));
        console.log("Answer sent to host");
      } else if (msg.type === "ice") {
        console.log("Adding ICE candidate");
        await pc.addIceCandidate(msg.candidate);
        console.log("ICE candidate added");
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
