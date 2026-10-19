import { mountFdfScreen, type FdfScreen } from "./fdf/render";
import { showGlueDialog } from "./glueDialog";
import { ProgressBarScene, PROGRESS_BAR_H, PROGRESS_BAR_W } from "../render/progressBarScene";
import { installVoiceModel, MODEL_BYTES, type VoiceInstallProgress } from "../voice/model";
import type { DataSource } from "../vfs/types";

// "Download voice control dependencies" — the dialog that fetches Voice Control's speech model
// (src/voice/model.ts), in the game's OWN downloading chrome.
//
// Warcraft III already has this dialog. When Battle.net handed the client a patch, the game put
// up `BattleNetPatchDialog` (`UI\FrameDef\Glue\MainMenu.fdf`): the Battle.net dialogue box, a gold
// "Downloading Update" title, a line of text, `BattlenetProgressBar.mdl` filling itself, and one
// Cancel button. Its sibling `UserDataMigrationDialog` is the same box, wider, with a title, a
// paragraph, the same bar and a PAIR of small buttons. Both are mounted straight out of the
// player's install; nothing here draws chrome of its own.
//
// Three shapes are offered while the developer picks one (`voiceDownloadVariant`):
//   A — the patch dialog alone: the press IS the decision, the download starts at once.
//   B — the menus' own question box first ("…41 MB. Download it now?"), then the patch dialog.
//   C — one wider box (the migration dialog) that explains, asks and downloads in place.
//
// Like the update overlay it is a MODAL over whatever screen opened it (`glue-dialog-scrim`, so
// `anyModalOpen` stands the keyboard down), but unlike it it can be left: Cancel aborts the fetch
// and nothing half-written is kept.

export type VoiceDownloadVariant = "A" | "B" | "C";

/** Which shape this build shows. `?voiceui=B` (or localStorage `ow3.voiceui`) while the choice is
 *  open; A otherwise. */
export function voiceDownloadVariant(): VoiceDownloadVariant {
  const pick = (v: string | null | undefined): VoiceDownloadVariant | null =>
    v === "A" || v === "B" || v === "C" ? v : null;
  try {
    return pick(new URLSearchParams(location.search).get("voiceui")?.toUpperCase()) ?? pick(localStorage.getItem("ow3.voiceui")) ?? "A";
  } catch {
    return "A";
  }
}

const MAIN_MENU_FDF = "UI\\FrameDef\\Glue\\MainMenu.fdf";
const MB = (MODEL_BYTES / 1_000_000).toFixed(0);

/** The words. Ours — the game never fetched anything but itself — set in its markup: gold
 *  (`|cffffcc00`) for the key, as the game golds a hotkey in a tooltip. */
const TEXT = {
  title: "Downloading Voice Control",
  titleDone: "Voice Control is ready",
  titleFailed: "Download failed",
  titleC: "Voice Control",
  fetching: `Speech model, ${MB} MB — kept on this computer.`,
  unpacking: "Unpacking the speech model…",
  done: "Tick |cffffcc00Voice Control|r, then hold |cffffcc00Period (.)|r and speak.",
  failed: (why: string) => `The speech model could not be downloaded.|n${why}`,
  ask: `Voice Control needs a speech model (|cffffcc00${MB} MB|r), downloaded once and kept on this computer.|n|nDownload it now?`,
  explainC:
    `Hold |cffffcc00Period (.)|r and speak a command — "train three footmen", "attack move here", "group one". ` +
    `Recognised on this computer: your voice never leaves it.|n|nNeeds a one-time ${MB} MB download.`,
};

export interface VoiceDownloadOptions {
  container: HTMLElement;
  vfs: DataSource;
  variant?: VoiceDownloadVariant;
  /** The model is installed (the Options row swaps to its checkbox through
   *  `onVoiceModelInstalled` either way; this is for a caller that wants to do more). */
  onInstalled?: () => void;
}

/** Put the dialog up. Resolves when it closes, true if the model arrived. */
export async function showVoiceDownload(opts: VoiceDownloadOptions): Promise<boolean> {
  const variant = opts.variant ?? voiceDownloadVariant();
  if (variant === "B") {
    const yes = await new Promise<boolean>((resolve) => {
      showGlueDialog({
        container: opts.container,
        vfs: opts.vfs,
        text: TEXT.ask,
        buttons: "yesno",
        dimmed: true,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }).catch(() => resolve(false));
    });
    if (!yes) return false;
  }
  return variant === "C" ? migrationShape(opts) : patchShape(opts);
}

