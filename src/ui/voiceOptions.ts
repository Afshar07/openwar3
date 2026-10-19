import type { FdfScreen } from "./fdf/render";
import type { DataSource } from "../vfs/types";
import { setGameTip } from "./gameTip";
import { showVoiceDownload } from "./voiceDownload";
import { onVoiceModelInstalled, voiceModelInstalled, voiceModelInstalledNow } from "../voice/model";

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
  "\"use frost nova\", \"camera to another gold mine\" — or any command button's name.|n" +
  "\"Here\" is the middle of the screen (say \"cursor\" for the mouse). A spell finds|n" +
  "the unit that has it and aims itself. Heard on this computer only.";
const TIP_DOWNLOAD = `${TIP_CHECKBOX}|n|nNeeds a one-time |cffffcc0041 MB|r speech model download first.`;

/** The screen this row was last bound on, and its rebuilder — so the model arriving mid-visit
 *  swaps the face without the player having to leave the screen. */
let bound: { screen: FdfScreen; sync: () => void } | null = null;
onVoiceModelInstalled(() => bound?.sync());

/**
 * Show the face the install calls for, and wire the button. Called from each Options panel's
 * bind (a screen rebuilds its whole tree on resize, so this runs again with it).
 */
export function bindVoiceRow(screen: FdfScreen): void {
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
    // On the BOX: a TEXT frame takes no pointer (every FDF frame is pointer-events: none), so
    // the label cannot carry a hover of its own.
    const box = screen.frame("VoiceControlCheckBox");
    if (box) setGameTip(box, TIP_CHECKBOX);
    const btn = screen.frame("VoiceDownloadButton");
    if (btn) setGameTip(btn, TIP_DOWNLOAD);
  };
  bound = { screen, sync };
  sync();
  // The first visit asks IndexedDB; every later one already knows.
  if (voiceModelInstalledNow() === null) void voiceModelInstalled().then(sync);
}

/** The download button's click (both panels' handler tables name it `VoiceDownloadButton`). */
export function voiceDownloadPressed(container: HTMLElement, vfs: DataSource): void {
  void showVoiceDownload({ container, vfs }).catch((err) => console.error("[voice] download dialog failed", err));
}
