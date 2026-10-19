# Voice Control

Options → Gameplay → **Voice Control**: hold **Period (.)**, say a command, let go. Nothing in
Warcraft III listens, so every part of this is OURS — the key, the vocabulary, the grammar —
and nothing here is a number from the game. What it ends in is the game's: every spoken command
is carried out through the doors a click and a hotkey already use.

## The pipeline

```
"." held ─▶ microphone (ScriptProcessor tap) ─▶ Vosk recogniser in a worker, GRAMMAR-constrained
          ─▶ text ─▶ parser (deterministic) ─▶ intents ─▶ game/voiceActions.ts ─▶ runCommand /
             orderClickAt / tryTargetArmedAt / RtsController.execute
```

| file | what it is |
| --- | --- |
| [`src/voice/model.ts`](../src/voice/model.ts) | the speech model: install check, download with a bar, the recogniser (lazy-loaded) |
| [`src/voice/vocabulary.ts`](../src/voice/vocabulary.ts) | the GRAMMAR — the words the recogniser may hear for this utterance |
| [`src/voice/parser.ts`](../src/voice/parser.ts) | text → intents. Pure; pinned by `tools/voice-parser-test.cjs` |
| [`src/voice/control.ts`](../src/voice/control.ts) | push-to-talk, the microphone, one utterance's life; `applyVoiceOptions` |
| [`src/game/voiceActions.ts`](../src/game/voiceActions.ts) | intents → the match's own click/hotkey paths; target resolution; spell assist |
| [`src/ui/voiceOptions.ts`](../src/ui/voiceOptions.ts), [`src/ui/voiceDownload.ts`](../src/ui/voiceDownload.ts) | the Options row's two faces and the download dialog |

## Why no language model

It was the obvious design and it is wrong for the machines this has to run on. Whisper's
smallest model is 75 MB and takes SECONDS per utterance in WebAssembly on a weak CPU; it
transcribes free text, so it invents words the game must then un-invent; an LLM to map the text
onto commands is the same cost again. Instead:

- **Vosk** (Kaldi in WebAssembly, `vosk-browser`, Apache-2.0) with its small English model (41 MB,
  Apache-2.0). Kaldi's small models run in real time on a Raspberry Pi.
- It takes a **grammar**: the list of words it may hear. Told it is listening for "footman",
  "attack", "three" and a few hundred others, it cannot hear "foot man" or "football". The grammar
  is rebuilt per utterance from the game's own tables — the card, the tech tree of everything we
  own, the spells our units know, what is on screen — so a map's custom ability is speakable the
  moment its button is on the card.
- The text is then a sentence in a CLOSED vocabulary, and a closed vocabulary is a small grammar,
  not a model: instant, offline, and it never does something the player did not say.

## Three traps

1. **Where the model is kept.** vosk-browser stores a model in Emscripten's IDBFS (IndexedDB
   database `/vosk`, store `FILE_DATA`, version 21, one row per file keyed by path) under a folder
   named after the model URL, and skips its own download when `downloaded.ok` is there. Its own
   fetch reports no progress, so we fetch the archive ourselves (with the bar) and WRITE it where
   its download would have — then loading the model is the unpack. The row shape is IDBFS's and is
   pinned with the package version; a vosk-browser upgrade must re-check it.
2. **The dictionary is inside `Gr.fst`.** The small model ships no `words.txt`; its word table is
   the grammar FST's embedded OpenFst symbol table (magic `2125658996`). It is read so that a
   compound the dictionary lacks ("blademaster") is offered split ("blade master") — the parser
   compares names with spaces removed, so the split costs nothing downstream. A grammar word the
   model does not know is silently dropped by Vosk.
3. **The download host.** The model comes from the vosk-browser project's own published copy, the
   one host that sends `Access-Control-Allow-Origin` (alphacephei.com does not, so a browser tab
   could never fetch it there). Nothing else ever leaves the machine. The microphone is open
   while Voice Control is on in a match, so a PRE-ROLL (the last 0.6 s, in memory only) can be
   fed ahead of the live audio when "." goes down — without it the first word, which is the
   verb, was cut off — and the audio goes into a worker on this page.

