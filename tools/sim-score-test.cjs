// Headless checks on what the SCORE SCREEN counts (issue #199, src/sim/matchStats.ts) and how the
// finished table is composed (src/game/scoreTable.ts).
//
// Nothing in the install says what the score screen's columns mean, so the rules are the ones
// the community measured off the real client (warcraft3.info article 394) — and the cheapest of
// them to get silently wrong are the ones pinned here: a DENY is not a kill, a creep is nobody's
// killer, a hero's head is worth 1005 a level, a summon is a unit produced but worth nothing,
// upkeep is counted as what it TOOK, and Tech Percentage rounds DOWN.
//
// The last section walks the real tech tree (needs `pnpm data:extract`): the four starting Unit
// Scores the article quotes come out of the TABLES exactly, and so do two of its four Tech
// Percentage denominators.
//
// Run: pnpm sim:test
const fs = require("node:fs");
const { join } = require("node:path");
const REPO = join(__dirname, "..");
const BUILD = join(REPO, ".sim-build");
fs.writeFileSync(join(BUILD, "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(BUILD, "src", "sim", "world.js"));
const { PathingGrid } = require(join(BUILD, "src", "sim", "pathing.js"));
const { MatchStats, techPercent, HERO_KILL_VALUE } = require(join(BUILD, "src", "sim", "matchStats.js"));
const { scoreRow, totalScore, researchableFor } = require(join(BUILD, "src", "game", "scoreTable.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// The real prices, out of Units\UnitBalance.slk.
const TYPES = {
  hfoo: { goldCost: 135, lumberCost: 0, deathTime: 3, isHero: false },
  hpea: { goldCost: 75, lumberCost: 0, deathTime: 3, isHero: false },
  halt: { goldCost: 180, lumberCost: 50, deathTime: 3, isHero: false },
  hkee: { goldCost: 705, lumberCost: 415, deathTime: 3, isHero: false },
  Hpal: { goldCost: 425, lumberCost: 100, deathTime: 1.5, isHero: true },
  osw1: { goldCost: 0, lumberCost: 0, deathTime: 1, isHero: false }, // a Spirit Wolf
};
const registry = { get: (id) => TYPES[id] };

let nextId = 1;
function unit(over = {}) {
  return {
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", race: "human", isHero: false, properName: "",
    level: 1, xp: 0, skillPoints: 0, abilities: [], inventory: [],
    baseStr: 10, baseAgi: 10, baseInt: 10, baseMaxHp: 100,
    hp: 100, maxHp: 100, mana: 0, maxMana: 0, x: 500, y: 500,
    sightDay: 1400, sightNight: 800, baseSightDay: 1400, baseSightNight: 800,
    flying: false, mechanical: false, isSummon: false,
    isCreep: false, neutralPassive: false, isIllusion: false,
    buffs: [], weapons: [], orderQueue: [], path: [], footprint: 0, hasReservation: false,
    building: null, worker: null, order: "idle", targetId: null, moving: false,
    garrison: [], garrisonCap: 0, inMine: false, inBurrow: false, insideBuild: false,
    summonLeft: 0, constructing: 0, mineId: 0, entangledBy: 0, heldCorpses: [],
    noCollision: false, radius: 16, facing: 0,
    ...over,
  };
}
const BUILDING = () => ({ constructionLeft: 0, builderIds: [], queue: [], rallyX: 0, rallyY: 0, rallyKind: "none", rallyTargetId: 0 });

function worldOf() {
  const grid = new PathingGrid({ width: 64, height: 64, flags: new Uint8Array(64 * 64) }, [0, 0]);
  return new SimWorld(grid, 1, { get: () => undefined }, undefined, registry);
}
const put = (w, u) => { w.units.set(u.id, u); return u; };

console.log("\nwhat a kill is worth, and to whom");
{
  const w = worldOf();
  const blade = put(w, unit({ owner: 0, team: 0 }));
  const peasant = put(w, unit({ owner: 1, team: 1, typeId: "hpea" }));
  const altar = put(w, unit({ owner: 1, team: 1, typeId: "halt", building: BUILDING() }));
  const hero = put(w, unit({ owner: 1, team: 1, typeId: "Hpal", isHero: true, level: 3 }));
  w.kill(peasant, blade.id);
  w.kill(altar, blade.id);
  w.kill(hero, blade.id);
  const t = w.stats.of(0);
  check("an enemy unit is a Units Killed", t.unitsKilled, 2); // the peasant and the hero
  check("…a building a Buildings Razed", t.buildingsRazed, 1);
  check("…a hero a Heroes Killed too", t.heroesKilled, 1);
  // 75 for the peasant, 230 for the altar, and the hero by its LEVEL, not its price.
  check("the value lands in Unit Score: cost for a unit, 1005 a level for a hero",
    t.valueDestroyed, 75 + 230 + HERO_KILL_VALUE * 3);
  check("the victim's side scores nothing for dying", w.stats.has(1) ? w.stats.of(1).unitsKilled : 0, 0);
}
{
  const w = worldOf();
  const a = put(w, unit({ owner: 0, team: 0 }));
  const own = put(w, unit({ owner: 0, team: 0 }));
  w.kill(own, a.id);
  check("a DENY is not a kill (\"ignores denies\")", w.stats.has(0) ? w.stats.of(0).unitsKilled : 0, 0);
}
{
  const w = worldOf();
  const creep = put(w, unit({ owner: 24, team: -1, isCreep: true }));
  const victim = put(w, unit({ owner: 0, team: 0 }));
  w.kill(victim, creep.id);
  check("a creep is nobody's killer", w.stats.has(24) ? w.stats.of(24).unitsKilled : 0, 0);
}
{
  const w = worldOf();
  const victim = put(w, unit({ owner: 0, team: 0 }));
  w.kill(victim, 0);
  check("a death with no killer credits nobody", [...[0, 1]].map((p) => (w.stats.has(p) ? w.stats.of(p).unitsKilled : 0)), [0, 0]);
}

console.log("\nwhat a player comes to own");
{
  const w = worldOf();
  const foot = put(w, unit({ owner: 0 }));
  const wolf = put(w, unit({ owner: 0, typeId: "osw1", isSummon: true }));
  const alt = put(w, unit({ owner: 0, typeId: "halt", building: BUILDING() }));
  const image = put(w, unit({ owner: 0, isIllusion: true }));
  w.noteGained(foot.id);
  w.noteGained(wolf.id, true);
  w.noteGained(alt.id);
  w.noteGained(image.id);
  const t = w.stats.of(0);
  check("a unit and a summon are Units Produced; an illusion is not", t.unitsProduced, 2);
  check("a building is a Buildings Produced", t.buildingsProduced, 1);
  check("…and only what was PAID FOR scores: the Footman and the Altar, not the wolf", t.valueGained, 135 + 230);
}

console.log("\nexperience, and the Hero Score made of it");
{
  const w = worldOf();
  const hero = put(w, unit({ owner: 0, typeId: "Hpal", isHero: true, level: 1, xp: 0 }));
  w.gainXp(hero, 150);
  w.gainXp(put(w, unit({ owner: 0, isIllusion: true, isHero: true })), 500); // an image banks nothing
  check("what the bar moved is Experience Gained", w.stats.of(0).xpGained, 150);
}

console.log("\nthe Largest Army sample");
{
  const s = new MatchStats();
  s.of(0);
  let food = 12;
  s.tick(0.1, () => food);
  food = 30; s.tick(0.5, () => food); // inside the same second — not sampled yet
  food = 20; s.tick(0.5, () => food);
  check("it keeps the peak it saw, sampled once a second", s.of(0).largestArmy, 20);
  food = 44; s.tick(1, () => food);
  food = 5; s.tick(1, () => food);
  check("…and never comes down", s.of(0).largestArmy, 44);
}

console.log("\nupkeep, and trades");
{
  const s = new MatchStats();
  s.mined(0, 7, 3); // a ten-gold load at Low Upkeep banks seven
  s.mined(0, 10, 0);
  check("Gold Mined is what was BANKED", s.of(0).goldMined, 17);
  check("…and Gold Lost to Upkeep what the band kept", s.of(0).upkeepLost, 3);
  s.traded(0, 1, 100, 50);
  check("a gift is sent by one side and received by the other", [s.of(0).resourcesSent, s.of(1).resourcesReceived], [150, 150]);
}

console.log("\nthe finished row");
{
  const s = new MatchStats();
  s.gained(0, 965, false);
  s.destroyed(0, 300, false, false);
  s.xp(0, 400);
  s.mined(0, 1000, 0);
  s.harvested(0, 250);
  const row = scoreRow({
    player: 0, name: "P", race: "human", team: 0, color: 0, won: true, tally: s.of(0),
    heroes: [{ typeId: "Hamg", icon: "", level: 2, xp: 300 }, { typeId: "Hpal", icon: "", level: 5, xp: 1200 }],
    research: new Map([["Rhme", 2]]),
  }, new Map([["Rhme", 3], ["Rhar", 3], ["Rhde", 1]]));
  check("Unit Score = value gained + value destroyed", row.unitScore, 1265);
  check("Hero Score = experience × 10", row.heroScore, 4000);
  check("Resource Score = gold mined + lumber harvested", row.resourceScore, 1250);
  check("Total Score sums the three", totalScore(row), 1265 + 4000 + 1250);
  check("Heroes Used is sorted by experience, not by arrival", row.heroes.map((h) => h.typeId), ["Hpal", "Hamg"]);
  check("Tech Percentage rounds DOWN (2 of 7 ranks is 28.57…)", row.techPercent, 28);
}
check("a race with no research is 0%, not NaN", techPercent(new Map(), new Map()), 0);

console.log("\nthe real tech tree (pnpm data:extract)");
const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "UnitBalance.slk"))) {
  console.log("  skip  no extracted install");
} else {
  const { PatchDataSource } = require(join(BUILD, "src", "vfs", "patch.js"));
  const { EditionDataSource } = require(join(BUILD, "src", "vfs", "edition.js"));
  const { loadTechRegistry } = require(join(BUILD, "src", "data", "techtree.js"));
  const { loadUpgradeRegistry } = require(join(BUILD, "src", "data", "upgrades.js"));
  const { loadUnitRegistry } = require(join(BUILD, "src", "data", "units.js"));
  const { STARTING_UNITS } = require(join(BUILD, "src", "data", "races.js"));
  const onDisk = (p) => {
    let dir = EXTRACT;
    for (const part of p.replace(/\//g, "\\").split("\\")) {
      if (!part) continue;
      let hit;
      try { hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase()); } catch { return null; }
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return fs.statSync(dir).isFile() ? dir : null;
  };
  const base = {
    label: "ExtractedData",
    exists: (p) => onDisk(p) !== null,
    rawBytes: (p) => { const f = onDisk(p); return f ? new Uint8Array(fs.readFileSync(f)) : null; },
    read: async (p) => base.rawBytes(p),
    list: () => [],
  };
  const vfs = new EditionDataSource(new PatchDataSource(base));
  const units = loadUnitRegistry(vfs);
  // The article's starting Unit Scores — "1005, 965, 945, and 825 for Undead, Human, Orc, and NE"
  // — are the starting units' gold + lumber, the Undead's including the Haunted Gold Mine
  // `MeleeStartingUnitsUndead` blights onto the nearest mine.
  const start = (race, extra = []) =>
    [...STARTING_UNITS[race].flatMap((s) => Array(s.count).fill(s.id)), ...extra]
      .reduce((sum, id) => sum + units.get(id).goldCost + units.get(id).lumberCost, 0);
  check("the four starting Unit Scores are the article's", [start("undead", ["ugol"]), start("human"), start("orc"), start("nightelf")], [1005, 965, 945, 825]);

  const tech = loadTechRegistry(vfs);
  const ups = loadUpgradeRegistry(vfs);
  const ranks = (race) => [...researchableFor(race, tech, ups).values()].reduce((a, b) => a + b, 0);
  check("Tech Percentage's denominators: Orc 29 and Undead 27, as the article counts", [ranks("orc"), ranks("undead")], [29, 27]);
  // One short of the article's 36 and 32 — see scoreTable.ts `researchableFor` for why that is
  // pinned as measured rather than forced.
  check("…Human 35 and Night Elf 31 on our tables", [ranks("human"), ranks("nightelf")], [35, 31]);
}

console.log(failed ? `\nscore screen: ${failed} CHECK(S) FAILED` : "\nscore screen: all checks passed");
process.exit(failed ? 1 : 0);
