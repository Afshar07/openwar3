import type { FdfScreen } from "./fdf/render";
import type { DataSource } from "../vfs/types";
import { setGameTip } from "./gameTip";
import { showVoiceDownload } from "./voiceDownload";
import { onVoiceModelInstalled, voiceModelInstalled, voiceModelInstalledNow } from "../voice/model";
import { WHISPER_MODELS } from "../voice/whisperModels";

// Options → Gameplay → "Voice Control": the one row with two faces (src/overrides/ui/
// OptionsMenu.fdf). Until the speech model is on this machine the row is a BUTTON that fetches
// it; from then on it is the CHECKBOX that turns push-to-talk on. Both panels — the glue Options
// screen and F10 → Options — dress it through here, so the two can never disagree about which
// face is up.
//
// Both faces carry the same hover slab, because the key is the thing a player needs to know
// BEFORE they decide: "." is held, not pressed.

/** What the row explains on hover — the same for both faces, plus the download's size on the
 *  button. In the game's tooltip markup: gold for the name and the key, as a command button's
 *  tooltip golds its hotkey. */
const TIP_CHECKBOX =
  "|cffffcc00Voice Control|r|n" +
  "Hold the |cffffcc00Period (.)|r key and speak a command; let go to send it.|n" +
  "\"train three footmen\", \"attack move here\", \"group one\", \"build a farm here\",|n" +
  "\"use healing salve on grunt\", \"finish the altar\" — or any command button's name.|n" +
  "\"Here\" is the middle of the screen (say \"cursor\" for the mouse). A spell finds|n" +
  "the unit that has it and aims itself. Heard on this computer only.";
const TIP_DOWNLOAD = `${TIP_CHECKBOX}|n|nNeeds a one-time |cffffcc00${Math.round((WHISPER_MODELS.base.bytes + WHISPER_MODELS.small.bytes) / 1_000_000)} MB|r download of its two speech models first.`;
const MB = (id: keyof typeof WHISPER_MODELS): number => Math.round(WHISPER_MODELS[id].bytes / 1_000_000);
/** The model pulldown's hover: what the two words cost and buy. */
const TIP_MODEL =
  "|cffffcc00Speech model|r|n" +
  `|cffffcc00Fast|r — Whisper base (${MB("base")} MB): quick on any computer.|n` +
  `|cffffcc00Accurate|r — Whisper small (${MB("small")} MB): better with hard names,|n` +
  "about three times slower to answer.";

/** The screen this row was last bound on, and its rebuilder — so the model arriving mid-visit
 *  swaps the face without the player having to leave the screen. */
/** What a screen lends the row: who to tell when Voice Control comes on, and how to put the
 *  model pulldown's value into its working AND committed copies. */
export interface VoiceRowHooks {
  enabled(): void;
  setModel(value: "fast" | "accurate"): void;
  container: HTMLElement;
  vfs: DataSource;
}

let bound: { screen: FdfScreen; sync: () => void; enabled?: () => void } | null = null;
// The model arriving turns Voice Control ON (ui/voiceDownload.ts saves that): the row swaps to
// its checkbox, TICKED, and the screen's own working and committed copies are told, so neither
// its OK nor its Cancel puts the old "off" back.
onVoiceModelInstalled((installed) => {
  if (!bound) return;
  bound.sync();
  if (!installed || !bound.screen.element.isConnected) return;
  const box = bound.screen.checkBox("VoiceControlCheckBox");
  if (box) box.checked = true;
  bound.enabled?.();
});

/**
 * Show the face the install calls for, and wire the button. Called from each Options panel's
 * bind (a screen rebuilds its whole tree on resize, so this runs again with it).
 */
export function bindVoiceRow(screen: FdfScreen, hooks: VoiceRowHooks): void {
  const enabled = hooks.enabled;
  const sync = (): void => {
    if (!screen.element.isConnected) return;
    const installed = voiceModelInstalledNow() === true;
    const show = (name: string, on: boolean): void => {
      const el = screen.frame(name);
      if (el) el.hidden = !on;
    };
    // The label column's "Voice Control:" is the download face's (the glue panel has it; the F10
    // panel has no room for it and shows the button alone).
    show("VoiceControlRowLabel", !installed);
    show("VoiceDownloadButton", !installed);
    show("VoiceControlCheckBox", installed);
    show("VoiceControlLabel", installed);
    // The model pulldown — the glue panel's socketed one, or F10's bare one.
    show("VoiceModelBackdrop", installed);
    show("EscVoiceModelMenu", installed);
    for (const name of ["VoiceModelMenu", "EscVoiceModelMenu"]) {
      const el = screen.frame(name);
      if (el) setGameTip(el, TIP_MODEL);
    }
    // On the BOX: a TEXT frame takes no pointer (every FDF frame is pointer-events: none), so
    // the label cannot carry a hover of its own.
    const box = screen.frame("VoiceControlCheckBox");
    if (box) setGameTip(box, TIP_CHECKBOX);
    const btn = screen.frame("VoiceDownloadButton");
    if (btn) setGameTip(btn, TIP_DOWNLOAD);
  };
  bound = { screen, sync, enabled };
  sync();
  // Both models come down with the row's one download, so the pulldown is a plain switch. The
  // one exception: ACCURATE picked while small.en is missing (its download was cancelled half-way,
  // or the browser cleared its cache) — then the pick is refused for now, the dialog fetches just
  // that model, and the pick is made for real once it has arrived, so the pulldown never names a
  // model that cannot listen.
  for (const name of ["VoiceModelMenu", "EscVoiceModelMenu"]) {
    const menu = screen.popup(name);
    if (!menu) continue;
    const commit = menu.onChange;
    menu.onChange = (v) => {
      if (v === "accurate" && voiceModelInstalledNow("small") !== true) {
        void showVoiceDownload({ container: hooks.container, vfs: hooks.vfs, models: ["small"] }).then((ok) => {
          if (!ok || !screen.element.isConnected) return;
          menu.value = "accurate";
          hooks.setModel("accurate");
        });
        return false;
      }
      return commit?.(v);
    };
  }
  // The first visit asks IndexedDB; every later one already knows.
  if (voiceModelInstalledNow() === null) void voiceModelInstalled().then(sync);
}

/** The download button's click (both panels' handler tables name it `VoiceDownloadButton`). */
export function voiceDownloadPressed(container: HTMLElement, vfs: DataSource): void {
  void showVoiceDownload({ container, vfs }).catch((err) => console.error("[voice] download dialog failed", err));
}
