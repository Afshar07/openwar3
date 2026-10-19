import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { showGlueDialog } from "./glueDialog";
import { ProgressBarScene, PROGRESS_BAR_H, PROGRESS_BAR_W } from "../render/progressBarScene";
import { installVoiceModel } from "../voice/model";
import { WHISPER_MODELS, type WhisperModelId } from "../voice/whisperModels";
import type { DataSource } from "../vfs/types";
import { loadOptions, saveOptions } from "../data/options";
import { applyVoiceOptions } from "../voice/control";

// "Download voice control dependencies" — fetching Voice Control's speech model
// (src/voice/model.ts) in the game's OWN chrome, in two steps:
//
//   1. the menus' own question box (`DialogWar3.fdf`, ui/glueDialog.ts) asks first, naming the
//      size — an 80 MB (or 250 MB) download is the player's decision, not a side effect of a click;
//   2. Yes puts up the dialog Warcraft III already had for exactly this: `BattleNetPatchDialog`
//      (`UI\FrameDef\Glue\MainMenu.fdf`), the box the game showed while Battle.net handed it a
//      patch — the dialogue box, a gold "Downloading Update" title, one line of text,
//      `BattlenetProgressBar.mdl` filling itself (render/progressBarScene.ts) and one Cancel
//      button, which becomes OK once it is done.
//
// Both are mounted straight out of the player's install; nothing here draws chrome of its own.
// Like the update overlay it is a MODAL over whatever screen opened it (`glue-dialog-scrim`, so
// `anyModalOpen` stands the keyboard down), but unlike it it can be left: Cancel or Escape aborts
// the fetch and nothing half-written is kept.

const MAIN_MENU_FDF = "UI\\FrameDef\\Glue\\MainMenu.fdf";
/** Every model, Fast first — what the one download action fetches. */
const ALL: WhisperModelId[] = ["base", "small"];
const mb = (id: WhisperModelId): string => (WHISPER_MODELS[id].bytes / 1_000_000).toFixed(0);
const mbOf = (ids: WhisperModelId[]): string => (ids.reduce((n, id) => n + WHISPER_MODELS[id].bytes, 0) / 1_000_000).toFixed(0);

/** The patch dialog's width (`BattleNetPatchDialog` Width), which every placement is scaled by. */
const DIALOG_W = 0.35;

/**
 * The bar's BOTTOM above the dialog's bottom edge. The FDF says `SetPoint BOTTOM …, 0.07875` of a
 * frame with no size, and nothing says how the engine sat a model in a sizeless sprite; taken as
 * the art's own bottom edge it puts the bar over the second line of the text. 0.06 is measured
 * off the running dialog instead: the bar's drawn body (the middle ~40% of its art — the rest is
 * glow) then sits in the middle of the band between the button's top (0.052) and the text,
 * clear of the button rather than resting on it.
 */
const BAR_BOTTOM = 0.06;

/** How much larger than authored the bar is drawn. Ours: at the art's own 0.229 it read small
 *  in a 0.35 box. Uniform, so the border's end caps keep their shape. */
const BAR_SCALE = 1.15;

/** The words. Ours — the game never fetched anything but itself — set in its markup: gold
 *  (`|cffffcc00`) for the key and the size, as the game golds a hotkey in a tooltip. */
const TEXT = {
  ask: (ids: WhisperModelId[]) =>
    ids.length > 1
      ? `Voice Control needs its speech models — |cffffcc00Fast|r and |cffffcc00Accurate|r, |cffffcc00${mbOf(ids)} MB|r — downloaded once and kept on this computer.|n|nDownload them now?`
      : `Voice Control needs its |cffffcc00${WHISPER_MODELS[ids[0]].label}|r speech model (|cffffcc00${mbOf(ids)} MB|r), downloaded once and kept on this computer.|n|nDownload it now?`,
  title: "Downloading Voice Control",
  titleDone: "Voice Control is ready",
  titleFailed: "Download failed",
  fetching: (id: WhisperModelId, ids: WhisperModelId[]) =>
    ids.length > 1
      ? `${WHISPER_MODELS[id].label} speech model (${ids.indexOf(id) + 1} of ${ids.length}), ${mb(id)} MB.`
      : `${WHISPER_MODELS[id].label} speech model, ${mb(id)} MB.`,
  done: "Hold |cffffcc00Period (.)|r and speak a command.",
  failed: (why: string) => `The speech model could not be downloaded.|n${why}`,
};

export interface VoiceDownloadOptions {
  container: HTMLElement;
  vfs: DataSource;
  /** Which models. BOTH by default — the Options row's one download action fetches Fast and
   *  Accurate together, so the pulldown is a switch and never a second download. One alone is the
   *  fallback for a pick whose model is missing (a cache the browser cleared). */
  models?: WhisperModelId[];
}

/** Ask, then download. Resolves when the dialog closes, true if the model arrived (the Options
 *  row swaps to its checkbox through `onVoiceModelInstalled` either way). */
