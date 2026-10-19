// Voice Control's one dependency: the SPEECH MODEL, fetched once and kept on this machine.
//
// Nothing in Warcraft III listens, so everything in src/voice/ is OURS. The choice of recogniser
// is the one decision here that the rest of the feature leans on, and it was made for the slow
// PC rather than for the fast one:
//
//   · **Vosk** (Kaldi, compiled to WebAssembly — the `vosk-browser` package, Apache-2.0) with its
//     SMALL English model (`vosk-model-small-en-us-0.15`, Apache-2.0, 41 MB packed). Kaldi's
//     small models run in real time on a Raspberry Pi; on a desktop the recogniser is a few per
//     cent of one core while the key is held and nothing at all while it is not.
//   · It takes a GRAMMAR — the list of words it may hear — and that is what makes it the right
//     engine for a game rather than for dictation: told that it is listening for "footman",
//     "attack", "three" and a few hundred other words, it cannot hear "foot man" or "football".
//     The grammar is rebuilt from the game's own tables (src/voice/vocabulary.ts), so it speaks
//     whatever the race, the map and the selection put on the card.
//   · Whisper was the obvious alternative and is the wrong one here: its smallest model is 75 MB,
//     it transcribes free text (and so invents words the game then has to un-invent), and in
//     WebAssembly on a weak CPU it takes SECONDS per utterance. An LLM to map text onto commands
//     is the same trade again. The mapping is deterministic instead (src/voice/parser.ts) — a
//     closed vocabulary does not need a model to understand it.
//
// Nothing leaves the machine. The model is downloaded once, from the vosk-browser project's own
// published copy (the one host that serves it with the CORS header a browser tab needs), and the
// microphone is only ever read while the push-to-talk key is held; the audio goes into a worker
// on this page and nowhere else.
//
// WHERE IT IS KEPT. vosk-browser keeps a model in Emscripten's IDBFS — an IndexedDB database named
// after its mount point (`/vosk`), one row per file, keyed by path — under a folder named after
// the model URL, and it skips the download when it finds `extracted.ok` there and the network
// fetch when it finds `downloaded.ok`. Its own fetch reports no progress, and a 41 MB download
// with no bar is a game that looks frozen, so we fetch the archive OURSELVES (with a bar), write
// it into that database exactly where its own download would have put it, and let it unpack from
// there. The row shape is IDBFS's (`{ timestamp, mode, contents }`, store `FILE_DATA`, version
// 21) — pinned with the package version in package.json.

/** The model archive. Its STRING is also the cache key (see `MODEL_DIR`), so it is never built. */
export const MODEL_URL = "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz";

/** The packed size, for the dialog to name before a byte is fetched (and for the bar, when a
 *  server sends no Content-Length). Measured off the file: 41 184 862 bytes. */
export const MODEL_BYTES = 41_184_862;

/** IDBFS's own constants (vosk-browser 0.0.8's Emscripten runtime). */
const IDB_NAME = "/vosk";
const IDB_VERSION = 21;
const IDB_STORE = "FILE_DATA";
/** The folder vosk-browser unpacks a model URL into: `/vosk/` + the URL with every non-word
 *  character made `_` (`load` in its worker). */
const MODEL_DIR = `${IDB_NAME}/${MODEL_URL.replace(/[\W]/g, "_")}`;
/** POSIX modes IDBFS stores: a 0755 directory and a 0644 file. */
const MODE_DIR = 0o40755;
const MODE_FILE = 0o100644;

export type VoiceInstallPhase = "download" | "unpack";

