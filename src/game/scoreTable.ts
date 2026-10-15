import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";
import { STARTING_UNITS, type PlayableRace } from "../data/races";
import { HERO_SCORE_PER_XP, techPercent, type PlayerTally } from "../sim/matchStats";

// The finished SCORE SCREEN table (issue #199): one row per seated player, the tallies the sim
// counted (sim/matchStats.ts) turned into the screen's twenty columns. Plain data, because on a
// LAN match it is the host who has it and it crosses the wire to every client in the dialog that
// ends that client's game (render/mapViewer.ts `scoreTable`).

/** One hero, as the Heroes Used column draws it: its icon and its level. */
export interface ScoreHero {
  typeId: string;
  /** Its command-card icon (UnitFunc `Art`) — resolved where the registry is, the authority. */
  icon: string;
  level: number;
  xp: number;
}

/** One player's line of the score screen. */
export interface ScoreRow {
  player: number;
  name: string;
  race: PlayableRace;
  team: number;
  /** The player-colour index the row's bar is tinted with (ScoreScreen-TopBar's clip). */
  color: number;
  /** Won the match — the gold name plate rather than the silver one. */
  won: boolean;
  // Overview
  unitScore: number;
  heroScore: number;
  resourceScore: number;
  // Units
  unitsProduced: number;
  unitsKilled: number;
  buildingsProduced: number;
  buildingsRazed: number;
  largestArmy: number;
  // Heroes
  heroes: ScoreHero[];
  heroesKilled: number;
  itemsObtained: number;
  mercenariesHired: number;
  experienceGained: number;
  // Resources
  goldMined: number;
  lumberHarvested: number;
  resourcesSent: number;
  resourcesReceived: number;
  techPercent: number;
  upkeepLost: number;
}

export interface ScoreTable {
  rows: ScoreRow[];
  /** Seconds the match ran — "Elapsed Time:". */
  elapsed: number;
  /** Whose screen it is: that row is printed in gold and its race picks the picture and the
   *  music. Null for a watcher. Stamped by the machine SHOWING it, never by the host that counted
   *  it (render/mapViewer.ts `finalScores`). */
  viewer: number | null;
}

/** What a row is built from — the seat facts the renderer owns and the tallies the sim kept. */
export interface ScoreSeat {
  player: number;
  name: string;
  race: PlayableRace;
  team: number;
  color: number;
  won: boolean;
  tally: PlayerTally;
  heroes: ScoreHero[];
  research: ReadonlyMap<string, number>;
}

/**
 * Every rank of every upgrade a race's tech tree offers — Tech Percentage's denominator.
 *
 * Walked out of the TABLES from the race's own melee starting units rather than listed: what a
 * worker `Builds`, what a building `Upgrade`s into and `Trains`, and everything any of those
 * `Researches`. So a map that edits the tech tree is asked about its own tree, and the four
 * numbers the article quotes ("36, 32, 29, 27 for Human, NE, Orc and UD") are a CHECK on this
 * walk rather than an input to it: on our tables it finds Orc 29 and Undead 27 exactly, and
 * Human 35 and Night Elf 31 — one short of each. The article read 1.32-era score screens and our
 * tables are the latest balance release (docs/patches.md), so a rank added or folded between the
 * two is the likelier difference than a building the walk misses; it is left as measured.
 */
export function researchableFor(race: PlayableRace, tech: TechRegistry, upgrades: UpgradeRegistry): Map<string, number> {
  const seen = new Set<string>();
  const queue = STARTING_UNITS[race].map((s) => s.id);
  const out = new Map<string, number>();
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of [...tech.builds(id), ...tech.upgradesTo(id), ...tech.trains(id)]) queue.push(next);
    for (const up of tech.researches(id)) {
      const def = upgrades.get(up);
      if (def) out.set(up, Math.max(1, def.maxLevel));
    }
  }
  return out;
}

/** A seat's tallies, as the screen prints them. */
export function scoreRow(seat: ScoreSeat, researchable: ReadonlyMap<string, number>): ScoreRow {
  const t = seat.tally;
  return {
    player: seat.player, name: seat.name, race: seat.race, team: seat.team, color: seat.color, won: seat.won,
    unitScore: t.valueGained + t.valueDestroyed,
    heroScore: t.xpGained * HERO_SCORE_PER_XP,
    resourceScore: t.goldMined + t.lumberHarvested,
    unitsProduced: t.unitsProduced,
    unitsKilled: t.unitsKilled,
    buildingsProduced: t.buildingsProduced,
    buildingsRazed: t.buildingsRazed,
    largestArmy: t.largestArmy,
    // "trained heroes are sorted by their XP, not in chronological order" (matchStats.ts header)
    heroes: [...seat.heroes].sort((a, b) => b.xp - a.xp),
    heroesKilled: t.heroesKilled,
    itemsObtained: t.itemsObtained,
    mercenariesHired: t.mercenariesHired,
    experienceGained: t.xpGained,
    goldMined: t.goldMined,
    lumberHarvested: t.lumberHarvested,
    resourcesSent: t.resourcesSent,
    resourcesReceived: t.resourcesReceived,
    techPercent: techPercent(researchable, seat.research),
    upkeepLost: t.upkeepLost,
  };
}

/** The Overview tab's last column — the other three summed. */
export const totalScore = (r: ScoreRow): number => r.unitScore + r.heroScore + r.resourceScore;
