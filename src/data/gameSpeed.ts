// GAME SPEED — the "Game Speed:" slider on F10 → Options → Gameplay and on LAN → Create Game.
//
// The 2003 game's slider has three steps (`SliderMaxValue 2` in both
// `UI\FrameDef\UI\EscMenuOptionsPanel.fdf` and `UI\FrameDef\Glue\LocalMultiplayerCreate.fdf`,
// worded Slow / Normal / Fast). Ours has FOUR, and the rungs and their rates are the
// developer's, not the game's: Fast is the speed OpenWar3 has always run at and stays the
// default, Fastest is half as fast again, Slow takes 1.5 times as long as Fast and Medium sits
// halfway between them (1.25 times as long — which lands it on 0.8, the rate the real client's
// Normal is usually quoted at against its Fast). Each label is a GlobalStrings word (SLOW,
// MEDIUM, FAST, FASTEST, DEFAULT), so the slider says it in the install's own language.
//
// What a rate SCALES is game time: the sim's fixed steps come faster or slower (every timer,
// cooldown, build, walk and trigger with them, because all of them count steps), and so does
// every clock that ages the drawn world — the model clips, the effects, the weather, the
// day/night medallion — and the match clock under the medallion, which counts GAME seconds, as
// the real client's does: ten minutes on it is the same amount of game at every speed. What it
// does NOT scale is the player's own hand (the camera, the HUD's own animation).
//
// Single player: every match opens on Fast and the player changes it from F10 for THAT match
// only. Nothing is remembered — a speed left on Slow last week is not a speed the player
// chose for today's game, so the default is the one rung a match never has to be talked out of.
// Multiplayer: the HOST's pick on the create screen, carried in `AdvancedOptions.gameSpeed` so
// every machine runs the same clock — and F10's slider only SHOWS it there.

import type { FdfLibrary } from "../ui/fdf/library";

export enum GameSpeed {
  Slow = 0,
  Medium = 1,
  Fast = 2,
  Fastest = 3,
}

/** Fast, always: the speed OpenWar3 ran at before the slider was live. */
export const DEFAULT_GAME_SPEED = GameSpeed.Fast;

/** The slider's range on OUR scale — 0 Slow … 3 Fastest. */
export const GAME_SPEED_MIN = GameSpeed.Slow;
export const GAME_SPEED_MAX = GameSpeed.Fastest;

/** Game seconds per real second, by rung (see the file header for where each comes from). */
const RATE: Record<GameSpeed, number> = {
  [GameSpeed.Slow]: 1 / 1.5,
  [GameSpeed.Medium]: 1 / 1.25,
  [GameSpeed.Fast]: 1,
  [GameSpeed.Fastest]: 1.5,
};

/** The GlobalStrings word each rung wears. */
const LABEL: Record<GameSpeed, string> = {
  [GameSpeed.Slow]: "SLOW",
  [GameSpeed.Medium]: "MEDIUM",
  [GameSpeed.Fast]: "FAST",
  [GameSpeed.Fastest]: "FASTEST",
};

/** Parse anything (a slider value, a URL parameter, a wire value from an older peer) into a
 *  rung — Fast when it is not one. */
export function toGameSpeed(v: unknown): GameSpeed {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= GAME_SPEED_MIN && n <= GAME_SPEED_MAX
    ? (n as GameSpeed)
    : DEFAULT_GAME_SPEED;
}

/** Game seconds per real second at this rung. */
export function gameSpeedRate(s: GameSpeed): number {
  return RATE[s] ?? 1;
}

/** "Slow", "Medium", "Fast (Default)", "Fastest" — the default rung always says so. */
export function gameSpeedLabel(s: GameSpeed, lib: FdfLibrary | null): string {
  const word = (key: string, fallback: string): string => lib?.string(key) ?? fallback;
  const fallback = { SLOW: "Slow", MEDIUM: "Medium", FAST: "Fast", FASTEST: "Fastest" }[LABEL[s]] ?? "Fast";
  const name = word(LABEL[s], fallback);
  return s === DEFAULT_GAME_SPEED ? `${name} (${word("DEFAULT", "Default")})` : name;
}
