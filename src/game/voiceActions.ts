import type { CommandButton } from "../ui/hud";
import type { RtsController } from "./rts";
import type { UnitRegistry } from "../data/units";
import type { AbilityRegistry } from "../data/abilities";
import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";
import type { ItemRegistry } from "../data/items";
import { isOffField, type SimUnit } from "../sim/world";
import { FogState } from "../sim/vision";
import { describe, type LexEntry, type Pick, type Region, type Subject, type VoiceIntent, type VoiceTarget } from "../voice/parser";
import type { VoiceHost } from "../voice/control";

// Voice Control's HANDS: an intent the parser read (src/voice/parser.ts) carried out through the
// paths a click and a hotkey already take. Nothing here issues an order the player could not
// have issued with the mouse — every command button is pressed with the card's own
// `runCommand`, every target is clicked through `orderClickAt` / `moveAt` at the place on screen
// where the target IS, and every order leaves through `RtsController.execute`. So voice is gated
// exactly as a click is (fog, mana, cooldowns, food, the LAN host), and cannot cheat.
//
// The two things voice has that a mouse does not are both READINGS of the world from the local
// player's own eyes: "the enemy hero" is the nearest enemy hero this player can SEE (fog decides,
// as it decides what the cursor can pick), and "my base" is this player's own town hall.
// "Here", "there", "that" are the middle of the SCREEN — what the player is looking at — and the
// mouse only when they say "the cursor" or "the mouse", since somebody playing by voice may have
// no hand on it. A spell ASSISTS: "frost nova" finds the unit of ours that has it (selecting it
// if it is not), and with nothing said about where, aims it at the best target that unit can
// see — the enemy for a curse, the most hurt friend for a heal, the thickest knot of enemies for
// an area. A building said "here" is put somewhere on the screen it fits, beside our others.

/** What the match lends Voice Control (render/mapViewer.ts builds it). */
export interface VoiceDriver {
  rts(): RtsController | null;
  localPlayer(): number;
  units: UnitRegistry;
  abilities: AbilityRegistry;
  tech: TechRegistry;
  upgrades: UpgradeRegistry;
  items: ItemRegistry;
  canAct(): boolean;
  /** The card as the HUD shows it, and the page it is on. */
  card(): CommandButton[];
  /** Press a card button by its command id (`runCommand`). */
  press(id: string): void;
  /** Where the mouse is, in canvas CSS pixels. */
  cursor(): { x: number; y: number };
  /** The ground at the middle of the screen — what "here" means — in world units. */
  screenCentre(): [number, number] | null;
  /** Where the camera is aimed (its target, updated the instant a pan is asked for — the screen
   *  centre only follows on the next frame). What "another" steps away from. */
  cameraFocus(): [number, number];
  /** The playable map, `[x0, y0, width, height]` in world units (regions are thirds of it). */
  mapBounds(): [number, number, number, number];
  /** With a building on the cursor: a valid site for it somewhere on screen, preferring one
   *  beside this player's other buildings — canvas CSS pixels, or null when nothing fits. */
  buildSpot(): { x: number; y: number } | null;
  /** Where a world point is drawn, in canvas CSS pixels (null behind the camera). */
  toScreen(wx: number, wy: number): { x: number; y: number } | null;
  /** A building is on the cursor waiting to be placed. */
  placing(): boolean;
  /** Place it at a canvas point (the placement click). */
  placeAt(x: number, y: number): void;
  panTo(wx: number, wy: number): void;
  jumpToSelection(): void;
  /** The "-" key: every army unit of ours (the HUD driver's own `selectAllArmy`). */
  selectAllArmy(): boolean;
  /** The creep camps the minimap marks, from this player's eyes. */
  creepCamps(): Array<{ x: number; y: number; level: number }>;
  recallGroup(n: number): boolean;
  selectHero(index: number): boolean;
  /** The console's four panels (F9–F12): whether one is open, and its key's toggle. */
  panelOpen(panel: "quests" | "menu" | "allies" | "chat"): boolean;
  togglePanel(panel: "quests" | "menu" | "allies" | "chat"): void;
  /** The player's pause (the F10 menu's Pause Game), on or off. */
  pause(on: boolean): void;
  /** The chat line: open it for typing, or send a line. `scope` null = the player's default. */
  openChat(scope: "all" | "allies" | null): void;
  sendChat(text: string, scope: "all" | "allies" | null): void;
  /** The inventory pockets' names, null for an empty one. */
  inventory(): Array<{ name: string; usable: boolean } | null>;
  useInventory(slot: number): void;
  /** The message log (what was heard) and the gold error line (what went wrong). */
  message(text: string): void;
  error(text: string): void;
  /** Voice Control's "Listening…" line. */
  status(text: string | null): void;
  /** Ride the camera on the first of these units still alive, then the next (Ctrl+C's lock,
   *  handed a list) — an army sent somewhere is followed there. */
  rideCamera(ids: number[]): void;
  /** The number on a unit's voice label ("Fiend 4"), null when it shows none. */
  labelNumber(id: number): number | null;
}

/** A card name as a sayable phrase: "+ Storm Bolt [0/3]" → "Storm Bolt". */
function sayable(name: string): string {
  return name
    .replace(/\|c[0-9a-f]{8}|\|r|\|n/gi, "")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
    .replace(/^\s*\+\s*/, "")
    .trim();
}

/** The verbs a card name may start with, dropped for the bare-name form ("Train Footman" is
 *  also "Footman"). The game's own Tip prefixes. */
const NAME_VERBS = /^(train|build|research|upgrade to|upgrade|learn|summon|create|hire|purchase|revive|awaken|morph into)\s+/i;

