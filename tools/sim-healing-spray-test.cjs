// Headless check that HEALING SPRAY (`ANhs`) keeps the Alchemist on the spray for as long as he
// performs it (issue #203). `[ANhs] Animnames = spell,looping` is not a channel, but the gesture
// runs DataF waves one DataB second apart (3/4/5s), and the cast order used to end at the 0.9s
// backswing — leaving him idle mid-spray, and an idle hero acquires: he went on swinging at
// whatever stood beside him while the gesture still read as spraying.
//
//   - he does not attack anything while the spray runs, and is on the cast order throughout;
//   - he goes back to fighting on his own once it is done;
//   - a player order still walks him out of it, and the spray (a field) keeps falling.
//
// Numbers are the install's 1.30.4 `[ANhs]` rank 1 (Units\AbilityData.slk): DataA 30 heal,
// DataB 1s interval, DataC 6 bottles, DataD 280 cap, DataF 3 waves, Area1 250; the Alchemist's
// own castBackswing (UnitBalance `[Nalc]`) 0.9.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

const D = (...v) => { const a = new Array(9).fill(NaN); v.forEach((x, i) => { a[i] = x; }); return a; };
const ABILITIES = {
  ANhs: {
    id: "ANhs", code: "ANhs", target: "point", targetFlags: ["air", "ground", "friend", "self", "vuln", "invu"],
    lightning: [], buffFx: [], buffArt: "", targetArt: "", casterArt: "", specialArt: "", effectArt: "", areaArt: "",
    fxArt: "", fxSpecialArt: "", missileArt: "", missileSpeed: 700, missileArc: 0.4, animNames: ["spell", "looping"], isItem: false,
    levelData: [{ cost: 0, cooldown: 0, castRange: 800, area: 250, duration: 0, heroDuration: 0, castTime: 0, data: D(30, 1, 6, 280, NaN, 3), buffs: [], summon: "" }],
  },
};

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// A melee slot (both the live and the base* halves — recomputeStats re-derives one from the other).
const WEAPON = () => ({
  enabled: true, targets: ["ground", "air", "structure"], ranged: false,
  damage: 20, baseDamage: 20, dice: 1, baseDice: 1, sides: 1,
  cooldown: 1, baseCooldown: 1, range: 100, baseRange: 100, rangeBuffer: 250,
  damagePoint: 0.3, baseDamagePoint: 0.3, backswing: 0.3, baseBackswing: 0.3,
  spillDist: 0, spillRadius: 0, baseSpillDist: 0, baseSpillRadius: 0, damageLoss: 0,
  acquire: 500, attackType: "hero", missileArt: "", missileSpeed: 0,
  launchX: 0, launchY: 0, launchZ: 0, impactZ: 0,
});

function world() {
  const W = 128, H = 128;
  const g = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [-(W * 32) / 2, -(H * 32) / 2]);
  const w = new SimWorld(g, 1);
  w.abilities = { get: (id) => ABILITIES[id], has: (id) => id in ABILITIES, all: () => Object.values(ABILITIES), buffFx: () => [] };
  return w;
}

let nextId = 1;
function add(w, over) {
  const weapons = over.weapons ?? [];
  const u = w.add({
    id: nextId++, owner: 0, team: 0, typeId: "hfoo", x: 0, y: 0, facing: 0,
    hp: 100000, maxHp: 100000, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 100, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    sight: 1400, nsight: 1400, baseSight: 1400, sightDay: 1400, sightNight: 1400,
    castPoint: 0, castBackswing: 0,
    flying: false, mechanical: false, invulnerable: false, race: "orc",
    isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0,
    abilities: [], upgrades: [], moveType: "foot", collisionSize: 16,
    canFlee: true, targetedAs: "ground", deathTime: 2, name: "Unit",
    worker: null, depotGold: false, depotLumber: false,
    ...over, weapons, oldWeapons: weapons,
  });
  u.x = over.x ?? 0;
  u.y = over.y ?? 0;
  return u;
}
const step = (w, seconds, dt = 0.05) => { for (let i = 0; i < Math.round(seconds / dt); i++) w.tick(dt); };

/** The Alchemist at the origin with an enemy Grunt in melee reach beside him, spraying the
 *  ground at his own feet. */
function scene() {
  const w = world();
  const alc = add(w, { name: "Alchemist", castPoint: 0.3, castBackswing: 0.9, weapons: [WEAPON()] });
  alc.isHero = true;
  alc.abilities = [{ id: "ANhs", code: "ANhs", level: 1, cooldownLeft: 0, autocastOn: false }];
  const foe = add(w, { owner: 1, team: 1, x: 60, name: "Grunt" });
  step(w, 0.05);
  const ok = w.issueCast(alc.id, "ANhs", 0, alc.x, alc.y);
  return { w, alc, foe, ok };
}
const fields = (w) => w.activeSpellFields().filter((f) => f.code === "ANhs").length;

{
  const s = scene();
  check("the cast goes through", s.ok, true);
  step(s.w, 0.35); // past the 0.3s cast point: the spray is on the ground
  check("the spray is falling", fields(s.w), 1);
  const hp = s.foe.hp;
  let orders = new Set();
  for (let t = 0; t < 2.8; t += 0.05) { step(s.w, 0.05); orders.add(s.alc.order); }
  check("he does NOT swing at the Grunt beside him while he sprays (3 waves = 3s)", s.foe.hp, hp);
  check("…and holds the cast order the whole time, not the 0.9s backswing", [...orders], ["cast"]);
  step(s.w, 2);
  check("once it is done he goes back to fighting on his own", s.foe.hp < hp, true);
}

{
  const s = scene();
  step(s.w, 0.35);
  s.w.issueOrder(s.alc.id, { kind: "move", x: -400, y: 0 });
  step(s.w, 0.1);
  check("a player's move order walks him out of the spray", s.alc.order, "move");
  check("…and the spray keeps falling (it is a field, not a channel)", fields(s.w), 1);
}

console.log(`\n${failed ? `${failed} FAILED` : "all passed"}`);
process.exit(failed ? 1 : 0);
