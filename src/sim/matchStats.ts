// The figures the SCORE SCREEN prints (issue #199) — what the match counts as it is played, per
// player, on the machine that steps the sim.
//
// The screen's four tabs and their columns are the game's own (`UI\FrameDef\GlobalStrings.fdf`:
// `OVERVIEW_COLUMN0..3`, `UNIT_COLUMN0..4`, `HEROES_COLUMN0..4`, `RESOURCES_COLUMN0..4`); what goes
// into each is written down nowhere in the install, so every rule here is the one the community
// measured off the real client, chiefly AlbZ's "Warcraft 3: beyond APM" (warcraft3.info article
// 394, read against 201 620 W3Champions score screens):
//
//   Unit Score      the gold + lumber of everything the player came to own — trained, built,
//                   upgraded into, or handed over at the start — plus the same value of every
//                   enemy or neutral unit killed and building razed. Checked against the article's
//                   four starting figures and they come out EXACTLY: Human 965 (Town Hall 385+205,
//                   five Peasants at 75), Orc 945, Night Elf 825 (Tree of Life 340+185, five Wisps
//                   at 60), Undead 1005 (Necropolis 225, three Acolytes, a Ghoul at 120 AND the
//                   Haunted Gold Mine at 225+210, which `MeleeStartingUnitsUndead` creates).
//                   Summons score nothing. A hero kill is worth "1005 at level 1, proportionate to
//                   level" — the article's own data point and wording, so `HERO_KILL_VALUE × level`.
//                   NOT reproduced: the article notes a few per-object bonuses on top of the cost
//                   (an Altar scores 270 against its 230, a first hero 550 against 525, a tier-up
//                   +40) whose rule it could not state, and neither can we — so we score the cost.
//   Hero Score      the experience the player's heroes earned, × 10.
//   Resource Score  the gold mined and the lumber harvested — bounty and item sales excluded.
//   Units Produced  every unit the player came to own, starting units and summons included.
//   Units Killed    enemy AND neutral units killed; a deny is not a kill.
//   Largest Army    the most food the player had in use at any moment. OURS: the column is
//                   never defined anywhere, and food is the measure every console readout of an
//                   army already uses.
//   Heroes Used     the player's heroes, sorted by experience rather than by when they arrived.
//   Tech Percentage researched upgrade levels over those the race can research, rounded down
//                   (computed at the end, not counted here — see `techPercent`).
//   Gold Lost to Upkeep  what the upkeep band took off the gold as it was banked.
//   Resources Traded     what the player SENT and what it RECEIVED, gold and lumber together,
//                   printed "sent / received". OURS: the screen prints two numbers and no
//                   source says which two.
//
// Only the AUTHORITY counts — a LAN client's sim never steps (rts.ts `frozenClient`), so the host
// ships the finished table to it with the screen that ends its game (render/mapViewer.ts).

/** What killing a level-1 hero adds to the killer's Unit Score — see the header. */
export const HERO_KILL_VALUE = 1005;

/** Hero Score is the experience earned, times this — see the header. */
export const HERO_SCORE_PER_XP = 10;

/** How often the Largest Army column samples food in use, in sim seconds. Food only moves when a
 *  unit is born or dies, so a once-a-second look misses nothing a player would call an army. */
export const ARMY_SAMPLE_SECONDS = 1;

/** One player's running tally. */
export interface PlayerTally {
  /** The value half of Unit Score (`valueGained` + `valueDestroyed` is the column). */
  valueGained: number;
  valueDestroyed: number;
  xpGained: number;
  goldMined: number;
  lumberHarvested: number;
  upkeepLost: number;
  unitsProduced: number;
  unitsKilled: number;
  buildingsProduced: number;
  buildingsRazed: number;
  largestArmy: number;
  heroesKilled: number;
  itemsObtained: number;
  mercenariesHired: number;
  resourcesSent: number;
  resourcesReceived: number;
}