export function makeVoiceHost(d: VoiceDriver): VoiceHost {
  let vocab: string[] | null = null;
  const rts = (): RtsController | null => d.rts();
  const me = (): number => d.localPlayer();

  /** This player's own units, alive. */
  const mine = (): SimUnit[] => {
    const r = rts();
    if (!r) return [];
    const out: SimUnit[] = [];
    for (const u of r.simView.units.values()) if (u.owner === me() && u.hp > 0) out.push(u);
    return out;
  };

  /** What this player can see right now — the cursor's own rule (fog decides). */
  const visible = (u: SimUnit): boolean => {
    const r = rts();
    return !!r && u.hp > 0 && r.getVision().stateAt(u.x, u.y) === FogState.Visible;
  };

  const sideOf = (u: SimUnit): "mine" | "enemy" | "ally" | "neutral" => {
    const r = rts();
    if (u.owner === me()) return "mine";
    if (!r) return "neutral";
    const ref = mine()[0];
    if (!ref) return "neutral";
    if (r.simWorld.hostile(ref, u)) return "enemy";
    if (r.simWorld.allied(ref, u)) return "ally";
    return "neutral";
  };

  /** Where "nearest" is measured from: the selection, else the camera's own focus. */
  const anchor = (): [number, number] => rts()?.selectionAnchor() ?? [0, 0];

  /** Whether a unit stands in a part of the map ("on the right side", "top left"). Halves on a
   *  lone axis, thirds where the middle is asked for. */
  const inRegion = (x: number, y: number, region?: Region): boolean => {
    if (!region) return true;
    const [x0, y0, w, h] = d.mapBounds();
    const fx = (x - x0) / w, fy = (y - y0) / h;
    const axis = (f: number, want: -1 | 0 | 1 | null): boolean =>
      want === null ? true : want === 0 ? f > 1 / 3 && f < 2 / 3 : want === 1 ? f >= 0.5 : f < 0.5;
    return axis(fx, region.x) && axis(fy, region.y);
  };

  /** The nearest unit passing `pred`, from `from` — or, for "another", the nearest that is
   *  not the one the CAMERA is on (so saying it again walks on to the next). */
  /**
   * "Another" as a TOUR: each one asked for is the nearest the camera has not already been taken
   * to in this run of "another"s, so saying it again and again walks through every camp (or mine,
   * or tavern) rather than bouncing between the two nearest. The run starts over when the kind of
   * thing changes or every one has been seen. `list` is sorted nearest-the-camera first.
   */
  let tour: { kind: string; seen: Array<[number, number]> } = { kind: "", seen: [] };
  const NEAR = 700;
  const stepNext = <T extends { x: number; y: number }>(kind: string, list: T[]): T | null => {
    const cam = d.cameraFocus();
    if (tour.kind !== kind) tour = { kind, seen: [cam] };
    const far = (p: T): boolean => Math.hypot(p.x - cam[0], p.y - cam[1]) > NEAR;
    const unseen = (p: T): boolean => !tour.seen.some(([x, y]) => Math.hypot(p.x - x, p.y - y) < NEAR);
    let pick = list.find((p) => far(p) && unseen(p));
    if (!pick) {
      tour.seen = [cam];
      pick = list.find(far) ?? list[0];
    }
    if (pick) tour.seen.push([pick.x, pick.y]);
    return pick ?? null;
  };

  const choose = (pred: (u: SimUnit) => boolean, pick: Pick | undefined, region: Region | undefined, from: [number, number]): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const list = [...r.simView.units.values()].filter((u) => pred(u) && inRegion(u.x, u.y, region));
    const cam = d.cameraFocus();
    const origin = pick === "next" ? cam : from;
    list.sort((a, b) => (a.x - origin[0]) ** 2 + (a.y - origin[1]) ** 2 - ((b.x - origin[0]) ** 2 + (b.y - origin[1]) ** 2));
    if (pick === "next") return stepNext(`unit:${list[0]?.typeId ?? ""}`, list);
    return list[0] ?? null;
  };

  /** A target, read from the local player's eyes. `prefer` is the side a bare "the hero" means
   *  for this verb (an attack means theirs, a camera jump means ours). `from` is where "nearest"
   *  is measured: the selection for an order, the screen for the camera. */
  /** How far "move up" walks: about half a screen at the default zoom — far enough to be a
   *  move, short enough to stay in sight. Ours (WC3 had no such command). */
  const STEP_DISTANCE = 800;
  /** How far from a camp's minimap marker its creeps stand (the marker is the camp's centre). */
  const CAMP_RADIUS = 600;
  /** How far short of a fogged camp the walk there stops before the attack-move takes over. */
  const CAMP_APPROACH = 450;
  type Spot = { cursor: true } | { unit: SimUnit } | { point: [number, number] } | { fail: string };
  const resolve = (t: VoiceTarget, prefer: "enemy" | "mine", from: [number, number] = anchor(), friendly = false): Spot => {
    const r = rts();
    if (!r) return { fail: "No match." };
    const sideOk = (u: SimUnit, side: string): boolean => side === "any" || sideOf(u) === side;
    const known = (u: SimUnit): boolean => r.getVision().stateAt(u.x, u.y) !== FogState.Unexplored;
    switch (t.kind) {
      case "step": {
        // "move up": a walk of STEP_DISTANCE from where they stand (the camera's centre for a
        // camera step), screen-up being north — clamped onto the playable map.
        const len = Math.hypot(t.dx, t.dy) || 1;
        const reach = STEP_DISTANCE * t.scale;
        const [x0, y0, w, h] = d.mapBounds();
        const x = Math.max(x0 + 64, Math.min(x0 + w - 64, from[0] + (t.dx / len) * reach));
        const y = Math.max(y0 + 64, Math.min(y0 + h - 64, from[1] + (t.dy / len) * reach));
        return { point: [x, y] };
      }
      case "cursor": return { cursor: true };
      case "screen": {
        const c = d.screenCentre();
        return c ? { point: c } : { fail: "Can't see the ground there." };
      }
      case "region": {
        const [x0, y0, w, h] = d.mapBounds();
        const at = (v: -1 | 0 | 1 | null): number => (v === null || v === 0 ? 0.5 : v === 1 ? 0.8 : 0.2);
        return { point: [x0 + w * at(t.region.x), y0 + h * at(t.region.y)] };
      }
      case "hero": {
        const side = t.side === "any" ? prefer : t.side;
        // "My hero" is the FIRST one — the top portrait, the one F1 selects — not the nearest.
        if (side === "mine" && !t.pick && !t.region) {
          const first = r.heroBar().find((h) => !h.dead && r.simView.units.get(h.simId)?.hp);
          const u = first ? r.simView.units.get(first.simId) : undefined;
          return u ? { unit: u } : { fail: "You have no hero." };
        }
        const u = choose((x) => x.isHero && !x.isIllusion && x.hp > 0 && (side === "mine" ? x.owner === me() : visible(x) && sideOk(x, side)), t.pick, t.region, from);
        return u ? { unit: u } : { fail: side === "mine" ? "You have no hero." : "No hero in sight." };
      }
      case "unit": {
        const side = t.side;
        // A GIFT aimed at a kind of unit ("healing salve on grunt", "holy light the footman")
        // goes on the one of ours or an ally's that needs it most — the lowest share of life.
        if (friendly && side === "any") {
          const ours = [...r.simView.units.values()].filter((x) =>
            x.hp > 0 && x.typeId === t.entry.id && (x.owner === me() || (sideOf(x) === "ally" && visible(x))));
          ours.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || Math.hypot(a.x - from[0], a.y - from[1]) - Math.hypot(b.x - from[0], b.y - from[1]));
          if (ours[0]) return { unit: ours[0] };
        }
        // A BUILDING is found wherever the player has seen it (it stays on the map in memory —
        // "the tavern", "the fountain"); a unit only where it can be seen now.
        const seen = (x: SimUnit): boolean => (x.building ? known(x) : visible(x));
        const u = choose((x) => x.hp > 0 && x.typeId === t.entry.id && (x.owner === me() ? side !== "enemy" : seen(x) && sideOk(x, side)), t.pick, t.region, from)
          ?? choose((x) => x.hp > 0 && d.units.get(x.typeId)?.name === t.entry.phrase && x.owner !== me() && visible(x) && sideOk(x, side), t.pick, t.region, from);
        return u ? { unit: u } : { fail: `No ${t.entry.phrase} in sight.` };
      }
      case "base": {
        const own = t.side !== "enemy";
        // An enemy base is somewhere we have SEEN — a building stays on the map in memory.
        const u = choose((x) => !!x.building && x.hp > 0 && d.units.get(x.typeId)?.buffType === "townhall" && (own ? x.owner === me() : known(x) && sideOf(x) === "enemy"), t.pick, t.region, from);
        return u ? { unit: u } : { fail: own ? "You have no town hall." : "No enemy base found." };
      }
      case "mine": {
        // A gold mine is not a unit in the sim — it is `SimMine`, its own table — so it is chosen
        // the way `choose` chooses a unit, among the mines the player has ever had in view (the
        // minimap shows them) that still hold gold.
        const cam = d.cameraFocus();
        const origin = t.pick === "next" ? cam : from;
        const list = [...r.simView.mines.values()]
          .filter((m) => m.gold > 0 && r.getVision().stateAt(m.x, m.y) !== FogState.Unexplored && inRegion(m.x, m.y, t.region))
          .sort((a, b) => Math.hypot(a.x - origin[0], a.y - origin[1]) - Math.hypot(b.x - origin[0], b.y - origin[1]));
        const m = t.pick === "next" ? stepNext("mine", list) : list[0];
        return m ? { point: [m.x, m.y] } : { fail: t.region ? "No gold mine found there." : "No gold mine found." };
      }
      case "creeps": {
        const cam = d.cameraFocus();
        const origin = t.pick === "next" ? cam : from;
        // A camp's colour is the minimap's (game/minimapView.ts): green 1–9, orange 10–19, red 20+.
        const tierOf = (level: number): "green" | "orange" | "red" => (level >= 20 ? "red" : level >= 10 ? "orange" : "green");
        const list = d.creepCamps()
          .filter((c) => inRegion(c.x, c.y, t.region) && (!t.tier || tierOf(c.level) === t.tier))
          .sort((a, b) => Math.hypot(a.x - origin[0], a.y - origin[1]) - Math.hypot(b.x - origin[0], b.y - origin[1]));
        const c = t.pick === "next" ? stepNext(`creeps:${t.tier ?? ""}`, list) : list[0];
        return c ? { point: [c.x, c.y] } : { fail: t.tier ? `No ${t.tier} creep camp found.` : "No creep camp found." };
      }
      case "trees": {
        const tree = r.simWorld.nearestTree(from[0], from[1], 2500);
        return tree ? { point: [tree.x, tree.y] } : { fail: "No trees nearby." };
      }
      case "army": {
        const army = mine().filter((u) => !u.building && !d.units.get(u.typeId)?.classification.includes("peon"));
        if (!army.length) return { fail: "You have no army." };
        const x = army.reduce((sum, u) => sum + u.x, 0) / army.length;
        const y = army.reduce((sum, u) => sum + u.y, 0) / army.length;
        return { point: [x, y] };
      }
    }
  };

  /** Where on screen a spot is, to click it there. */
  const screenOf = (s: Spot): { x: number; y: number } | null => {
    if ("cursor" in s) return d.cursor();
    if ("unit" in s) return d.toScreen(s.unit.x, s.unit.y);
    if ("point" in s) return d.toScreen(s.point[0], s.point[1]);
    return null;
  };

  /** A spot, clicked: a unit target through the card's own unit-aim, anything else through the
   *  world click at the place on screen where it is (fog, range and legality are the click's). */
  const click = (spot: Exclude<Spot, { fail: string }>): boolean => {
    const r = rts();
    if (!r) return false;
    if ("unit" in spot && r.tryTargetArmedAt(spot.unit.id)) return true;
    const at = screenOf(spot);
    if (at && r.orderClickAt(at.x, at.y, false)) return true;
    // Off the edge of the view: a point order still goes, the minimap's way.
    const p: [number, number] | null = "unit" in spot ? [spot.unit.x, spot.unit.y] : "point" in spot ? spot.point : null;
    return !!p && r.minimapClick(p[0], p[1], false, false) === "ordered";
  };

  /**
   * What is armed and waiting for a target, if it is a SPELL or an ITEM use: the ability row it
   * fires (an item's behaviour is an ability — docs/items.md), at what rank, aimed at a unit or
   * at the ground, with what radius, and who is using it. Null for anything else armed (a move,
   * an attack) — those are left for the player's click when no target is said.
   */
  const armedAim = (): { def: NonNullable<ReturnType<typeof d.abilities.get>>; level: number; target: "unit" | "point"; area: number; user: SimUnit } | null => {
    const r = rts();
    if (!r) return null;
    const sel = r.selectedUnitIds().map((id) => r.simView.units.get(id)).filter((u): u is SimUnit => !!u);
    if (r.orderMode === "cast" && r.armedCast) {
      const armed = r.armedCast;
      const user = sel.find((u) => u.abilities.some((a) => a.code === armed.code && a.level > 0));
      const ab = user?.abilities.find((a) => a.code === armed.code);
      const def = d.abilities.get(armed.abilityId ?? ab?.id ?? armed.code) ?? d.abilities.get(armed.code);
      if (!user || !def) return null;
      const level = Math.max(1, ab?.level ?? 1);
      return { def, level, target: armed.target, area: armed.area || def.levelData[level - 1]?.area || 250, user };
    }
    if (r.orderMode === "item" && r.armedItem && r.armedItem.mode !== "move") {
      const it = r.armedItem;
      const def = it.abilityId ? d.abilities.get(it.abilityId) : undefined;
      const user = sel.find((u) => u.inventory?.[it.slot]);
      if (!user || !def) return null;
      return { def, level: 1, target: it.mode === "useunit" ? "unit" : "point", area: it.area || def.levelData[0]?.area || 250, user };
    }
    return null;
  };

  /** Whether an ability row is a GIFT (may only touch friends) rather than a weapon. */
  const isGift = (def: NonNullable<ReturnType<typeof d.abilities.get>>): boolean => {
    const flags = new Set(def.targetFlags);
    return !(flags.has("enemy") || flags.has("enemies")) && (flags.has("friend") || flags.has("allies") || flags.has("player") || flags.has("self"));
  };

  /** The order is armed (a button pressed that wants a target): finish it at the spot, the way
   *  the click after the press would. An unsaid target leaves it armed for the player's own
   *  click — except a SPELL or an ITEM, which aims itself (`assist`). */
  const aim = (t: VoiceTarget | undefined, prefer: "enemy" | "mine"): boolean => {
    const r = rts();
    if (!r) return false;
    const armed = armedAim();
    if (armed && (!t || t.kind === "screen")) {
      // "frost nova" / "frost nova here": the best target near the caster, or near the middle
      // of the screen when the player pointed there.
      if (assist(armed, t ? d.screenCentre() : null)) return true;
      if (!t) {
        d.status(null);
        d.error("No target for that in sight — click one.");
        return false;
      }
    }
    if (!t) return true;
    const gift = !!armed && isGift(armed.def);
    const spot = resolve(t, gift ? "mine" : prefer, anchor(), gift);
    if ("fail" in spot) {
      d.press("cancel");
      d.error(spot.fail);
      return false;
    }
    return click(spot);
  };

  /**
   * Aim the armed spell or item for the player. Who it is FOR comes off the row's own Targets
   * Allowed: a row that may hit an enemy is a weapon and goes on the enemy — a hero first, then
   * whoever is nearest; a row that may only touch friends is a gift and goes on the friend who
   * needs it most (lowest share of life). An AREA aimed at the ground goes where the most of its
   * targets stand inside its own radius. Every candidate is offered to the card's own aim in
   * turn, so a target it cannot take (air, magic-immune, full mana) simply passes to the next.
   */
  const assist = (armed: NonNullable<ReturnType<typeof armedAim>>, near: [number, number] | null): boolean => {
    const r = rts();
    if (!r) return false;
    const { def, level, user } = armed;
    const hostile = !isGift(def);
    const lvl = def.levelData[level - 1];
    const reach = Math.max(lvl?.castRange ?? 0, 600) + 400;
    const from = near ?? [user.x, user.y];
    const pool = [...r.simView.units.values()].filter((u) =>
      u.hp > 0 && !u.isIllusion && visible(u) && Math.hypot(u.x - user.x, u.y - user.y) <= reach + (near ? 1200 : 0) &&
      (hostile ? sideOf(u) === "enemy" : sideOf(u) === "mine" || sideOf(u) === "ally"));
    if (!pool.length) return false;
    const dist = (u: SimUnit): number => Math.hypot(u.x - from[0], u.y - from[1]);
    if (armed.target === "point") {
      const crowd = (u: SimUnit): number => pool.filter((o) => Math.hypot(o.x - u.x, o.y - u.y) <= armed.area).length;
      pool.sort((a, b) => crowd(b) - crowd(a) || dist(a) - dist(b));
      for (const u of pool.slice(0, 6)) {
        const at = d.toScreen(u.x, u.y);
        if (at && r.orderClickAt(at.x, at.y, false)) return true;
      }
      return false;
    }
    if (hostile) pool.sort((a, b) => Number(b.isHero) - Number(a.isHero) || dist(a) - dist(b));
    else {
      const hurt = pool.filter((u) => u.hp < u.maxHp);
      pool.length = 0;
      pool.push(...(hurt.length ? hurt : [user]));
      pool.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || dist(a) - dist(b));
    }
    for (const u of pool.slice(0, 8)) if (r.tryTargetArmedAt(u.id)) return true;
    return false;
  };

  /** The unit of ours that can cast `entry` right now — learned, off cooldown, with the mana —
   *  the one nearest the middle of the screen. Selected, so its card carries the button. */
  const selectCaster = (entry: LexEntry): boolean => {
    const r = rts();
    if (!r) return false;
    const centre = d.screenCentre() ?? anchor();
    const ready = mine()
      .map((u) => ({ u, a: u.abilities.find((a) => (a.id === entry.id || a.code === entry.id) && a.level > 0) }))
      .filter((x): x is { u: SimUnit; a: NonNullable<typeof x.a> } => !!x.a)
      .map((x) => {
        const cost = d.abilities.get(x.a.id)?.levelData[x.a.level - 1]?.cost ?? 0;
        return { ...x, ok: x.a.cooldownLeft <= 0 && x.u.mana >= cost };
      });
    if (!ready.length) return false;
    ready.sort((p, q) => Number(q.ok) - Number(p.ok) || Math.hypot(p.u.x - centre[0], p.u.y - centre[1]) - Math.hypot(q.u.x - centre[0], q.u.y - centre[1]));
    r.selectSingle(ready[0].u.id);
    return true;
  };

  /** Whether a unit of ours is a gatherer — the race's worker, or anything carrying a harvest
   *  order right now (an undead Ghoul in the trees). */
  const gathering = (u: SimUnit, res?: "gold" | "lumber"): boolean =>
    // Walking a load home is still working that resource (`resKind` outlives the trip).
    (u.order === "harvest" || u.order === "return") && !!u.resKind && (!res || u.resKind === res);
  const isWorker = (u: SimUnit): boolean => u.isPeon || gathering(u);
  /** Whether a unit of ours CAN gather `res` — any harvest ability at all, read off the sim's
   *  own worker profile. A Ghoul is no "worker" (it is never the idle-worker button's) and an
   *  Acolyte is a worker that never touches a tree; asking the profile is what tells them apart. */
  const canGather = (u: SimUnit, res?: "gold" | "lumber"): boolean =>
    !!u.worker && (res ? u.worker[res] : u.worker.gold || u.worker.lumber);
  /** A building TYPE and everything it upgrades into: "the town hall" is still the Keep it became,
   *  and "the farm" the Spirit Tower a Ziggurat turned into. */
  const family = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    for (const k of out) for (const up of d.tech.get(k).upgrade) out.add(up);
    return out;
  };
  /** A worker that is BUILDING — standing over a structure going up, or walking to found one.
   *  It finishes what it is building: no spoken order takes it off the job (`shield`). */
  const busyBuilding = (u: SimUnit): boolean => u.constructing !== 0 || !!u.buildPending;
  /** The idle-worker button's own test (rts.ts isIdleWorker): no order, no construction job. */
  // …and ON THE FIELD: a Wisp inside an Entangled Gold Mine (or a Peon in a Burrow, a Peasant in
  // a mine) holds no order and is nobody's idle worker — rts.ts isIdleWorker asks `isOffField` too.
  const idleWorker = (u: SimUnit): boolean => u.isPeon && u.order === "idle" && !u.building && !busyBuilding(u) && !isOffField(u) && !u.garrisonHost;

  /**
   * The units a SUBJECT names, best first: idle ones first (a worker said with no number means an
   * IDLE one), then the nearest to the middle of the screen. `from` keeps only those gathering
   * that resource; "all" is every one of them, map-wide.
   */
  const pickSubject = (sub: Subject): SimUnit[] => {
    const centre = d.screenCentre() ?? anchor();
    const near = (a: SimUnit, b: SimUnit): number => Math.hypot(a.x - centre[0], a.y - centre[1]) - Math.hypot(b.x - centre[0], b.y - centre[1]);
    // "Select altar", "select my main building": a BUILDING of ours, of that type or anything it
    // has become. The MAIN one is the oldest (the lowest id — the hall the match started with),
    // otherwise the nearest the middle of the screen.
    if (sub.entry?.kind === "building") {
      const types = family(sub.entry.id);
      const blds = mine().filter((u) => !!u.building && types.has(u.typeId));
      if (sub.index !== undefined) return blds.filter((u) => d.labelNumber(u.id) === sub.index).slice(0, 1);
      blds.sort(/\bmain\b/i.test(sub.entry.phrase) ? (a, b) => a.id - b.id : near);
      return sub.count === "all" ? blds : blds.slice(0, sub.count);
    }
    const matches = mine().filter((u) =>
      !u.building && !busyBuilding(u) && !isOffField(u) && !u.garrisonHost && (sub.worker ? isWorker(u) : u.typeId === sub.entry?.id) &&
      (!sub.from || gathering(u, sub.from)) &&
      (!sub.idle || idleWorker(u)));
    // "Fiend 4": the one wearing that label.
    if (sub.index !== undefined) return matches.filter((u) => d.labelNumber(u.id) === sub.index).sort((a, b) => Number(b.isPeon) - Number(a.isPeon)).slice(0, 1);
    matches.sort((a, b) => Number(idleWorker(b)) - Number(idleWorker(a)) || near(a, b));
    // "select peasant" / "select worker" — no number said — is the idle-worker button's job; with
    // nobody idle, the one cheapest to take off a job: a lumberjack (a Wisp in the trees, never
    // one of the five inside the mine), then anybody standing out on the field.
    if (sub.worker && !sub.counted && sub.count === 1 && !sub.from) {
      const pick = matches.find(idleWorker) ?? matches.find((u) => gathering(u, "lumber")) ?? matches[0];
      return pick ? [pick] : [];
    }
    return sub.count === "all" ? matches : matches.slice(0, sub.count);
  };

  /** What to call a subject in an error ("No idle worker.", "No Footman."). */
  const subjectName = (sub: Subject): string =>
    `${sub.idle ? "idle " : ""}${sub.worker ? "worker" : sub.entry?.phrase ?? "unit"}${sub.index !== undefined ? ` ${sub.index}` : ""}${sub.from ? ` on ${sub.from}` : ""}`;

  /** Select a subject's units (a selection holds 12); false, with the reason said, if none. */
  const selectSubject = (sub: Subject): SimUnit[] | null => {
    const r = rts();
    const units = pickSubject(sub);
    if (!r || !units.length) {
      d.error(`No ${subjectName(sub)}.`);
      return null;
    }
    r.clearSelection();
    for (const u of units.slice(0, 12)) r.scriptSelect(u.id, true);
    return units;
  };

  /**
   * An army ordered somewhere by voice is FOLLOWED there: the camera rides the first hero of the
   * selection in the hero bar's order, the next one when that one falls, and only then the rest
   * of the group — the player has no hand on a mouse to chase it with. Taking the camera by hand
   * lets go, as it does Ctrl+C's lock.
   */
  const ride = (): void => {
    const r = rts();
    if (!r) return;
    const sel = new Set(r.selectedUnitIds());
    const heroes = r.heroBar().map((h) => h.simId).filter((id) => sel.has(id));
    const rest = [...sel].filter((id) => !heroes.includes(id));
    if (heroes.length + rest.length) d.rideCamera([...heroes, ...rest]);
  };

  /** The creep of the camp at `at` nearest our army — what "attack the green camp" goes for. */
  const campCreep = (at: [number, number]): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const from = anchor();
    let best: SimUnit | null = null;
    for (const u of r.simView.units.values()) {
      if (u.owner >= 0 || u.neutralPassive || u.hp <= 0 || u.building || !visible(u)) continue;
      if (Math.hypot(u.x - at[0], u.y - at[1]) > CAMP_RADIUS) continue;
      if (!best || Math.hypot(u.x - from[0], u.y - from[1]) < Math.hypot(best.x - from[0], best.y - from[1])) best = u;
    }
    return best;
  };

  const needSelection = (): boolean => {
    if (rts()?.selectedUnitIds().length) return true;
    d.error("Select something first.");
    return false;
  };

  const findButton = (pred: (b: CommandButton) => boolean): CommandButton | null =>
    d.card().find((b) => !b.passive && pred(b)) ?? null;

  /** Press a card button; reports why not when it is greyed. */
  const pressButton = (b: CommandButton): boolean => {
    if (b.disabled) {
      d.error(`${sayable(b.name)} is not available.`);
      return false;
    }
    d.press(b.id);
    return true;
  };

  /** The names of what `id` still needs: its first requirement tier, less whatever of ours
   *  already stands (finished) of each. */
  const missingRequirements = (id: string): string[] => {
    const have = new Set(mine().filter((u) => u.constructing === 0).map((u) => u.typeId));
    return (d.tech.get(id).requiresTiers[0] ?? [])
      .filter((req) => !have.has(req) && !d.tech.get(req).dependencyOr.some((alt) => have.has(alt)))
      .map((req) => d.units.get(req)?.name || d.tech.get(req).name || req);
  };

  /** The own building that can train `unitId` — the selected one first, then the least busy. */
  const trainer = (unitId: string): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const sel = new Set(r.selectedUnitIds());
    const can = mine().filter((u) => u.building && d.tech.get(u.typeId).trains.includes(unitId));
    can.sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
    return can[0] ?? null;
  };

  /**
   * "Put the rally point of the barracks on my hero": every finished building of ours of that
   * type rallies there, with the command the Set Rally Point click sends — and the selection is
   * left alone, since the player never selected the barracks. A unit is rallied ON (its units
   * follow it), a mine or a point is rallied AT.
   */
  const rallyOf = (source: LexEntry, t: VoiceTarget | undefined): void => {
    const r = rts();
    if (!r) return;
    const at = mine().filter((u) => u.building && u.typeId === source.id && u.constructing === 0);
    if (!at.length) { d.error(`You have no ${source.phrase}.`); return; }
    if (!t) { d.error(`Where should the ${source.phrase} rally?`); return; }
    const spot = resolve(t, "mine", [at[0].x, at[0].y]);
    if ("fail" in spot) { d.error(spot.fail); return; }
    let p: [number, number] | null = "unit" in spot ? [spot.unit.x, spot.unit.y] : "point" in spot ? spot.point : null;
    if ("cursor" in spot) {
      const c = d.cursor();
      p = r.groundPoint(c.x, c.y);
    }
    if (!p) return;
    for (const b of at) {
      r.execute(me(), "unit" in spot
        ? { c: "rally", unitId: b.id, x: p[0], y: p[1], kind: "unit", targetId: spot.unit.id }
        : { c: "rally", unitId: b.id, x: p[0], y: p[1], kind: "point", targetId: 0 });
    }
  };

  /**
   * Workers FINISH WHAT THEY ARE BUILDING. An order said to the selection — a move, an attack, a
   * stop, a spell — is given to everyone selected EXCEPT a worker on a construction job, who is
   * left out of the selection for the order and put back after it, so the player keeps the
   * selection they had. (A click still re-tasks a builder, as in the game; this is the spoken
   * path, where nobody looked at who was in the group.) Orders that name their own units or do
   * not touch the selection pass straight through.
   */
  const shield = (i: VoiceIntent, fn: () => void): void => {
    const r = rts();
    const guarded = (i.kind === "order" && !i.subject && !i.source) || i.kind === "stop" || i.kind === "hold" || i.kind === "press";
    if (!r || !guarded) return fn();
    const sel = r.selectedUnitIds();
    const busy = sel.filter((id) => { const u = r.simView.units.get(id); return !!u && busyBuilding(u); });
    if (!busy.length) return fn();
    if (busy.length === sel.length) {
      d.error(busy.length > 1 ? "They are building — they will finish first." : "Busy building — it will finish first.");
      return;
    }
    for (const id of busy) r.scriptSelect(id, false);
    const rest = r.selectedUnitIds().join(",");
    fn();
    // Put the builders back only if the order left the selection as it found it.
    if (r.selectedUnitIds().join(",") === rest) for (const id of busy) r.scriptSelect(id, true);
  };

  const run = (i: VoiceIntent): void => {
    const r = rts();
    if (!r) return;
    switch (i.kind) {
      case "order": {
        if (i.order === "rally" && i.source) { rallyOf(i.source, i.target); return; }
        if (i.subject && !selectSubject(i.subject)) return;
        // "Go to gold", "go to the trees": for gatherers a resource is somewhere to WORK, not to
        // stand — the right-click on a mine or a tree, which is a harvest. Only when everybody it
        // is said to can gather that resource; an army sent to the gold mine walks there.
        if ((i.order === "move" || i.order === "smart") && (i.target?.kind === "mine" || i.target?.kind === "trees")) {
          const res = i.target.kind === "mine" ? "gold" : "lumber";
          const sel = r.selectedUnitIds().map((id) => r.simView.units.get(id)).filter((u): u is SimUnit => !!u && !u.building);
          if (!sel.length || sel.every((u) => canGather(u, res))) { run({ kind: "harvest", res, target: i.target }); return; }
        }
        if (!needSelection()) return;
        // A creep camp is ATTACKED, not attack-moved to: an attack-move fights everything it
        // walks past, so an army sent to a green camp took on the red one beside its path. The
        // order goes on one creep of THAT camp, which walks there without stopping; when it falls
        // the rest of the camp is already fighting back and is taken next.
        if ((i.order === "attackmove" || i.order === "attack") && i.target?.kind === "creeps") {
          const spot = resolve(i.target, "enemy");
          if ("fail" in spot) { d.error(spot.fail); return; }
          const creep = "point" in spot ? campCreep(spot.point) : null;
          if (creep) {
            d.press("attack");
            if (click({ unit: creep })) ride();
            return;
          }
          // A camp in the fog has no creep to aim at: WALK (a move fights nothing on the way) to
          // just short of it, then a QUEUED attack-move covers the last stretch into it.
          if ("point" in spot) {
            const [cx, cy] = spot.point;
            const [ax, ay] = anchor();
            const len = Math.hypot(cx - ax, cy - ay) || 1;
            const short = Math.min(CAMP_APPROACH, len);
            d.press("move");
            if (!click({ point: [cx - ((cx - ax) / len) * short, cy - ((cy - ay) / len) * short] })) return;
            d.press("attack");
            const at = screenOf(spot);
            if (at) r.orderClickAt(at.x, at.y, true);
            else r.minimapClick(cx, cy, false, true);
            ride();
            return;
          }
        }
        if (i.order === "smart") {
          if (!i.target) return;
          // "Follow the archmage": a MOVE onto a friendly unit is a follow, wherever it stands on
          // the map (a right-click only reaches what is on screen). Never on itself.
          if (i.target.kind === "unit" || i.target.kind === "hero") {
            const sel = new Set(r.selectedUnitIds());
            const spot = resolve(i.target, "mine", anchor(), true);
            if ("unit" in spot && !sel.has(spot.unit.id) && sideOf(spot.unit) !== "enemy") {
              // The right-click's own order on a friend (rts.ts moveAt): FOLLOW, which keeps
              // walking after it — a move to where it stands now would stop there.
              const leader = spot.unit.id;
              let any = false;
              for (const id of sel) {
                if (r.execute(me(), { c: "order", unitId: id, order: { kind: "follow", targetId: leader }, queued: false })) any = true;
              }
              if (!any) d.error(`They cannot follow the ${i.target.kind === "unit" ? i.target.entry.phrase : "hero"}.`);
              return;
            }
          }
          const spot = resolve(i.target, "mine");
          if ("fail" in spot) { d.error(spot.fail); return; }
          const at = screenOf(spot);
          if (at) r.moveAt(at.x, at.y, false);
          return;
        }
        // Attack-move IS the attack order aimed at the ground (WC3's A-click), so it arms the
        // same button; an attack aimed at a unit is an attack on that unit.
        const button = i.order === "attackmove" ? "attack" : i.order;
        d.press(button);
        if (aim(i.target, i.order === "move" || i.order === "rally" ? "mine" : "enemy") && i.target && i.order !== "rally") ride();
        return;
      }
      case "retreat": {
        // "Fall back": the whole army — the "-" key's selection — walks home (our town hall), or
        // to the place said. A MOVE, not an attack-move: falling back is not stopping to fight.
        if (!d.selectAllArmy()) { d.error("You have no army."); return; }
        d.press("move");
        if (aim(i.target ?? { kind: "base", side: "mine" }, "mine")) ride();
        return;
      }
      case "stop": if (needSelection()) r.stopSelected(); return;
      case "hold": if (needSelection()) r.holdSelected(); return;
      case "cancel": d.press("cancel"); return;
      case "harvest": {
        // Gathering is the workers' RIGHT-CLICK on a mine or a tree, so it is one here too —
        // given a selection at a time (a selection holds 12; "all peasants" may be more).
        let units: SimUnit[];
        if (i.subject) {
          units = pickSubject(i.subject);
          if (!units.length) { d.error(`No ${subjectName(i.subject)}.`); return; }
        } else {
          // Whoever is selected that can gather it — a Ghoul in the trees as much as a Peasant.
          const sel = r.selectedUnitIds().map((id) => r.simView.units.get(id)).filter((u): u is SimUnit => !!u && !u.building && canGather(u, i.res) && !busyBuilding(u));
          units = sel.length ? sel : pickSubject({ worker: true, count: 1, counted: false, idle: true }).filter((u) => canGather(u, i.res));
          if (!units.length) { d.error("Select a worker first."); return; }
        }
        // A subject that cannot work the resource is told so rather than walked to it (an
        // Acolyte to the trees).
        const able = units.filter((u) => canGather(u, i.res));
        if (!able.length) { d.error(`They cannot gather ${i.res ?? "that"}.`); return; }
        units = able;
        // Nothing said: gold for whoever can mine, the trees for a lumber-only gatherer (Ghoul).
        const res = i.res ?? (units.every((u) => !u.worker?.gold) ? "lumber" : undefined);
        for (let k = 0; k < units.length; k += 12) {
          const batch = units.slice(k, k + 12);
          r.clearSelection();
          for (const u of batch) r.scriptSelect(u.id, true);
          const t: VoiceTarget = i.target ?? (res === "lumber" ? { kind: "trees" } : { kind: "mine" });
          const spot = resolve(t, "mine");
          if ("fail" in spot) { d.error(spot.fail); return; }
          const at = screenOf(spot);
          if (at) r.moveAt(at.x, at.y, false);
        }
        return;
      }
      case "train": {
        const b = findButton((x) => x.id === `train:${i.entry.id}`);
        if (b) {
          for (let k = 0; k < i.count; k++) if (!pressButton(b)) return;
          return;
        }
        // Not on the card: train it at whichever building of ours makes it, without touching
        // the selection — the same command the card's button sends.
        const at = trainer(i.entry.id);
        if (!at) { d.error(`Nothing of yours trains ${i.entry.phrase}.`); return; }
        for (let k = 0; k < i.count; k++) {
          if (!r.execute(me(), { c: "train", buildingId: at.id, unitId: i.entry.id })) return;
        }
        return;
      }
      case "build": {
        let b = findButton((x) => x.id === `build:${i.entry.id}`);
        if (!b) {
          // The build buttons are a page of the worker's card: open it (selecting a worker if
          // nothing that can build is selected), then press.
          const canBuild = (): boolean => r.selectedUnitIds().some((id) => {
            const u = r.simView.units.get(id);
            return !!u && !busyBuilding(u) && d.tech.get(u.typeId).builds.includes(i.entry.id);
          });
          if (!canBuild()) {
            // An IDLE builder first — taking a miner off the gold is the cost of asking — then the
            // one nearest the middle of the screen.
            const builders = mine().filter((u) => !u.building && !busyBuilding(u) && d.tech.get(u.typeId).builds.includes(i.entry.id));
            const centre = d.screenCentre() ?? anchor();
            builders.sort((a, b) => Number(idleWorker(b)) - Number(idleWorker(a)) || Math.hypot(a.x - centre[0], a.y - centre[1]) - Math.hypot(b.x - centre[0], b.y - centre[1]));
            const worker = builders[0];
            if (!worker) { d.error(`Nothing of yours builds ${i.entry.phrase}.`); return; }
            r.selectSingle(worker.id);
          }
          if (!findButton((x) => x.id === `build:${i.entry.id}`)) {
            const page = findButton((x) => x.id === "build");
            if (page) d.press("build");
          }
          b = findButton((x) => x.id === `build:${i.entry.id}`);
        }
        const name = d.units.get(i.entry.id)?.name ?? i.entry.phrase;
        if (b?.disabled) {
          // Greyed for a REQUIREMENT is worth saying in words: "build a tower" as a night elf
          // with no Hunter's Hall is a question about the tech tree, not a broken command.
          const missing = missingRequirements(i.entry.id);
          d.error(missing.length ? `${name} requires ${missing.join(", ")}.` : `${name} is not available.`);
          return;
        }
        if (!b || !pressButton(b) || !d.placing()) return;
        // A word for a kind of building that THIS race reaches by an upgrade ("tower" as the
        // undead: a Ziggurat, which becomes the Spirit Tower) says so.
        if (i.entry.phrase.toLowerCase() === "tower" && !/tower/i.test(name)) {
          const up = d.tech.get(i.entry.id).upgrade.map((u) => d.units.get(u)?.name).find((n) => n && /tower/i.test(n));
          if (up) d.message(`Building a ${name} — upgrade it to a ${up} for a tower.`);
        }
        // "Here", or nothing said: SOMEWHERE ON THE SCREEN it fits, beside our other buildings —
        // the site a player would have picked, found rather than asked for. "At the cursor" is
        // the mouse; any other place ("by the gold mine") is that place.
        let at: { x: number; y: number } | null;
        if (!i.target || i.target.kind === "screen") at = d.buildSpot();
        else {
          const spot = resolve(i.target, "mine");
          if ("fail" in spot) { d.press("cancel"); d.error(spot.fail); return; }
          at = screenOf(spot);
        }
        if (at) d.placeAt(at.x, at.y);
        else d.error("No room for that on screen — place it with the mouse.");
        return;
      }
      case "research": {
        const b = findButton((x) => (x.id === `research:${i.entry.id}` || x.id === `upgrade:${i.entry.id}`) || (i.entry.kind === "button" && x.id === i.entry.id));
        if (b) { pressButton(b); return; }
        // At whichever building of ours researches it.
        const at = mine().find((u) => u.building && d.tech.get(u.typeId).researches.includes(i.entry.id));
        if (!at) { d.error(`Nothing of yours researches ${i.entry.phrase}.`); return; }
        r.execute(me(), { c: "research", buildingId: at.id, upgradeId: i.entry.id });
        return;
      }
      case "learn": {
        // The learn page, then its button.
        if (!findButton((x) => x.id.startsWith("learn:"))) {
          const page = findButton((x) => x.id === "learnpage");
          if (!page) { d.error("Select a hero with a skill point."); return; }
          d.press("learnpage");
        }
        const b = findButton((x) => x.id === `learn:${i.entry.id}` || (x.id.startsWith("learn:") && sayable(x.name).toLowerCase() === i.entry.phrase.toLowerCase()));
        if (b) pressButton(b);
        else d.error(`Can't learn ${i.entry.phrase} now.`);
        return;
      }
      case "autocast": {
        const b = findButton((x) => x.id === `ability:${i.entry.id}` || x.id === i.entry.id);
        if (!b) { d.error(`${i.entry.phrase} is not on the card.`); return; }
        if (b.altId && b.altId.startsWith("autocast:") && (b.active !== i.on)) d.press(b.altId);
        else if (b.active !== i.on) d.press(`autocast:${i.entry.id}`);
        return;
      }
      case "press": {
        const id = i.entry.kind === "button" ? i.entry.id : `ability:${i.entry.id}`;
        const onCard = (): CommandButton | null =>
          findButton((x) => x.id === id) ??
          findButton((x) => x.id === `ability:${i.entry.id}`) ??
          findButton((x) => sayable(x.name).toLowerCase() === i.entry.phrase.toLowerCase());
        let b = onCard();
        // Not on the card: "use frost nova" means the unit of ours that HAS it.
        if (!b && i.entry.kind === "ability" && selectCaster(i.entry)) b = onCard();
        if (!b) { d.error(`${i.entry.phrase} is not on the card.`); return; }
        if (!pressButton(b)) return;
        // A button that wants a target is armed now: aim it — at what was said, or for a spell
        // at the best target in sight.
        if (r.aimingTarget()) aim(i.target, "enemy");
        return;
      }
      case "useitem": {
        // "Use healing salve on grunt": the HERO carrying it — the selected one first, then any
        // of ours — is selected, the pocket pressed, and the item aimed like a spell (at the
        // grunt of ours with the least life, or by itself with nothing said).
        const holds = (u: SimUnit): number => {
          if (i.slot !== undefined) return u.inventory?.[i.slot] ? i.slot : -1;
          return (u.inventory ?? []).findIndex((it) => !!it && !!i.entry &&
            (it.itemId === i.entry.id || d.items.get(it.itemId)?.name?.toLowerCase() === i.entry.phrase.toLowerCase()));
        };
        const sel = r.selectedUnitIds().map((id) => r.simView.units.get(id)).filter((u): u is SimUnit => !!u);
        let hero = sel.find((u) => holds(u) >= 0);
        if (!hero) {
          const centre = d.screenCentre() ?? anchor();
          hero = mine().filter((u) => !u.building && holds(u) >= 0)
            .sort((a, b) => Math.hypot(a.x - centre[0], a.y - centre[1]) - Math.hypot(b.x - centre[0], b.y - centre[1]))[0];
          if (!hero) { d.error(`Nobody of yours carries ${i.entry?.phrase ?? "that item"}.`); return; }
          r.selectSingle(hero.id);
        }
        d.useInventory(holds(hero));
        // A Town Portal said with nowhere ("tp out") goes HOME — to our main hall — rather than
        // being assisted like a heal onto whichever friend is most hurt.
        const portal = !!i.entry && (d.items.get(i.entry.id)?.abilities ?? []).some((a) => d.abilities.get(a)?.code === "AItp");
        if (r.aimingTarget()) aim(i.target ?? (portal ? { kind: "base", side: "mine" } : undefined), "mine");
        return;
      }
      case "panel": {
        // The F-key's own toggle, asked only when the panel is not already where it was asked
        // to be ("open the menu" with the menu open does nothing).
        // Another panel up: put it away first — one panel at a time, as the F-keys do.
        if (i.open !== false && !d.panelOpen(i.panel)) {
          for (const p of ["quests", "menu", "allies", "chat"] as const) if (p !== i.panel && d.panelOpen(p)) d.togglePanel(p);
        }
        if (i.open === null || i.open !== d.panelOpen(i.panel)) d.togglePanel(i.panel);
        return;
      }
      case "pause": d.pause(i.on); return;
      case "chat": {
        if (!i.text) { d.openChat(i.scope); return; }
        d.sendChat(i.text, i.scope);
        return;
      }
      case "finish": {
        // A building of ours whose construction HALTED — its builder walked off, as a human
        // structure stops dead the moment it does — gets a worker back on it, with the
        // right-click's own order (`buildresume`). An idle worker first, then one off the trees
        // (lumber is the cheaper income to lose), then any other that is not building already.
        const halted = mine().filter((u) => !!u.building && u.building.constructionLeft > 0 &&
          u.building.builderIds.length === 0 && !u.building.selfBuilds && (!i.entry || u.typeId === i.entry.id));
        if (!halted.length) { d.error(i.entry ? `No unfinished ${i.entry.phrase} is waiting for a builder.` : "Nothing is waiting for a builder."); return; }
        const centre = d.screenCentre() ?? anchor();
        halted.sort((a, b) => Math.hypot(a.x - centre[0], a.y - centre[1]) - Math.hypot(b.x - centre[0], b.y - centre[1]));
        const taken = new Set<number>();
        for (const b of i.all ? halted : halted.slice(0, 1)) {
          const workers = mine().filter((u) => u.isPeon && !u.building && !busyBuilding(u) && !taken.has(u.id) &&
            d.tech.get(u.typeId).builds.includes(b.typeId));
          const rank = (u: SimUnit): number => (idleWorker(u) ? 0 : gathering(u, "lumber") ? 1 : 2);
          workers.sort((p, q) => rank(p) - rank(q) || Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y));
          const w = workers[0];
          if (!w) { d.error(`No worker free to finish the ${d.units.get(b.typeId)?.name ?? "building"}.`); return; }
          taken.add(w.id);
          r.execute(me(), { c: "order", unitId: w.id, order: { kind: "buildresume", buildingId: b.id }, queued: false });
        }
        return;
      }
      case "select": {
        // "Select army" is the "-" key, through the HUD's own door.
        if (i.what === "army") { if (!d.selectAllArmy()) d.error("You have no army."); return; }
        if (i.what === "idle") { if (!r.cycleIdleWorker()) d.error("No idle workers."); else d.jumpToSelection(); return; }
        if (i.what === "hero") { if (!d.selectHero(i.index ?? 0)) d.error("No such hero."); return; }
        if (i.subject && selectSubject(i.subject)) d.jumpToSelection();
        return;
      }
      case "group": {
        const key = String(i.n);
        if (i.mode === "assign") { if (needSelection()) r.assignGroup(key); return; }
        if (i.mode === "add") { if (needSelection()) r.appendGroup(key); return; }
        if (!d.recallGroup(i.n)) d.error(`Group ${i.n} is empty.`);
        return;
      }
      case "camera": {
        if (i.target.kind === "screen") return;
        const spot = resolve(i.target, "mine", i.target.kind === "step" ? d.cameraFocus() : d.screenCentre() ?? anchor());
        if ("fail" in spot) { d.error(spot.fail); return; }
        if ("unit" in spot) d.panTo(spot.unit.x, spot.unit.y);
        else if ("point" in spot) d.panTo(spot.point[0], spot.point[1]);
        else if ("cursor" in spot) {
          const c = d.cursor();
          const w = rts()?.groundPoint(c.x, c.y);
          if (w) d.panTo(w[0], w[1]);
        }
        return;
      }
    }
  };

  return {
    acceptsInput: () => d.canAct(),
    lexicon: () => lexicon(d, mine()),
    vocabulary: () => (vocab ??= gameVocabulary(d)),
    perform: (intents, heard) => {
      // The echo: what was heard, then what it was read as — in the message log, where the game
      // prints what a player said.
      d.message(`|cff99ccff“${heard}”|r  ${intents.map(describe).join(" · ")}`);
      for (const i of intents) shield(i, () => run(i));
    },
    status: (t) => d.status(t),
    error: (t) => d.error(t),
  };
}

