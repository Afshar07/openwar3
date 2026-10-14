import { installEntries, readZipIndex, ZipCursor, type InstallEntry } from "../../electron/zip.mjs";
import { readInstallDir, type DirHandle, type PickedInstall } from "./opfs";

// "Download game files" (src/ui/gate.ts): the player's own install, zipped and kept somewhere they
// can reach from a new machine — a Google Drive share, typically — streamed down and unpacked
// where the game can read it.
//
// The LINK ships with the game (GAME_FILES_LINK below): "Download game files" on the load gate
// (src/ui/gate.ts) takes the player straight down it — no field to fill, the press IS the start —
// and what this player typed last time, if anything, wins over the shipped one.
//
// Two homes for the result. The DESKTOP app unpacks into a real folder the shell then remembers
// (electron/download.mjs) — a downloaded install is an install. A BROWSER has no folder to write
// to, so it unpacks into OPFS, the origin's private disk, and boots from there on every visit
// after; that is this file. Both read the archive through electron/zip.mjs.

/** The link the field starts with, in every build. A developer's `.env.local` used to be the
 *  only home for it (`VITE_GAME_FILES_URL`, read behind `import.meta.env.DEV`); it is the
 *  player's door now, so it ships. */
const GAME_FILES_LINK =
  "https://drive.google.com/file/d/1hcH5hqQInvvqcGKxe9lj9N9qzCz2EekG/view?usp=sharing";
const LINK_KEY = "ow3.gameFilesLink";

/** What the link the download starts from: the last one this player used, else the shipped one. */
export function rememberedLink(): string {
  try {
    return localStorage.getItem(LINK_KEY) ?? GAME_FILES_LINK;
  } catch {
    return GAME_FILES_LINK;
  }
}

/**
 * The URL that hands over the BYTES behind what the player pasted.
 *
 * A Drive share link (`drive.google.com/file/d/<id>/view`) is a web page about the file, not the
 * file. `drive.usercontent.google.com/download?…&confirm=t` is the file itself: `confirm=t`
 * steps past the "too large to scan for viruses" page Drive puts in front of anything over
 * ~100 MB, and that host answers cross-origin (`Access-Control-Allow-Origin: *`) and honours
 * `Range` — the two things the browser half needs. Any other http(s) link is taken as already
 * pointing at a .zip.
 */