export interface VoiceInstallProgress {
  phase: VoiceInstallPhase;
  /** 0…1 across the whole install (the download is most of it). */
  fraction: number;
  received: number;
  total: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    // The same upgrade IDBFS runs, so whichever side opens the database first leaves it in the
    // shape the other expects.
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      const store = db.objectStoreNames.contains(IDB_STORE) ? tx!.objectStore(IDB_STORE) : db.createObjectStore(IDB_STORE);
      if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let installedCache: boolean | null = null;
const listeners = new Set<(installed: boolean) => void>();

/** Whether the model is on this machine, unpacked and ready (`extracted.ok` is in its folder). */
export async function voiceModelInstalled(): Promise<boolean> {
  if (installedCache !== null) return installedCache;
  try {
    const db = await openDb();
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getKey(`${MODEL_DIR}/extracted.ok`);
    const key = await new Promise<IDBValidKey | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    installedCache = key !== undefined;
  } catch {
    installedCache = false; // no IndexedDB (a locked-down private window): nothing to keep it in
  }
  return installedCache;
}

/** The last answer `voiceModelInstalled` gave, without asking again (null = not asked yet). */
export function voiceModelInstalledNow(): boolean | null {
  return installedCache;
}

/** Be told when the model arrives (the Options row swaps its button for the checkbox). */
export function onVoiceModelInstalled(fn: (installed: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setInstalled(v: boolean): void {
  installedCache = v;
  for (const fn of listeners) fn(v);
}

/**
 * Fetch the archive with a progress bar, hand it to the recogniser's own storage and let the
 * recogniser unpack it. Resolves once the model is ready to listen; rejects on a network
 * failure or when `signal` aborts (Cancel), leaving nothing half-written behind.
 */
export async function installVoiceModel(onProgress: (p: VoiceInstallProgress) => void, signal: AbortSignal): Promise<void> {
  // The download is ~90% of the wait and the unpack the rest; the bar spends them in that ratio
  // so it does not sit full while the archive unpacks.
  const DOWNLOAD_SHARE = 0.9;
  const res = await fetch(MODEL_URL, { signal, cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`speech model download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onProgress({ phase: "download", fraction: 0, received, total });
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress({ phase: "download", fraction: DOWNLOAD_SHARE * Math.min(1, received / total), received, total });
  }
  if (signal.aborted) throw new DOMException("cancelled", "AbortError");
  const archive = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    archive.set(c, at);
    at += c.byteLength;
  }
  chunks.length = 0;

  // Write it where vosk-browser's own download would have: the folder, the archive and the
  // marker that says the archive is whole.
  const now = new Date();
  const db = await openDb();
  const tx = db.transaction(IDB_STORE, "readwrite");
  const store = tx.objectStore(IDB_STORE);
  store.put({ timestamp: now, mode: MODE_DIR }, MODEL_DIR);
  store.put({ timestamp: now, mode: MODE_FILE, contents: archive }, `${MODEL_DIR}/downloaded.tar.gz`);
  store.put({ timestamp: now, mode: MODE_FILE, contents: new Uint8Array(0) }, `${MODEL_DIR}/downloaded.ok`);
  await done(tx);
  db.close();

  onProgress({ phase: "unpack", fraction: DOWNLOAD_SHARE, received, total });
  if (signal.aborted) {
    await removeVoiceModel();
    throw new DOMException("cancelled", "AbortError");
  }
  // Loading it IS the unpack: the recogniser finds `downloaded.ok`, extracts, writes
  // `extracted.ok` and drops the archive. Kept loaded — the player who just fetched it is about to
  // tick the box.
  await loadVoiceModel();
  setInstalled(true);
  onProgress({ phase: "unpack", fraction: 1, received, total });
}

/** One file of the UNPACKED model, straight out of the recogniser's storage — the vocabulary
 *  reads the model's own dictionary (`graph/words.txt`) this way. Null when it is not there. */
export async function readModelFile(rel: string): Promise<Uint8Array | null> {
  try {
    const db = await openDb();
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(`${MODEL_DIR}/${rel}`);
    const row = await new Promise<{ contents?: Uint8Array } | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as { contents?: Uint8Array } | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return row?.contents ?? null;
  } catch {
    return null;
  }
}

/** Forget the model (every row under its folder). */
export async function removeVoiceModel(): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(IDBKeyRange.bound(MODEL_DIR, `${MODEL_DIR}￿`));
    await done(tx);
    db.close();
  } catch {
    /* nothing to remove */
  }
  setInstalled(false);
}

// ---- the loaded recogniser ------------------------------------------------------------------

type VoskModule = typeof import("vosk-browser");
export type VoskModel = Awaited<ReturnType<VoskModule["createModel"]>>;

let loading: Promise<VoskModel> | null = null;

/**
 * The recogniser, loaded once. A DYNAMIC import, so a player who never turns Voice Control on
 * never downloads the 6 MB WebAssembly engine either (the Lua front end's rule, src/compat/lua/).
 */
export function loadVoiceModel(): Promise<VoskModel> {
  loading ??= (async () => {
    const vosk = await import("vosk-browser");
    // Log level -1: errors only. Its verbose level prints every audio chunk.
    return vosk.createModel(MODEL_URL, -1);
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}