/** Every name the player could mean right now. */
function lexicon(d: VoiceDriver, own: SimUnit[]): LexEntry[] {
  const out: LexEntry[] = [];
  // The card as it stands: every button by its name, and by its name without the verb.
  for (const b of d.card()) {
    if (b.passive || b.id === "noop") continue;
    const phrase = sayable(b.name);
    if (!phrase) continue;
    out.push({ kind: "button", id: b.id, phrase });
    const bare = phrase.replace(NAME_VERBS, "");
    if (bare !== phrase) out.push({ kind: "button", id: b.id, phrase: bare });
  }
  // The tech tree of everything we own: what it trains, builds and researches — so "train two
  // footmen" works from anywhere, not only with the Barracks selected.
  const types = new Set(own.map((u) => u.typeId));
  for (const t of types) {
    const tech = d.tech.get(t);
    for (const id of tech.trains) {
      const u = d.units.get(id);
      if (u?.name) out.push({ kind: u.isHero ? "hero" : "unit", id, phrase: u.name }, ...shortNames(u.isHero ? "hero" : "unit", id, u.name));
    }
    for (const id of tech.builds) {
      const u = d.units.get(id);
      if (u?.name) out.push({ kind: "building", id, phrase: u.name }, ...shortNames("building", id, u.name));
    }
    for (const id of tech.researches) {
      const up = d.upgrades.get(id);
      const name = up?.names?.[0];
      if (name) out.push({ kind: "upgrade", id, phrase: sayable(name) });
    }
    const def = d.units.get(t);
    if (def) {
      out.push({ kind: def.isBuilding ? "building" : def.isHero ? "hero" : "unit", id: t, phrase: def.name });
      out.push(...shortNames(def.isBuilding ? "building" : def.isHero ? "hero" : "unit", t, def.name));
      for (const a of def.heroAbilities) {
        const ab = d.abilities.get(a);
        if (ab?.name) out.push({ kind: "ability", id: a, phrase: ab.name });
      }
    }
  }
  // Every spell a unit of ours can cast, so "frost nova" reaches the Lich wherever he stands.
  for (const u of own) {
    for (const a of u.abilities) {
      if (a.level <= 0) continue;
      const ab = d.abilities.get(a.id);
      if (ab?.name && ab.target !== "passive") out.push({ kind: "ability", id: a.id, phrase: ab.name });
    }
  }
  // The words a player uses for a KIND of building rather than its name — "tower", "shop",
  // "farm" — meaning this race's own (`raceTerms`).
  const builds = new Set<string>();
  for (const t of types) for (const id of d.tech.get(t).builds) builds.add(id);
  out.push(...raceTerms(d, [...builds]));
  // What is on the map that the player knows of — the names targets are said by: a unit while it
  // can be seen, a BUILDING wherever it has been seen ("the tavern", "the fountain", "the goblin
  // merchant"), by its whole name and by its first and last words ("fountain", "merchant").
  const r = d.rts();
  if (r) {
    const seen = new Set<string>();
    for (const u of r.simView.units.values()) {
      if (seen.has(u.typeId) || u.hp <= 0) continue;
      const fog = r.getVision().stateAt(u.x, u.y);
      if (u.building ? fog === FogState.Unexplored : fog !== FogState.Visible) continue;
      seen.add(u.typeId);
      const def = d.units.get(u.typeId);
      if (!def?.name) continue;
      const kind = def.isBuilding ? "building" : def.isHero ? "hero" : "unit";
      out.push({ kind, id: u.typeId, phrase: def.name });
      if (def.isBuilding && u.owner !== d.localPlayer()) {
        const ws = def.name.split(/\s+/).filter((w) => w.length >= 4 && !/^(of|the)$/i.test(w));
        for (const w of new Set([ws[0], ws[ws.length - 1]])) if (w && w !== def.name) out.push({ kind, id: u.typeId, phrase: w });
      }
    }
  }
  // What every unit of ours CARRIES, by the item's name — "use healing salve" finds the hero
  // holding it whoever is selected.
  for (const u of own) {
    for (const it of u.inventory ?? []) {
      const name = it ? d.items.get(it.itemId)?.name : undefined;
      if (!it || !name) continue;
      const full = sayable(name);
      out.push({ kind: "item", id: it.itemId, phrase: full });
      // The way an item is SAID: "Potion of Healing" is a "healing potion", "Scroll of Town
      // Portal" a "town portal" (or a "tp"), "Healing Salve" a "salve".
      const of = /^(\w+) of (.+)$/i.exec(full);
      if (of) out.push({ kind: "item", id: it.itemId, phrase: `${of[2]} ${of[1]}` }, { kind: "item", id: it.itemId, phrase: of[2] });
      const last = full.split(/\s+/).pop() ?? "";
      if (last.length >= 4 && last !== full) out.push({ kind: "item", id: it.itemId, phrase: last });
      if (/town portal/i.test(full)) out.push({ kind: "item", id: it.itemId, phrase: "tp" });
    }
  }
  return out;
}