/** What both shapes share: the scrim, the bar canvas laid over the FDF's bar sprite, the fetch
 *  and its abort. `layout` names the shape's frames. */
interface Shape {
  root: string;
  width: number;
  /**
   * The bar's BOTTOM above the dialog's bottom edge. The FDF says `SetPoint BOTTOM …, 0.07875` of
   * a frame with no size, and nothing says how the engine sat a model in a sizeless sprite; taken
   * as the art's own bottom edge it puts the bar over the second line of the text. 0.052 is
   * measured off the running dialog instead: the bar's drawn body (the middle ~40% of its 0.0571
   * art — the rest is glow) then sits in the band between the button's top (0.052) and the text.
   */
  barBottom: number;
  progressText: string;
}

async function mountShape(
  opts: VoiceDownloadOptions,
  shape: Shape,
  build: (s: FdfScreen, ctl: Controls) => void,
  textOverrides: Record<string, string>,
  hidden: string[],
  handlers: Record<string, () => void>,
): Promise<boolean> {
  const scrim = document.createElement("div");
  scrim.className = "glue-dialog-scrim dimmed voice-download";
  opts.container.appendChild(scrim);
  const canvas = document.createElement("canvas");
  canvas.className = "voice-download-bar";
  const abort = new AbortController();
  let bar: ProgressBarScene | null = null;
  let screen: FdfScreen | null = null;
  let raf = 0;
  let settle: (ok: boolean) => void = () => {};
  const closed = new Promise<boolean>((r) => (settle = r));
  let installed = false;

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

  const wrapped: Record<string, () => void> = {};
  for (const [k, fn] of Object.entries(handlers)) wrapped[k] = () => fn();
  try {
    screen = await mountFdfScreen({
      container: scrim,
      vfs: opts.vfs,
      fdfPath: MAIN_MENU_FDF,
      rootFrame: shape.root,
      centerRoot: true,
      hidden,
      textOverrides,
      handlers: wrapped,
    });
  } catch (err) {
    close();
    throw err;
  }
  scrim.appendChild(canvas);
  // A title is measured off the word the FDF mounted it with; "Voice Control is ready" is longer
  // than "Voice Control", so it would wrap in a box sized for the shorter one.
  for (const t of ["PatchTitleText", "MigrationTitleText"]) {
    const el = screen.frame(t);
    if (el) el.style.whiteSpace = "nowrap";
  }

  // The percentage is OURS, in the bar's middle as the update overlay prints its own — the FDF's
  // `…ProgressText` is anchored off a zero-sized sprite frame and has nowhere sensible to be.
  const percent = document.createElement("p");
  percent.className = "voice-download-percent";
  scrim.appendChild(percent);
  const own = screen.frame(shape.progressText);
  if (own) own.hidden = true;

  // Lay the bar where the FDF's SPRITE frame puts it: centred across the box (its art spans
  // x 0…0.229 from its own origin; started AT the anchor, it would run off the box's right edge),
  // its bottom `barBottom` above the box's.
  const dialog = screen.frame(shape.root);
  const place = (): void => {
    if (dialog) {
      const r = dialog.getBoundingClientRect();
      const k = r.width / shape.width;
      const top = r.bottom - (shape.barBottom + PROGRESS_BAR_H) * k;
      canvas.style.left = `${r.left + r.width / 2 - (PROGRESS_BAR_W / 2) * k}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${PROGRESS_BAR_W * k}px`;
      canvas.style.height = `${PROGRESS_BAR_H * k}px`;
      percent.style.left = `${r.left + r.width / 2}px`;
      percent.style.top = `${top + (PROGRESS_BAR_H / 2) * k}px`;
      percent.style.fontSize = `${0.013 * k}px`;
    }
    raf = requestAnimationFrame(place);
  };
  place();
  bar = new ProgressBarScene(canvas, opts.vfs);
  void bar.load().then(() => bar?.start()).catch((err) => console.warn("[voice] progress bar unavailable:", err));

  const ctl: Controls = {
    screen,
    close,
    progress: (p) => {
      bar?.setProgress(p);
      percent.textContent = `${Math.round(p * 100)}%`;
    },
    showBar: (on) => {
      canvas.hidden = !on;
      percent.hidden = !on;
    },
    run: async (onPhase) => {
      try {
        await installVoiceModel((p: VoiceInstallProgress) => {
          ctl.progress(p.fraction);
          onPhase(p.phase);
        }, abort.signal);
        installed = true;
        opts.onInstalled?.();
        return null;
      } catch (err) {
        if (abort.signal.aborted) return "cancelled";
        return err instanceof Error ? err.message : String(err);
      }
    },
  };
  build(screen, ctl);
  return closed;
}

