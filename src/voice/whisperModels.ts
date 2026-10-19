// The Whisper model Voice Control listens with, and the messages between the page and the
// recogniser's worker (src/voice/whisperWorker.ts). Shared, so both ends agree on one shape.
//
// Whisper small.en: English-only, the hub's int8-quantized ONNX files (`onnx-community/
// whisper-small.en`, MIT, the format transformers.js runs) — encoder 92.3 MB + merged decoder
// 156.8 MB, plus a few MB of tokenizer and configs, measured off the hub.
//
// There used to be a second, "Fast" base.en (~80 MB) beside it on a Fast/Accurate pulldown. It
// was taken out: on the developer's machine it answered no quicker than small.en and was the
// worse listener, so the pulldown bought nothing a player could feel. Its cached files are
// deleted on boot with anything else that is not this model (model.ts `forgetOldVoiceModels`).

export const WHISPER_MODEL = { repo: "onnx-community/whisper-small.en", bytes: 252_000_000 };

/** The ONNX files the model is loaded from (`dtype: "q8"` names them `*_quantized.onnx`) — what
 *  "is it installed?" looks for in the browser's cache. */
export function whisperFiles(): string[] {
  const base = `https://huggingface.co/${WHISPER_MODEL.repo}/resolve/main/`;
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