/**
 * The short ways a name is SAID, beside the name itself: "Crypt Fiend" is a "fiend" (and wears
 * "Fiend 4" on its label), "Orc Burrow" a "burrow", "Moon Well" a "moonwell". The last word, when
 * it is a word nobody says for anything else; and two short words run together, the way the
 * recogniser often writes them.
 */
const NOT_SHORT = new Set(["well", "hall", "tower", "keep", "mage", "rider", "golem", "lord", "master", "hunter"]);
function shortNames(kind: LexEntry["kind"], id: string, name: string): LexEntry[] {
  const ws = name.split(/\s+/).filter(Boolean);
  const out: LexEntry[] = [];
  // What the recogniser writes for the names it has never heard spoken: an Orc Burrow comes out
  // a "borough" or a "barrow" (the parser's own sound-alike test is for SHORT misses).
  for (const [re, also] of SOUNDS_LIKE) if (re.test(name)) for (const phrase of also) out.push({ kind, id, phrase, misheard: true });
  if (ws.length < 2) return out;
  const last = ws[ws.length - 1];
  if (last.length >= 5 && !NOT_SHORT.has(last.toLowerCase())) out.push({ kind, id, phrase: last });
  if (ws.length === 2 && ws.every((w) => w.length <= 5)) out.push({ kind, id, phrase: ws.join("") });
  return out;
}
const SOUNDS_LIKE: Array<[RegExp, string[]]> = [
  [/^orc burrow$/i, ["burrow", "borough", "barrow", "burro", "burrows"]],
  [/^ziggurat$/i, ["ziggarat", "zigurat", "ziggurate", "zigarat", "sigurat"]],
  [/^moon well$/i, ["moon wall", "moon whale"]],
  [/^farm$/i, ["farms"]],
];

