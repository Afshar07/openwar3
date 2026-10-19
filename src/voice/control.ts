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
//   1. a fresh Vosk recogniser is made whose GRAMMAR is the words this match can mean right
//      now (vocabulary.ts), and fed the PRE-ROLL — the last 0.6 s of microphone from before the
//      key went down, as voice chat's "/" does — then the live samples. The microphone is opened
//      as soon as Voice Control is on in a match (`warm`), so even the first press has a
//      pre-roll; while the key is up nothing but those 0.6 s is ever kept;
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
  /** A host that understands sentences ITSELF (the menus, src/voice/menu.ts) takes the text
   *  whole instead of the match's intents. True if it did something with it. */
  handle?(text: string): boolean;
  /** Whether to run the free DICTATION recogniser beside the grammar one — the match does, for
   *  "say good game to all", whose message is words no grammar can hold. */
  dictates?: boolean;
  /** Tell the player what is going on (listening, heard nothing, …). null clears it. */
  status(text: string | null): void;
  /** Tell the player something went wrong (no microphone, …). */
  error(text: string): void;
}

/** The push-to-talk key, by position (`e.code`). */
export const VOICE_CONTROL_KEY_CODE = "Period";

/** How long the microphone keeps feeding the recogniser after the key comes up. */
const TAIL_MS = 250;

/**
 * Seconds of microphone kept, in memory only, while the key is UP — and fed to the recogniser
 * ahead of the live audio when it goes down. People start speaking as they press, and the key
 * event, the processor's buffer and the recogniser's start all lag that, so without it the first
 * syllable ("TRAIN three footmen") was cut off. Voice chat's own pre-roll (audio/voiceChat.ts
 * `PREROLL_SECS`, 0.4) is the same idea; this one is a little longer, because a command's first
 * word is the verb and losing it loses the command.
 */
const PREROLL_SECS = 0.6;
/** Samples per processor callback: ~43 ms at 48 kHz, so the pre-roll is kept in fine slices. */
const TAP_SAMPLES = 2048;

let enabled = false;
/** The match, while one is up. */
let host: VoiceHost | null = null;
/** The menus — every glue screen, and the in-game panels (F10, quests, allies) — registered
 *  once at boot. Asked only when the match is not taking commands. */
let menuHost: VoiceHost | null = null;

/** Who a press is for right now: the match if it is taking commands, else the menus. */
function active(): VoiceHost | null {
  if (host?.acceptsInput()) return host;
  if (menuHost?.acceptsInput()) return menuHost;
  return null;
}

/** The menus register themselves once (main.ts). */
export function setMenuVoiceHost(h: VoiceHost | null): void {
  menuHost = h;
  warm();
}

/** Options → Gameplay → "Voice Control", live. */
export function applyVoiceOptions(opts: Options): void {
  const on = opts.voiceControl === true;
  if (on === enabled) return;
  enabled = on;
  if (!on) closeMic();
  else warm();
}

/**
 * Get ready to listen BEFORE the first press: with Voice Control on, a match up and the model
 * installed, the recogniser is loaded and the microphone opened, so the pre-roll is already
 * filling when "." goes down — the first command of a match is not the one that loses its start
 * to a permission prompt and a model load — and the menus listen too, so it is open whenever the
 * option is on. The microphone is closed again when the option is turned off.
 */
function warm(): void {
  if (!enabled || (!host && !menuHost)) return;
  void voiceModelInstalled().then((ok) => {
    if (!ok || !enabled || (!host && !menuHost)) return;
    void loadVoiceModel().catch(() => {});
    void openMic();
  });
}

