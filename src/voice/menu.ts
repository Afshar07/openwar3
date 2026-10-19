import { popupOptions } from "../ui/fdf/widgets";
import { voiceClick, voicePoint, voicePointed } from "../ui/gamepad";
import { dressAsGameTip } from "../ui/gameTipSkin";
import { stem, words, type LexEntry } from "./parser";
import type { VoiceHost } from "./control";

// Voice Control in the MENUS: "click single player", "move the cursor to options", "select echo
// isles", "change my race to orc", "change the second player to insane", "put the red player on
// team two", "turn on observer mode".
//
// Nothing here knows any particular screen. Every glue screen is the game's own FrameDef drawn
// into the DOM (ui/fdf/render.ts), and what a player can SEE on it is what they can SAY: so the
// screen is read off the page at the moment the key goes down — every visible button by its
// caption, every checkbox and dropdown by the label beside it, every list row by its text, every
// dropdown's own options — and a sentence is matched against that. A map's name, a menu's
// options, a lobby's player rows all come with the screen, and a screen added tomorrow is
// speakable without a line here.
//
// The lobby's player rows are the one place a LABEL is not enough: ten rows carry the same five
// dropdowns ("NameMenu3", "RaceMenu3", "TeamButton3", "ColorButton3", "HandicapMenu3" —
// ui/playerSlots.ts), told apart only by their row. So a sentence may name a ROW ("the second
// player", "player three", "the red player", "my") and a FIELD ("race", "team", "colour",
// "handicap", "player"), and when it names no field the field is the dropdown in that row that
// HAS the value said: "change the second player to insane" is the player menu, "…to orc" the race.
//
// Every action is the PAD's (ui/gamepad.ts): the drawn cursor and the gold box land on the
// control and press it, so the control hears the pointer events a mouse would send — the click
// sound, the glow, the tooltip and the screen's own handler, all unchanged.

/** One thing on screen a sentence may name. */
interface MenuItem {
  kind: "button" | "checkbox" | "popup" | "row";
  el: HTMLElement;
  /** What it is called — the caption, the label beside it, the row's text. */
  label: string;
  /** `label` as comparison keys (stemmed, stop words out). */
  keys: string[];
  disabled: boolean;
  /** A lobby player row's index and which of its five dropdowns this is. */
  slot?: { row: number; field: SlotField };
}

type SlotField = "name" | "race" | "team" | "color" | "handicap";

const SLOT_FRAMES: Record<string, SlotField> = {
  NameMenu: "name", RaceMenu: "race", TeamButton: "team", ColorButton: "color", HandicapMenu: "handicap",
};

/** Words that carry nothing when comparing a sentence with a caption. */
const STOP = new Set(["the", "a", "an", "of", "on", "to", "as", "my", "our", "for", "and", "button", "please", "in", "into", "at", "it", "that", "this"]);

/** The sayings for a slot field. */
const FIELD_WORDS: Record<string, SlotField> = {
  race: "race", races: "race", faction: "race",
  team: "team", teams: "team", side: "team",
  color: "color", colour: "color", colors: "color", colours: "color",
  handicap: "handicap", health: "handicap",
  player: "name", type: "name", slot: "name", difficulty: "name", computer: "name", ai: "name", controller: "name",
};

/** The game's own player colours, in `UI\TriggerData.txt` playercolor order — how a lobby row is
 *  called by its colour ("the red player"). Two-word ones first, so "light blue" is not "blue". */
const COLOURS = ["light blue", "dark green", "red", "blue", "teal", "purple", "yellow", "orange", "green", "pink", "gray", "grey", "brown"];

/** The colours by their PLAYER number — `UI\TriggerData.txt` playercolor order. The lobby's
 *  colour menu labels its swatches "Player N" (ui/fdfSkirmish.ts), so this is how one is SAID. */
const COLOUR_BY_PLAYER = ["red", "blue", "teal", "purple", "yellow", "orange", "green", "pink", "gray", "light blue", "dark green", "brown"];