/**
 * The race-neutral words for a KIND of building, each meaning the one THIS player's workers
 * build — read off the data rather than listed per race, so a custom race gets them too:
 *
 * - **shop**: builds whose `Makeitems` is not empty (Arcane Vault, Voodoo Lounge, Tomb of Relics,
 *   Ancient of Wonders) — the race shop is the one building whose stock is items it makes;
 * - **tower**: one whose name says Tower, or one that ATTACKS and trains nothing (the Ancient
 *   Protector — an Ancient of War attacks too, but it is a barracks), or one that UPGRADES into
 *   either (the undead's Ziggurat, which becomes its Spirit Tower);
 * - **farm / supply / house / food**: one that makes food and is not a town hall (Farm, Orc
 *   Burrow, Ziggurat, Moon Well);
 * - **hall / town hall / base**: `buffType` townhall;
 * - **altar**: one that trains a hero;
 * - **barracks**: one that trains a soldier — not a hero, not a worker — with the fewest
 *   requirements (Barracks, Crypt, Ancient of War).
 */
function raceTerms(d: VoiceDriver, builds: string[]): LexEntry[] {
  const out: LexEntry[] = [];
  const def = (id: string) => d.units.get(id);
  const attacks = (id: string): boolean => (def(id)?.attackDamage ?? 0) + (def(id)?.attackDice ?? 0) > 0 && def(id)?.buffType !== "townhall";
  const named = (id: string, w: RegExp): boolean => w.test(def(id)?.name ?? "");
  const add = (ids: string[], phrases: string[]): void => {
    const id = ids[0];
    if (id) for (const phrase of phrases) out.push({ kind: "building", id, phrase });
  };
  add(builds.filter((id) => d.tech.get(id).makeitems.length > 0), ["shop", "store"]);
  // A tower attacks and TRAINS NOTHING — an Ancient of War and a Tree of Life swing at you too.
  const defends = (id: string): boolean => attacks(id) && d.tech.get(id).trains.length === 0;
  add([
    ...builds.filter((id) => named(id, /tower/i)),
    ...builds.filter(defends),
    ...builds.filter((id) => d.tech.get(id).upgrade.some((u) => named(u, /tower/i) || defends(u))),
  ], ["tower", "defense", "defence"]);
  add(builds.filter((id) => (def(id)?.foodMade ?? 0) > 0 && def(id)?.buffType !== "townhall"), ["farm", "supply", "house", "food"]);
  add(builds.filter((id) => def(id)?.buffType === "townhall"), [
    "hall", "town hall", "main building", "main hall", "main base", "main", "base", "home base",
    "headquarters", "hq", "town center", "town centre", "home",
  ]);
  add(builds.filter((id) => d.tech.get(id).trains.some((t) => def(t)?.isHero)), ["altar"]);
  const soldier = (t: string): boolean => !!def(t) && !def(t)!.isHero && !def(t)!.classification.includes("peon") && attacks(t);
  const reqs = (id: string): number => d.tech.get(id).requiresTiers[0]?.length ?? 0;
  add(builds.filter((id) => d.tech.get(id).trains.some(soldier)).sort((a, b) => reqs(a) - reqs(b)), ["barracks", "rax"]);
  return out;
}

/**
 * Every name a player might say in Warcraft III, whoever owns it: the melee units, buildings,
 * heroes and creeps (campaign-only and special rows left out — they are not what anybody calls
 * out in a match), every ability one of them carries, and every item. Grammar only — saying a
 * name the match cannot act on is still heard RIGHT, and answered as such.
 */
function gameVocabulary(d: VoiceDriver): string[] {
  const out = new Set<string>();
  const abilities = new Set<string>();
  for (const u of d.units.all()) {
    if (u.campaign || u.special || !u.name) continue;
    out.add(u.name);
    for (const a of [...u.abilities, ...u.heroAbilities]) abilities.add(a);
  }
  for (const a of abilities) {
    const name = d.abilities.get(a)?.name;
    if (name) out.add(name);
  }
  for (const it of d.items.all()) if (it.name) out.add(it.name);
  return [...out].map(sayable).filter(Boolean);
}
