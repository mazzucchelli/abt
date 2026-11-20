import { createConnection, createServer, type Server } from "node:net";
import { rmSync } from "node:fs";

/** What the server answers to a nudge: `ok` if some project owns the ticket, `unknown` if none does. */
export type NudgeHandler = (ticket: string) => Promise<boolean>;

/** Listens on a local unix socket for `nudge <ticket>` lines. No network, no tunnel. */
export function listenForNudges(path: string, handle: NudgeHandler): Promise<Server> {
  rmSync(path, { force: true });
  const server = createServer((conn) => {
    let buf = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^nudge (\S+)$/.exec(line);
        if (!m) {
          conn.write("error: expected `nudge <ticket>`\n");
          continue;
        }
        handle(m[1]!).then(
          (known) => conn.write(known ? "ok\n" : "unknown\n"),
          () => conn.write("error\n"),
        );
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

/** The primary agent's side: tells the runner a ticket needs a pass. Returns the runner's answer. */
export function sendNudge(path: string, ticket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path);
    let buf = "";
    conn.on("connect", () => conn.write(`nudge ${ticket}\n`));
    conn.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        conn.end();
        resolve(buf.trim());
      }
    });
    conn.on("error", reject);
  });
}