/** The match registers itself while it is up; null when it ends. */
export function setVoiceHost(h: VoiceHost | null): void {
  host = h;
  if (!h) cancelUtterance();
  warm();
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
      (host ?? menuHost)?.error("Voice Control: microphone unavailable or permission refused.");
      return false;
    }
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor, as voice chat's tap (audio/voiceChat.ts): the one tap every Chromium the
    // game ships in has, needing no module file.
    tap = ctx.createScriptProcessor(TAP_SAMPLES, 1, 1);
    tap.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0));
    source.connect(tap);
    tap.connect(ctx.destination); // a ScriptProcessor only runs while it reaches the output
    return true;
  })().finally(() => (opening = null));
  return opening;
}

function closeMic(): void {
  preroll = [];
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

/** A sentence that is a CHAT line ("say good game", "tell allies push mid", "send message gg to
 *  all"): its message is whatever was said, so it is read off the dictation recogniser. */
const CHAT_START = /^(say|tell|type|write|chat|message|send (a )?(message|msg|text|chat))\b/;

interface Utterance {
  h: VoiceHost;
  rec: Recognizer | null;
  /** The free recogniser — no grammar, the model's whole vocabulary — for chat dictation. */
  free: Recognizer | null;
  lexicon: Lexicon;
  /** Audio captured before the recognisers were ready (the first press loads the model). */
  pending: Float32Array[];
  /** Text of every result segment so far — Kaldi ends a segment at a pause, so a long
   *  sentence can arrive in pieces. One list per recogniser. */
  text: string[];
  freeText: string[];
  /** Final results still to come back (one per recogniser running). */
  outstanding: number;
  listening: boolean;
  finishing: boolean;
}

let current: Utterance | null = null;

/** The last `PREROLL_SECS` of microphone, oldest first, while no utterance is listening. */
let preroll: Float32Array[] = [];

function feed(samples: Float32Array): void {
  const u = current;
  if (!ctx) return;
  const copy = new Float32Array(samples);
  if (!u || !u.listening) {
    // Key up: keep the last moments, in memory, and nothing else.
    preroll.push(copy);
    const keep = Math.ceil((PREROLL_SECS * ctx.sampleRate) / TAP_SAMPLES);
    while (preroll.length > keep) preroll.shift();
    return;
  }
  if (u.rec) {
    u.rec.acceptWaveformFloat(copy, ctx.sampleRate);
    u.free?.acceptWaveformFloat(copy, ctx.sampleRate);
  } else u.pending.push(copy);
}

async function begin(h: VoiceHost): Promise<void> {
  if (current) return;
  const lexicon = new Lexicon(h.lexicon());
  // The utterance starts with the pre-roll — the audio from just BEFORE the key went down.
  const u: Utterance = {
    h, rec: null, free: null, lexicon, pending: preroll, text: [], freeText: [], outstanding: 0, listening: true, finishing: false,
  };
  preroll = [];
  current = u;
  h.status("Listening…");
  const [model, mic] = await Promise.all([loadVoiceModel().catch(() => null), openMic()]);
  if (current !== u) return;
  if (!model || !mic) {
    if (!model) h.error("Voice Control: the speech model could not be loaded.");
    h.status(null);
    current = null;
    return;
  }
  const rec = new model.KaldiRecognizer(ctx!.sampleRate, JSON.stringify(await grammarFor(lexicon, h.vocabulary())));
  if (current !== u) { rec.remove(); return; }
  const collect = (r: Recognizer, into: string[]): void => {
    r.on("result", (m) => {
      if (m.event !== "result") return;
      const t = m.result.text.trim();
      if (t) into.push(t);
      if (u.finishing && --u.outstanding <= 0) finish(u);
    });
  };
  collect(rec, u.text);
  rec.on("partialresult", (m) => {
    if (m.event === "partialresult" && m.result.partial && current === u) h.status(`“${m.result.partial}”`);
  });
  u.rec = rec;
  if (h.dictates) {
    // No grammar: the model's whole vocabulary, so a chat line is heard as said.
    u.free = new model.KaldiRecognizer(ctx!.sampleRate);
    collect(u.free, u.freeText);
  }
  for (const p of u.pending) {
    rec.acceptWaveformFloat(p, ctx!.sampleRate);
    u.free?.acceptWaveformFloat(p, ctx!.sampleRate);
  }
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
  u.outstanding = (u.rec ? 1 : 0) + (u.free ? 1 : 0);
  u.rec?.retrieveFinalResult();
  u.free?.retrieveFinalResult();
}

const clean = (parts: string[]): string => parts.join(" ").replace(/\[unk\]/g, "").replace(/\s+/g, " ").trim();

function finish(u: Utterance): void {
  if (current !== u) return;
  current = null;
  u.rec?.remove();
  u.free?.remove();
  let heard = clean(u.text);
  // A chat line: the grammar recogniser heard the VERB ("say …"); the message is the free one's.
  const dictated = clean(u.freeText);
  if (CHAT_START.test(heard) && dictated) heard = CHAT_START.test(dictated) ? dictated : `${heard.split(" ")[0]} ${dictated}`;
  run(u.h, heard, u.lexicon);
}

/** One sentence, to whichever host it was spoken at. */
function run(h: VoiceHost, heard: string, lexicon: Lexicon): string[] {
  h.status(null);
  if (!heard) {
    h.error("Voice Control: didn't catch that.");
    return [];
  }
  // A match is up but not taking commands — paused, or a panel is open. Its CONSOLE lines still
  // belong to it: "unpause", "open the quest log", "say gg to all" are not on any panel's face.
  if (h === menuHost && host) {
    const intents = parse(heard, { lexicon: new Lexicon([]) });
    if (intents.length && intents.every((i) => i.kind === "pause" || i.kind === "chat" || (i.kind === "panel" && i.open === true))) {
      console.info("[voice]", JSON.stringify(heard), "→", intents.map(describe).join(" · "));
      host.perform(intents, heard);
      return intents.map(describe);
    }
  }
  if (h.handle) {
    console.info("[voice:menu]", JSON.stringify(heard));
    h.handle(heard);
    return [heard];
  }
  const intents = parse(heard, { lexicon });
  if (!intents.length) {
    h.error(`Voice Control: “${heard}” is not a command.`);
    return [];
  }
  console.info("[voice]", JSON.stringify(heard), "→", intents.map(describe).join(" · "));
  h.perform(intents, heard);
  return intents.map(describe);
}

/**
 * Run a sentence through the same path an utterance takes, with no microphone —
 * `window.openwar3.voiceSay("train three footmen")`, the console probe for testing the mapping
 * in a live match or on a menu (and for a player to see what a phrase would do).
 */
export function voiceSay(text: string): string[] {
  const h = active() ?? host ?? menuHost;
  if (!h) return [];
  return run(h, text, new Lexicon(h.lexicon()));
}

/** Whether the microphone is open and how many seconds of pre-roll it holds — a console probe
 *  (`window.openwar3.voicePreroll()`) for checking the pre-roll in a live match. */
export function voicePrerollState(): { micOpen: boolean; seconds: number } {
  const n = preroll.reduce((sum, p) => sum + p.length, 0);
  return { micOpen: !!stream, seconds: ctx ? n / ctx.sampleRate : 0 };
}

function cancelUtterance(): void {
  current?.rec?.remove();
  current?.free?.remove();
  current = null;
}

// ---- the key ---------------------------------------------------------------------------

/** INPUT, TEXTAREA or contenteditable — the chat line above all. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

window.addEventListener("keydown", (e) => {
  if (e.code !== VOICE_CONTROL_KEY_CODE || !enabled || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
  const h = active();
  if (!h) return;
  e.preventDefault();
  // Swallowed before anything else hears it: on a menu, "." is nobody's key, and in a match the
  // HUD's handler must not see it either.
  e.stopImmediatePropagation();
  if (!e.repeat) void begin(h);
});
window.addEventListener("keyup", (e) => {
  if (e.code === VOICE_CONTROL_KEY_CODE) release();
});
// A key released in another window is never seen: let go of the utterance with the focus.
window.addEventListener("blur", () => release());