/** A colour option's label in words: "Player 2" → "Player 2 blue". */
function sayColour(label: string): string {
  const m = /^Player (\d+)$/.exec(label.trim());
  return m ? `${label} ${COLOUR_BY_PLAYER[Number(m[1]) - 1] ?? ""}` : label;
}

const ORDINALS: Record<string, number> = {
  first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9, eleventh: 10, twelfth: 11,
  one: 0, two: 1, three: 2, four: 3, five: 4, six: 5, seven: 6, eight: 7, nine: 8, ten: 9, eleven: 10, twelve: 11,
};
for (let i = 1; i <= 12; i++) ORDINALS[String(i)] = i - 1;

/** Number words → digits, so "team two" meets "Team 2" and "fifty percent" meets "50%". */
const DIGITS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

function keysOf(text: string): string[] {
  return words(text.replace(/\+/g, " plus ").replace(/%/g, " percent "))
    .map((w) => DIGITS[w] ?? w)
    .filter((w) => !STOP.has(w))
    .map(stem);
}

/** Close enough to be the same word: equal, or one edit apart in a word of five letters or more
 *  (a recogniser's "isle" for "isles" survives stemming; "orc" for "ork" does not need to). */
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.length + b.length - 2 * (i + j) <= 2;
}

/**
 * How well a spoken phrase names a caption: the share of the caption's words that were said,
 * plus a little for each — so "single player" beats "player" for "Single Player", and "observer
 * mode" names "Observer Mode" and not "Observers:". Zero when too little of it was said.
 */
function score(said: readonly string[], keys: readonly string[]): number {
  if (!keys.length || !said.length) return 0;
  const hits = keys.filter((k) => said.some((w) => near(w, k))).length;
  const extra = said.filter((w) => !keys.some((k) => near(w, k))).length;
  if (!hits || (hits < keys.length / 2 && hits < 2)) return 0;
  return hits / keys.length + hits * 0.05 - extra * 0.02;
}

function best<T>(said: readonly string[], items: readonly T[], keys: (t: T) => readonly string[]): T | null {
  let top: T | null = null;
  let topScore = 0;
  for (const it of items) {
    const s = score(said, keys(it));
    if (s > topScore) { topScore = s; top = it; }
  }
  return top;
}

// ---- reading the screen ------------------------------------------------------------------

function visible(el: HTMLElement): boolean {
  if (el.closest("[hidden]")) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}

