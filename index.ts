// bun run signaling-server.ts
import type { ServerWebSocket } from "bun";

type Role   = "host" | "client";
type Meta   = { session?: string; role?: Role };
type Bucket = { host?: ServerWebSocket<Meta>; client?: ServerWebSocket<Meta> };

const sessions = new Map<string, Bucket>();
const PORT = 8080;                                   // fixed

Bun.serve<Meta>({
  port: PORT,

  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("upgrade required", { status: 400 });
  },

  websocket: {
    close(ws) {
      const { session, role } = ws.data ?? {};
      if (!session || !role) return;
      const b = sessions.get(session);
      if (!b) return;
      delete b[role];
      if (!b.host && !b.client) sessions.delete(session);
    },

    message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString()); }
      catch { return; }

      /* first packet must be {type:"join", session, role} */
      if (msg.type === "join") {
        const { session, role } = msg as { session: string; role: Role };
        ws.data = { session, role };
        (sessions.get(session) ?? (sessions.set(session, {}), sessions.get(session)!))[role] = ws;
        return;
      }

      /* proxy all other payloads */
      const meta = ws.data;
      if (!meta?.session || !meta.role) return;
      const bucket = sessions.get(meta.session);
      const target = meta.role === "host" ? bucket?.client : bucket?.host;
      target?.send(raw);
    },
  },
});

console.log(`📡  Signaling ready → ws://0.0.0.0:${PORT}`);
