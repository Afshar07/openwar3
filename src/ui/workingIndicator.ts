// The "working" indicator a glue list shows while it is still being filled — the map list while a
// folder's maps are read (ui/mapBrowser.ts). OURS: a thin ring in the glue's gold, picked by the
// developer over the game's own Battle.net "working" eye (war3skins.txt `BattleNetWorking`), which
// belongs to a Battle.net screen this list is not.

/** Put the indicator over `host`, centred, taking no clicks. Returns the node so the caller can
 *  take it away again once the list is filled. */
export function mountWorking(host: HTMLElement): HTMLElement {
  const box = document.createElement("div");
  box.className = "ow3-working";
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  box.append(Object.assign(document.createElement("div"), { className: "ow3-working-ring" }));
  host.append(box);
  return box;
}
