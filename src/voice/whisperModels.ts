// The two Whisper models Voice Control offers, and the messages between the page and the
// recogniser's worker (src/voice/whisperWorker.ts). Shared, so both ends agree on one shape.
//
// Options → Gameplay → "Voice Control" → the dropdown beside it: FAST is Whisper base.en (the
// default — real-time on a weak CPU) and ACCURATE is small.en (about three times the work, a
// clearly lower error rate). Both English-only, both the hub's int8-quantized ONNX files
// (`onnx-community/whisper-*.en`, MIT, the format transformers.js runs), measured off the hub:
// base.en's encoder 23.2 MB + merged decoder 53.7 MB, small.en's 92.3 MB + 156.8 MB — plus a few
// MB of tokenizer and configs each.

export type WhisperModelId = "base" | "small";

export const WHISPER_MODELS: Record<WhisperModelId, { repo: string; bytes: number; label: string }> = {
  base: { repo: "onnx-community/whisper-base.en", bytes: 80_000_000, label: "Fast" },
  small: { repo: "onnx-community/whisper-small.en", bytes: 252_000_000, label: "Accurate" },
};

/** The ONNX files a model is loaded from (`dtype: "q8"` names them `*_quantized.onnx`) — what
 *  "is it installed?" looks for in the browser's cache. */
export function whisperFiles(id: WhisperModelId): string[] {
  const base = `https://huggingface.co/${WHISPER_MODELS[id].repo}/resolve/main/`;
  return [`${base}onnx/encoder_model_quantized.onnx`, `${base}onnx/decoder_model_merged_quantized.onnx`];
}

export type WhisperRequest =
  | { type: "load"; model: WhisperModelId }
  | { type: "transcribe"; id: number; model: WhisperModelId; audio: Float32Array; prompt: string };

export type WhisperReply =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; model: WhisperModelId }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id?: number; error: string };
