import type { ServerWebSocket } from "bun";

type Role   = "host" | "client";
type Meta   = { session?: string; role?: Role };
type Bucket = { host?: ServerWebSocket<Meta>; client?: ServerWebSocket<Meta> };

const SESS = "global-share";                    // <─ fixed id
const buckets = new Map<string, Bucket>();
const PORT = 8080;

Bun.serve<Meta>({
  port: PORT,
  fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("ws only", {status:400}); },
  websocket: {
    message(ws, raw) {
      const msg = JSON.parse(raw.toString());

      /* first packet = {type:"join", role:"host"|"client"}  */
      if (msg.type === "join") {
        const role = msg.role as Role;
        ws.data = { session: SESS, role };
        (buckets.get(SESS) ?? (buckets.set(SESS, {}), buckets.get(SESS)!))[role] = ws;
        return;
      }
      /* forward every other packet to the opposite peer */
      const role = ws.data?.role as Role;
      const peer =
        role === "host" ? buckets.get(SESS)?.client : buckets.get(SESS)?.host;
      peer?.send(raw);
    },
    close(ws) {
      const role = ws.data?.role as Role;
      const bucket = buckets.get(SESS);
      if (!bucket) return;
      delete bucket[role];
    },
  },
});
console.log(`📡  signaling on ws://0.0.0.0:${PORT}`);
