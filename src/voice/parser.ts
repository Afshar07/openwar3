// Voice Control's MAPPING: what the recogniser heard → the commands a player could have clicked.
//
// Deterministic, and deliberately so. The recogniser is told which words it may hear
// (src/voice/model.ts), so what arrives here is already a sentence in a closed vocabulary —
// "train three footmen", "storm bolt the enemy hero", "group two" — and turning a closed
// vocabulary into commands is a small grammar, not a model. A grammar is instant on the slowest
// machine, never invents an action the player did not say, and does the same thing every time;
// a language model would cost seconds per command on the PCs this has to run on.
//
// Kept pure (no DOM, no game): the NAMES it can match are handed in as a lexicon built from
// the game's own tables (src/voice/vocabulary.ts), and what comes out is a list of intents for
// the match to carry out through the very paths a click takes (render/mapViewer.ts). So the
// grammar can be pinned headlessly (tools/voice-parser-test.cjs).
//
// THE SENTENCE SHAPE is the one a player says out loud:
//
//     [verb] [count] [name] [preposition] [target]      "train 3 footmen", "attack the hero"
//     [name] [target]                                   "storm bolt that", "blizzard here"
//     … and … / … then …                                 several commands in one breath
//
// A sentence with no verb is a BUTTON's name — any button on the command card can be pressed
// by saying what it is called, which is what makes a map's custom abilities speakable without
// a line of code for them.

/** One name the player may say, and what it names. */
export interface LexEntry {
  /** What it is, for the intent that names it. */
  kind: "unit" | "building" | "ability" | "upgrade" | "item" | "button" | "hero";
  /** The game id (a unit type, an ability code, an upgrade id, an item id) or, for "button", the
   *  card's command id (`ability:AHtb`, `train:hfoo`, `move`…). */
  id: string;
  /** The phrase as the game spells it ("Storm Bolt", "Footman"). */
  phrase: string;
}

export type Side = "mine" | "enemy" | "ally" | "any";

/** A part of the MAP a target is looked for in — "a gold mine on the right side of the map",
 *  "the top left". Each axis is -1 (left / bottom), +1 (right / top), 0 (the middle third) or
 *  null (either). */
export interface Region {
  x: -1 | 0 | 1 | null;
  y: -1 | 0 | 1 | null;
}

/** Which of several matches: the nearest (the default), or "another"/"next" — the nearest one
 *  that is NOT the one the camera is already on, so saying it again walks through them. */
export type Pick = "nearest" | "next";

/** Where an order goes. */
export type VoiceTarget =
  | { kind: "screen" } // "here", "there", "this", "that" — the middle of the screen
  | { kind: "cursor" } // "the cursor", "the mouse" — only when the player says so
  | { kind: "unit"; entry: LexEntry; side: Side; region?: Region; pick?: Pick } // "the enemy footman"
  | { kind: "hero"; side: Side; region?: Region; pick?: Pick } // "the hero", "my hero", "their hero"
  | { kind: "base"; side: Side; region?: Region; pick?: Pick } // "home", "my base", "the enemy base"
  | { kind: "mine"; region?: Region; pick?: Pick } // "the gold mine", "another gold mine"
  | { kind: "trees" } // "the trees", "the forest"
  | { kind: "army" } // "my army"
  | { kind: "region"; region: Region }; // "the top left", "the middle of the map"

export type OrderVerb = "move" | "attack" | "attackmove" | "patrol" | "attackground" | "rally" | "smart";

export type VoiceIntent =
  | { kind: "order"; order: OrderVerb; target?: VoiceTarget }
  | { kind: "stop" }
  | { kind: "hold" }
  | { kind: "cancel" }
  | { kind: "harvest"; res?: "gold" | "lumber"; target?: VoiceTarget }
  | { kind: "train"; entry: LexEntry; count: number }
  | { kind: "build"; entry: LexEntry; target?: VoiceTarget }
  | { kind: "research"; entry: LexEntry }
  | { kind: "learn"; entry: LexEntry }
  | { kind: "press"; entry: LexEntry; target?: VoiceTarget }
  | { kind: "autocast"; entry: LexEntry; on: boolean }
  | { kind: "useitem"; entry?: LexEntry; slot?: number; target?: VoiceTarget }
  | { kind: "select"; what: "army" | "idle" | "hero" | "all-of"; entry?: LexEntry; index?: number }
  | { kind: "group"; n: number; mode: "recall" | "assign" | "add" }
  | { kind: "camera"; target: VoiceTarget };

