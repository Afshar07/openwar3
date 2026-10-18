// Headless check that a unit can REACH a building — `SimWorld.canReachUnit`.
//
// Reported: "Computer+ AI (Normal and Insane) must also target their enemy's expansion.
// currently they target only their main base." The expansion rung (plus/index.ts
// `knownExpansion`) asked `canWalkTo` of the hall's CENTRE, and `canWalkTo` gives a point two
// pathing cells of slack: a Town Hall's centre is four cells deep inside its own blocked stamp, so
// every hall on the map read as unreachable and every wave fell through to the main, whose rung
// never asked. `canReachUnit` asks the same region question up to the thing's EDGE
// (`approachExtent`), which is where an attack on it actually stops.
//
// Pins both halves: the point test still says no (it is right to — nobody can stand there), the
// thing test says yes, and a building walled off by blocked ground is still unreachable.

const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { SimWorld } = require(join(REPO, ".sim-build", "src", "sim", "world.js"));
const { PathingGrid } = require(join(REPO, ".sim-build", "src", "sim", "pathing.js"));

let failed = 0;
function check(what, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
}

const CELL = 32;
const HALL = [2560, 2560];
const HALL_R = 128; // a Town Hall's blocked core, as tools/sim-harvest-test.cjs sizes it

function block(grid, cx, cy, half) {
  const cells = (half * 2) / CELL;
  const [x0, y0] = [Math.round((cx - half) / CELL), Math.round((cy - half) / CELL)];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) grid.block(x0 + i, y0 + j);
}

function unit(id, typeId, x, y, extra) {
  return {
    id, owner: 0, team: 0, typeId, x, y, facing: 0,
    hp: 500, maxHp: 500, mana: 0, maxMana: 0, manaRegen: 0, hpRegen: 0,
    speed: 270, turnRate: 0.6, radius: 16, scale: 1, armor: 0, armorType: "medium", defUp: 0,
    weapon: null, weapons: [], oldWeapons: [], sight: 1400, nsight: 800, baseSight: 1400,
    sightDay: 1400, sightNight: 800, flying: false, mechanical: false, invulnerable: false,
    race: "human", isBuilding: false, foodCost: 2, goldCost: 0, lumberCost: 0, abilities: [],
    upgrades: [], moveType: "foot", collisionSize: 16, canFlee: true, targetedAs: "ground",
    deathTime: 2, name: typeId, castPoint: 0, castBackswing: 0, worker: null,
    depotGold: false, depotLumber: false,
    ...extra,
  };
}

function world(walled) {
  const W = 160, H = 160;
  const grid = new PathingGrid({ width: W, height: H, flags: new Uint8Array(W * H) }, [0, 0]);
  block(grid, HALL[0], HALL[1], HALL_R);
  // A moat: a ring of blocked ground two cells wide, well clear of the hall's own stamp.
  if (walled) {
    const inner = HALL_R + 6 * CELL;
    const outer = inner + 2 * CELL;
    for (let y = HALL[1] - outer; y < HALL[1] + outer; y += CELL) {
      for (let x = HALL[0] - outer; x < HALL[0] + outer; x += CELL) {
        const d = Math.max(Math.abs(x + CELL / 2 - HALL[0]), Math.abs(y + CELL / 2 - HALL[1]));
        if (d >= inner && d < outer) grid.block(Math.floor(x / CELL), Math.floor(y / CELL));
      }
    }
  }
  const w = new SimWorld(grid, 1);
  w.add(
    unit(100, "htow", HALL[0], HALL[1], {
      owner: 1, team: 1, hp: 1500, maxHp: 1500, speed: 0, radius: HALL_R, armorType: "fort",
      isBuilding: true, foodCost: 0, collisionSize: 72, canFlee: false, targetedAs: "structure",
      name: "Town Hall", depotGold: true, depotLumber: true,
    }),
    { constructionLeft: 0, buildTimeTotal: 1, builderIds: [], goldCost: 0, lumberCost: 0, queue: [], rallyX: HALL[0], rallyY: HALL[1], rallyKind: "point", rallyTargetId: 0, producesUnits: false },
  );
  w.add(unit(1, "hfoo", HALL[0] - 1500, HALL[1]));
  return w;
}

{
  const w = world(false);
  check("the hall's centre, as a POINT, is not somewhere a Footman can stand", w.canWalkTo(1, HALL[0], HALL[1]) === false);
  check("…but the HALL itself is reachable — up to its edge", w.canReachUnit(1, 100) === true);
  check("open ground beside it is reachable as a point too", w.canWalkTo(1, HALL[0] - HALL_R - 3 * CELL, HALL[1]) === true);
}
{
  const w = world(true);
  check("a hall behind a wall of blocked ground is NOT reachable", w.canReachUnit(1, 100) === false);
}

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nreach-building: all checks passed");
