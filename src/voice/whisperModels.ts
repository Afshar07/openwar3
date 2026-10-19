// The Whisper model Voice Control listens with, and the messages between the page and the
// recogniser's worker (src/voice/whisperWorker.ts). Shared, so both ends agree on one shape.
//
// Whisper base.en: English-only, the hub's int8-quantized ONNX files (`onnx-community/
// whisper-base.en`, MIT, the format transformers.js runs) — encoder 23.2 MB + merged decoder
// 53.7 MB, plus a few MB of tokenizer and configs, measured off the hub.
//
// There used to be a second, "Accurate" small.en (~250 MB) beside it on a Fast/Accurate pulldown.
// It was taken out: on the developer's machine it answered no faster than base.en's "Fast" was
// supposed to and the pulldown bought nothing a player could feel, while it tripled the download.
// Its cached files are deleted on boot (`DROPPED_MODEL_REPOS`, model.ts `forgetOldVoiceModels`).

export const WHISPER_MODEL = { repo: "onnx-community/whisper-base.en", bytes: 80_000_000 };

/** Models an earlier build downloaded and this one no longer uses. */
export const DROPPED_MODEL_REPOS = ["onnx-community/whisper-small.en"];

/** The ONNX files the model is loaded from (`dtype: "q8"` names them `*_quantized.onnx`) — what
 *  "is it installed?" looks for in the browser's cache. */
export function whisperFiles(repo: string = WHISPER_MODEL.repo): string[] {
  const base = `https://huggingface.co/${repo}/resolve/main/`;
  return [`${base}onnx/encoder_model_quantized.onnx`, `${base}onnx/decoder_model_merged_quantized.onnx`];
}

export type WhisperRequest =
  | { type: "load" }
  | { type: "transcribe"; id: number; audio: Float32Array; prompt: string };

export type WhisperReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id?: number; error: string };