export function downloadUrl(link: string): string | null {
  const s = link.trim();
  const drive =
    /drive\.google\.com\/file\/d\/([\w-]{10,})/.exec(s) ??
    /drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/.exec(s) ??
    /drive\.usercontent\.google\.com\/(?:download|uc)\?(?:.*&)?id=([\w-]{10,})/.exec(s);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t`;
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/**
 * Whether this page is served by a host that has the Drive relay (tools/vite-plugin-drive-proxy.ts
 * — the dev server and `vite preview`). Asked once: the route answers 400 to a malformed id
 * WITHOUT touching Drive, so a probe costs no upstream request, and a static host answers 404
 * (or its SPA fallback's 200).
 */
let relay: boolean | null = null;
async function driveRelay(): Promise<boolean> {
  if (relay === null) {
    try {
      relay = (await fetch("/dev-drive?id=x", { method: "HEAD" })).status === 400;
    } catch {
      relay = false;
    }
  }
  return relay;
}

/**
 * Where the PAGE fetches `url` from. Drive answers a page's own request 403 whatever its CORS
 * headers say (it refuses `Sec-Fetch-Site: cross-site`, which no script can remove), so a Drive
 * file has to go through the relay above and is out of reach of a hosted build altogether —
 * where the desktop app, whose shell fetches it, is the answer. Any other host is fetched
 * directly and has to allow it.
 */
async function pageUrl(url: string): Promise<string> {
  const id = /^https:\/\/drive\.usercontent\.google\.com\/download\?id=([\w-]+)/.exec(url)?.[1];
  if (!id) return url;
  if (await driveRelay()) return `/dev-drive?id=${id}`;
  throw new Error("Google Drive does not let a web page download its files. Use the desktop app, or a direct link to the .zip.");
}

export interface DownloadProgress {
  /** 0..1 of the archive's bytes, or null before its size is known. */
  fraction: number | null;
  received: number;
  total: number;
}

/** The OPFS folder the install is unpacked into, and the file written LAST that says it is whole.
 *  A download that died halfway leaves no marker and is wiped by the next attempt. */
const STORE_DIR = "Warcraft III";
const COMPLETE = ".ow3-download.json";

/** Which entries the browser keeps. It never runs the game's executables, so of the archive's
 *  ~470 entries it wants the content store, the maps, the version file and the player's hotkeys
 *  — what `readInstallDir` reads, and nothing it would only have to skip. */
const wanted = (path: string): boolean => {
  const p = path.toLowerCase();
  return p === ".build.info" || p === "customkeys.txt" || p === "customkeybindings/customkeys.txt" ||
    p.startsWith("data/") || /^[^/]+\.mpq$/.test(p) || (p.startsWith("maps/") && /\.(w3m|w3x)$/.test(p));
};

async function rangeReader(url: string, signal?: AbortSignal): Promise<{ size: number; read: (a: number, b: number) => Promise<Uint8Array> }> {
  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    if (res.status !== 206) throw new Error(notAZip(res));
    return new Uint8Array(await res.arrayBuffer());
  };
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
  const size = Number(/\/(\d+)$/.exec(probe.headers.get("content-range") ?? "")?.[1]);
  await probe.body?.cancel();
  if (probe.status !== 206 || !size) throw new Error(notAZip(probe));
  return { size, read };
}

/** Why a link did not hand over an archive, in the terms the player can act on. Drive answers a
 *  file that is not shared publicly with its sign-in PAGE, which is the usual case. */
function notAZip(res: Response): string {
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    return "That link opened a web page instead of the file. Make sure it is shared with \"Anyone with the link\".";
  }
  if (!res.ok) return `The download failed (${res.status}).`;
  return "That server does not allow resumable downloads, which this needs.";
}

/** A ReadableStream as the async iterable ZipCursor walks — written out, since a stream's own
 *  `Symbol.asyncIterator` is newer than some of the Chromiums this runs in. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fileAt(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir.getFileHandle(parts[parts.length - 1], { create: true });
}

/** One entry's bytes, from the cursor into OPFS. Deflate is the browser's own
 *  (`DecompressionStream("deflate-raw")`), so no zip library ships for a button most players
 *  never press. */
async function unpack(cursor: ZipCursor, entry: InstallEntry, file: FileSystemFileHandle): Promise<void> {
  const out = await file.createWritable();
  if (entry.method === 0) {
    for await (const piece of cursor.take(entry.compressedSize)) await out.write(piece as Uint8Array<ArrayBuffer>);
    await out.close();
  } else if (entry.method === 8) {
    const inflate = new DecompressionStream("deflate-raw");
    const piped = inflate.readable.pipeTo(out);
    const w = inflate.writable.getWriter();
    for await (const piece of cursor.take(entry.compressedSize)) await w.write(piece as Uint8Array<ArrayBuffer>);
    await w.close();
    await piped;
  } else {
    await out.abort();
    throw new Error(`${entry.path} is packed with a method this cannot unpack (${entry.method}).`);
  }
  if ((await file.getFile()).size !== entry.uncompressedSize) throw new Error(`${entry.path} did not unpack whole.`);
}

/**
 * Download the archive behind `link` and unpack the install out of it into OPFS. Replaces any
 * earlier copy, whole or partial. Resolves once the copy is whole; `storedInstall()` then reads
 * it. `signal` is the load gate's Cancel (src/ui/gate.ts): an abort stops the stream and wipes
 * what has been unpacked so far — a cancelled download leaves nothing behind.
 */
export async function downloadInstall(link: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const direct = downloadUrl(link);
  if (!direct) throw new Error("That is not a link.");
  const url = await pageUrl(direct);
  if (!navigator.storage?.getDirectory) throw new Error("This browser cannot store the game files. Try Chrome or Edge.");

  const { size, read } = await rangeReader(url, signal);
  const entries = installEntries(await readZipIndex(read, size)).filter((e) => wanted(e.path));
  const need = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  const { usage, quota } = (await navigator.storage.estimate?.()) ?? {};
  if (quota && need > quota - (usage ?? 0)) {
    throw new Error(`Not enough browser storage: the game files need ${gb(need)} and ${gb(quota - (usage ?? 0))} is free.`);
  }

  const opfs = await navigator.storage.getDirectory();
  await opfs.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
  const root = await opfs.getDirectoryHandle(STORE_DIR, { create: true });

  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(notAZip(res));
    const cursor = new ZipCursor(chunksOf(res.body));
    onProgress({ fraction: 0, received: 0, total: size });
    // On a clock rather than per network chunk, which arrive by the thousand.
    const timer = setInterval(() => onProgress({ fraction: cursor.pos / size, received: cursor.pos, total: size }), 250);
    try {
      for (const entry of entries) {
        await cursor.enter(entry);
        await unpack(cursor, entry, await fileAt(root, entry.path));
      }
    } finally {
      clearInterval(timer);
      await cursor.close().catch(() => {});
      await res.body.cancel().catch(() => {});
    }
    const marker = await (await root.getFileHandle(COMPLETE, { create: true })).createWritable();
    await marker.write(JSON.stringify({ from: link, at: new Date().toISOString(), files: entries.length }));
    await marker.close();
    onProgress({ fraction: 1, received: size, total: size });
  } catch (err) {
    // Cancelled: take the half-unpacked copy with you. A download that died any other way keeps
    // its partial for the next attempt to wipe (which this function also does, above).
    if (signal?.aborted) await opfs.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
    throw err;
  }
}

/** The install a previous "Download game files" left in OPFS, or null if there is none (or only
 *  a partial one). */
export async function storedInstall(): Promise<PickedInstall | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(STORE_DIR);
    await root.getFileHandle(COMPLETE);
    return readInstallDir(root as unknown as DirHandle);
  } catch {
    return null;
  }
}

/** Throw away the stored copy — a downloaded install the game then refuses (the wrong build)
 *  would otherwise be mounted again at every visit. */
export async function forgetStoredInstall(): Promise<void> {
  await (await navigator.storage?.getDirectory?.())?.removeEntry(STORE_DIR, { recursive: true }).catch(() => {});
}

export const gb = (bytes: number): string =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
