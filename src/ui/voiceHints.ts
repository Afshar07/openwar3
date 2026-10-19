// Voice Control's hint box: a short list of things worth SAYING, on the right of the screen in a
// match, while Voice Control is on. Ours — the game has no voice commands to remind anyone of.
// "," hides and shows it (the box says so), remembered for this browser; it is never in the way
// of the console or the resource bar, and it takes no clicks.

/** The key that hides and shows the box. */
export const VOICE_HINTS_KEY_CODE = "Comma";

const STORE_KEY = "ow3.voiceHints.hidden";

/** The examples, worded with this race's own names. */
export interface HintNames {
  worker: string;
  soldier: string;
  farm: string;
}

const plural = (name: string): string => {
  const w = name.toLowerCase();
  if (w.endsWith("man")) return `${w.slice(0, -3)}men`;
  if (/(s|x|ch|sh)$/.test(w)) return `${w}es`;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
};

/** The commands, in groups — the developer's priority first: selecting the army and a worker. */
function groups(n: HintNames): Array<{ title: string; lines: string[] }> {
  const worker = n.worker.toLowerCase();
  const soldier = n.soldier.toLowerCase();
  return [
    { title: "Select", lines: ["select army", `select ${worker}`, "select my main building", "select hero", `select ${soldier} 2`] },
    { title: "Orders", lines: ["attack move here", "fall back", `put all ${plural(worker)} on gold`, "tp out"] },
    { title: "Build & camera", lines: [`train three ${plural(soldier)}`, `build a ${n.farm.toLowerCase()} here`, "camera to a green camp"] },
  ];
}

export interface VoiceHints {
  setEnabled(on: boolean): void;
  dispose(): void;
}

export function mountVoiceHints(ui: HTMLElement, names: () => HintNames): VoiceHints {
  const box = document.createElement("div");
  box.className = "voice-hints";
  box.hidden = true;
  ui.appendChild(box);

  let enabled = false;
  let hidden = false;
  try {
    hidden = localStorage.getItem(STORE_KEY) === "1";
  } catch {
    /* no storage: shown */
  }
  let worded = "";

  const render = (): void => {
    const n = names();
    const sig = `${n.worker}|${n.soldier}|${n.farm}`;
    if (sig === worded) return;
    worded = sig;
    box.replaceChildren();
    const head = document.createElement("div");
    head.className = "voice-hints-head";
    head.innerHTML = `Voice commands <span class="voice-hints-key">Hold <b>.</b> and say:</span>`;
    box.appendChild(head);
    for (const g of groups(n)) {
      const t = document.createElement("div");
      t.className = "voice-hints-title";
      t.textContent = g.title;
      const list = document.createElement("ul");
      list.className = "voice-hints-list";
      for (const line of g.lines) {
        const li = document.createElement("li");
        li.textContent = line;
        list.appendChild(li);
      }
      box.append(t, list);
    }
    const foot = document.createElement("div");
    foot.className = "voice-hints-foot";
    foot.innerHTML = `Press <b>,</b> to hide`;
    box.appendChild(foot);
  };

  const sync = (): void => {
    box.hidden = !enabled || hidden;
    if (!box.hidden) render();
  };
  // The race's names are known only once the match has its units: re-worded for a while after.
  const reword = window.setInterval(() => { if (!box.hidden) render(); }, 2000);

  const typing = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== VOICE_HINTS_KEY_CODE || !enabled || e.repeat || e.ctrlKey || e.altKey || e.metaKey || typing(e.target)) return;
    hidden = !hidden;
    try {
      localStorage.setItem(STORE_KEY, hidden ? "1" : "0");
    } catch {
      /* not remembered */
    }
    sync();
  };
  window.addEventListener("keydown", onKey);

  return {
    setEnabled(on) {
      enabled = on;
      sync();
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      window.clearInterval(reword);
      box.remove();
    },
  };
}
