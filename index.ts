// bun run relay-server.ts   — Railway will inject PORT
import type { ServerWebSocket } from "bun";

/* ------------------------------------------------------------------ */
/*  Types & globals                                                   */
/* ------------------------------------------------------------------ */
type Role = "host" | "client";
type Meta = { role?: Role };

let host:   ServerWebSocket<Meta> | undefined;
let client: ServerWebSocket<Meta> | undefined;

/* queued messages while the other side is absent */
let toHost:   string[] = [];
let toClient: string[] = [];

/* ------------------------------------------------------------------ */
/*  Viewer HTML (phone loads this over HTTPS)                          */
/* ------------------------------------------------------------------ */
const viewerHTML = /*html*/ `
<!doctype html><html><head><meta charset="utf-8"/>
  <title>Live Viewer</title>
  <style>html,body{margin:0;height:100%;background:#111}
        #view{width:100%;height:100%;border:none}</style>
</head><body>
  <iframe id="view"></iframe>
  <script type="module">
    console.log("[viewer] boot");
    const WS_URL = location.origin.replace(/^http/, "ws");
    console.log("[viewer] connecting to WebSocket:", WS_URL);
    
    const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
    console.log("[viewer] created RTCPeerConnection");
    
    pc.ondatachannel = ev => {
      console.log("[viewer] data channel received");
      ev.channel.onmessage = ({data}) => {
        console.log("[viewer] data channel message received");
        const {kind,payload} = JSON.parse(data);
        if(kind==="html") {
          console.log("[viewer] received HTML content");
          document.getElementById("view").srcdoc = payload;
        }
      };
    };
    
    const ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log("[viewer] WebSocket connected, joining as client");
      ws.send(JSON.stringify({type:"join",role:"client"}));
    };
    
    ws.onmessage = async ({data}) => {
      const m = JSON.parse(data);
      console.log("[viewer] WebSocket message received:", m.type);
      
      if(m.type==="offer"){
        console.log("[viewer] processing offer");
        await pc.setRemoteDescription(m.offer);
        console.log("[viewer] creating answer");
        const ans = await pc.createAnswer();
        console.log("[viewer] setting local description");
        await pc.setLocalDescription(ans);
        console.log("[viewer] sending answer");
        ws.send(JSON.stringify({type:"answer",answer:ans}));
      } else if(m.type==="ice"){
        console.log("[viewer] adding ICE candidate");
        await pc.addIceCandidate(m.candidate);
      }
    };
    
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log("[viewer] ICE candidate generated");
        ws.send(JSON.stringify({type:"ice",candidate:e.candidate}));
      }
    };
    
    pc.onconnectionstatechange = () => {
      console.log("[viewer] connection state:", pc.connectionState);
    };
  </script>
</body></html>`;

/* ------------------------------------------------------------------ */
/*  Bun server (HTTP + WebSocket)                                      */
/* ------------------------------------------------------------------ */
Bun.serve<Meta>({
  port: Number(process.env.PORT) || 5050,

  fetch(req, srv) {
    console.log(`HTTP request: ${req.method} ${req.url}`);
    /* upgrade → WS ; otherwise serve viewer page */
    if (srv.upgrade(req)) {
      console.log(`WebSocket upgrade for ${req.url}`);
      return;
    }
    console.log(`Serving viewer HTML to ${req.headers.get("user-agent")}`);
    return new Response(viewerHTML, { headers: { "content-type": "text/html" }});
  },

  websocket: {
    open(ws) {
      console.log(`WebSocket connection opened, waiting for join message`);
    },

    /* the very first message must be {type:"join", role:"host"|"client"} */
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const msg  = JSON.parse(text);
      console.log(`WebSocket message received: ${msg.type}`);

      /* ------------ handshake ----------------------------------------- */
      if (msg.type === "join") {
        ws.data = { role: msg.role as Role };
        console.log(`Client joined as: ${msg.role}`);
        
        if (msg.role === "host") {
          host = ws;
          console.log(`Host connected, ${toHost.length} queued messages`);
          /* flush anything the phone sent early */
          toHost.forEach(p => ws.send(p));
          toHost = [];
        } else {
          client = ws;
          console.log(`Client connected, ${toClient.length} queued messages`);
          /* flush anything the desktop sent early */
          toClient.forEach(p => ws.send(p));
          toClient = [];
        }
        return;
      }

      /* ------------ proxy / queue ------------------------------------- */
      if (ws.data?.role === "host") {
        console.log(`Forwarding message from host to client: ${msg.type}`);
        if (client) {
          console.log(`Client connected, sending directly`);
          client.send(text);
        } else {
          console.log(`Client not connected, queueing message`);
          toClient.push(text);
        }
      } else { /* sender is client */
        console.log(`Forwarding message from client to host: ${msg.type}`);
        if (host) {
          console.log(`Host connected, sending directly`);
          host.send(text);
        } else {
          console.log(`Host not connected, queueing message`);
          toHost.push(text);
        }
      }
    },

    close(ws) {
      if (ws === host) {
        console.log(`Host disconnected`);
        host = undefined;
      }
      if (ws === client) {
        console.log(`Client disconnected`);
        client = undefined;
      }
    },
  },
});

console.log("🛰️  relay & viewer listening on :", process.env.PORT || 5050);
