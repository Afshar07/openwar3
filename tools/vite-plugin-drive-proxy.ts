import { Readable } from "node:stream";
import type { Plugin } from "vite";

/**
 * Dev-only: let the BROWSER half of "Download game files" (src/assets/downloadInstall.ts) reach a
 * Google Drive file.
 *
 * Drive serves the file with `Access-Control-Allow-Origin: *` and still refuses a page: any
 * request carrying `Sec-Fetch-Site: cross-site` is answered 403 with no CORS headers, which the
 * page sees as "Failed to fetch". That header is set by the browser and no script can take it
 * off, so from a page Drive is simply unreachable. The desktop app's main process sends no such
 * header and fetches it directly (electron/download.mjs); this route gives the dev server the
 * same reach, so the developer can use — and test — the browser half at localhost.
 *
 * `apply: "serve"`, like devInstall: a build has no such route, so a hosted OpenWar3 never relays
 * anybody's game files (CLAUDE.md, legal boundary). And it is NOT an open proxy — the upstream is
 * fixed to Drive's download host, and the only thing the page chooses is the file id.
 *
 *   GET /dev-drive?id=<file id>   → the file's bytes, honouring `Range`
 */
export function driveProxy(): Plugin {
  return {
    name: "openwar3-drive-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev-drive", (req, res) => {
        const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
        if (!/^[\w-]{10,}$/.test(id)) {
          res.statusCode = 400;
          res.end("bad id");
          return;
        }
        const upstream = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
        const range = req.headers.range;
        const abort = new AbortController();
        // The page drops the connection once it has what it wants (ZipCursor.close); pass that on.
        res.on("close", () => abort.abort());
        void fetch(upstream, { headers: range ? { range } : {}, signal: abort.signal })
          .then((up) => {
            res.statusCode = up.status;
            for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
              const v = up.headers.get(h);
              if (v) res.setHeader(h, v);
            }
            if (!up.body) return res.end();
            Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
          })
          .catch(() => {
            if (!res.headersSent) res.statusCode = 502;
            res.end();
          });
      });
    },
  };
}
