import type { Options } from "../data/options";
import { loadVoiceModel, voiceModelInstalled, type VoskModel } from "./model";
import { describe, Lexicon, parse, type LexEntry, type VoiceIntent } from "./parser";
import { grammarFor } from "./vocabulary";

// Voice Control's PUSH-TO-TALK: hold ".", speak, let go (Options → Gameplay → "Voice Control").
//
// The key is "." by `e.code` ("Period"), the key beside voice chat's "/" (game/voice.ts) — the
// two are a pair, one for talking to people and one for talking to the game. It is read only
// while the option is ticked, only in a match, and never while the player is typing.
//
// What happens between the press and the release:
//   1. the microphone is opened (once; it stays open while Voice Control is on, so the second
//      command does not pay the permission round trip) and its samples go into a fresh Vosk
//      recogniser whose GRAMMAR is the words this match can mean right now (vocabulary.ts);
//   2. on release, a short tail is let through (people let go of a key as the last syllable
//      ends), then the recogniser is asked for its final text;
//   3. the text is parsed (parser.ts) and the intents are handed to the match (`VoiceHost`),
//      which carries them out through the same paths a click and a hotkey take.
//
// Nothing is sent anywhere: the samples go to a worker on this page.

/** What the match does for Voice Control (render/mapViewer.ts implements it). */
export interface VoiceHost {
  /** Whether the match is taking commands right now (no menu up, not paused, not a cinematic) —
   *  the HUD's own `acceptsInput` gate. */
  acceptsInput(): boolean;
  /** Every name the player could mean right now: the card, the race's tech tree, what is on
   *  the map. */
  lexicon(): LexEntry[];
  /** Every unit, ability and item NAME in the game — heard even when it is not on this screen,
   *  so the recogniser is not forced to hear it as something that is. Built once per match. */
  vocabulary(): readonly string[];
  /** Carry the intents out. */
  perform(intents: VoiceIntent[], heard: string): void;
  /** Tell the player what is going on (listening, heard nothing, …). null clears it. */
  status(text: string | null): void;
  /** Tell the player something went wrong (no microphone, …). */
  error(text: string): void;
}

/** The push-to-talk key, by position (`e.code`). */
export const VOICE_CONTROL_KEY_CODE = "Period";

/** How long the microphone keeps feeding the recogniser after the key comes up. */
const TAIL_MS = 250;

let enabled = false;
let host: VoiceHost | null = null;

/** Options → Gameplay → "Voice Control", live. */
export function applyVoiceOptions(opts: Options): void {
  const on = opts.voiceControl === true;
  if (on === enabled) return;
  enabled = on;
  if (!on) closeMic();
  else void voiceModelInstalled().then((ok) => { if (ok && enabled) void loadVoiceModel().catch(() => {}); });
}

/** The match registers itself while it is up; null when it ends. */
export function setVoiceHost(h: VoiceHost | null): void {
  host = h;
  if (!h) {
    cancelUtterance();
    closeMic();
  }
}

// ---- the microphone --------------------------------------------------------------------

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let tap: ScriptProcessorNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let opening: Promise<boolean> | null = null;

function openMic(): Promise<boolean> {
  if (stream) return Promise.resolve(true);
  opening ??= (async () => {
    try {
      ctx ??= new AudioContext({ latencyHint: "interactive" });
      if (ctx.state === "suspended") await ctx.resume();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch {
      host?.error("Voice Control: microphone unavailable or permission refused.");
      return false;
    }
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor, as voice chat's tap (audio/voiceChat.ts): the one tap every Chromium the
    // game ships in has, needing no module file.
    tap = ctx.createScriptProcessor(4096, 1, 1);
    tap.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0));
    source.connect(tap);
    tap.connect(ctx.destination); // a ScriptProcessor only runs while it reaches the output
    return true;
  })().finally(() => (opening = null));
  return opening;
}

function closeMic(): void {
  tap?.disconnect();
  source?.disconnect();
  for (const t of stream?.getTracks() ?? []) t.stop();
  void ctx?.close();
  ctx = null;
  stream = null;
  tap = null;
  source = null;
}

// ---- one utterance ---------------------------------------------------------------------