## What a phrase means (the developer's rules)

- **"Here", "there", "this", "that" are the middle of the SCREEN**, not the mouse — a player
  playing by voice may have no hand on it. "The cursor" / "the mouse" is the mouse.
- **"Build a farm here"** (or no place at all) puts it SOMEWHERE ON THE SCREEN it fits, beside our
  other buildings, never in the lane between a town hall and its gold mine
  (`MapViewerScene.voiceBuildSpot`, every candidate through the placement click's own test).
- **A spell assists**: "use frost nova" selects the unit of ours that has it (ready, with the
  mana, nearest the middle of the screen) and, with nothing said about where, aims it — a row that
  may hit an enemy goes on the enemy (heroes first), a friendly-only row on the most hurt friend,
  an area spell where the most enemies stand inside its own radius. Each candidate is offered to
  the card's own aim, so the spell's own refusals still apply.
- **Camera**: any clause naming the camera is a camera command ("move the camera to another gold
  mine" is not a MOVE order). "Another"/"next" is the nearest one the camera is NOT already on;
  "on the right side of the map", "top left" are halves (thirds for "middle") of the playable map.
- **Subjects**: a clause may name WHO instead of relying on the selection — "put ALL PEASANTS on
  gold", "send TWO WORKERS to wood", "ALL PEASANTS to the gold mine" (no verb at all). "Worker",
  "peasant", "peon", "acolyte", "wisp" all mean this race's gatherers. A worker said with NO
  number ("select peasant") is an IDLE one — the idle-worker button's job; "select one worker"
  is any one (idle first); "select one worker from wood" is one carrying a lumber order (walking
  a load home counts). Plural or "all" is every one, map-wide.
- **"Select army"** is the "-" key, through the HUD's own `selectAllArmy`.
- **Rally by building**: "put the rally point of the barracks on my hero" sets it on EVERY
  finished Barracks of ours with the Set Rally Point command, without touching the selection; a
  unit is rallied ON. "My hero" is the FIRST hero (the top portrait), not the nearest.
- **Words for a kind of building** (`raceTerms`): "tower", "shop", "farm"/"supply", "hall",
  "altar", "barracks" mean THIS race's one, read off the data (a shop makes items; a tower attacks
  and trains nothing, or upgrades into one — the undead build a Ziggurat and are told so). A
  greyed build button says what it is missing: "Ancient Protector requires Hunter's Hall."
- **Camera to things**: any building the player has SEEN ("the tavern", "the goblin merchant",
  "the fountain" — first and last words of a neutral building's name work too) and the minimap's
  creep camps. "Another" is a tour: each one asked for is one the camera has not yet been taken to.
- **Builders finish what they build.** A spoken order to the selection (move, attack, stop, a
  spell) leaves out any worker on a construction job and puts it back in the selection after
  (`shield`); a subject ("all peasants") never picks one; "select a peasant" — "a" is not a count —
  is an IDLE worker by the idle-worker button's own test.
- **"Finish the altar"** puts a worker back on a building of ours whose construction HALTED (no
  builder, not self-building) with the right-click's `buildresume` order: an idle worker first,
  then one off the trees, then any other not already building. "Complete all buildings" does
  every one.
- **Items are spells.** "Use healing salve on grunt" selects the hero CARRYING it (the selected
  one first), presses the pocket, and aims it: an item's behaviour is its ability row, so a gift
  goes on the grunt of ours with the least life, a weapon on the enemy. Said as players say them:
  "healing potion" for Potion of Healing, "town portal" / "tp", "salve".
- **The grammar knows the whole game.** Every melee unit, building, hero, creep, ability and item
  name (≈1000), the jargon (creep, expo, rax, tp, upkeep…), and the commands themselves as whole
  PHRASES ("finish the altar", "build a farm", "use healing salve"). Vosk scores one listed phrase
  below the same words loose, so a real command is preferred over a near-sounding word salad —
  the fix for "altar" heard as "alter" and "finish" as "fish".
- Everything is fog-honest: "the enemy hero" is the nearest one this player can SEE.

`window.openwar3.voiceSay("train three footmen")` runs a sentence through the same path with no
microphone — the way to test the mapping in a live match.
