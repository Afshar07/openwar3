// "Download game files" in the DESKTOP app (src/ui/gate.ts): the player's own zipped install,
// streamed from a link they gave and unpacked into a real folder, which is then remembered exactly
// as a picked one is. The archive is read by electron/zip.mjs, the same reader the browser's half
// uses (src/assets/downloadInstall.ts) — the page resolves the link, so a Drive share URL has
// one meaning in both.
//
// The WHOLE folder is unpacked, executables and all, where the browser keeps only what the game
// reads: this is a copy of the player's install on their own disk, and a copy missing half its
// files is not one they can point anything else at.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { safeJoin } from "./install.mjs";
import { installEntries, readZipIndex, ZipCursor } from "./zip.mjs";

async function rangeReader(url, signal) {
  const read = async (start, end) => {
    const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` }, signal });
    if (res.status !== 206) throw new Error(notAZip(res));
    return new Uint8Array(await res.arrayBuffer());
  };
  const probe = await fetch(url, { headers: { range: "bytes=0-0" }, signal });
  const size = Number(/\/(\d+)$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
  await probe.body?.cancel();
  if (probe.status !== 206 || !size) throw new Error(notAZip(probe));
  return { size, read };
}

/** The same wording the browser's half uses (src/assets/downloadInstall.ts `notAZip`). */
function notAZip(res) {
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return "That link opened a web page instead of the file. Make sure it is shared with \"Anyone with the link\".";
  }
  if (!res.ok) return `The download failed (${res.status}).`;
  return "That server does not allow resumable downloads, which this needs.";
}

/**
 * Download the archive at `url` and unpack the install into `<parent>/<name>`, where `name` is the
 * folder the archive itself wraps the install in ("Warcraft III"), else "Warcraft III". Unpacks
 * into a `.download` sibling first and renames it into place only when whole, so a download that
 * dies — or is cancelled through `signal`, the load gate's Cancel — leaves no folder that looks
 * like an install. Resolves to the finished folder.
 */
export async function downloadInstall(url, parent, onProgress, signal) {
  if (typeof fetch !== "function") throw new Error("This build of the app cannot download. Use a newer one.");
  if (!/^https?:\/\//i.test(url)) throw new Error("That is not a link.");

  const { size, read } = await rangeReader(url, signal);
  const all = await readZipIndex(read, size);
  const entries = installEntries(all);
  const wrapper = /^([^/]+)\/\.build\.info$/i.exec(all.find((e) => /(^|\/)\.build\.info$/i.test(e.name))?.name ?? "")?.[1];
  const target = join(parent, wrapper ?? "Warcraft III");
  if (existsSync(target)) throw new Error(`There is already a folder at ${target}. Choose another place, or pick that folder with Load Game Files.`);
  const staging = `${target}.download`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(notAZip(res));
    const cursor = new ZipCursor(res.body);
    onProgress({ fraction: 0, received: 0, total: size });
    const timer = setInterval(() => onProgress({ fraction: cursor.pos / size, received: cursor.pos, total: size }), 250);
    try {
      for (const entry of entries) {
        const full = safeJoin(staging, entry.path);
        if (!full) continue;
        await cursor.enter(entry);
        await mkdir(dirname(full), { recursive: true });
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.path} is packed with a method this cannot unpack (${entry.method}).`);
        await pipeline(
          Readable.from(cursor.take(entry.compressedSize)),
          entry.method === 8 ? createInflateRaw() : new PassThrough(),
          createWriteStream(full),
        );
        if ((await stat(full)).size !== entry.uncompressedSize) throw new Error(`${entry.path} did not unpack whole.`);
      }
    } finally {
      clearInterval(timer);
      await cursor.close().catch(() => {});
    }
    await rename(staging, target);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  onProgress({ fraction: 1, received: size, total: size });
  return target;
}
