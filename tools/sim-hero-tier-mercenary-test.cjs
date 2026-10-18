// Two things a unit you have NOT trained must not do to your tech tree.
//
//   • An ILLUSION is not a hero you own. A Blademaster's Mirror Image is the same TYPE as the
//     hero it copies, and the hero roster (`Authority.heroCensus`) counted it — so with one
//     image out, an orc at a Stronghold was told the altar's next hero was its THIRD and that
//     it "Requires: Fortress" (`[Obla] Requirescount=3, Requires1=ostr, Requires2=ofrt`).
//
//   • A MERCENARY's abilities are its own. A Forest Troll Shadow Priest hired at a Mercenary
//     Camp carries Abolish Magic (Creep), whose row names the night elf research
//     (`[ACdm] Requires=Resi`, NeutralAbilityFunc.txt). A neutral owner is exempt from that
//     (`techMeets`), but the hired priest is the BUYER's — and an orc can never research Resi,
//     so the button was dead for good. A unit a shop sold keeps every ability live
//     (`SimUnit.mercenary`, `SimWorld.unitMeets`), and the flag crosses the wire for a LAN
//     client's command card.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));
const { TechRegistry } = require(join(REPO, ".sim-build", "src", "data", "techtree.js"));
const { UpgradeRegistry } = require(join(REPO, ".sim-build", "src", "data", "upgrades.js"));
const { UnitRegistry } = require(join(REPO, ".sim-build", "src", "data", "units.js"));
const { Authority } = require(join(REPO, ".sim-build", "src", "game", "authority.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const unit = (id, over) => ({
  id, name: id, isHero: false, isBuilding: false, goldCost: 0, lumberCost: 0, buildTime: 10,
  foodUsed: 0, foodMade: 0, ...over,
});
const hero = (id) => unit(id, { isHero: true, goldCost: 425, lumberCost: 100, buildTime: 55, foodUsed: 5 });
const HEROES = ["Obla", "Ofar", "Otch", "Oshd"];
const units = new UnitRegistry(new Map([
  ["oalt", unit("oalt", { isBuilding: true })],
  ["ostr", unit("ostr", { isBuilding: true, foodMade: 100 })],
  ["nmer", unit("nmer", { isBuilding: true })],
  ["nfsp", unit("nfsp", { goldCost: 135, foodUsed: 2 })],
  ...HEROES.map((h) => [h, hero(h)]),
]));
const techNode = (id, over = {}) => [id, {
  id, name: id, requiresTiers: [[]], requiresAmount: [], dependencyOr: [], trains: [], researches: [],
  builds: [], upgrade: [], makeitems: [], sellitems: [], sellunits: [], revive: false, ...over,
}];
// The orc heroes' three tiers exactly as OrcUnitFunc.txt has them, and the creep Abolish Magic's
// one requirement as NeutralAbilityFunc.txt has it.
const tech = new TechRegistry(new Map([
  techNode("oalt", { trains: HEROES, revive: true }),
  techNode("ostr"),
  techNode("nmer", { sellunits: ["nfsp"] }),
  techNode("ACdm", { requiresTiers: [["Resi"]] }),
  ...HEROES.map((h) => techNode(h, { requiresTiers: [[], ["ostr"], ["ofrt"]] })),
]));
const upgrades = new UpgradeRegistry(new Map());

const grid = new PathingGrid({ width: 32, height: 32, flags: new Uint8Array(32 * 32) }, [0, 0]);
const world = new SimWorld(grid, 1, undefined, undefined, units, tech, upgrades);
const authority = new Authority(world, units, { get: () => undefined }, tech, upgrades);

let nextId = 1;
function put(typeId, owner, over = {}) {
  const u = { id: nextId++, owner, team: owner, typeId, hp: 100, x: 0, y: 0, isIllusion: false, mercenary: false, abilities: [], ...over };
  world.units.set(u.id, u);
  world.tech.invalidate();
  return u;
}

world.initStash(0, 100000, 100000);
const altar = put("oalt", 0, { building: { queue: [], constructionLeft: 0 } });
put("ostr", 0, { building: { queue: [], constructionLeft: 0 } });
const bm = put("Obla", 0);

console.log("a Mirror Image is not a second hero");
{
  check("one Blademaster is one hero", authority.heroCount(0), 1);
  check("…so the second hero needs only the Stronghold", world.canMake(0, "Ofar", authority.heroCount(0)), true);
  put("Obla", 0, { isIllusion: true, illusionOf: bm.id });
  check("with an image out, still one hero", authority.heroCount(0), 1);
  check("…and the Blademaster is still one of his type", authority.heroCensus(0).get("Obla"), 1);
  check("…and the Far Seer can still be trained at a Stronghold",
    authority.execute(0, { c: "train", buildingId: altar.id, unitId: "Ofar" }), true);
  check("the altar's queue holds that second hero", altar.building.queue.map((j) => j.unitId), ["Ofar"]);
  check("…and the third would need the Fortress", world.canMake(0, "Otch", authority.heroCount(0)), false);
}

console.log("\na mercenary's abilities are live whatever its buyer researched");
{
  const camp = put("nmer", -1, { neutralPassive: true, building: { queue: [], constructionLeft: 0 } });
  const charmed = put("nfsp", 0, { abilities: [{ id: "ACdm", code: "ACdm", level: 1 }] });
  check("a creep that is merely OURS still needs Resi (the charmed quirk)", world.unitMeets(charmed, "ACdm"), false);
  check("…and the creep camp's own priest needs nothing", world.unitMeets({ owner: -1, mercenary: false }, "ACdm"), true);
  const hired = put("nfsp", 0, { abilities: [{ id: "ACdm", code: "ACdm", level: 1 }] });
  world.noteTrainFinish(camp.id, hired.id);
  check("a priest the camp SOLD is a mercenary", hired.mercenary, true);
  check("…and its Abolish Magic is live for an orc", world.unitMeets(hired, "ACdm"), true);
  check("a hero bought at a shop is no mercenary", (() => {
    const h = put("Oshd", 0);
    world.noteTrainFinish(camp.id, h.id);
    return h.mercenary;
  })(), false);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall hero-tier / mercenary checks passed");
