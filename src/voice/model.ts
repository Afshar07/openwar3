import { WHISPER_MODELS, whisperFiles, type WhisperModelId, type WhisperReply, type WhisperRequest } from "./whisperModels";

// Voice Control's speech recogniser: OpenAI's Whisper, English-only, run on this computer in a
// worker (src/voice/whisperWorker.ts, transformers.js over onnxruntime-web's WebAssembly build).
//
// It replaced Vosk's small model, which was chosen for the slow PC and paid for it in accuracy:
// it misheard "altar" as "alter" and "finish" as "fish", and a grammar can only narrow what it
// guesses between, not make it hear better. Whisper is a far better listener of English, and it
// is PRIMED rather than constrained — the names on the card and the map go in as a prompt
// (`transcribe`), so "Blademaster" is the likely spelling without "fish" being forbidden. What
// it hears is then free text, which the parser reads with a tolerance for near misses
// (parser.ts `Lexicon.match`).
//
// Two sizes, the player's pick (Options → Gameplay, the dropdown beside the checkbox):
// FAST = base.en (the default, ~80 MB) and ACCURATE = small.en (~250 MB) — `WHISPER_MODELS`.
// Each is downloaded once, from the Hugging Face hub (the one host the files are published on,
// with the CORS header a page needs), into the browser's own Cache Storage, where transformers.js
// looks before it ever goes to the network again. Nothing else leaves the machine: the audio of
// a command goes to a worker on this page.

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
let onWorkerMessage: ((m: WhisperReply) => void) | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./whisperWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WhisperReply>) => {
    const m = e.data;
    if (m.type === "result") {
      waiting.get(m.id)?.resolve(m.text);
      waiting.delete(m.id);
    } else if (m.type === "error" && m.id !== undefined) {
      waiting.get(m.id)?.reject(new Error(m.error));
      waiting.delete(m.id);
    }
    onWorkerMessage?.(m);
  };
  return worker;
}

/** Stop the worker — a cancelled download is abandoned with it (a file only lands in the cache
 *  once it is whole, so nothing half-written is kept). */
function killWorker(): void {
  worker?.terminate();
  worker = null;
  loadedModel = null;
  for (const w of waiting.values()) w.reject(new Error("cancelled"));
  waiting.clear();
}

const send = (m: WhisperRequest, transfer: Transferable[] = []): void => getWorker().postMessage(m, transfer);

// ---- what is on this machine -------------------------------------------------------------------

/** Each model, once asked about: is it in the browser's cache? */
const installed = new Map<WhisperModelId, boolean>();
const listeners = new Set<(installed: boolean) => void>();

/** Whether `id`'s files are all in the cache transformers.js reads from. */
async function inCache(id: WhisperModelId): Promise<boolean> {
  try {
    const cache = await caches.open("transformers-cache");
    for (const url of whisperFiles(id)) if (!(await cache.match(url))) return false;
    return true;
  } catch {
    return false; // no Cache Storage (a locked-down private window): nowhere to keep a model
  }
}

/** Whether a model is on this machine — `id`, or with no `id` EITHER of them (which is what
 *  decides the Options row's face: the download button, or the checkbox and its dropdown). */
export async function voiceModelInstalled(id?: WhisperModelId): Promise<boolean> {
  for (const m of id ? [id] : (Object.keys(WHISPER_MODELS) as WhisperModelId[])) {
    if (!installed.has(m)) installed.set(m, await inCache(m));
    if (installed.get(m)) return true;
  }
  return false;
}

/** The last answer for `id` (or for either), without asking again; null = not asked yet. */
export function voiceModelInstalledNow(id?: WhisperModelId): boolean | null {
  if (id) return installed.has(id) ? installed.get(id)! : null;
  const answers = [...installed.values()];
  if (answers.some(Boolean)) return true;
  return answers.length === Object.keys(WHISPER_MODELS).length ? false : null;
}

/** Be told when a model arrives (the Options row swaps its button for the checkbox). */
export function onVoiceModelInstalled(fn: (installed: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface VoiceInstallProgress {
  /** 0…1 across the whole model. */
  fraction: number;
  received: number;
  total: number;
}

/**
 * Download `id` with a progress bar and load it, ready to listen. Rejects on a network failure
 * or when `signal` aborts (Cancel), which stops the worker and with it the download.
 */
export async function installVoiceModel(id: WhisperModelId, onProgress: (p: VoiceInstallProgress) => void, signal: AbortSignal): Promise<void> {
  const total0 = WHISPER_MODELS[id].bytes;
  onProgress({ fraction: 0, received: 0, total: total0 });
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      killWorker();
      reject(new DOMException("cancelled", "AbortError"));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    onWorkerMessage = (m) => {
      if (m.type === "progress") {
        onProgress({ fraction: Math.min(0.99, m.loaded / m.total), received: m.loaded, total: m.total });
      } else if (m.type === "ready" && m.model === id) {
        signal.removeEventListener("abort", onAbort);
        onWorkerMessage = null;
        loadedModel = id;
        resolve();
      } else if (m.type === "error" && m.id === undefined) {
        signal.removeEventListener("abort", onAbort);
        onWorkerMessage = null;
        reject(new Error(m.error));
      }
    };
    send({ type: "load", model: id });
  });
  installed.set(id, true);
  onProgress({ fraction: 1, received: total0, total: total0 });
  for (const fn of listeners) fn(true);
}

// ---- listening ---------------------------------------------------------------------------------

let loadedModel: WhisperModelId | null = null;

/** Load `id` into the worker ahead of the first press (a cold load is seconds). */
export function preloadVoiceModel(id: WhisperModelId): void {
  if (loadedModel === id) return;
  loadedModel = id;
  send({ type: "load", model: id });
}

/** Whisper's own sample rate: every model in the family hears 16 kHz mono. */
export const WHISPER_RATE = 16_000;

/** What was said, as text. `audio` is 16 kHz mono; `prompt` primes the spelling of names. */
export function transcribe(id: WhisperModelId, audio: Float32Array, prompt: string): Promise<string> {
  const reqId = nextId++;
  loadedModel = id;
  return new Promise((resolve, reject) => {
    waiting.set(reqId, { resolve, reject });
    send({ type: "transcribe", id: reqId, model: id, audio, prompt }, [audio.buffer]);
  });
}

/**
 * The Vosk model the first Voice Control downloaded into IndexedDB (`/vosk`, ~70 MB unpacked) is
 * nothing to anyone now: dropped once, quietly, so a player who had it gets the space back.
 */
export function forgetOldVoskModel(): void {
  try {
    indexedDB.deleteDatabase("/vosk");
  } catch {
    /* no IndexedDB — nothing to forget */
  }
}