function emptyTally(): PlayerTally {
  return {
    valueGained: 0, valueDestroyed: 0, xpGained: 0,
    goldMined: 0, lumberHarvested: 0, upkeepLost: 0,
    unitsProduced: 0, unitsKilled: 0, buildingsProduced: 0, buildingsRazed: 0, largestArmy: 0,
    heroesKilled: 0, itemsObtained: 0, mercenariesHired: 0,
    resourcesSent: 0, resourcesReceived: 0,
  };
}

/** Every player's tally, created on first touch. */
export class MatchStats {
  private readonly tallies = new Map<number, PlayerTally>();
  private sampleIn = 0;

  of(player: number): PlayerTally {
    let t = this.tallies.get(player);
    if (!t) {
      t = emptyTally();
      this.tallies.set(player, t);
    }
    return t;
  }

  /** Has this player been counted at all — the table is built for the seats, not for these. */
  has(player: number): boolean {
    return this.tallies.has(player);
  }

  /** A unit or building came to belong to `player` — trained, hired, built, summoned, created by
   *  the script or placed with the map. `value` is its gold + lumber (0 for a summon). */
  gained(player: number, value: number, structure: boolean): void {
    const t = this.of(player);
    t.valueGained += value;
    if (structure) t.buildingsProduced++;
    else t.unitsProduced++;
  }

  /** A building became a dearer one (Town Hall → Keep): the new type's value, no new building. */
  upgraded(player: number, value: number): void {
    this.of(player).valueGained += value;
  }

  /** `killer` destroyed something of somebody it is hostile to — never a deny. */
  destroyed(killer: number, value: number, structure: boolean, hero: boolean): void {
    const t = this.of(killer);
    t.valueDestroyed += value;
    if (structure) t.buildingsRazed++;
    else t.unitsKilled++;
    if (hero) t.heroesKilled++;
  }

  /** Gold banked from a mine: what arrived, and what the upkeep band took on the way. */
  mined(player: number, banked: number, taxed: number): void {
    const t = this.of(player);
    t.goldMined += banked;
    t.upkeepLost += Math.max(0, taxed);
  }

  harvested(player: number, lumber: number): void {
    this.of(player).lumberHarvested += lumber;
  }

  xp(player: number, amount: number): void {
    if (amount > 0) this.of(player).xpGained += amount;
  }

  item(player: number): void {
    this.of(player).itemsObtained++;
  }

  hired(player: number): void {
    this.of(player).mercenariesHired++;
  }

  traded(from: number, to: number, gold: number, lumber: number): void {
    const sum = Math.max(0, gold) + Math.max(0, lumber);
    if (sum <= 0) return;
    this.of(from).resourcesSent += sum;
    this.of(to).resourcesReceived += sum;
  }

  /** The Largest Army sample — `foodUsed` is asked of every counted player once a second. */
  tick(dt: number, foodUsed: ((player: number) => number) | null): void {
    if (!foodUsed) return;
    this.sampleIn -= dt;
    if (this.sampleIn > 0) return;
    this.sampleIn = ARMY_SAMPLE_SECONDS;
    for (const [player, t] of this.tallies) {
      const used = foodUsed(player);
      if (used > t.largestArmy) t.largestArmy = used;
    }
  }
}

/**
 * Tech Percentage: researched levels over researchable levels, rounded down.
 *
 * The article's denominators are "36, 32, 29, 27 for Human, NE, Orc and UD" — what the RACE can
 * research, every rank of every upgrade its tech tree offers — so this is handed exactly that
 * list (`upgrade id → max level`) and the player's own levels.
 */
export function techPercent(researchable: ReadonlyMap<string, number>, done: ReadonlyMap<string, number>): number {
  let total = 0;
  let have = 0;
  for (const [id, max] of researchable) {
    total += max;
    have += Math.min(max, done.get(id) ?? 0);
  }
  return total > 0 ? Math.floor((100 * have) / total) : 0;
}