/** Number words → value. "a"/"an" count as one ("train a footman"). */
const NUMBERS: Record<string, number> = {
  zero: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6,
  seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1,
};
/** The digit forms a recogniser may print instead. */
for (let i = 0; i <= 12; i++) NUMBERS[String(i)] = i;

/** Words that carry nothing in a command ("please train the footman"). "the" is dropped
 *  everywhere; "a"/"an" are numbers until a count has been read. */
const FILLER = new Set(["please", "the", "now", "go", "ahead", "and", "then", "um", "uh", "some", "of", "with", "your", "you"]);

/** The words that make a TARGET out of the rest of the sentence. "Here" is the middle of the
 *  SCREEN — what the player is looking at — and the mouse only when they say the mouse: a player
 *  playing by voice may not have a hand on it at all. */
const SCREEN_WORDS = new Set(["here", "there", "this", "that", "it", "him", "her", "them", "screen"]);
const CURSOR_WORDS = new Set(["cursor", "mouse", "pointer"]);
/** "another gold mine", "the next one". */
const NEXT_WORDS = new Set(["another", "next", "other", "different", "second"]);
const NEAREST_WORDS = new Set(["nearest", "closest", "near", "close"]);
/** Compass and side words → an axis of `Region`. */
const REGION_WORDS: Record<string, Partial<Region>> = {
  left: { x: -1 }, west: { x: -1 }, western: { x: -1 },
  right: { x: 1 }, east: { x: 1 }, eastern: { x: 1 },
  top: { y: 1 }, north: { y: 1 }, northern: { y: 1 }, upper: { y: 1 },
  bottom: { y: -1 }, south: { y: -1 }, southern: { y: -1 }, lower: { y: -1 },
  middle: { x: 0, y: 0 }, center: { x: 0, y: 0 }, centre: { x: 0, y: 0 },
};
const ENEMY_WORDS = new Set(["enemy", "enemies", "their", "hostile", "opponent", "opponents", "his"]);
const MINE_WORDS = new Set(["my", "our", "mine"]);
const ALLY_WORDS = new Set(["ally", "allied", "friendly"]);
const PREPOSITIONS = new Set(["on", "at", "to", "into", "onto", "toward", "towards", "near", "in"]);

/** Verb synonyms. The left word is what the player says; the right is what it means. Two-word
 *  verbs are matched first ("attack move" before "attack"). */
const VERBS2: Array<[string, string]> = [
  ["attack move", "attackmove"], ["a move", "attackmove"], ["attack ground", "attackground"],
  ["hold position", "hold"], ["set rally", "rally"], ["rally point", "rally"], ["control group", "group"],
  ["make group", "assign"], ["set group", "assign"], ["assign group", "assign"], ["bind group", "assign"],
  ["add to", "add"], ["turn on", "auto-on"], ["turn off", "auto-off"], ["never mind", "cancel"],
  ["look at", "camera"], ["go to", "move"], ["chop wood", "lumber"], ["cut wood", "lumber"],
  ["get gold", "gold"], ["get lumber", "lumber"], ["get wood", "lumber"], ["idle worker", "idle"],
  ["select army", "army"],
];
const VERBS1: Record<string, string> = {
  move: "move", walk: "move", run: "move", retreat: "move", come: "move",
  attack: "attack", hit: "attack", kill: "attack", fight: "attack", charge: "attack",
  amove: "attackmove", patrol: "patrol", rally: "rally", follow: "smart",
  stop: "stop", halt: "stop", hold: "hold", cancel: "cancel", escape: "cancel", back: "cancel",
  gather: "harvest", harvest: "harvest", mine: "harvest", collect: "harvest", chop: "lumber",
  train: "train", make: "train", recruit: "train", hire: "train", produce: "train", summon: "train", create: "train",
  build: "build", construct: "build", place: "build",
  research: "research", upgrade: "research", improve: "research",
  learn: "learn", skill: "learn",
  cast: "press", use: "press", press: "press", click: "press", activate: "press", do: "press",
  autocast: "autocast",
  select: "select", choose: "select", pick: "select", grab: "select",
  group: "group", camera: "camera", view: "camera", show: "camera", jump: "camera", pan: "camera", scroll: "camera",
  everyone: "army", everybody: "army", army: "army", idle: "idle",
};

