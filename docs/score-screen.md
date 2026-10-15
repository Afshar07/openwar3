# The score screen (issue #199)

What stands between a FINISHED match and the menu: four tabs of figures over the parchment, the
local race's victory picture (or the defeat one), and OK. Built from the game's own
`UI\FrameDef\Glue\ScoreScreen.fdf`; the code is in three places —

| piece | where |
|---|---|
| the counting, as the match is played | [`src/sim/matchStats.ts`](../src/sim/matchStats.ts), hooked into `SimWorld` |
| the finished table (rows, Tech Percentage, Heroes Used) | [`src/game/scoreTable.ts`](../src/game/scoreTable.ts), `RtsController.scoreRowFor` |
| the art (flat models in the 0.8 × 0.6 box) | [`src/render/scoreScreenScene.ts`](../src/render/scoreScreenScene.ts) |
| the screen (FDF + stamped rows) | [`src/ui/scoreScreen.ts`](../src/ui/scoreScreen.ts) |
| when it appears | `MapViewerScene.finalScores` → `onExit(scores)` → `main.ts` `exitToMenu` |

## When it appears — and when it does not

**Only after a game that has ENDED** (the developer's rule, and WC3's). `finalScores` answers
null until the local seat's own `RemovePlayer` has fired (victory, defeat, tie), the match is
decided, or — on a LAN client, whose script never runs — the host's `over` stamp has arrived. So:

- the melee victory/defeat dialog's **Quit Game** shows it: `DialogAddQuitButton(d, true, …)`, and
  the `doScoreScreen` flag is honoured per button (a map's own quit button with `false` does not);
- `EndGame(doScoreScreen)` honours the flag the same way (a campaign's `bj_changeLevelShowScores`
  is false, so a chapter goes straight back to the campaign screen);
- **Continue Game, then F10 → End Game** still shows it — the game is over;
- **F10 → End Game in a match still being played does not**, and neither does Exit Program.

## What each column counts

The columns and their order are `GlobalStrings.fdf`'s (`OVERVIEW_COLUMN0..3`, `UNIT_COLUMN0..4`,
`HEROES_COLUMN0..4`, `RESOURCES_COLUMN0..4`). Their meaning is in no file; the rules are AlbZ's,
measured over 201 620 score screens — [warcraft3.info 394, "Warcraft 3: beyond APM, A brief
exploration of in-game statistics"](https://warcraft3.info/articles/394/warcraft-3-beyond-apm-a-brief-exploration-of-in-game-statistics).
The page is JS-rendered; its text is at `https://warcraft3.info/api/v1/articles/394`.

- **Unit Score** = the gold + lumber of everything the player came to own (trained, hired, built,
  upgraded INTO — a Keep scores its whole price — created by the script, placed with the map) +
  the same value of every enemy or neutral unit killed / building razed. A hero kill is worth
  1005 × its level. Summons score nothing. **Proof it is the rule:** the article's four starting
  scores (Undead 1005, Human 965, Orc 945, NE 825) come out of `UnitBalance.slk` exactly, the
  Undead's including the Haunted Gold Mine — `tools/sim-score-test.cjs` pins it, and a real
  Echo Isles match opens on 945 / 965.
  **Not reproduced:** the article's unexplained per-object bonuses (Altar 270 vs its 230, first
  hero 550 vs 525, "tier 2 or greater comes with a larger bonus"). No rule is given, so we score
  the cost.
- **Hero Score** = experience earned × 10 (what the bar moved, `gainXp` — a creep's dropped
  overshoot is not counted).
- **Resource Score** = Gold Mined + Lumber Harvested. Bounty and item sales are not mining.
- **Units Produced** includes starting units and summons (not illusions, not revives).
  **Units Killed** is enemy AND neutral; a deny is not a kill; a creep is nobody's killer.
- **Largest Army** = peak food in use, sampled once a sim second. OURS — nothing defines it.
- **Heroes Used**: icons + level, sorted by experience ("not in chronological order").
  **Mercenaries Hired**: a non-hero unit bought off a neutral building (a Tavern hero is a hero).
  **Items Obtained**: bought or picked up (powerups too); a hand-over between heroes is not.
- **Gold Mined** is what was BANKED; **Gold Lost to Upkeep** is what the band kept back.
- **Resources Traded** prints `sent / received` (gold + lumber). OURS — the screen prints two
  numbers and no source says which two.
- **Tech Percentage** = researched ranks / ranks the race's tech tree offers, rounded down. The
  denominator is WALKED out of the tables from the race's starting units (`researchableFor`):
  Orc 29 and Undead 27 match the article; Human 35 and NE 31 are one short of its 36/32 (it read
  1.32-era screens; we are on the latest balance release).

## Multiplayer

Only the AUTHORITY counts (a LAN client's sim never steps). The host builds the table and sends
it inside the relayed dialog that ends each client's game (`DialogMessage.scores`, plus a `score`
flag per quit button) — not in a snapshot, because the client hangs up the moment that dialog
arrives. The table is plain data; the receiving machine stamps `viewer` itself.

## The art, measured

Every model is flat quads in the FDF's 0.8 × 0.6 box with NO camera (like the loading screen),
so the scene is one orthographic window and the screen is mounted `stretchRoot`:

- `ScoreScreen-Background.mdx` — clips `Scorescreen-5Button` / `Scorescreen-4Button`: the header
  BOXES are painted (`scorescreen-background-sort4.blp`); the FDF's header checkboxes are only hot
  spots + captions over them. Overview is the four-box layout.
- `ScoreScreen-Tabs.mdx` — `Tab1`…`Tab5`, the selected flap.
- `ScoreScreen-TopBar.mdx` — ONE row, 0.0373 tall (0.032 without its border); its colour is a
  geoset colour track keyed per clip `TeamColor00 Stand`…`TeamColor23 Stand`. The first hangs at
  the FDF's TOPLEFT −0.11; rows are 0.032 apart (36 px at 675, 40 at 768 in the references).
- war3skins `[Race] ScoreScreenVictory_V1` / `[Default] ScoreScreenDefeat` — the picture;
  `ScoreScreenBannerWin/Loss` — the name plate's gold/silver border (0.19 × 0.0475, centred on
  the strip); `ScoreScreenPlayer<Race>` — the race mark (texture 0.0282 × 0.0284, its frame
  0.026 × 0.016 at either aspect); `VictoryMusic_V1` / `DefeatMusic_V1` — the music.
- The team number sits INSIDE the mark's frame (its dark right end); the name starts at 0.031;
  the row type is 0.012. Your own row is printed in `StandardLabelTextTemplate` gold.
- Hero icons are GLYPHS: square in pixels at any aspect, so their width is taken back out of the
  stretch. Everything else stretches.
- The sort highlight is `scorescreen-tab-hilight.blp`, `HighlightAlphaMode "ADD"` on OPAQUE black
  — `fdf/render.ts` `addedLight` turns it into light, or it draws a black bar.
- The FDF hangs a SCROLLBAR off the panel; it is removed, or the renderer makes the whole panel a
  scroll frame with a bar at the screen's edge. Twelve seats fit.

The reference opens on the FIRST column sorted highest-first (none of the shots has Teams lit),
keeps that column's place across tabs, and Teams sorts by team. The ally-colour button recolours
the bars with `ALLY_FILTER_COLOR` (you blue, teammates teal, the rest red).

`window.openwar3.scoreScreen(table?)` (dev) puts the screen back up on the last table or one
handed in — lay it out without finishing a match each time; `lastScores()` reads the last one.
