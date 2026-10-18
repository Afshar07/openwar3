// Headless checks on a shift-queued order given to a worker that is GATHERING.
//
// Gathering is the one order that never ends, and the queue pump only starts the next order
// when a unit falls idle — so shift-placing three Burrows with a Peon on the lumber used to
// queue three builds that never ran, while their silhouettes stood on the ground for the rest
// of the match. The rule now (SimWorld.interruptGatherLoop): the queued orders run straight
// away and the worker goes back to the job it left, which is re-queued LAST as a `resume`
// entry and stays last whatever is queued after it. Also checked: a worker that DIES takes
// its queue with it (refunding what was paid), since a corpse holding build orders kept
// their silhouettes up too.
//
// Run: pnpm sim:test
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

const CELL = 32;
const MINE = [2560, 2560];
const MINE_R = 128;
const HALL = [2560 + 900, 2560];

function setup() {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  for (const [cx, cy, half] of [[MINE[0], MINE[1], MINE_R], [HALL[0], HALL[1], 128]]) {
    const cells = (half * 2) / CELL;
    const [x0, y0] = [Math.round((cx - half) / CELL), Math.round((cy - half) / CELL)];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
  }
  const world = new SimWorld(grid, 1);
  world.initStash(0, 1000, 1000);
  const mine = world.addMine(MINE[0], MINE[1], 125000, MINE_R);
  world.add(
    {
      id: 100, owner: 0, team: 0, typeId: "htow", x: HALL[0], y: HALL[1], facing: 0,
      hp: 1500, maxHp: 1500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
      speed: 0, turnRate: 0.6, radius: 128, scale: 1, armor: 5, armorType: "fort", defUp: 0,
      weapon: null, weapons: [], oldWeapons: [], sight: 1800, nsight: 1200, baseSight: 1800,
      sightDay: 1800, sightNight: 1200, flying: false, mechanical: false, invulnerable: false,
      race: "human", isBuilding: true, foodCost: 0, goldCost: 0, lumberCost: 0, abilities: [],
      upgrades: [], moveType: "foot", collisionSize: 72, canFlee: false, targetedAs: "structure",
      deathTime: 2, name: "Town Hall", worker: null, depotGold: true, depotLumber: true,
      castPoint: 0, castBackswing: 0,
    },
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: HALL[0], rallyY: HALL[1], rallyKind: "point", rallyTargetId: 0, producesUnits: true },
  );
  world.add({
    id: 1, owner: 0, team: 0, typeId: "hpea", x: HALL[0] - 300, y: HALL[1], facing: 0,
    hp: 220, maxHp: 220, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 190, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 1, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: "Peasant", castPoint: 0, castBackswing: 0,
    worker: { gold: true, lumber: true, lumberCapacity: 10, baseLumberCapacity: 10, lumberPerChop: 1, chopPeriod: 1, damagesTree: true, carryGold: 0, carryLumber: 0 },
    depotGold: false, depotLumber: false, isPeon: true,
  });
  if (!world.issueHarvest(1, "gold", mine.id)) throw new Error("issueHarvest refused");
  return { world, mine, w: world.units.get(1) };
}

const DT = 1 / 30;
const site = (i) => ({ kind: "buildnew", defId: "otrb", x: 1600 + i * 192, y: 1600, gold: 160, lumber: 40, paid: false });
const shape = (q) => q.map((o) => (o.kind === "buildnew" ? `build@${o.x}` : `${o.kind}${o.resume ? "(resume)" : ""}`));

console.log("a shift-queued build interrupts the harvest loop, and the worker goes back to work");
{
  const { world, mine, w } = setup();
  for (let t = 0; t < 3 / DT; t++) world.tick(DT); // well into the loop
  check("the worker is on the gold", [w.order === "harvest" || w.order === "return", w.resId], [true, mine.id]);
  world.queueOrder(1, site(0));
  world.queueOrder(1, site(1));
  world.tick(DT);
  check("the first build is live at once, priced as it sets off",
    [w.buildPending && w.buildPending.x, w.buildPending && w.buildPending.paid], [1600, true]);
  check("…the rest wait, with the mine to go back to LAST", shape(w.orderQueue), ["build@1792", "harvest(resume)"]);
  world.queueOrder(1, site(2));
  check("a build queued after that still goes in front of the job", shape(w.orderQueue), ["build@1792", "build@1984", "harvest(resume)"]);
  // The renderer raises the foundation; headless, the raise is what assignBuilder's clearing
  // of the intent amounts to for the queue — stand in for it and let the pump carry on.
  for (const x of [1600, 1792, 1984]) {
    check(`the worker is sent to build @${x}`, w.buildPending && w.buildPending.x, x);
    w.buildPending = null;
    world.stop(1);
    world.tick(DT);
  }
  check("…and once the queue is through it is back on the same mine", [w.order, w.resKind, w.resId, w.orderQueue.length], ["harvest", "gold", mine.id, 0]);
}

console.log("\na gather order the player queues replaces the remembered job");
{
  const { world, w } = setup();
  for (let t = 0; t < 3 / DT; t++) world.tick(DT);
  world.queueOrder(1, site(0));
  world.tick(DT);
  world.queueOrder(1, { kind: "harvest", res: "lumber", nodeId: 999 });
  check("the player's harvest is the end of the queue, and there is only one", shape(w.orderQueue), ["harvest"]);
}

console.log("\nan idle worker's queue is unchanged: nothing is invented to go back to");
{
  const { world, w } = setup();
  world.stop(1);
  w.resKind = null; w.resId = 0;
  world.queueOrder(1, site(0));
  world.queueOrder(1, site(1));
  world.tick(DT);
  check("first build live, second queued, no resume entry", [w.buildPending && w.buildPending.x, shape(w.orderQueue)], [1600, ["build@1792"]]);
}

console.log("\na worker that dies takes its queued builds with it");
{
  const { world, w } = setup();
  world.stop(1);
  w.orderQueue.push({ ...site(0), paid: true }, site(1));
  const before = world.stashOf(0).gold;
  world.killUnit(1);
  check("its queue is empty", w.orderQueue.length, 0);
  check("…and the one it had already paid for comes back", world.stashOf(0).gold - before, 160);
}

if (failed) {
  console.log(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall gather-queue checks passed");