type Recognizer = InstanceType<VoskModel["KaldiRecognizer"]>;

interface Utterance {
  rec: Recognizer | null;
  lexicon: Lexicon;
  /** Audio captured before the recogniser was ready (the first press loads the model). */
  pending: Float32Array[];
  /** Text of every result segment so far — Kaldi ends a segment at a pause, so a long
   *  sentence can arrive in pieces. */
  text: string[];
  listening: boolean;
  finishing: boolean;
}

let current: Utterance | null = null;

function feed(samples: Float32Array): void {
  const u = current;
  if (!u || !u.listening || !ctx) return;
  const copy = new Float32Array(samples);
  if (u.rec) u.rec.acceptWaveformFloat(copy, ctx.sampleRate);
  else u.pending.push(copy);
}

async function begin(): Promise<void> {
  if (!host || current) return;
  const lexicon = new Lexicon(host.lexicon());
  const u: Utterance = { rec: null, lexicon, pending: [], text: [], listening: true, finishing: false };
  current = u;
  host.status("Listening…");
  const [model, mic] = await Promise.all([loadVoiceModel().catch(() => null), openMic()]);
  if (current !== u) return;
  if (!model || !mic) {
    if (!model) host?.error("Voice Control: the speech model could not be loaded.");
    host?.status(null);
    current = null;
    return;
  }
  const rec = new model.KaldiRecognizer(ctx!.sampleRate, JSON.stringify(await grammarFor(lexicon, host.vocabulary())));
  if (current !== u) { rec.remove(); return; }
  rec.on("result", (m) => {
    if (m.event !== "result") return;
    const t = m.result.text.trim();
    if (t) u.text.push(t);
    if (u.finishing) finish(u);
  });
  rec.on("partialresult", (m) => {
    if (m.event === "partialresult" && m.result.partial && current === u) host?.status(`“${m.result.partial}”`);
  });
  u.rec = rec;
  for (const p of u.pending) rec.acceptWaveformFloat(p, ctx!.sampleRate);
  u.pending = [];
  if (!u.listening) end(u); // the key came up while the model was loading
}

function release(): void {
  const u = current;
  if (!u || !u.listening) return;
  setTimeout(() => {
    u.listening = false;
    if (u.rec) end(u);
  }, TAIL_MS);
}

function end(u: Utterance): void {
  u.finishing = true;
  u.rec?.retrieveFinalResult();
}

function finish(u: Utterance): void {
  if (current !== u) return;
  current = null;
  u.rec?.remove();
  const heard = u.text.join(" ").replace(/\[unk\]/g, "").replace(/\s+/g, " ").trim();
  if (!heard) {
    host?.status(null);
    host?.error("Voice Control: didn't catch that.");
    return;
  }
  const intents = parse(heard, { lexicon: u.lexicon });
  host?.status(null);
  if (!intents.length) {
    host?.error(`Voice Control: “${heard}” is not a command.`);
    return;
  }
  console.info("[voice]", JSON.stringify(heard), "→", intents.map(describe).join(" · "));
  host?.perform(intents, heard);
}

/**
 * Run a sentence through the same parse-and-perform path an utterance takes, with no microphone —
 * `window.openwar3.voiceSay("train three footmen")`, the console probe for testing the mapping
 * in a live match (and for a player to see what a phrase would do).
 */
export function voiceSay(text: string): string[] {
  if (!host) return [];
  const intents = parse(text, { lexicon: new Lexicon(host.lexicon()) });
  if (intents.length) host.perform(intents, text);
  return intents.map(describe);
}

function cancelUtterance(): void {
  current?.rec?.remove();
  current = null;
}

// ---- the key ---------------------------------------------------------------------------

/** INPUT, TEXTAREA or contenteditable — the chat line above all. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

window.addEventListener("keydown", (e) => {
  if (e.code !== VOICE_CONTROL_KEY_CODE || !enabled || !host || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
  if (!host.acceptsInput()) return;
  e.preventDefault();
  if (!e.repeat) void begin();
});
window.addEventListener("keyup", (e) => {
  if (e.code === VOICE_CONTROL_KEY_CODE) release();
});
// A key released in another window is never seen: let go of the utterance with the focus.
window.addEventListener("blur", () => release());
