// bun run relay-server.ts      (Railway sets PORT env var)
import { nanoid } from "nanoid";
import type { ServerWebSocket } from "bun";

/* ───────── Types & In‑memory State ───────── */

type Role = "host" | "client";
interface WebSocketMeta { role?: Role; id?: string } // Metadata attached to WebSocket connection

// Store the single host connection
let host: ServerWebSocket<WebSocketMeta> | undefined;
// Store multiple client connections, keyed by their unique ID
const clients = new Map<string, ServerWebSocket<WebSocketMeta>>();

/* Message buffers for when the target is temporarily disconnected */
const messagesForHost: string[] = []; // Queue messages intended for the host
const messagesForClient: Record<string, string[]> = {}; // Queues messages for specific clients

// Simple logging helper
const log = (id: string | "server", msg: string, ...args: any[]) =>
    console.log(`[${id}] ${msg}`, ...args);

/* ───────── Viewer Page (Served over HTTPS) ───────── */

const viewerHTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Live Viewer</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Basic styling for viewer */
    html, body { margin: 0; height: 100%; background: #111; color: #eee; font-family: monospace; overflow: hidden; }
    #view { width: 100%; height: 100%; border: none; display: block; background-color: #222; }
    #hud  { position: fixed; top: 8px; left: 8px; background: #000c; padding: 6px 10px;
            border-radius: 6px; font-size: 12px; line-height: 1.4; max-width: 85vw; z-index: 10;
            border: 1px solid #333; }
    #log  { position: fixed; bottom: 0; left: 0; right: 0; max-height: 40vh; overflow-y: auto;
            background: #000c; margin: 0; padding: 8px 10px; font-size: 11px; line-height: 1.4; z-index: 10;
            border-top: 1px solid #333; }
    #log::before { content: "Event Log:"; display: block; font-weight: bold; margin-bottom: 4px; color: #0f0; }
  </style>
</head>
<body>
  <iframe id="view" sandbox="allow-scripts allow-same-origin"></iframe>
  <div id="hud">Initializing...</div>
  <pre id="log"></pre>

  <script type="module">
    const hud = document.getElementById('hud');
    const logBox = document.getElementById('log');
    const viewFrame = document.getElementById('view');

    // --- Logging ---
    const log = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' ');
      const timestamp = new Date().toLocaleTimeString();
      logBox.textContent += \`[\${timestamp}] \${message}\n\`;
      logBox.scrollTop = logBox.scrollHeight; // Auto-scroll
      console.log('[Client]', ...args);
    };
    const step = (status) => {
      hud.textContent = status;
      log('[Status]', status);
    };

    // --- Configuration ---
    const WS_URL = location.origin.replace(/^http/, 'ws'); // Dynamically determine WebSocket URL
    const STUN_SERVERS = [ // Use multiple STUN servers for better reliability
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ];

    // --- State ---
    let ws; // WebSocket connection
    let pc; // RTCPeerConnection
    let dc; // RTCDataChannel
    let myId = null; // Unique ID assigned by the server

    // --- WebSocket Handling ---
    function connectWebSocket() {
      step('Connecting WebSocket...');
      log('[WS] Attempting connection to:', WS_URL);
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        log('[WS] Connection opened');
        step('WebSocket connected. Joining as client...');
        // Identify role to the server
        ws.send(JSON.stringify({ type: 'join', role: 'client' }));
      };

      ws.onmessage = async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
          log('[WS] Received:', msg.type, msg);
        } catch (e) {
          log('[WS] Error parsing message:', e, event.data);
          return;
        }

        switch (msg.type) {
          case 'client-id':
            myId = msg.id;
            step(\`Registered with ID: \${myId}\`);
            log('[WS] Received client ID:', myId);
            // Now that we have an ID, set up the peer connection
            initializePeerConnection();
            break;

          case 'offer':
            if (!pc) {
              log('[Error] Offer received but PeerConnection not ready!');
              return;
            }
            if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') {
                 log('[Warn] Received offer in unexpected state:', pc.signalingState);
                 // Potentially reset connection or handle gracefully
            }
            step('Offer received, processing...');
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
              log('[PC] Remote description (offer) set');
              step('Creating answer...');
              const answer = await pc.createAnswer();
              log('[PC] Answer created');
              await pc.setLocalDescription(answer);
              log('[PC] Local description (answer) set');
              step('Answer created, sending...');
              ws.send(JSON.stringify({ type: 'answer', id: myId, answer: pc.localDescription }));
              log('[WS] Sent answer');
              step('Answer sent');
            } catch (e) {
              log('[PC] Error processing offer/answer:', e);
              step('Error processing offer');
              // Consider sending an error back to the host
            }
            break;

          case 'ice':
            if (!pc) {
              log('[Error] ICE candidate received but PeerConnection not ready!');
              return;
            }
            if (msg.candidate) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                // log('[PC] Added ICE candidate:', msg.candidate);
              } catch (e) {
                 // Often ignorable, especially late candidates or minor format issues
                 if (e.name !== 'OperationError' && !e.message.includes("SyntaxError")) { // Filter common non-fatal errors
                      log('[PC] Error adding ICE candidate:', e.name, e.message, msg.candidate);
                 }
              }
            } else {
                 log('[PC] Received null ICE candidate (end of candidates signal)');
            }
            break;

          default:
            log('[WS] Received unknown message type:', msg.type);
        }
      };

      ws.onerror = (event) => {
        log('[WS] WebSocket error:', event);
        step('WebSocket error!');
      };

      ws.onclose = (event) => {
        log('[WS] WebSocket closed:', event.code, event.reason, 'Clean:', event.wasClean);
        step(\`WebSocket closed (\${event.code})\`);
        // Optional: Implement reconnection logic here
        pc?.close(); // Close peer connection if WebSocket drops
        pc = null;
        dc = null;
      };
    }

    // --- WebRTC PeerConnection Handling ---
    function initializePeerConnection() {
      if (pc) {
        log('[PC] PeerConnection already exists. Closing previous.');
        pc.close();
      }
      log('[PC] Initializing PeerConnection...');
      step('Initializing WebRTC...');
      try {
          pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
          log('[PC] PeerConnection created.');

          // Log state changes for debugging
          pc.onconnectionstatechange = () => {
              log('[PC] Connection State:', pc.connectionState);
              step(\`WebRTC state: \${pc.connectionState}\`);
              if (pc.connectionState === 'failed') {
                 log('[PC] Connection failed. Restarting ICE...');
                 pc.restartIce(); // Attempt to recover
              }
          };
          pc.oniceconnectionstatechange = () => log('[PC] ICE Connection State:', pc.iceConnectionState);
          pc.onicegatheringstatechange = () => log('[PC] ICE Gathering State:', pc.iceGatheringState);
          pc.onsignalingstatechange = () => log('[PC] Signaling State:', pc.signalingState);
          pc.onnegotiationneeded = () => log('[PC] Negotiation needed'); // Should typically be handled by offerer

          // Handle incoming ICE candidates: send them to the host via WebSocket
          pc.onicecandidate = (event) => {
            if (event.candidate && myId && ws && ws.readyState === WebSocket.OPEN) {
              // log('[PC] Sending ICE candidate:', event.candidate);
              ws.send(JSON.stringify({ type: 'ice', id: myId, candidate: event.candidate }));
            } else if (!event.candidate) {
                log('[PC] ICE gathering complete.');
            }
          };

           pc.onicecandidateerror = (event) => {
                 log('[PC] ICE Candidate Error:', event.errorCode, event.errorText);
           }

          // Handle the data channel being created by the host
          pc.ondatachannel = (event) => {
            log('[PC] DataChannel received:', event.channel.label);
            dc = event.channel;
            setupDataChannelHandlers();
          };

      } catch (e) {
          log('[PC] Error creating PeerConnection:', e);
          step('Error creating WebRTC connection');
      }
    }

    // --- WebRTC DataChannel Handling ---
    function setupDataChannelHandlers() {
      if (!dc) return;
      log('[DC] Setting up DataChannel handlers');

      dc.onopen = () => {
        log('[DC] DataChannel opened');
        step('Data channel open - ready for HTML');
        // **REMOVED**: No longer sending 'data-open' via WebSocket
      };

      dc.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
          log('[DC] Received:', msg.kind);

          if (msg.kind === 'html') {
            step('HTML received, rendering...');
            viewFrame.srcdoc = msg.payload; // Render HTML in the iframe
            step('HTML applied ✔');
            // **CHANGED**: Send acknowledgment back via the DataChannel
            if (dc.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'html-ack' }));
              log('[DC] Sent html-ack');
            } else {
              log('[DC] Cannot send html-ack, channel state:', dc.readyState);
            }
             // **REMOVED**: No longer sending 'html-ack' via WebSocket
          } else {
              log('[DC] Received unknown message kind:', msg.kind);
          }
        } catch (e) {
          log('[DC] Error processing message:', e, event.data);
          step('Error processing received data');
        }
      };

      dc.onerror = (error) => {
        log('[DC] DataChannel error:', error);
        step('Data channel error');
      };

      dc.onclose = () => {
        log('[DC] DataChannel closed');
        step('Data channel closed');
        dc = null; // Clear reference
      };
    }

    // --- Start the process ---
    connectWebSocket();

  </script>
</body>
</html>
`;

