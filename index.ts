import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import QRCode from "qrcode-svg";

// --- Constants ---
const VIEWER_URL = "https://next-go-production.up.railway.app"; // URL the QR code points to
const WS_URL = "wss://next-go-production.up.railway.app";      // URL of your signaling server
const HTML_URL = "/dummy.html"; // Path to the HTML file to send

const STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];
const RETRY_DELAY_MS = 4000;
const MAX_HTML_RETRIES = 3;

// --- Types ---
type ClientStage =
    | "connecting" | "ws-connected" | "pc-created" | "offered"
    | "pc-connected" | "data-open" | "sending-html" | "html-acked"
    | "failed" | "closed";

interface ClientState {
    id: string;
    stage: ClientStage;
    pcState: RTCPeerConnectionState;
    iceState: RTCIceConnectionState;
    sigState: RTCSignalingState;
    htmlSendRetries: number;
    // We store PC/DC in a Ref, not directly in state
    retryTimeoutId?: ReturnType<typeof setTimeout>;
}

// --- Component ---
export default function ShareOverlay() {
    const [clients, setClients] = useState<Record<string, ClientState>>({});
    // Use Refs for non-serializable objects or things that shouldn't trigger re-renders on change
    const peerConnections = useRef<Map<string, { pc: RTCPeerConnection, dc: RTCDataChannel }>>(new Map());
    const htmlCache = useRef<string | null>(null);

    // --- State Update Helpers (Memoized) ---
    const patchClient = useCallback((id: string, patch: Partial<Omit<ClientState, 'id'>>) => {
        setClients(prevClients => {
            const current = prevClients[id];
            if (!current) return prevClients; // Ignore if client left
            // Only update if values actually changed to prevent unnecessary renders
            const newState = { ...current, ...patch };
            for(const key in patch) {
                if (newState[key] !== current[key]) {
                    return { ...prevClients, [id]: newState }; // Update if any patched value changed
                }
            }
            return prevClients; // No change detected in patched fields
        });
    }, []); // No dependencies, safe to memoize

    const removeClient = useCallback((id: string) => {
        console.log(`[${id}] Removing client and closing connections.`);
        const connection = peerConnections.current.get(id);
        if (connection) {
            // Clear any pending retry timeouts first
             setClients(prev => {
                 if (prev[id]?.retryTimeoutId) {
                     clearTimeout(prev[id].retryTimeoutId);
                     console.log(`[${id}] Cleared pending retry timeout during removal.`);
                 }
                 // Return previous state as we only want the side effect of clearing timeout
                 return prev;
             })

            connection.dc?.close();
            connection.pc?.close();
            peerConnections.current.delete(id);
        }
        setClients(prevClients => {
            const { [id]: _, ...rest } = prevClients;
            return rest;
        });
    }, []); // No dependencies, safe to memoize

    // --- QR Code Generation (Memoized) ---
    const qrSvg = useMemo(() => {
        console.log('[Host] Generating QR Code for:', VIEWER_URL);
        return new QRCode({
            content: VIEWER_URL, padding: 1, join: true, container: "svg",
            width: 128, height: 128, color: "#FFFFFF", background: "#00000000"
        }).svg();
    }, []);

    // --- HTML Fetching & Caching ---
    const fetchAndCacheHtml = useCallback(async (): Promise<string> => {
        if (htmlCache.current) return htmlCache.current;
        try {
            console.log('[Host] Fetching HTML from:', HTML_URL);
            const response = await fetch(HTML_URL);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const html = await response.text();
            htmlCache.current = html; // Cache it
            console.log('[Host] HTML fetched and cached.');
            return html;
        } catch (error) {
            console.error('[Host] Failed to fetch HTML:', error);
            return `<html><body><h1>Error loading content</h1><p>${error.message}</p></body></html>`;
        }
    }, []);

    // Pre-fetch HTML on component mount
    useEffect(() => {
        fetchAndCacheHtml();
    }, [fetchAndCacheHtml]);

    // --- Send HTML Logic (Memoized) ---
    const sendHtmlToClient = useCallback(async (clientId: string) => {
        console.log(`[${clientId}] Preparing to send HTML.`);
        const connection = peerConnections.current.get(clientId);
        // Need latest state for retry count and stage check
        let currentRetryCount = 0;
        let currentStage : ClientStage | undefined = undefined;
        setClients(prev => {
             currentRetryCount = prev[clientId]?.htmlSendRetries ?? 0;
             currentStage = prev[clientId]?.stage;
             return prev; // No state change here, just reading
        });


        if (!connection || !connection.dc) {
            console.error(`[${clientId}] No data channel found for sending HTML.`);
            patchClient(clientId, { stage: "failed" }); return;
        }
        const { dc } = connection;

        if (dc.readyState !== 'open') {
            console.warn(`[${clientId}] Data channel not open (state=${dc.readyState}). Cannot send HTML yet.`);
            return;
        }
        if (currentStage === 'html-acked') {
             console.log(`[${clientId}] HTML already acknowledged. Skipping send.`); return;
        }
        if (currentRetryCount >= MAX_HTML_RETRIES) {
            console.error(`[${clientId}] Max HTML send retries (${MAX_HTML_RETRIES}) reached.`);
            patchClient(clientId, { stage: "failed" }); return;
        }

        // Update stage and increment retry count *before* sending
        patchClient(clientId, { stage: "sending-html", htmlSendRetries: currentRetryCount + 1 });

        const htmlContent = htmlCache.current ?? await fetchAndCacheHtml();
        const payload = JSON.stringify({ kind: "html", payload: htmlContent });

        try {
            console.log(`[${clientId}] Sending HTML via DataChannel (attempt ${currentRetryCount + 1}).`);
            dc.send(payload);

             // Clear previous timeout using setClients to access the latest state
             let existingTimeoutId: ReturnType<typeof setTimeout> | undefined;
             setClients(prev => {
                 existingTimeoutId = prev[clientId]?.retryTimeoutId;
                 return prev;
             });
             if (existingTimeoutId) {
                  clearTimeout(existingTimeoutId);
             }


            // Set a *new* timeout to check for ACK
            const timeoutId = setTimeout(() => {
                // Check stage again *inside* the timeout callback using setClients
                let stageToCheck : ClientStage | undefined;
                 setClients(currentClients => {
                    stageToCheck = currentClients[clientId]?.stage;
                    return currentClients; // No state change needed here
                });

                 if (stageToCheck && stageToCheck !== 'html-acked') {
                     console.warn(`[${clientId}] HTML ACK not received within ${RETRY_DELAY_MS}ms. Retrying...`);
                     sendHtmlToClient(clientId); // Retry (will increment count again)
                 } else {
                      // console.log(`[${clientId}] ACK received or client gone before timeout fired.`);
                 }

            }, RETRY_DELAY_MS);

            // Store the new timeout ID
            patchClient(clientId, { retryTimeoutId: timeoutId });

        } catch (error) {
            console.error(`[${clientId}] Error sending HTML via DataChannel:`, error);
             patchClient(clientId, { stage: "failed" });
              // Also clear timeout on error
             setClients(prev => {
                 if (prev[clientId]?.retryTimeoutId) clearTimeout(prev[clientId].retryTimeoutId);
                 return { ...prev, [clientId]: { ...(prev[clientId]!), retryTimeoutId: undefined } };
             });
        }
    }, [fetchAndCacheHtml, patchClient]); // Dependencies

    // --- Main Effect for WebSocket and Peer Connection Setup ---
    useEffect(() => {
        console.log('[Host] Initializing WebSocket connection...');
        // Create WebSocket instance directly scoped to this effect
        const ws = new WebSocket(WS_URL);
        let wsOpened = false; // Track if connection succeeded initially

        // --- PeerConnection Creation Function (scoped to useEffect) ---
        async function createPeerConnection(clientId: string) {
             console.log(`[${clientId}] Creating RTCPeerConnection...`);
            // Clean up any previous connection for this ID just in case
             if (peerConnections.current.has(clientId)) {
                 console.warn(`[${clientId}] Existing PeerConnection found. Cleaning up before creating new one.`);
                 removeClient(clientId); // Use the callback to ensure proper cleanup
             }

             try {
                 const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
                 const dc = pc.createDataChannel("data"); // Create data channel immediately
                 console.log(`[${clientId}] PC and DC created.`);

                 // Store refs
                 peerConnections.current.set(clientId, { pc, dc });
                 // Update initial state
                  patchClient(clientId, {
                     stage: "pc-created", pcState: pc.connectionState,
                     iceState: pc.iceConnectionState, sigState: pc.signalingState
                 });


                 // --- Data Channel Handlers ---
                 dc.onopen = () => {
                     console.log(`[${clientId}][DC] Opened.`);
                     patchClient(clientId, { stage: "data-open", htmlSendRetries: 0 }); // Reset retries
                     setClients(prev => { // Clear any lingering timeout
                        if(prev[clientId]?.retryTimeoutId) clearTimeout(prev[clientId].retryTimeoutId);
                        return { ...prev, [clientId]: { ...(prev[clientId]!), retryTimeoutId: undefined } };
                     });
                     sendHtmlToClient(clientId); // Send HTML now
                 };
                 dc.onclose = () => {
                     console.log(`[${clientId}][DC] Closed.`);
                     patchClient(clientId, { stage: "closed" });
                 };
                 dc.onerror = (error) => {
                     console.error(`[${clientId}][DC] Error:`, error);
                     patchClient(clientId, { stage: "failed" });
                 };
                 dc.onmessage = (event) => { // Listen for ACK
                     try {
                         const msg = JSON.parse(event.data);
                         if (msg.type === 'html-ack') {
                             console.log(`[${clientId}][DC] Received html-ack.`);
                             // Clear pending retry timeout and update stage
                             setClients(prev => {
                                 const client = prev[clientId];
                                 if (client?.retryTimeoutId) clearTimeout(client.retryTimeoutId);
                                 return { ...prev, [clientId]: { ...client, stage: 'html-acked', retryTimeoutId: undefined } };
                             });
                         } else {
                              console.warn(`[${clientId}][DC] Received unknown msg type:`, msg.type);
                         }
                     } catch (e) { console.error(`[${clientId}][DC] Failed to parse message:`, e); }
                 };

                 // --- Peer Connection Handlers ---
                 pc.onicecandidate = (event) => {
                     if (event.candidate && ws?.readyState === WebSocket.OPEN) {
                         ws.send(JSON.stringify({ type: "ice", id: clientId, candidate: event.candidate }));
                     }
                 };
                  pc.onicecandidateerror = (event) => console.error(`[${clientId}][PC] ICE Error:`, event.errorCode, event.errorText);
                 pc.onconnectionstatechange = () => {
                      console.log(`[${clientId}][PC] State: ${pc.connectionState}`);
                      patchClient(clientId, { pcState: pc.connectionState });
                     switch (pc.connectionState) {
                         case "connected": patchClient(clientId, { stage: "pc-connected" }); break;
                         case "failed": patchClient(clientId, { stage: "failed" }); pc.restartIce(); break; // Attempt restart
                         case "closed": patchClient(clientId, { stage: "closed" }); removeClient(clientId); break;
                         case "disconnected": patchClient(clientId, { stage: "connecting" }); break; // May recover
                     }
                 };
                 pc.oniceconnectionstatechange = () => patchClient(clientId, { iceState: pc.iceConnectionState });
                 pc.onsignalingstatechange = () => patchClient(clientId, { sigState: pc.signalingState });

                 // --- Create and Send Offer ---
                 console.log(`[${clientId}] Creating offer...`);
                 const offer = await pc.createOffer();
                 await pc.setLocalDescription(offer);
                  patchClient(clientId, { sigState: pc.signalingState });
                 console.log(`[${clientId}] Offer created and set. Sending via WS...`);
                 if (ws?.readyState === WebSocket.OPEN) {
                     ws.send(JSON.stringify({ type: "offer", id: clientId, offer: pc.localDescription }));
                     patchClient(clientId, { stage: "offered" });
                 } else {
                     console.error(`[${clientId}] WS closed before offer could be sent.`);
                      patchClient(clientId, { stage: "failed" });
                      removeClient(clientId); // Clean up unusable PC
                 }

             } catch (error) {
                 console.error(`[${clientId}] Failed to create PeerConnection:`, error);
                 patchClient(clientId, { stage: "failed" });
                 removeClient(clientId); // Clean up any partial state
             }
         } // --- End of createPeerConnection ---


        // --- WebSocket Event Handlers ---
        ws.onopen = () => {
            wsOpened = true;
            console.log('[Host][WS] Connection established. Sending join message...');
            ws.send(JSON.stringify({ type: "join", role: "host" }));
        };

        ws.onmessage = async (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data as string);
                 // console.log('[Host][WS] Received:', msg.type, 'for ID:', msg.id);
            } catch (e) { console.error('[Host][WS] Failed to parse message:', e); return; }

            const clientId = msg.id;
            if (!clientId) { console.warn('[Host][WS] Ignoring message without client ID', msg); return; }

             const connection = peerConnections.current.get(clientId); // Get existing PC ref if available

            switch (msg.type) {
                case "client-join":
                     console.log(`[${clientId}][WS] client-join received.`);
                     patchClient(clientId, { // Set initial state for UI
                         id: clientId, stage: "ws-connected", pcState: "new",
                         iceState: "new", sigState: "stable", htmlSendRetries: 0,
                     });
                     await createPeerConnection(clientId); // Start WebRTC setup
                    break;
                case "answer":
                    if (connection?.pc) {
                         console.log(`[${clientId}][WS] answer received. Setting remote description.`);
                         try {
                             await connection.pc.setRemoteDescription(msg.answer); // Note: Constructor might not be needed if object is correct
                              patchClient(clientId, { sigState: connection.pc.signalingState });
                         } catch (e) { console.error(`[${clientId}] Failed to set remote answer:`, e); patchClient(clientId, {stage: 'failed'}); }
                    } else { console.warn(`[${clientId}][WS] answer received but no PC found.`); }
                    break;
                case "ice":
                     if (connection?.pc && msg.candidate) {
                         try {
                            await connection.pc.addIceCandidate(msg.candidate);
                         } catch (e) { if (e.name !== 'OperationError' && !e.message.includes("SyntaxError")) console.warn(`[${clientId}] Failed to add ICE:`, e.name); }
                     }
                    break;
                case "client-leave":
                     console.log(`[${clientId}][WS] client-leave received.`);
                     removeClient(clientId);
                    break;
                default:
                    console.log(`[${clientId}][WS] Received unhandled type: ${msg.type}`);
            }
        };

        ws.onerror = (event) => {
            console.error('[Host][WS] WebSocket error:', event);
            // Consider updating UI or attempting reconnect here if needed
        };

        ws.onclose = (event) => {
            console.log(`[Host][WS] WebSocket closed. Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}, Opened: ${wsOpened}`);
            if (!wsOpened && event.code === 1006) {
                 console.error("[Host][WS] CONNECTION FAILED (1006). Check Server/URL/Network/TLS.");
                 // Maybe set a global error state for the UI
            }
             // Clean up all clients when WebSocket closes unexpectedly? Or allow them to persist for reconnect?
             // For simplicity now, we don't clear clients here, only on explicit leave or component unmount.
        };

        // --- Effect Cleanup ---
        return () => {
            console.log('[Host] Cleaning up: Closing WebSocket and all PeerConnections...');
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                 ws.close(1000, "Host component unmounting");
            }
            // Close all active peer connections and clear timeouts
            peerConnections.current.forEach((conn, id) => {
                console.log(`[${id}] Closing connections during cleanup.`);
                // Clear timeout using setClients state access
                setClients(prev => {
                     if (prev[id]?.retryTimeoutId) clearTimeout(prev[id].retryTimeoutId);
                     return prev; // No state change needed
                 });
                conn.dc?.close();
                conn.pc?.close();
            });
            peerConnections.current.clear(); // Clear the ref map
            setClients({}); // Clear UI state
            console.log('[Host] Cleanup complete.');
        };
    // }, []); // <-- Original empty array caused issues with callbacks using stale state
    // Depend on memoized callbacks to ensure they have access to latest state/refs if needed
    }, [patchClient, removeClient, sendHtmlToClient]);

    // --- Render UI ---
    return (
        <div style={{ width: "100%", height: "100%", position: "relative", background: "#333" }}>
            {/* Local Preview Iframe */}
            <iframe src={HTML_URL} style={{ width: "100%", height: "100%", border: "none", display: "block" }} title="Local HTML Preview" />
            {/* QR Code Overlay */}
            <div style={{ position: "absolute", bottom: "20px", left: "50%", transform: "translateX(-50%)", background: "rgba(0, 0, 0, 0.7)", padding: "10px", borderRadius: "8px", border: "1px solid #555" }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
            {/* Client Status Roster */}
            <div style={{ position: "absolute", top: "10px", right: "10px", width: "350px", maxHeight: "80vh", overflowY: "auto", backgroundColor: "rgba(31, 41, 55, 0.85)", backdropFilter: "blur(3px)", color: "white", padding: "12px", borderRadius: "12px", fontSize: "12px", border: "1px solid rgba(255, 255, 255, 0.2)", fontFamily: "monospace" }}>
                <div style={{ fontWeight: "bold", marginBottom: "8px", borderBottom: "1px solid #555", paddingBottom: "4px" }}>Clients ({Object.keys(clients).length})</div>
                {Object.keys(clients).length === 0 && <div style={{ fontStyle: "italic", color: "#aaa" }}>Scan QR code...</div>}
                {Object.values(clients).map(({ id, stage, pcState, iceState, sigState, htmlSendRetries }) => (
                    <div key={id} style={{ display: "grid", gridTemplateColumns: "4.5rem 7rem 5.5rem 5.5rem 4rem", gap: "6px", padding: "4px 2px", borderBottom: "1px dashed #444", opacity: (stage === 'closed' || stage === 'failed') ? 0.5 : 1 }} title={`ID: ${id}\nStage: ${stage}\nPC State: ${pcState}\nICE State: ${iceState}\nSig State: ${sigState}\nRetries: ${htmlSendRetries -1}`}> {/* Show 0-based retries */}
                        <span style={{ fontWeight: "bold", color: "#90ee90" }}>{id}</span>
                        <span style={{ color: stage === 'html-acked' ? '#0f0' : (stage === 'failed' ? '#f00' : '#ffcc66') }}>{stage}</span>
                        <span style={{ fontStyle: "italic", color: pcState === 'connected' ? '#7f7' : (pcState === 'failed' ? '#f77' : '#ccc') }}>{pcState}</span>
                        <span style={{ fontStyle: "italic", color: '#aaa' }}>{iceState}</span>
                        <span style={{ fontStyle: "italic", color: '#aaa' }}>{(stage === 'sending-html' || stage === 'html-acked') ? `Try:${htmlSendRetries}` : '-'}</span> {/* Show retry attempt# */}
                    </div>
                ))}
            </div>
        </div>
    );
}