/** "HotkeyEditorButton" → "hotkey editor": a control with no caption is still called something. */
function frameWords(name: string | undefined): string {
  return (name ?? "")
    .replace(/\d+$/, "")
    .replace(/(Button|CheckBox|Checkbox|Menu|Backdrop|Popup)$/g, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

/** What is on screen now: the topmost modal if one is up — a menu's message box, or an in-game
 *  panel (F10's menu, the Quest Log, Allies, Chat: each sits on an `fdf-dialog-scrim`) — else
 *  every visible glue screen. */
function scope(): ParentNode {
  const modals = [...document.querySelectorAll<HTMLElement>(".glue-dialog-scrim, .fdf-dialog-scrim")].filter((m) => !m.hidden && visible(m));
  return modals[modals.length - 1] ?? document;
}

/** Whether an in-game panel or a menu's message box is up — what "close" closes. */
function modalUp(): boolean {
  return scope() !== document;
}

/** The leaf text frames in `root` — captions and labels, not controls. */
function texts(root: ParentNode): Array<{ el: HTMLElement; text: string; r: DOMRect }> {
  const out: Array<{ el: HTMLElement; text: string; r: DOMRect }> = [];
  for (const el of root.querySelectorAll<HTMLElement>(".fdf-screen [data-frame]")) {
    if (el.matches(".fdf-button, .fdf-checkbox, .fdf-popup, .fdf-list, .fdf-list-row")) continue;
    if (el.closest(".fdf-button, .fdf-popup, .fdf-list")) continue;
    if (el.querySelector("[data-frame]")) continue;
    const text = el.innerText?.trim();
    if (!text || !visible(el)) continue;
    out.push({ el, text, r: el.getBoundingClientRect() });
  }
  return out;
}

/** The label on the same line as a control: to its right for a checkbox, to its left for a
 *  dropdown — the two ways every glue panel lays them out. */
function labelBeside(r: DOMRect, side: "left" | "right", pool: ReturnType<typeof texts>): string {
  const cy = r.top + r.height / 2;
  let bestText = "";
  let bestGap = Infinity;
  for (const t of pool) {
    const ty = t.r.top + t.r.height / 2;
    if (Math.abs(ty - cy) > Math.max(r.height, t.r.height) * 0.7) continue;
    const gap = side === "right" ? t.r.left - r.right : r.left - t.r.right;
    if (gap < -4 || gap > 320) continue;
    if (gap < bestGap) { bestGap = gap; bestText = t.text; }
  }
  return bestText;
}

function readScreen(): MenuItem[] {
  const root = scope();
  const pool = texts(root);
  const out: MenuItem[] = [];
  const add = (kind: MenuItem["kind"], el: HTMLElement, label: string, slot?: MenuItem["slot"]): void => {
    const clean = label.replace(/\s+/g, " ").trim();
    if (!clean && !slot) return;
    out.push({ kind, el, label: clean, keys: keysOf(clean), disabled: el.classList.contains("fdf-disabled"), slot });
  };
  for (const el of root.querySelectorAll<HTMLElement>(".fdf-button")) {
    if (el.matches(".fdf-checkbox, .fdf-popup") || el.closest(".fdf-popup") || !visible(el)) continue;
    add("button", el, el.innerText?.trim() || frameWords(el.dataset.frame));
  }
  for (const el of root.querySelectorAll<HTMLElement>(".fdf-checkbox")) {
    if (!visible(el)) continue;
    add("checkbox", el, labelBeside(el.getBoundingClientRect(), "right", pool) || frameWords(el.dataset.frame));
  }
  for (const el of root.querySelectorAll<HTMLElement>(".fdf-popup")) {
    if (!visible(el)) continue;
    const m = /^([A-Za-z]+?)(\d+)$/.exec(el.dataset.frame ?? "");
    const field = m ? SLOT_FRAMES[m[1]] : undefined;
    add("popup", el, labelBeside(el.getBoundingClientRect(), "left", pool) || frameWords(el.dataset.frame),
      field ? { row: Number(m![2]), field } : undefined);
  }
  for (const el of root.querySelectorAll<HTMLElement>(".fdf-list-row")) {
    if (el.classList.contains("disabled") || !el.closest(".fdf-screen")) continue;
    add("row", el, el.innerText?.trim() ?? "");
  }
  return out;
}

// ---- the lobby's player rows --------------------------------------------------------------

/** The row a sentence names, if it names one: an ordinal or "player N", a colour, or "my". */
function readRow(ws: readonly string[], items: readonly MenuItem[]): { row: number; used: Set<number> } | null {
  const rows = [...new Set(items.filter((i) => i.slot).map((i) => i.slot!.row))].sort((a, b) => a - b);
  if (!rows.length) return null;
  const used = new Set<number>();
  // "my": the first row that is a person — its player menu names neither a computer nor a seat.
  const mine = ws.findIndex((w) => w === "my" || w === "me" || w === "mine");
  if (mine >= 0) {
    used.add(mine);
    const me = rows.find((r) => {
      const name = items.find((i) => i.slot?.row === r && i.slot.field === "name");
      const label = name?.el.innerText ?? "";
      return name && !/computer|open|closed|observer/i.test(label);
    });
    return { row: me ?? rows[0], used };
  }
  for (let i = 0; i < ws.length; i++) {
    // "player two", "slot three", "the second player", "second"
    const n = ORDINALS[ws[i]];
    const prev = ws[i - 1], next = ws[i + 1];
    if (n !== undefined && (prev === "player" || prev === "slot" || next === "player" || next === "slot" || /(st|nd|rd|th)$/.test(ws[i]))) {
      used.add(i);
      if (prev === "player" || prev === "slot") used.add(i - 1);
      if (next === "player" || next === "slot") used.add(i + 1);
      return rows[n] !== undefined ? { row: rows[n], used } : null;
    }
  }
  // "the red player": the row whose colour menu holds that colour now.
  const text = ws.join(" ");
  for (const c of COLOURS) {
    const at = text.indexOf(c);
    if (at < 0) continue;
    for (const r of rows) {
      const colour = items.find((i) => i.slot?.row === r && i.slot.field === "color");
      const state = colour ? popupOptions(colour.el) : null;
      const n = /^Player (\d+)$/.exec(state?.options.find((o) => o.value === state.value)?.label ?? "");
      if (n && COLOUR_BY_PLAYER[Number(n[1]) - 1] === c.replace("grey", "gray")) {
        const first = text.slice(0, at).split(" ").filter(Boolean).length;
        for (let k = 0; k < c.split(" ").length; k++) used.add(first + k);
        if (ws[first + c.split(" ").length] === "player") used.add(first + c.split(" ").length);
        return { row: r, used };
      }
    }
  }
  return null;
}

// ---- doing it -----------------------------------------------------------------------------

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/** Pick `value` (an option's index) in a dropdown, the way a hand does: open it, click the item. */
async function pick(item: MenuItem, index: number): Promise<boolean> {
  const state = popupOptions(item.el);
  if (!state || item.disabled) return false;
  if (state.options[index]?.value === state.value) return true;
  voiceClick(item.el);
  await frame();
  const menu = [...document.querySelectorAll<HTMLElement>(".fdf-popup-menu")].find((m) => !m.hidden);
  const entries = menu ? [...menu.querySelectorAll<HTMLElement>(".fdf-popup-item")] : [];
  const target = entries[index];
  if (!target) return false;
  voiceClick(target);
  return true;
}

/** The option of a dropdown a phrase names, by its label ("insane" → "Computer (Insane)"; "two"
 *  → "Team 2"). The SHORTEST label that matches wins, so "insane" is the plain computer before
 *  "Computer+ (Insane)" — the plus is said when it is meant. */
function optionFor(said: readonly string[], item: MenuItem): { index: number; score: number } | null {
  const state = popupOptions(item.el);
  if (!state) return null;
  let top: { index: number; score: number } | null = null;
  state.options.forEach((o, index) => {
    const keys = keysOf(sayColour(o.label));
    const hits = said.filter((w) => keys.some((k) => near(w, k))).length;
    if (!hits) return;
    const s = hits * 2 - keys.length * 0.1 - (said.length - hits) * 0.05;
    if (!top || s > top.score) top = { index, score: s };
  });
  return top;
}

const VERB_CLICK = new Set(["click", "press", "hit", "push", "open", "choose", "pick", "select", "go", "start", "play", "enter", "launch"]);
const VERB_HOVER = new Set(["hover", "point", "highlight", "focus"]);
const VERB_ON = new Set(["check", "tick", "enable", "activate"]);
const VERB_OFF = new Set(["uncheck", "untick", "disable", "deactivate"]);
const VERB_SET = new Set(["set", "change", "make", "switch", "put", "turn", "move"]);
const CURSOR = new Set(["cursor", "mouse", "pointer"]);

/** The menu's half of Voice Control (registered once, from main.ts). */
export function makeMenuVoiceHost(): VoiceHost {
  let line: HTMLDivElement | null = null;
  let timer = 0;
  const show = (text: string | null, ms = 0): void => {
    if (!line) {
      line = document.createElement("div");
      line.className = "voice-control-status game-tip menu";
      dressAsGameTip(line);
      document.body.appendChild(line);
    }
    clearTimeout(timer);
    line.hidden = text === null;
    if (text !== null) line.textContent = text;
    if (text !== null && ms) timer = window.setTimeout(() => { if (line) line.hidden = true; }, ms);
  };

  const handle = (text: string): boolean => {
    const ws = words(text);
    if (!ws.length) return false;
    const items = readScreen();
    const say = (msg: string): void => show(`“${text}” — ${msg}`, 3500);

    // "click" / "click it" alone: whatever the cursor was last put on.
    if (ws.length <= 2 && VERB_CLICK.has(ws[0]) && (ws.length === 1 || ws[1] === "it" || ws[1] === "that" || ws[1] === "this")) {
      const el = voicePointed();
      if (!el) { say("point at something first."); return true; }
      voiceClick(el);
      show(`“${text}”`, 1500);
      return true;
    }

    // "move the cursor to options", "hover over single player", "point at cancel".
    const cursorAt = ws.findIndex((w) => CURSOR.has(w));
    if (VERB_HOVER.has(ws[0]) || cursorAt >= 0) {
      const rest = keysOf(ws.slice(cursorAt >= 0 ? cursorAt + 1 : 1).join(" "));
      const it = best(rest, items, (i) => i.keys);
      if (!it) { say("nothing on screen by that name."); return true; }
      voicePoint(it.el);
      show(`“${text}” → ${it.label}`, 1500);
      return true;
    }

    // "turn on observer mode", "check use computer plus", "toggle fog".
    let want: boolean | null | undefined;
    if (VERB_ON.has(ws[0]) || (ws[0] === "turn" && ws[1] === "on")) want = true;
    else if (VERB_OFF.has(ws[0]) || (ws[0] === "turn" && ws[1] === "off")) want = false;
    else if (ws[0] === "toggle") want = null;
    if (want !== undefined) {
      const rest = keysOf(ws.slice(ws[0] === "turn" ? 2 : 1).join(" "));
      const box = best(rest, items.filter((i) => i.kind === "checkbox"), (i) => i.keys);
      if (!box) { say("no checkbox by that name."); return true; }
      if (box.disabled) { say(`${box.label} can't be changed here.`); return true; }
      const on = box.el.classList.contains("fdf-checked");
      if (want === null || want !== on) voiceClick(box.el);
      show(`“${text}” → ${box.label}: ${want === null ? (on ? "off" : "on") : want ? "on" : "off"}`, 2000);
      return true;
    }

    // "change my race to orc", "change the second player to insane", "set healthbars to team
    // colored", "put the red player on team two", "make player three computer normal".
    if (VERB_SET.has(ws[0]) || ws.includes("to") || readRow(ws, items)) {
      const row = readRow(ws, items);
      const body = ws.slice(VERB_SET.has(ws[0]) ? 1 : 0);
      // Split the sentence into WHAT and TO WHAT at its last "to"/"as"/"into"/"on" — "put the
      // red player on team two" splits at "on".
      let cut = -1;
      for (let i = body.length - 1; i > 0; i--) if (["to", "as", "into", "on"].includes(body[i])) { cut = i; break; }
      const subject = cut > 0 ? body.slice(0, cut) : body;
      const value = cut > 0 ? body.slice(cut + 1) : [];
      // The FIELD said: "race", "team", "colour", "handicap" beat "player", which is mostly the
      // row's own noun ("the second PLAYER's race") and names the player menu only when alone.
      const fields = subject.map((w) => FIELD_WORDS[w]).filter((f): f is SlotField => !!f);
      const field = fields.find((f) => f !== "name") ?? (value.includes("team") ? "team" : fields[0]);
      const valueKeys = keysOf((value.length ? value : body).join(" "));

      let target: MenuItem | null = null;
      let option: { index: number; score: number } | null = null;
      if (row) {
        // A lobby row: the field said, or the dropdown in that row holding the value said.
        const look = (f: SlotField | undefined): void => {
          const inRow = items.filter((i) => i.slot?.row === row.row && i.kind === "popup" && (!f || i.slot.field === f));
          for (const it of inRow) {
            const o = optionFor(valueKeys, it);
            if (o && (!option || o.score > option.score)) { option = o; target = it; }
          }
        };
        look(field);
        // "Player" was only the row's noun: "change the second player to orc" is the race.
        if (!option && field === "name") look(undefined);
      } else if (value.length) {
        // A labelled dropdown ("healthbars", "hotkeys", "resolution").
        target = best(keysOf(subject.join(" ")), items.filter((i) => i.kind === "popup"), (i) => i.keys);
        option = target ? optionFor(valueKeys, target) : null;
      }
      if (target && option) {
        const t = target;
        const state = popupOptions(t.el);
        const label = state?.options[option.index]?.label ?? "";
        void pick(t, option.index).then((ok) => show(ok ? `“${text}” → ${label}` : `“${text}” — that can't be changed here.`, 2500));
        return true;
      }
      if (!row) {
        const colour = COLOURS.find((c) => ws.join(" ").includes(c));
        if (colour && items.some((i) => i.slot) && ws.includes("player")) { say(`no ${colour} player.`); return true; }
      }
      if (row || VERB_SET.has(ws[0])) {
        if (row || value.length) { say("no such choice."); return true; }
      }
    }

    // "Close", "close the menu", "exit", "resume", "return to game": a button by that name if
    // the panel has one, else the panel's own Escape — which is how every one of them closes.
    if (["close", "exit", "hide", "dismiss", "resume", "return", "done"].includes(ws[0]) && modalUp()) {
      const rest = keysOf(ws.join(" "));
      const button = best(rest, items.filter((i) => i.kind === "button"), (i) => i.keys);
      if (button && !button.disabled && score(rest, button.keys) >= 0.5) {
        voiceClick(button.el);
        show(`“${text}” → ${button.label}`, 1500);
        return true;
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      show(`“${text}”`, 1500);
      return true;
    }

    // Anything else is a NAME: "click single player", "select echo isles", "options", "back".
    const start = VERB_CLICK.has(ws[0]) ? (ws[0] === "go" && ws[1] === "to" ? 2 : 1) : 0;
    const rest = keysOf(ws.slice(start).join(" ").replace(/\bmap\b/g, ""));
    // The verb may BE the name: "select", "open", "start", "play" are captions on some screens.
    const it = best(rest, items, (i) => i.keys) ?? best(keysOf(ws.join(" ")), items, (i) => i.keys);
    if (!it) { say("nothing on screen by that name."); return true; }
    if (it.disabled) { say(`${it.label} is not available.`); return true; }
    voiceClick(it.el);
    show(`“${text}” → ${it.label}`, 1500);
    return true;
  };

  return {
    // The menus answer whenever a glue screen is up and no match is taking commands (the match
    // is asked first — control.ts `active`).
    acceptsInput: () => [...document.querySelectorAll<HTMLElement>(".fdf-screen")].some((s) => visible(s)),
    lexicon: (): LexEntry[] => {
      const out: LexEntry[] = [];
      for (const it of readScreen()) {
        if (it.label) out.push({ kind: "button", id: it.label, phrase: it.label });
        if (it.kind === "popup") for (const o of popupOptions(it.el)?.options ?? []) out.push({ kind: "button", id: o.label, phrase: o.label });
      }
      return out;
    },
    vocabulary: () => [
      "click", "press", "select", "choose", "open", "go to", "back", "cancel", "ok", "move the cursor to", "hover over",
      "turn on", "turn off", "toggle", "check", "uncheck", "change my race to", "change the team of", "set", "player",
      "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
      "race", "team", "color", "handicap", "computer", "easy", "normal", "insane", "open", "closed", "plus", "map",
      "human", "orc", "undead", "night elf", "random", "close", "exit", "resume", "return to game", "quit", "menu",
      ...COLOURS,
    ],
    perform: () => {},
    handle,
    status: (t) => show(t),
    error: (t) => show(t, 3500),
  };
}
