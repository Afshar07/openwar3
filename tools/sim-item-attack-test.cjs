// Headless check that an ITEM lying on the ground can be ATTACKED and broken (issue #186):
// "items have 75 hit points and can be destroyed by attacking them directly". The Attack
// command aimed at an item is `attackitem` (SimWorld.issueAttackItem); who may strike one is
// the weapon slot's own Targets Allowed (`item`), and each of the four deliveries — a melee
// blow, a hitscan, a missile, an artillery shell — has to land on it.
//
// Every unit and item here is built from the install's own rows (`pnpm data:extract`).
//
// Run: pnpm sim:test
const { join } = require("node:path");
const fs = require("node:fs");
const REPO = join(__dirname, "..");
fs.writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld, weaponsFromDef } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { loadAbilityRegistry, KNOWN_ABILITIES } = require(join(REPO, ".sim-build", "src", "data", "abilities.js"));
const { loadUnitRegistry, autoArmed } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { loadItemRegistry } = require(join(REPO, ".sim-build", "src", "data", "items.js"));

const EXTRACT = join(REPO, "Warcraft III", "ExtractedData", "merged");
if (!fs.existsSync(join(EXTRACT, "Units", "AbilityData.slk"))) {
  console.log("skip  no extracted game data (run `pnpm data:extract`)");
  process.exit(0);
}
/** The unpacked install as a DataSource: exactly the files the loaders name, read off disk.
 *  Case-insensitively, as the store itself is — the extractor kept the archive's own casing
 *  (`Units\\unitUI.slk`), and the loaders ask by the game's. */
const vfs = {
  label: "ExtractedData",
  rawBytes(p) {
    const parts = p.split("\\");
    let dir = EXTRACT;
    for (const part of parts) {
      const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === part.toLowerCase());
      if (!hit) return null;
      dir = join(dir, hit);
    }
    return new Uint8Array(fs.readFileSync(dir));
  },
  exists: () => false, // model variants are the renderer's business
  list: () => [],
};
const ABILITIES = loadAbilityRegistry(vfs);
const UNITS = loadUnitRegistry(vfs);
const ITEMS = loadItemRegistry(vfs);

let failed = 0;
function check(what, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${want}, got ${got}`);
}

const W = 200, H = 200;
function world() {
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  const w = new SimWorld(grid, 1, ABILITIES, ITEMS, UNITS);
  return w;
}

/** A unit from its own row — the same mapping RtsController.addSimUnit makes, minus what a
 *  headless fight never reads. */
let nextId = 1;
function spawn(w, typeId, x, y, owner, team) {
  const def = UNITS.get(typeId);
  if (!def) throw new Error(`no unit ${typeId}`);
  const abilities = [];
  for (const id of def.abilities) {
    const a = ABILITIES.get(id);
    if (a && KNOWN_ABILITIES[a.code]) abilities.push({ id, code: a.code, level: 1, cooldownLeft: 0, autocastOn: autoArmed(def, id, a.code) });
  }
  const u = w.add(
    {
      id: nextId++, owner, team, race: def.race, typeId: def.id, x, y, facing: 0,
      speed: def.speed, turnRate: def.turnRate, radius: def.collision || 16, flying: false, flyHeight: 0,
      sightDay: def.sightDay || 1400, sightNight: def.sightNight || 800,
      hp: def.hitPoints, maxHp: def.hitPoints, mana: def.mana, maxMana: def.mana,
      armor: def.armor, armorType: def.armorType, weapons: weaponsFromDef(def),
      castPoint: def.castPoint, castBackswing: def.castBackswing, targetedAs: "ground", moveType: "foot",
      worker: null, depotGold: false, depotLumber: false,
    },
    null,
    { abilities, level: def.level, isPeon: def.classification.includes("peon") },
  );
  return u;
}

const run = (w, seconds) => { for (let i = 0; i < seconds * 20; i++) w.tick(0.05); };
const broke = (w, id) => w.drainItemRemovals().some((r) => r.id === id && r.died);

console.log("an item lies on the ground with its ItemData HP");
{
  const w = world();
  const id = w.createItem("phea", 1000, 1000);
  const it = w.items.get(id);
  check("a Potion of Healing has 75 hit points", it.hp, 75);
  check("…out of 75", it.maxHp, 75);
}

for (const [typeId, what] of [["hfoo", "a Footman's melee blow"], ["hrif", "a Rifleman's hitscan"], ["earc", "an Archer's arrow"], ["hmtm", "a Mortar Team's shell"]]) {
  console.log(`\n${what} breaks an item`);
  const w = world();
  const id = w.createItem("phea", 1600, 1000);
  const u = spawn(w, typeId, 1000, 1000, 0, 0);
  check("the unit carries a weapon that may strike an item", !!w.weaponVsItem(u), true);
  check("the Attack order on the item is taken", w.issueOrder(u.id, { kind: "attackitem", itemId: id }), true);
  run(w, 4);
  const it = w.items.get(id);
  check("…and it has been struck", !it || it.hp < 75, true);
  run(w, 40);
  check("…until it breaks", w.items.has(id), false);
  check("…which plays its Death clip (removed as `died`)", broke(w, id), true);
  check("…and the attacker stands down", u.order, "idle");
}

console.log("\nwhat the Attack order on an item refuses");
{
  const w = world();
  const id = w.createItem("phea", 1200, 1000);
  const f = spawn(w, "hfoo", 1000, 1000, 0, 0);
  w.setItemInvulnerable(id, true);
  check("an invulnerable item (SetItemInvulnerable) is refused", w.issueOrder(f.id, { kind: "attackitem", itemId: id }), false);
  w.setItemInvulnerable(id, false);
  check("…and taken again once it is not", w.issueOrder(f.id, { kind: "attackitem", itemId: id }), true);
  const gone = w.createItem("phea", 1300, 1300);
  w.removeItemById(gone);
  check("an item that is gone is refused", w.issueOrder(f.id, { kind: "attackitem", itemId: gone }), false);
}

console.log("\nthe order ends when the item is picked up");
{
  const w = world();
  const id = w.createItem("phea", 1500, 1000);
  const f = spawn(w, "hfoo", 1000, 1000, 0, 0);
  w.issueOrder(f.id, { kind: "attackitem", itemId: id });
  run(w, 0.5);
  w.removeItemById(id); // somebody walked off with it
  run(w, 1);
  check("the Footman stops", f.order, "idle");
}

console.log("\nSetWidgetLife on an item");
{
  const w = world();
  const id = w.createItem("phea", 1000, 1000);
  w.setItemLife(id, 20);
  check("sets its hit points", w.itemSnapshot(id).life, 20);
  w.setItemLife(id, 500);
  check("…capped at its type's", w.itemSnapshot(id).life, 75);
  w.setItemLife(id, 0);
  check("…and 0 breaks it", w.items.has(id), false);
}

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
