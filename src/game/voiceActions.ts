import type { CommandButton } from "../ui/hud";
import type { RtsController } from "./rts";
import type { UnitRegistry } from "../data/units";
import type { AbilityRegistry } from "../data/abilities";
import type { TechRegistry } from "../data/techtree";
import type { UpgradeRegistry } from "../data/upgrades";
import type { SimUnit } from "../sim/world";
import { FogState } from "../sim/vision";
import { describe, type LexEntry, type Pick, type Region, type VoiceIntent, type VoiceTarget } from "../voice/parser";
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
  canAct(): boolean;
  /** The card as the HUD shows it, and the page it is on. */
  card(): CommandButton[];
  /** Press a card button by its command id (`runCommand`). */
  press(id: string): void;
  /** Where the mouse is, in canvas CSS pixels. */
  cursor(): { x: number; y: number };
  /** The ground at the middle of the screen — what "here" means — in world units. */
  screenCentre(): [number, number] | null;
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
  recallGroup(n: number): boolean;
  selectHero(index: number): boolean;
  /** The inventory pockets' names, null for an empty one. */
  inventory(): Array<{ name: string; usable: boolean } | null>;
  useInventory(slot: number): void;
  /** The message log (what was heard) and the gold error line (what went wrong). */
  message(text: string): void;
  error(text: string): void;
  /** Voice Control's "Listening…" line. */
  status(text: string | null): void;
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

  const nearest = (pred: (u: SimUnit) => boolean): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const [ax, ay] = anchor();
    let best: SimUnit | null = null;
    let bestD = Infinity;
    for (const u of r.simView.units.values()) {
      if (!pred(u)) continue;
      const dd = (u.x - ax) ** 2 + (u.y - ay) ** 2;
      if (dd < bestD) { bestD = dd; best = u; }
    }
    return best;
  };

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
  const choose = (pred: (u: SimUnit) => boolean, pick: Pick | undefined, region: Region | undefined, from: [number, number]): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const list = [...r.simView.units.values()].filter((u) => pred(u) && inRegion(u.x, u.y, region));
    const cam = d.screenCentre() ?? from;
    const origin = pick === "next" ? cam : from;
    list.sort((a, b) => (a.x - origin[0]) ** 2 + (a.y - origin[1]) ** 2 - ((b.x - origin[0]) ** 2 + (b.y - origin[1]) ** 2));
    if (pick === "next") return list.find((u) => Math.hypot(u.x - cam[0], u.y - cam[1]) > 700) ?? list[0] ?? null;
    return list[0] ?? null;
  };

  /** A target, read from the local player's eyes. `prefer` is the side a bare "the hero" means
   *  for this verb (an attack means theirs, a camera jump means ours). `from` is where "nearest"
   *  is measured: the selection for an order, the screen for the camera. */
  type Spot = { cursor: true } | { unit: SimUnit } | { point: [number, number] } | { fail: string };
  const resolve = (t: VoiceTarget, prefer: "enemy" | "mine", from: [number, number] = anchor()): Spot => {
    const r = rts();
    if (!r) return { fail: "No match." };
    const sideOk = (u: SimUnit, side: string): boolean => side === "any" || sideOf(u) === side;
    const known = (u: SimUnit): boolean => r.getVision().stateAt(u.x, u.y) !== FogState.Unexplored;
    switch (t.kind) {
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
        const u = choose((x) => x.isHero && !x.isIllusion && x.hp > 0 && (side === "mine" ? x.owner === me() : visible(x) && sideOk(x, side)), t.pick, t.region, from);
        return u ? { unit: u } : { fail: side === "mine" ? "You have no hero." : "No hero in sight." };
      }
      case "unit": {
        const side = t.side;
        const u = choose((x) => x.hp > 0 && x.typeId === t.entry.id && (x.owner === me() ? side !== "enemy" : visible(x) && sideOk(x, side)), t.pick, t.region, from)
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
        const cam = d.screenCentre() ?? from;
        const origin = t.pick === "next" ? cam : from;
        const list = [...r.simView.mines.values()]
          .filter((m) => m.gold > 0 && r.getVision().stateAt(m.x, m.y) !== FogState.Unexplored && inRegion(m.x, m.y, t.region))
          .sort((a, b) => Math.hypot(a.x - origin[0], a.y - origin[1]) - Math.hypot(b.x - origin[0], b.y - origin[1]));
        const m = t.pick === "next" ? list.find((x) => Math.hypot(x.x - cam[0], x.y - cam[1]) > 700) ?? list[0] : list[0];
        return m ? { point: [m.x, m.y] } : { fail: t.region ? "No gold mine found there." : "No gold mine found." };
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

  /** The order is armed (a button pressed that wants a target): finish it at the spot, the way
   *  the click after the press would. An unsaid target leaves it armed for the player's own
   *  click — except a SPELL, which aims itself (`assistCast`). */
  const aim = (t: VoiceTarget | undefined, prefer: "enemy" | "mine"): boolean => {
    const r = rts();
    if (!r) return false;
    const casting = r.orderMode === "cast" && !!r.armedCast;
    if (casting && (!t || t.kind === "screen")) {
      // "frost nova" / "frost nova here": the best target near the caster, or near the middle
      // of the screen when the player pointed there.
      if (assistCast(t ? d.screenCentre() : null)) return true;
      if (!t) {
        d.status(null);
        d.error("No target for that in sight — click one.");
        return false;
      }
    }
    if (!t) return true;
    const spot = resolve(t, prefer);
    if ("fail" in spot) {
      d.press("cancel");
      d.error(spot.fail);
      return false;
    }
    return click(spot);
  };

  /**
   * Aim the armed spell for the player. Who it is FOR comes off the row's own Targets Allowed: a
   * row that may hit an enemy is a weapon and goes on the enemy — a hero first, then whoever is
   * nearest; a row that may only touch friends is a gift and goes on the friend who needs it
   * most (lowest share of life). An AREA spell aimed at the ground goes where the most enemies
   * stand inside its own radius. Every candidate is offered to the card's own aim in turn, so a
   * target the spell cannot take (out of range is the cast's own walk; air, magic-immune,
   * mechanical are its refusals) simply passes to the next.
   */
  const assistCast = (near: [number, number] | null): boolean => {
    const r = rts();
    const armed = r?.armedCast;
    if (!r || !armed) return false;
    const caster = r.selectedUnitIds().map((id) => r.simView.units.get(id)).find((u) => u?.abilities.some((a) => a.code === armed.code && a.level > 0));
    const ab = caster?.abilities.find((a) => a.code === armed.code);
    const def = d.abilities.get(armed.abilityId ?? ab?.id ?? armed.code) ?? d.abilities.get(armed.code);
    if (!caster || !def) return false;
    const flags = new Set(def.targetFlags);
    const hostile = flags.has("enemy") || flags.has("enemies") || (!flags.has("friend") && !flags.has("allies") && !flags.has("player") && !flags.has("self"));
    const lvl = def.levelData[Math.max(0, (ab?.level ?? 1) - 1)];
    const reach = Math.max(lvl?.castRange ?? 0, 600) + 400;
    const from = near ?? [caster.x, caster.y];
    const pool = [...r.simView.units.values()].filter((u) =>
      u.hp > 0 && !u.isIllusion && visible(u) && Math.hypot(u.x - caster.x, u.y - caster.y) <= reach + (near ? 1200 : 0) &&
      (hostile ? sideOf(u) === "enemy" : sideOf(u) === "mine" || sideOf(u) === "ally"));
    if (!pool.length) return false;
    const dist = (u: SimUnit): number => Math.hypot(u.x - from[0], u.y - from[1]);
    if (armed.target === "point") {
      const area = armed.area || lvl?.area || 250;
      const crowd = (u: SimUnit): number => pool.filter((o) => Math.hypot(o.x - u.x, o.y - u.y) <= area).length;
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
      pool.push(...(hurt.length ? hurt : [caster]));
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

  /** The own building that can train `unitId` — the selected one first, then the least busy. */
  const trainer = (unitId: string): SimUnit | null => {
    const r = rts();
    if (!r) return null;
    const sel = new Set(r.selectedUnitIds());
    const can = mine().filter((u) => u.building && d.tech.get(u.typeId).trains.includes(unitId));
    can.sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
    return can[0] ?? null;
  };

  const run = (i: VoiceIntent): void => {
    const r = rts();
    if (!r) return;
    switch (i.kind) {
      case "order": {
        if (!needSelection()) return;
        if (i.order === "smart") {
          if (!i.target) return;
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
        aim(i.target, i.order === "move" || i.order === "rally" ? "mine" : "enemy");
        return;
      }
      case "stop": if (needSelection()) r.stopSelected(); return;
      case "hold": if (needSelection()) r.holdSelected(); return;
      case "cancel": d.press("cancel"); return;
      case "harvest": {
        // Gathering is the workers' RIGHT-CLICK on a mine or a tree, so it is one here too.
        if (!r.selectedUnitIds().length) r.cycleIdleWorker();
        if (!needSelection()) return;
        const t: VoiceTarget = i.target ?? (i.res === "lumber" ? { kind: "trees" } : { kind: "mine" });
        const spot = resolve(t, "mine");
        if ("fail" in spot) { d.error(spot.fail); return; }
        const at = screenOf(spot);
        if (at) r.moveAt(at.x, at.y, false);
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
            return !!u && d.tech.get(u.typeId).builds.includes(i.entry.id);
          });
          if (!canBuild()) {
            const worker = nearest((u) => u.owner === me() && !u.building && d.tech.get(u.typeId).builds.includes(i.entry.id));
            if (!worker) { d.error(`Nothing of yours builds ${i.entry.phrase}.`); return; }
            r.selectSingle(worker.id);
          }
          if (!findButton((x) => x.id === `build:${i.entry.id}`)) {
            const page = findButton((x) => x.id === "build");
            if (page) d.press("build");
          }
          b = findButton((x) => x.id === `build:${i.entry.id}`);
        }
        if (!b || !pressButton(b) || !d.placing()) return;
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
        const inv = d.inventory();
        const slot = i.slot ?? inv.findIndex((s) => !!s && !!i.entry && sayable(s.name).toLowerCase() === i.entry.phrase.toLowerCase());
        if (slot < 0 || !inv[slot]) { d.error("No such item."); return; }
        d.useInventory(slot);
        if (i.target && r.aimingTarget()) aim(i.target, "mine");
        return;
      }
      case "select": {
        if (i.what === "army") { if (!r.selectAllArmy()) d.error("You have no army."); return; }
        if (i.what === "idle") { if (!r.cycleIdleWorker()) d.error("No idle workers."); else d.jumpToSelection(); return; }
        if (i.what === "hero") { if (!d.selectHero(i.index ?? 0)) d.error("No such hero."); return; }
        const id = i.entry?.id;
        const ofType = mine().filter((u) => u.typeId === id);
        if (!ofType.length) { d.error(`You have no ${i.entry?.phrase ?? "such unit"}.`); return; }
        // The double-click's selection, map-wide: voice cannot see the screen edge, so "select
        // footmen" means your footmen — nearest first, as many as a selection holds (12).
        const [ax, ay] = anchor();
        ofType.sort((a, b) => (a.x - ax) ** 2 + (a.y - ay) ** 2 - ((b.x - ax) ** 2 + (b.y - ay) ** 2));
        r.clearSelection();
        for (const u of ofType.slice(0, 12)) r.scriptSelect(u.id, true);
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
        const spot = resolve(i.target, "mine", d.screenCentre() ?? anchor());
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
    perform: (intents, heard) => {
      // The echo: what was heard, then what it was read as — in the message log, where the game
      // prints what a player said.
      d.message(`|cff99ccff“${heard}”|r  ${intents.map(describe).join(" · ")}`);
      for (const i of intents) run(i);
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
      if (u?.name) out.push({ kind: u.isHero ? "hero" : "unit", id, phrase: u.name });
    }
    for (const id of tech.builds) {
      const u = d.units.get(id);
      if (u?.name) out.push({ kind: "building", id, phrase: u.name });
    }
    for (const id of tech.researches) {
      const up = d.upgrades.get(id);
      const name = up?.names?.[0];
      if (name) out.push({ kind: "upgrade", id, phrase: sayable(name) });
    }
    const def = d.units.get(t);
    if (def) {
      out.push({ kind: def.isBuilding ? "building" : def.isHero ? "hero" : "unit", id: t, phrase: def.name });
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
  // What is on the map that the player can see — the names targets are said by.
  const r = d.rts();
  if (r) {
    const seen = new Set<string>();
    for (const u of r.simView.units.values()) {
      if (seen.has(u.typeId) || u.hp <= 0) continue;
      if (r.getVision().stateAt(u.x, u.y) !== FogState.Visible) continue;
      seen.add(u.typeId);
      const def = d.units.get(u.typeId);
      if (def?.name) out.push({ kind: def.isBuilding ? "building" : def.isHero ? "hero" : "unit", id: u.typeId, phrase: def.name });
    }
  }
  // The inventory, by name.
  d.inventory().forEach((s) => {
    if (s?.usable && s.name) out.push({ kind: "item", id: s.name, phrase: sayable(s.name) });
  });
  return out;
}