interface Controls {
  screen: FdfScreen;
  close(): void;
  progress(p: number): void;
  showBar(on: boolean): void;
  /** Fetch and unpack; resolves null on success, the reason otherwise. */
  run(onPhase: (phase: VoiceInstallProgress["phase"]) => void): Promise<string | null>;
}

/** A and B: the game's "Downloading Update" box, started the moment it is up. */
function patchShape(opts: VoiceDownloadOptions): Promise<boolean> {
  let ctl: Controls | null = null;
  return mountShape(
    opts,
    { root: "BattleNetPatchDialog", width: 0.35, barBottom: 0.052, progressText: "PatchProgressText" },
    (s, c) => {
      ctl = c;
      c.progress(0);
      void c.run((phase) => s.setText("PatchInfoText", phase === "unpack" ? TEXT.unpacking : TEXT.fetching)).then((why) => {
        if (why === "cancelled") return;
        s.setText("PatchTitleText", why ? TEXT.titleFailed : TEXT.titleDone);
        s.setText("PatchInfoText", why ? TEXT.failed(why) : TEXT.done);
        s.setText("PatchButtonText", "OK");
        if (why) c.showBar(false);
      });
    },
    { PatchTitleText: TEXT.title, PatchInfoText: TEXT.fetching, PatchProgressText: "0%" },
    [],
    // Cancel while it runs, OK once it has finished — one button, as the patch box has.
    { PatchButton: () => ctl?.close() },
  );
}

/** C: the wider migration box — the explanation, the question and the download in one place. */
function migrationShape(opts: VoiceDownloadOptions): Promise<boolean> {
  let ctl: Controls | null = null;
  let started = false;
  const start = (): void => {
    const c = ctl;
    if (!c || started) return;
    started = true;
    const s = c.screen;
    s.setEnabled("MigrationButtonSmallLeft", false);
    c.showBar(true);
    s.setText("MigrationInfoText", TEXT.fetching);
    void c.run((phase) => s.setText("MigrationInfoText", phase === "unpack" ? TEXT.unpacking : TEXT.fetching)).then((why) => {
      if (why === "cancelled") return;
      s.setText("MigrationTitleText", why ? TEXT.titleFailed : TEXT.titleDone);
      s.setText("MigrationInfoText", why ? TEXT.failed(why) : TEXT.done);
      // Finished: the pair gives way to the box's single wide button.
      for (const f of ["MigrationButtonSmallLeftBackdrop", "MigrationButtonSmallRightBackdrop"]) {
        const el = s.frame(f);
        if (el) el.hidden = true;
      }
      const one = s.frame("MigrationButtonLargeSingleBackdrop");
      if (one) one.hidden = false;
      s.setText("MigrationButtonLargeSingleText", "OK");
      if (why) c.showBar(false);
    });
  };
  return mountShape(
    opts,
    { root: "UserDataMigrationDialog", width: 0.45, barBottom: 0.052, progressText: "MigrationProgressText" },
    (s, c) => {
      ctl = c;
      c.progress(0);
      c.showBar(false);
      const one = s.frame("MigrationButtonLargeSingleBackdrop");
      if (one) one.hidden = true;
    },
    {
      MigrationTitleText: TEXT.titleC,
      MigrationInfoText: TEXT.explainC,
      MigrationButtonSmallLeftText: "Download",
      MigrationButtonSmallRightText: "Cancel",
      MigrationProgressText: "0%",
    },
    [],
    {
      MigrationButtonSmallLeft: start,
      MigrationButtonSmallRight: () => ctl?.close(),
      MigrationButtonLargeSingle: () => ctl?.close(),
    },
  );
}
