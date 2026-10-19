// Headless check of Voice Control's MAPPING — what the recogniser heard → the intents the match
// carries out (src/voice/parser.ts). Run: pnpm sim:test
//
// The parser is the whole of "understanding" in Voice Control: there is no language model, by
// design (src/voice/model.ts says why), so every phrase a player is promised in the Options
// tooltip is pinned here. The lexicon is a hand-made slice of what a match hands in — the card's
// buttons, the race's tech tree, the units on screen — using the game's own names.
const { join } = require("node:path");
const REPO = join(__dirname, "..");
require("node:fs").writeFileSync(join(REPO, ".sim-build", "package.json"), '{"type":"commonjs"}');
const { Lexicon, parse, describe, stem } = require(join(REPO, ".sim-build", "src", "voice", "parser.js"));

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else { fails++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const lex = new Lexicon([
  { kind: "unit", id: "hfoo", phrase: "Footman" },
  { kind: "unit", id: "hrif", phrase: "Rifleman" },
  { kind: "unit", id: "hpea", phrase: "Peasant" },
  { kind: "hero", id: "Hblm", phrase: "Blood Mage" },
  { kind: "unit", id: "Obla", phrase: "Blademaster" },
  { kind: "building", id: "hhou", phrase: "Farm" },
  { kind: "building", id: "hbar", phrase: "Barracks" },
  { kind: "upgrade", id: "Rhme", phrase: "Iron Forged Swords" },
  { kind: "ability", id: "AHtb", phrase: "Storm Bolt" },
  { kind: "ability", id: "AUfn", phrase: "Frost Nova" },
  { kind: "ability", id: "AHhb", phrase: "Holy Light" },
  { kind: "button", id: "ability:AHbz", phrase: "Blizzard" },
  { kind: "button", id: "rally", phrase: "Set Rally Point" },
  { kind: "building", id: "hbar", phrase: "Barracks" },
  { kind: "building", id: "usep", phrase: "Crypt" },
  { kind: "hero", id: "Udea", phrase: "Death Knight" },
  { kind: "building", id: "ntav", phrase: "Tavern" },
  { kind: "building", id: "etrp", phrase: "tower" },
  { kind: "building", id: "eden", phrase: "shop" },
  { kind: "building", id: "halt", phrase: "Altar of Kings" },
  { kind: "building", id: "halt", phrase: "altar" },
  { kind: "unit", id: "ogru", phrase: "Grunt" },
  { kind: "item", id: "hslv", phrase: "Healing Salve" },
  { kind: "item", id: "stwp", phrase: "town portal" },
]);
const p = (t) => parse(t, { lexicon: lex });
const one = (t) => { const r = p(t); return r.length === 1 ? r[0] : null; };

console.log("stems");
check("footmen → footman", stem("footmen") === "footman");
check("riflemen → rifleman", stem("riflemen") === "rifleman");

console.log("orders");
let i = one("attack move here");
check("attack move here = attackmove @ screen", i?.kind === "order" && i.order === "attackmove" && i.target?.kind === "screen", JSON.stringify(i));
i = one("move to the cursor");
check("cursor only when said", i?.kind === "order" && i.order === "move" && i.target?.kind === "cursor", JSON.stringify(i));
i = one("attack the enemy hero");
check("attack the enemy hero", i?.kind === "order" && i.order === "attack" && i.target?.kind === "hero" && i.target.side === "enemy", JSON.stringify(i));
i = one("hold position");
check("hold position", i?.kind === "hold");
i = one("stop");
check("stop", i?.kind === "stop");

console.log("production");
i = one("train three footmen");
check("train three footmen", i?.kind === "train" && i.entry.id === "hfoo" && i.count === 3, JSON.stringify(i));
i = one("make a rifleman");
check("make a rifleman = 1", i?.kind === "train" && i.entry.id === "hrif" && i.count === 1, JSON.stringify(i));
const two = p("train two footmen and a rifleman");
check("train … and … inherits the verb", two.length === 2 && two[1].kind === "train" && two[1].entry.id === "hrif", JSON.stringify(two));
i = one("build a farm here");
check("build a farm here", i?.kind === "build" && i.entry.id === "hhou" && i.target?.kind === "screen", JSON.stringify(i));
i = one("build farm");
check("build farm (no place)", i?.kind === "build" && i.entry.id === "hhou" && !i.target, JSON.stringify(i));
i = one("research iron forged swords");
check("research", i?.kind === "research" && i.entry.id === "Rhme", JSON.stringify(i));
i = one("train blade master");
check("a split compound still names the unit", i?.kind === "train" && i.entry.id === "Obla", JSON.stringify(i));

console.log("spells");
i = one("use frost nova");
check("use frost nova = press, no target (assist)", i?.kind === "press" && i.entry.id === "AUfn" && !i.target, JSON.stringify(i));
i = one("storm bolt the enemy hero");
check("storm bolt the enemy hero", i?.kind === "press" && i.entry.id === "AHtb" && i.target?.kind === "hero" && i.target.side === "enemy", JSON.stringify(i));
i = one("blizzard here");
check("blizzard here (a card button)", i?.kind === "press" && i.entry.id === "ability:AHbz" && i.target?.kind === "screen", JSON.stringify(i));
i = one("holy light my hero");
check("holy light my hero", i?.kind === "press" && i.target?.kind === "hero" && i.target.side === "mine", JSON.stringify(i));

console.log("selection & groups");
i = one("select all footmen");
check("select all footmen", i?.kind === "select" && i.what === "subject" && i.subject.entry.id === "hfoo" && i.subject.count === "all", JSON.stringify(i));
i = one("select army");
check("select army", i?.kind === "select" && i.what === "army");
i = one("select all");
check("select all = army", i?.kind === "select" && i.what === "army");
for (const w of ["peasant", "worker", "peon"]) {
  i = one(`select ${w}`);
  check(`select ${w} = one IDLE worker`, i?.kind === "select" && i.subject?.worker && i.subject.count === 1 && !i.subject.counted, JSON.stringify(i));
}
i = one("select one worker");
check("select one worker = any one", i?.kind === "select" && i.subject?.worker && i.subject.count === 1 && i.subject.counted, JSON.stringify(i));
i = one("select one worker from wood");
check("select one worker from wood", i?.kind === "select" && i.subject?.from === "lumber" && i.subject.count === 1, JSON.stringify(i));
i = one("select two peasants that are mining gold");
check("select two peasants mining gold", i?.kind === "select" && i.subject?.from === "gold" && i.subject.count === 2, JSON.stringify(i));
i = one("select idle peasants");
check("select idle peasants = all idle", i?.kind === "select" && i.subject?.idle && i.subject.count === "all", JSON.stringify(i));
i = one("group two");
check("group two", i?.kind === "group" && i.n === 2 && i.mode === "recall", JSON.stringify(i));
i = one("make group three");
check("make group three", i?.kind === "group" && i.n === 3 && i.mode === "assign", JSON.stringify(i));

console.log("gathering & rally");
i = one("put all peasants on gold");
check("put all peasants on gold", i?.kind === "harvest" && i.res === "gold" && i.subject?.worker && i.subject.count === "all", JSON.stringify(i));
i = one("send two workers to wood");
check("send two workers to wood", i?.kind === "harvest" && i.res === "lumber" && i.subject?.count === 2, JSON.stringify(i));
i = one("all peasants to the gold mine");
check("subject first, no verb", i?.kind === "harvest" && i.res === "gold" && i.subject?.count === "all", JSON.stringify(i));
i = one("put the rally point of barracks on my hero");
check("rally of barracks on my hero", i?.kind === "order" && i.order === "rally" && i.source?.id === "hbar" && i.target?.kind === "hero" && i.target.side === "mine", JSON.stringify(i));
i = one("put the rally point of the crypt on the death knight");
check("rally of crypt on the death knight", i?.kind === "order" && i.order === "rally" && i.source?.id === "usep" && i.target?.kind === "unit" && i.target.entry.id === "Udea", JSON.stringify(i));
i = one("set rally point here");
check("set rally point here (selected)", i?.kind === "order" && i.order === "rally" && !i.source && i.target?.kind === "screen", JSON.stringify(i));
i = one("send all footmen here");
check("send all footmen here = move", i?.kind === "order" && i.order === "move" && i.subject?.entry.id === "hfoo" && i.target?.kind === "screen", JSON.stringify(i));
i = one("build a tower");
check("build a tower (race term)", i?.kind === "build" && i.entry.id === "etrp", JSON.stringify(i));
i = one("build a shop");
check("build a shop (race term)", i?.kind === "build" && i.entry.id === "eden", JSON.stringify(i));

console.log("finish & items");
i = one("finish the altar");
check("finish the altar", i?.kind === "finish" && i.entry?.id === "halt" && !i.all, JSON.stringify(i));
i = one("finish building the altar of kings");
check("finish building the altar of kings", i?.kind === "finish" && i.entry?.id === "halt", JSON.stringify(i));
i = one("complete all buildings");
check("complete all buildings", i?.kind === "finish" && !i.entry && i.all, JSON.stringify(i));
i = one("select a peasant");
check("select a peasant = idle one (a is not a count)", i?.kind === "select" && i.subject?.worker && !i.subject.counted && i.subject.count === 1, JSON.stringify(i));
i = one("use healing salve on grunt");
check("use healing salve on grunt", i?.kind === "useitem" && i.entry?.id === "hslv" && i.target?.kind === "unit" && i.target.entry.id === "ogru", JSON.stringify(i));
i = one("use town portal");
check("use town portal", i?.kind === "useitem" && i.entry?.id === "stwp" && !i.target, JSON.stringify(i));

console.log("camera");
i = one("move the camera to the tavern");
check("camera to the tavern", i?.kind === "camera" && i.target.kind === "unit" && i.target.entry.id === "ntav", JSON.stringify(i));
i = one("camera to another creep camp");
check("camera to another creep camp", i?.kind === "camera" && i.target.kind === "creeps" && i.target.pick === "next", JSON.stringify(i));
i = one("move the camera to another gold mine");
check("camera → another gold mine (not a MOVE order)", i?.kind === "camera" && i.target.kind === "mine" && i.target.pick === "next", JSON.stringify(i));
i = one("move the camera to a gold mine on the right side of the map");
check("camera → gold mine, right side", i?.kind === "camera" && i.target.kind === "mine" && i.target.region?.x === 1 && i.target.region.y === null, JSON.stringify(i));
i = one("camera top left");
check("camera top left = a region", i?.kind === "camera" && i.target.kind === "region" && i.target.region.x === -1 && i.target.region.y === 1, JSON.stringify(i));
i = one("look at my base");
check("look at my base", i?.kind === "camera" && i.target.kind === "base" && i.target.side === "mine", JSON.stringify(i));
i = one("show the enemy base");
check("show the enemy base", i?.kind === "camera" && i.target.kind === "base" && i.target.side === "enemy", JSON.stringify(i));

console.log("panels, pause & chat");
i = one("open the quest log");
check("open the quest log", i?.kind === "panel" && i.panel === "quests" && i.open === true, JSON.stringify(i));
i = one("close the menu");
check("close the menu", i?.kind === "panel" && i.panel === "menu" && i.open === false, JSON.stringify(i));
i = one("allies");
check("allies (toggle)", i?.kind === "panel" && i.panel === "allies" && i.open === null, JSON.stringify(i));
i = one("show the message log");
check("show the message log", i?.kind === "panel" && i.panel === "chat", JSON.stringify(i));
i = one("pause the game");
check("pause the game", i?.kind === "pause" && i.on, JSON.stringify(i));
i = one("unpause");
check("unpause", i?.kind === "pause" && !i.on, JSON.stringify(i));
i = one("say good game to all");
check("say good game to all", i?.kind === "chat" && i.text === "good game" && i.scope === "all", JSON.stringify(i));
i = one("tell allies push the middle and then attack");
check("tell allies … (and is part of the message)", i?.kind === "chat" && i.scope === "allies" && i.text === "push the middle and then attack", JSON.stringify(p("tell allies push the middle and then attack")));
i = one("send message we need help to my team");
check("send message … to my team", i?.kind === "chat" && i.scope === "allies" && i.text === "we need help", JSON.stringify(i));
i = one("open chat");
check("open chat = the input", i?.kind === "chat" && i.text === "", JSON.stringify(i));
i = one("show the enemy base");
check("show the enemy base is still the camera", i?.kind === "camera", JSON.stringify(i));

console.log("free text (Whisper)");
i = one("Build an alter.");
check("Build an alter. (sound-alike, punctuation)", i?.kind === "build" && i.entry.id === "halt", JSON.stringify(i));
i = one("Train 3 Footmen.");
check("Train 3 Footmen. (digits, capitals)", i?.kind === "train" && i.entry.id === "hfoo" && i.count === 3, JSON.stringify(i));
i = one("Finish the altar.");
check("Finish the altar.", i?.kind === "finish" && i.entry?.id === "halt", JSON.stringify(i));
i = one("Attack-move here.");
check("Attack-move here.", i?.kind === "order" && i.order === "attackmove", JSON.stringify(i));
check("orc does not sound like ark (too short)", one("build an ark") === null, JSON.stringify(p("build an ark")));

console.log("camps, camera, fall back");
i = one("Move the camera to a green camp.");
check("camera to a green camp", i?.kind === "camera" && i.target.kind === "creeps" && i.target.tier === "green", JSON.stringify(i));
i = one("Pan the camera to another orange creep camp");
check("pan to another orange creep camp", i?.kind === "camera" && i.target.kind === "creeps" && i.target.tier === "orange" && i.target.pick === "next", JSON.stringify(i));
i = one("Move the camera back to my base.");
check("camera back to my base", i?.kind === "camera" && i.target.kind === "base" && i.target.side === "mine", JSON.stringify(i));
i = one("pan to my base");
check("pan to my base", i?.kind === "camera" && i.target.kind === "base", JSON.stringify(i));
i = one("Fall back!");
check("fall back", i?.kind === "retreat" && !i.target, JSON.stringify(i));
i = one("retreat to the gold mine");
check("retreat to the gold mine", i?.kind === "retreat" && i.target?.kind === "mine", JSON.stringify(i));
i = one("go home");
check("go home", i?.kind === "retreat", JSON.stringify(i));
i = one("Place a farm here.");
check("place a farm here", i?.kind === "build" && i.entry.id === "hhou", JSON.stringify(i));
i = one("camera to the goblin merchant");
check("camera to the goblin merchant (lexicon has it when seen)", i === null || i.kind === "camera", JSON.stringify(i));

console.log("buildings, labels, teleport, gatherers");
const lex2 = new Lexicon([
  { kind: "unit", id: "ugho", phrase: "Ghoul" },
  { kind: "unit", id: "ucry", phrase: "Crypt Fiend" },
  { kind: "unit", id: "ucry", phrase: "Fiend" },
  { kind: "building", id: "uaod", phrase: "Altar of Darkness" },
  { kind: "building", id: "uaod", phrase: "altar" },
  { kind: "building", id: "unpl", phrase: "main building" },
  { kind: "building", id: "uzig", phrase: "Ziggurat" },
  { kind: "item", id: "stwp", phrase: "tp" },
]);
const one2 = (t) => { const r = parse(t, { lexicon: lex2 }); return r.length === 1 ? r[0] : null; };
i = one2("select altar");
check("select altar = a building", i?.kind === "select" && i.subject?.entry?.id === "uaod", JSON.stringify(i));
i = one2("select my main building");
check("select my main building", i?.kind === "select" && i.subject?.entry?.id === "unpl", JSON.stringify(i));
i = one2("select fiend 4");
check("select fiend 4 = the label", i?.kind === "select" && i.subject?.entry?.id === "ucry" && i.subject.index === 4, JSON.stringify(i));
i = one2("select crypt fiend number for");
check("…number for (a homophone, at the end)", i?.subject?.index === 4, JSON.stringify(i));
i = one2("send a ghoul to gather lumber");
check("ghoul to gather lumber", i?.kind === "harvest" && i.res === "lumber" && i.subject?.entry?.id === "ugho", JSON.stringify(i));
i = one2("ghouls go collect wood");
check("ghouls collect wood", i?.kind === "harvest" && i.res === "lumber" && i.subject?.count === "all", JSON.stringify(i));
i = one2("tp out");
check("tp out = Town Portal home", i?.kind === "useitem" && i.entry?.id === "stwp" && !i.target, JSON.stringify(i));
i = one2("teleport out of there");
check("teleport out of there (not 'there')", i?.kind === "useitem" && i.entry?.id === "stwp" && !i.target, JSON.stringify(i));
i = one2("tp back to the base");
check("tp back to the base", i?.kind === "useitem" && i.target?.kind === "base", JSON.stringify(i));
i = one2("build a ziggurat");
check("build a ziggurat", i?.kind === "build" && i.entry.id === "uzig", JSON.stringify(i));

i = one2("select a collide");
check("'a collide' is heard as acolyte", i?.kind === "select" && i.subject?.worker === true, JSON.stringify(i));
i = one2("send two accolades to gold");
check("'accolades' is heard as acolytes", i?.kind === "harvest" && i.subject?.count === 2, JSON.stringify(i));
i = one2("go to gold");
check("go to gold (gathering is decided by who hears it)", i?.kind === "order" && i.target?.kind === "mine", JSON.stringify(i));

console.log("not commands");
check("small talk is nothing", p("hello how are you").length === 0, JSON.stringify(p("hello how are you")));
check("describe() names every intent", p("train three footmen and group two").map(describe).join(" · ") === "Train 3 × Footman · Group 2", p("train three footmen and group two").map(describe).join(" · "));

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
console.log("\nvoice parser: all ok");