export async function showVoiceDownload(opts: VoiceDownloadOptions): Promise<boolean> {
  const yes = await new Promise<boolean>((resolve) => {
    showGlueDialog({
      container: opts.container,
      vfs: opts.vfs,
      text: TEXT.ask(opts.models ?? ALL),
      buttons: "yesno",
      dimmed: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }).catch(() => resolve(false));
  });
  return yes ? download(opts) : false;
}

/** The patch dialog, downloading from the moment it is up. */
async function download(opts: VoiceDownloadOptions): Promise<boolean> {
  const models = opts.models ?? ALL;
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed voice-download";
  opts.container.appendChild(scrim);
  const abort = new AbortController();
  let bar: ProgressBarScene | null = null;
  let screen: FdfScreen | null = null;
  let raf = 0;
  let installed = false;
  let settle: (ok: boolean) => void = () => {};
  const closed = new Promise<boolean>((r) => (settle = r));

  const close = (): void => {
    abort.abort();
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    bar?.dispose();
    screen?.dispose();
    scrim.remove();
    settle(installed);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener("keydown", onKey, true);

  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: MAIN_MENU_FDF,
      rootFrame: "BattleNetPatchDialog",
      centerRoot: true,
      textOverrides: { PatchTitleText: TEXT.title, PatchInfoText: TEXT.fetching(models[0], models) },
      // Cancel while it runs, OK once it has finished — one button, as the patch box has.
      handlers: { PatchButton: () => close() },
    });
  } catch (err) {
    close();
    throw err;
  }
  const s = screen;
  // A title is measured off the words it was mounted with; "Voice Control is ready" would wrap in
  // a box sized for "Downloading Voice Control" otherwise.
  const title = s.frame("PatchTitleText");
  if (title) title.style.whiteSpace = "nowrap";
  // The FDF's own `PatchProgressText` is anchored off a zero-sized sprite frame and has nowhere
  // sensible to be; the percentage is printed in the bar's middle instead, as the update overlay
  // prints its own.
  // The info line sits directly over the bar, so while it runs it is ONE line: a second line
  // wrapped under the bar ("…252 MB — kept on this computer." did). A failure hides the bar and
  // may wrap again, since its reason is the browser's words and of any length.
  const info = s.frame("PatchInfoText");
  if (info) Object.assign(info.style, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  const own = s.frame("PatchProgressText");
  if (own) own.hidden = true;

  const canvas = document.createElement("canvas");
  canvas.className = "voice-download-bar";
  const percent = document.createElement("p");
  percent.className = "voice-download-percent";
  scrim.append(canvas, percent);

  // The bar where the FDF's SPRITE frame puts it: centred across the box (its art spans x 0…0.229
  // from its own origin; started AT the anchor, it would run off the box's right edge).
  const dialog = s.frame("BattleNetPatchDialog");
  const place = (): void => {
    if (dialog) {
      const r = dialog.getBoundingClientRect();
      const k = r.width / DIALOG_W;
      const w = PROGRESS_BAR_W * BAR_SCALE;
      const h = PROGRESS_BAR_H * BAR_SCALE;
      const top = r.bottom - (BAR_BOTTOM + h) * k;
      canvas.style.left = `${r.left + r.width / 2 - (w / 2) * k}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${w * k}px`;
      canvas.style.height = `${h * k}px`;
      percent.style.left = `${r.left + r.width / 2}px`;
      percent.style.top = `${top + (h / 2) * k}px`;
      percent.style.fontSize = `${0.013 * k}px`;
    }
    raf = requestAnimationFrame(place);
  };
  place();
  bar = new ProgressBarScene(canvas, opts.vfs);
  void bar.load().then(() => bar?.start()).catch((err) => console.warn("[voice] progress bar unavailable:", err));

  const progress = (p: number): void => {
    bar?.setProgress(p);
    percent.textContent = `${Math.round(p * 100)}%`;
  };
  progress(0);
  try {
    // One bar over all of them: each model's share of the bar is its share of the bytes.
    const total = models.reduce((n, id) => n + WHISPER_MODELS[id].bytes, 0);
    let before = 0;
    for (const id of models) {
      s.setText("PatchInfoText", TEXT.fetching(id, models));
      const share = WHISPER_MODELS[id].bytes;
      await installVoiceModel(id, (p) => progress((before + p.fraction * share) / total), abort.signal);
      before += share;
    }
    installed = true;
    // Downloading it was the decision to use it: Voice Control comes on, saved, at once. Fast is
    // the default; a lone Accurate fetched for a pick IS the pick.
    const stored = loadOptions();
    stored.voiceControl = true;
    if (models.length === 1) stored.voiceModel = models[0] === "small" ? "accurate" : "fast";
    saveOptions(stored);
    applyVoiceOptions(stored);
    s.setText("PatchTitleText", TEXT.titleDone);
    s.setText("PatchInfoText", TEXT.done);
    s.setText("PatchButtonText", "OK");
  } catch (err) {
    if (!abort.signal.aborted) {
      if (info) info.style.whiteSpace = "normal";
      s.setText("PatchTitleText", TEXT.titleFailed);
      s.setText("PatchInfoText", TEXT.failed(err instanceof Error ? err.message : String(err)));
      s.setText("PatchButtonText", "OK");
      canvas.hidden = true;
      percent.hidden = true;
    }
  }
  return closed;
}
