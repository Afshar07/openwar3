/// <reference lib="webworker" />
import { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, env } from "@huggingface/transformers";
import type { PreTrainedTokenizer, Processor } from "@huggingface/transformers";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { WHISPER_MODELS, type WhisperModelId, type WhisperRequest, type WhisperReply } from "./whisperModels";

// Voice Control's recogniser: Whisper, run in a WORKER so a second of transcription never stalls
// a frame of the match (src/voice/model.ts talks to it).
//
// The runtime is onnxruntime-web's WebAssembly build, SHIPPED WITH THE GAME (the `?url` imports
// above, fetched only the first time Voice Control is used) — transformers.js would otherwise
// fetch it from a CDN, and the only thing this feature downloads is the model itself. CPU
// (`wasm`) everywhere: it is the device every machine the game runs on has, and the quantized
// (int8) files are the ones it is fast on.

env.allowLocalModels = false; // models come from the hub (and then the browser's cache), never from our server
env.useBrowserCache = true; // the Cache Storage `transformers-cache` — the download happens ONCE
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { wasm: ortWasm, mjs: ortMjs };
  // Threads need a cross-origin-ISOLATED page (SharedArrayBuffer); the game serves the two
  // headers that make it one (vite.config.ts, electron/main.mjs). Up to eight — the encoder's
  // matrix work stops scaling past that — and one where the page is not isolated.
  onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
}

interface Loaded {
  id: WhisperModelId;
  model: WhisperForConditionalGeneration;
  processor: Processor;
  tokenizer: PreTrainedTokenizer;
}

let loaded: Promise<Loaded> | null = null;
let loadedId: WhisperModelId | null = null;

const post = (m: WhisperReply): void => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

function load(id: WhisperModelId): Promise<Loaded> {
  if (loaded && loadedId === id) return loaded;
  loadedId = id;
  const repo = WHISPER_MODELS[id].repo;
  // Every file's bytes, summed, so the dialog's bar is one bar over the whole model.
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }): void => {
    if (p.status !== "progress" || !p.file) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let got = 0;
    let all = 0;
    for (const f of files.values()) { got += f.loaded; all += f.total; }
    post({ type: "progress", loaded: got, total: Math.max(all, WHISPER_MODELS[id].bytes) });
  };
  loaded = (async () => {
    const [model, processor, tokenizer] = await Promise.all([
      WhisperForConditionalGeneration.from_pretrained(repo, {
        dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        device: "wasm",
        progress_callback,
      }) as Promise<WhisperForConditionalGeneration>,
      AutoProcessor.from_pretrained(repo, { progress_callback }),
      AutoTokenizer.from_pretrained(repo, { progress_callback }),
    ]);
    return { id, model, processor, tokenizer };
  })();
  loaded.catch(() => { loaded = null; loadedId = null; });
  return loaded;
}

/**
 * Transcribe 16 kHz mono samples. `prompt` PRIMES the decoder the way Whisper's own
 * `initial_prompt` does: the words go in after `<|startofprev|>`, as if they had been said just
 * before, which makes the names in them the likely spellings ("Blademaster", "Altar of Kings",
 * "Storm Bolt"). transformers.js does not wire `prompt_ids` through `generate`, so the decoder's
 * opening tokens are written out here — the model's own default start ([start of transcript,
 * no timestamps]) with the prompt in front of it — and the prompt is cut off the answer again.
 */
async function transcribe(id: WhisperModelId, audio: Float32Array, prompt: string): Promise<string> {
  const { model, processor, tokenizer } = await load(id);
  const inputs = await processor(audio);
  const gen = model.generation_config as unknown as {
    decoder_start_token_id: number;
    no_timestamps_token_id: number;
    prev_sot_token_id?: number;
  };
  const start = [gen.decoder_start_token_id, gen.no_timestamps_token_id];
  let init = start;
  if (prompt && gen.prev_sot_token_id) {
    // Whisper takes at most half its 448-token context as a prompt; names are short, so this is
    // a ceiling and not a budget.
    const ids = tokenizer.encode(` ${prompt}`, { add_special_tokens: false }).slice(-180);
    init = [gen.prev_sot_token_id, ...ids, ...start];
  }
  const out = (await model.generate({
    ...inputs,
    decoder_input_ids: init,
    max_new_tokens: 64,
  } as Parameters<typeof model.generate>[0])) as unknown as { tolist(): number[][] };
  const seq = out.tolist()[0].map(Number).slice(init.length);
  return tokenizer.decode(seq, { skip_special_tokens: true }).trim();
}

self.onmessage = async (e: MessageEvent<WhisperRequest>) => {
  const m = e.data;
  try {
    if (m.type === "load") {
      await load(m.model);
      post({ type: "ready", model: m.model });
    } else if (m.type === "transcribe") {
      const text = await transcribe(m.model, m.audio, m.prompt);
      post({ type: "result", id: m.id, text });
    }
  } catch (err) {
    post({ type: "error", id: m.type === "transcribe" ? m.id : undefined, error: err instanceof Error ? err.message : String(err) });
  }
};