/* ───────── Bun Server (HTTP + WebSocket) ───────── */

const PORT = process.env.PORT || 5050;

Bun.serve<WebSocketMeta>({
    port: Number(PORT),

    /* Handle HTTP requests -> Serve the viewer HTML */
    fetch(req, server) {
        // Upgrade to WebSocket if requested
        if (server.upgrade(req)) {
            return; // Bun handles the response for upgrades
        }
        // Otherwise, serve the HTML page
        log('server', `HTTP request from ${req.headers.get('x-forwarded-for') || req.remoteAddress}`);
        return new Response(viewerHTML, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    },

    /* Handle WebSocket connections */
    websocket: {
        /* Handle incoming messages */
        message(ws: ServerWebSocket<WebSocketMeta>, messageData) {
            const messageText = messageData instanceof Buffer ? messageData.toString() : typeof messageData === 'string' ? messageData : '';
            let msg;
            try {
                msg = JSON.parse(messageText);
            } catch (e) {
                log(ws.data.id ?? 'unknown', 'Received invalid JSON', messageText);
                return;
            }

            /* --- Join Handshake --- */
            if (msg.type === "join") {
                if (msg.role === "host") {
                    if (host && host !== ws) {
                        log('server', 'New host connected, disconnecting previous host.');
                        host.close(1000, "New host connected"); // Close old host connection
                    }
                    host = ws;
                    ws.data = { role: "host" }; // Assign role to connection metadata
                    log("host", "WebSocket connected");
                    // Send any buffered messages to the newly connected host
                    const buffered = messagesForHost.splice(0); // Atomically get and clear buffer
                    if (buffered.length > 0) {
                         log("host", `Sending ${buffered.length} buffered message(s)`);
                         buffered.forEach(payload => host!.send(payload));
                    }
                } else if (msg.role === "client") {
                    const clientId = nanoid(6); // Generate unique ID for the client
                    ws.data = { role: "client", id: clientId }; // Assign role and ID
                    clients.set(clientId, ws); // Store client connection

                    // Send the client its unique ID
                    ws.send(JSON.stringify({ type: "client-id", id: clientId }));

                    // Notify the host about the new client
                    const joinNotice = JSON.stringify({ type: "client-join", id: clientId });
                    if (host && host.readyState === WebSocket.OPEN) {
                        host.send(joinNotice);
                    } else {
                        messagesForHost.push(joinNotice); // Buffer if host is offline
                    }
                    log(clientId, "WebSocket connected");

                    // Send any buffered messages for this specific client
                     const clientBuffer = messagesForClient[clientId] ?? [];
                     messagesForClient[clientId] = []; // Clear buffer
                     if (clientBuffer.length > 0) {
                         log(clientId, `Sending ${clientBuffer.length} buffered message(s)`);
                         clientBuffer.forEach(payload => ws.send(payload));
                     }

                } else {
                    log(ws.data.id ?? 'unknown', 'Invalid role specified in join message:', msg.role);
                    ws.close(1008, "Invalid role");
                }
                return; // Join message processed
            }

            /* --- Message Relaying --- */
            const senderRole = ws.data.role;
            const senderId = ws.data.id; // Will be undefined for host

            if (senderRole === "host") {
                // Message FROM host TO a specific client
                const targetClientId = msg.id;
                if (!targetClientId) {
                     log('host', 'Received message without target client ID', msg);
                     return;
                }
                const targetClient = clients.get(targetClientId);
                log('host', `Relaying '${msg.type}' to client ${targetClientId}`);
                if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                    targetClient.send(messageText); // Forward directly
                } else {
                    // Buffer message if client is offline or not found yet
                    log('host', `Client ${targetClientId} offline, buffering message`);
                    if (!messagesForClient[targetClientId]) {
                        messagesForClient[targetClientId] = [];
                    }
                    messagesForClient[targetClientId].push(messageText);
                }
            } else if (senderRole === "client" && senderId) {
                // Message FROM a client TO the host
                msg.id = senderId; // Add/overwrite client ID for host context
                const payloadWithId = JSON.stringify(msg);
                log(senderId, `Relaying '${msg.type}' to host`);
                if (host && host.readyState === WebSocket.OPEN) {
                    host.send(payloadWithId); // Forward directly
                } else {
                    // Buffer message if host is offline
                    log(senderId, 'Host offline, buffering message');
                    messagesForHost.push(payloadWithId);
                }
            } else {
                 log(senderId ?? 'unknown', 'Received message from socket with unknown/missing role');
            }
        },

        /* Handle WebSocket closing */
        close(ws: ServerWebSocket<WebSocketMeta>, code, reason) {
            const role = ws.data.role;
            const id = ws.data.id;

            if (role === "host") {
                log("host", `WebSocket closed (${code})`);
                if (host === ws) { // Ensure it's the current host being closed
                    host = undefined;
                }
            } else if (role === "client" && id) {
                log(id, `WebSocket closed (${code})`);
                clients.delete(id); // Remove from active clients
                delete messagesForClient[id]; // Clear any pending message buffer for this client

                // Notify the host that the client left
                const leaveNotice = JSON.stringify({ type: "client-leave", id });
                if (host && host.readyState === WebSocket.OPEN) {
                    host.send(leaveNotice);
                } else {
                    messagesForHost.push(leaveNotice); // Buffer if host is offline
                }
            } else {
                 log('unknown', `WebSocket closed (${code}) for socket without role/id`);
            }
        },

        /* Handle WebSocket errors */
        error(ws: ServerWebSocket<WebSocketMeta>, error) {
             log(ws.data.id ?? (ws.data.role === 'host' ? 'host' : 'unknown'), 'WebSocket error:', error);
        }
    },
});

log('server', `Relay & Viewer server running on http://localhost:${PORT}`);