/** Lower-case, strip WC3 markup and punctuation, split. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\|c[0-9a-f]{8}|\|r|\|n/gi, " ")
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/** One word's DICTIONARY form, so "footmen" says "footman" and "wolves" "wolf". Applied to both
 *  sides of every comparison, so it only has to be consistent, not correct English. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("men")) return w.slice(0, -3) + "man";
  if (w.endsWith("ves")) return w.slice(0, -3) + "f";
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

/** A phrase's comparison key: its words stemmed and run together ("Blade Master" and
 *  "blademasters" both read `blademaster`), so a recogniser's word split never matters. */
export function key(ws: readonly string[]): string {
  return ws.map(stem).join("");
}

/** Levenshtein distance, capped (the caller only ever asks "within k?"). */
function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The lexicon, indexed once per vocabulary (a match changes it when the card changes). */
export class Lexicon {
  readonly entries: ReadonlyArray<{ entry: LexEntry; key: string; len: number }>;
  constructor(entries: readonly LexEntry[]) {
    const seen = new Set<string>();
    const out: Array<{ entry: LexEntry; key: string; len: number }> = [];
    for (const e of entries) {
      const ws = words(e.phrase);
      if (!ws.length) continue;
      const k = key(ws);
      const dedupe = `${e.kind}|${e.id}|${k}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ entry: e, key: k, len: ws.length });
    }
    this.entries = out;
  }

  /**
   * The best entry spelled by the words starting at `at` — trying every span up to four words
   * longer than the entry (a recogniser may split "blademaster" into "blade master"), preferring
   * an EXACT key over a near one and a longer span over a shorter, so "storm bolt" never stops
   * at "storm". `kinds` narrows the search ("train" only wants units).
   */
  match(ws: readonly string[], at: number, kinds?: ReadonlyArray<LexEntry["kind"]>): { entry: LexEntry; end: number } | null {
    let best: { entry: LexEntry; end: number; score: number } | null = null;
    for (let end = Math.min(ws.length, at + 5); end > at; end--) {
      const k = key(ws.slice(at, end));
      for (const e of this.entries) {
        if (kinds && !kinds.includes(e.entry.kind)) continue;
        // A near miss is allowed one edit per five letters — enough for "riflemen"/"rifleman"
        // that survived stemming and for a plural the recogniser spelled oddly, not enough to
        // turn "farm" into "arm".
        const cap = e.key.length >= 6 ? Math.floor(e.key.length / 5) : 0;
        const d = k === e.key ? 0 : distance(k, e.key, cap);
        if (d > cap) continue;
        const score = (end - at) * 10 - d * 15;
        if (!best || score > best.score) best = { entry: e.entry, end, score };
      }
    }
    return best ? { entry: best.entry, end: best.end } : null;
  }
}

/** What `parse` needs besides the words. */
export interface ParseContext {
  lexicon: Lexicon;
}

/**
 * The words `parse` itself knows — the verbs, numbers, targets — for the recogniser's grammar.
 * The lexicon's own names are added beside them (src/voice/vocabulary.ts).
 */
export function grammarWords(): string[] {
  const out = new Set<string>();
  for (const [p] of VERBS2) for (const w of p.split(" ")) out.add(w);
  for (const w of Object.keys(VERBS1)) out.add(w);
  for (const w of Object.keys(NUMBERS)) if (!/^\d+$/.test(w)) out.add(w);
  for (const s of [SCREEN_WORDS, CURSOR_WORDS, NEXT_WORDS, NEAREST_WORDS, ENEMY_WORDS, MINE_WORDS, ALLY_WORDS, PREPOSITIONS, FILLER]) for (const w of s) out.add(w);
  for (const w of Object.keys(REGION_WORDS)) out.add(w);
  for (const w of ["side", "map", "corner", "camera", "move", "take", "put", "look", "one"]) out.add(w);
  for (const w of ["hero", "heroes", "base", "home", "town", "hall", "gold", "lumber", "wood", "trees", "forest", "position",
    "point", "ground", "item", "slot", "off", "worker", "workers", "units", "all", "every", "unit", "group", "add"]) out.add(w);
  return [...out];
}

/** Parse what was heard. An empty list means nothing in it was a command. */
export function parse(text: string, ctx: ParseContext): VoiceIntent[] {
  const ws = words(text);
  const out: VoiceIntent[] = [];
  // Split on the joins a player uses between two commands. A clause with no verb of its own
  // inherits the previous one ("select footmen and riflemen").
  const clauses: string[][] = [[]];
  for (const w of ws) {
    if (w === "and" || w === "then") clauses.push([]);
    else clauses[clauses.length - 1].push(w);
  }
  let lastVerb: string | null = null;
  for (const c of clauses) {
    if (!c.length) continue;
    const r = parseClause(c, ctx, lastVerb);
    if (r) {
      out.push(r.intent);
      lastVerb = r.verb;
    }
  }
  return out;
}

/** Read the verb at the head of a clause: [meaning, words consumed]. */
function readVerb(ws: readonly string[]): [string, number] | null {
  if (ws.length >= 2) {
    const two = `${ws[0]} ${ws[1]}`;
    for (const [p, v] of VERBS2) if (p === two) return [v, 2];
  }
  const v = VERBS1[ws[0]];
  return v ? [v, 1] : null;
}

/** The count at `at`, if there is one: [value, next index]. */
function readCount(ws: readonly string[], at: number): [number, number] {
  const n = NUMBERS[ws[at] ?? ""];
  return n === undefined ? [1, at] : [n, at + 1];
}

/** The region and the pick a target phrase carries anywhere in it ("another gold mine on the
 *  right side of the map": pick next, region x +1). */
function readModifiers(ws: readonly string[], from: number): { region?: Region; pick?: Pick } {
  let region: Region | undefined;
  let pick: Pick | undefined;
  for (let i = from; i < ws.length; i++) {
    const r = REGION_WORDS[ws[i]];
    if (r) {
      region ??= { x: null, y: null };
      if (r.x !== undefined && !(r.x === 0 && region.x !== null)) region.x = r.x;
      if (r.y !== undefined && !(r.y === 0 && region.y !== null)) region.y = r.y;
    }
    if (NEXT_WORDS.has(ws[i])) pick = "next";
    else if (NEAREST_WORDS.has(ws[i]) && !pick) pick = "nearest";
  }
  return { region, pick };
}

/** Read a target phrase out of `ws` from `at` on. Prepositions, "the" and the modifier words
 *  are skipped, and the modifiers are read off the whole rest of the clause. */
export function readTarget(ws: readonly string[], at: number, lex: Lexicon): VoiceTarget | undefined {
  let i = at;
  let side: Side = "any";
  const mods = readModifiers(ws, at);
  const skippable = (w: string): boolean =>
    PREPOSITIONS.has(w) || FILLER.has(w) || w === "a" || w === "an" || NEXT_WORDS.has(w) || NEAREST_WORDS.has(w) || w === "camera";
  while (i < ws.length && skippable(ws[i])) i++;
  if (i >= ws.length) return undefined;
  if (CURSOR_WORDS.has(ws[i])) return { kind: "cursor" };
  if (SCREEN_WORDS.has(ws[i])) return { kind: "screen" };
  if (ENEMY_WORDS.has(ws[i])) { side = "enemy"; i++; }
  else if (MINE_WORDS.has(ws[i]) && ws[i] !== "mine") { side = "mine"; i++; }
  else if (ALLY_WORDS.has(ws[i])) { side = "ally"; i++; }
  while (i < ws.length && skippable(ws[i])) i++;
  const w = ws[i];
  if (w === undefined) return side === "enemy" ? { kind: "base", side, ...mods } : undefined;
  const s = stem(w);
  if (s === "hero") return { kind: "hero", side, ...mods };
  if (s === "base" || s === "home" || (s === "town" && ws[i + 1] === "hall")) return { kind: "base", side: side === "any" ? "mine" : side, ...mods };
  if ((s === "gold" && (ws[i + 1] === "mine" || ws[i + 1] === undefined)) || (s === "mine" && side === "any")) return { kind: "mine", ...mods };
  if (s === "tree" || s === "forest" || s === "wood" || s === "lumber") return { kind: "trees" };
  if (s === "army") return { kind: "army" };
  const m = lex.match(ws, i, ["unit", "building", "hero"]);
  if (m) return { kind: "unit", entry: m.entry, side, ...mods };
  // Nothing but a part of the map: "the top left", "the middle of the map".
  if (mods.region) return { kind: "region", region: mods.region };
  return undefined;
}

function parseClause(ws: string[], ctx: ParseContext, inherited: string | null): { intent: VoiceIntent; verb: string } | null {
  const lex = ctx.lexicon;
  // "move the camera to another gold mine", "take the camera to my base", "camera top left":
  // a clause that names the CAMERA is about the camera, whichever verb it opens with — "move"
  // above all, which would otherwise order the army there.
  const cam = ws.indexOf("camera");
  if (cam >= 0) {
    const t = readTarget(ws, cam + 1, lex);
    return t ? { intent: { kind: "camera", target: t }, verb: "camera" } : null;
  }
  const head = readVerb(ws);
  const verb = head?.[0] ?? null;
  let i = head?.[1] ?? 0;
  const rest = (): VoiceTarget | undefined => readTarget(ws, i, lex);
  const done = (intent: VoiceIntent, v: string = verb ?? inherited ?? ""): { intent: VoiceIntent; verb: string } => ({ intent, verb: v });

  switch (verb) {
    case "move": case "attack": case "attackmove": case "patrol": case "attackground": case "rally": case "smart":
      return done({ kind: "order", order: verb, target: rest() });
    case "stop": return done({ kind: "stop" });
    case "hold": return done({ kind: "hold" });
    case "cancel": return done({ kind: "cancel" });
    case "gold": return done({ kind: "harvest", res: "gold", target: rest() });
    case "lumber": return done({ kind: "harvest", res: "lumber", target: rest() });
    case "harvest": {
      const t = rest();
      const res = t?.kind === "mine" ? "gold" : t?.kind === "trees" ? "lumber" : ws.slice(i).some((w) => w === "gold") ? "gold" : undefined;
      return done({ kind: "harvest", res, target: t });
    }
    case "army": return done({ kind: "select", what: "army" });
    case "idle": return done({ kind: "select", what: "idle" });
    case "group": case "assign": case "add": {
      while (ws[i] === "group" || ws[i] === "to") i++;
      const n = NUMBERS[ws[i] ?? ""];
      if (n === undefined || n > 10) return null;
      return done({ kind: "group", n: n === 10 ? 0 : n, mode: verb === "group" ? "recall" : verb === "assign" ? "assign" : "add" });
    }
    case "camera": {
      const t = rest();
      return t ? done({ kind: "camera", target: t }) : null;
    }
    case "select": {
      while (i < ws.length && (FILLER.has(ws[i]) || MINE_WORDS.has(ws[i]))) i++;
      const w = ws[i];
      if (w === undefined || w === "all" || w === "army" || w === "everyone" || w === "everybody") {
        // "select all footmen" is a type; "select all" alone is the army.
        if (w === "all" && ws[i + 1]) i++;
        else return done({ kind: "select", what: "army" });
      }
      if (ws[i] === "idle" || stem(ws[i]) === "worker" && ws[i - 1] === "idle") return done({ kind: "select", what: "idle" });
      if (stem(ws[i]) === "hero") {
        const n = NUMBERS[ws[i + 1] ?? ""];
        return done({ kind: "select", what: "hero", index: n ? n - 1 : 0 });
      }
      const m = lex.match(ws, i, ["unit", "building", "hero"]);
      return m ? done({ kind: "select", what: "all-of", entry: m.entry }) : null;
    }
    case "train": {
      const [count, j] = readCount(ws, i);
      i = j;
      const m = lex.match(ws, i, ["unit", "hero"]);
      if (m) return done({ kind: "train", entry: m.entry, count: Math.max(1, Math.min(count, 12)) });
      // "make a farm": the player said make, the game calls it build.
      const b = lex.match(ws, i, ["building"]);
      if (b) { i = b.end; return done({ kind: "build", entry: b.entry, target: rest() }, "build"); }
      return pressByName(ws, i, lex, done);
    }
    case "build": {
      while (ws[i] === "a" || ws[i] === "an") i++;
      const b = lex.match(ws, i, ["building"]);
      if (b) { i = b.end; return done({ kind: "build", entry: b.entry, target: rest() }); }
      // "build three footmen" — said build, meant train.
      const [count, j] = readCount(ws, i);
      const u = lex.match(ws, j, ["unit", "hero"]);
      if (u) return done({ kind: "train", entry: u.entry, count }, "train");
      return null;
    }
    case "research": {
      const m = lex.match(ws, i, ["upgrade", "button"]);
      return m ? done({ kind: "research", entry: m.entry }) : null;
    }
    case "learn": {
      const m = lex.match(ws, i, ["ability", "button"]);
      return m ? done({ kind: "learn", entry: m.entry }) : null;
    }
    case "auto-on": case "auto-off": case "autocast": {
      let on = verb !== "auto-off";
      const m = lex.match(ws, i, ["ability", "button"]);
      if (!m) return null;
      if (ws[m.end] === "off") on = false;
      return done({ kind: "autocast", entry: m.entry, on });
    }
    case "press": {
      // "use slot two" / "use item one" — the inventory by number.
      if (ws[i] === "item" || ws[i] === "slot") {
        const n = NUMBERS[ws[i + 1] ?? ""];
        if (n !== undefined && n >= 1 && n <= 6) { i += 2; return done({ kind: "useitem", slot: n - 1, target: rest() }); }
      }
      return pressByName(ws, i, lex, done);
    }
    default:
      break;
  }

  // No verb of its own. A clause after "and" carries the previous one on ("select footmen and
  // riflemen", "train two footmen and a priest").
  if (inherited === "select" || inherited === "train") {
    const kinds: LexEntry["kind"][] = ["unit", "hero", "building"];
    const [count, j] = inherited === "train" ? readCount(ws, 0) : [1, 0];
    const m = lex.match(ws, j, kinds);
    if (m) {
      return inherited === "train"
        ? done({ kind: "train", entry: m.entry, count }, inherited)
        : done({ kind: "select", what: "all-of", entry: m.entry }, inherited);
    }
  }
  // …and otherwise it is a BUTTON's name: "storm bolt the hero", "blizzard here", "footman".
  return pressByName(ws, 0, lex, done);
}

function pressByName(
  ws: readonly string[],
  at: number,
  lex: Lexicon,
  done: (intent: VoiceIntent, v?: string) => { intent: VoiceIntent; verb: string },
): { intent: VoiceIntent; verb: string } | null {
  let i = at;
  while (i < ws.length && FILLER.has(ws[i])) i++;
  const m = lex.match(ws, i, ["button", "ability", "item"]);
  if (!m) return null;
  const target = readTarget(ws, m.end, lex);
  if (m.entry.kind === "item") return done({ kind: "useitem", entry: m.entry, target }, "press");
  return done({ kind: "press", entry: m.entry, target }, "press");
}

/** A one-line reading of an intent, for the echo the player sees ("Train 3 × Footman"). */
export function describe(i: VoiceIntent): string {
  const t = (x?: VoiceTarget): string => {
    if (!x) return "";
    switch (x.kind) {
      case "screen": return " → here";
      case "cursor": return " → cursor";
      case "region": return ` → ${regionWords(x.region)}`;
      case "unit": return ` → ${x.side === "enemy" ? "enemy " : x.side === "mine" ? "my " : ""}${x.entry.phrase}`;
      case "hero": return ` → ${x.side === "enemy" ? "enemy " : x.side === "mine" ? "my " : ""}hero`;
      case "base": return ` → ${x.side === "enemy" ? "enemy" : "my"} base`;
      case "mine": return ` → ${x.pick === "next" ? "another " : ""}gold mine${x.region ? ` (${regionWords(x.region)})` : ""}`;
      case "trees": return " → trees";
      case "army": return " → army";
    }
  };
  switch (i.kind) {
    case "order": return `${{ move: "Move", attack: "Attack", attackmove: "Attack-move", patrol: "Patrol", attackground: "Attack ground", rally: "Rally", smart: "Follow" }[i.order]}${t(i.target)}`;
    case "stop": return "Stop";
    case "hold": return "Hold position";
    case "cancel": return "Cancel";
    case "harvest": return `Gather${i.res ? ` ${i.res}` : ""}${t(i.target)}`;
    case "train": return `Train ${i.count > 1 ? `${i.count} × ` : ""}${i.entry.phrase}`;
    case "build": return `Build ${i.entry.phrase}${t(i.target)}`;
    case "research": return `Research ${i.entry.phrase}`;
    case "learn": return `Learn ${i.entry.phrase}`;
    case "press": return `${i.entry.phrase}${t(i.target)}`;
    case "autocast": return `Autocast ${i.entry.phrase} ${i.on ? "on" : "off"}`;
    case "useitem": return `Use ${i.entry?.phrase ?? `item ${(i.slot ?? 0) + 1}`}${t(i.target)}`;
    case "select": return i.what === "army" ? "Select army" : i.what === "idle" ? "Select idle worker" : i.what === "hero" ? `Select hero ${(i.index ?? 0) + 1}` : `Select ${i.entry?.phrase ?? ""}`;
    case "group": return `${i.mode === "recall" ? "Group" : i.mode === "assign" ? "Assign group" : "Add to group"} ${i.n}`;
    case "camera": return `Camera${t(i.target)}`;
  }
}

function regionWords(r: Region): string {
  const y = r.y === 1 ? "top" : r.y === -1 ? "bottom" : r.y === 0 ? "middle" : "";
  const x = r.x === 1 ? "right" : r.x === -1 ? "left" : r.x === 0 && r.y !== 0 ? "middle" : "";
  return [y, x].filter(Boolean).join(" ") || "map";
}
