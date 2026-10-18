import { MELEE_INSANE, MELEE_NEWBIE, MELEE_NORMAL, UPKEEP_TIER2 } from "../ids";
import { CAMP_GREEN_MAX } from "./power";
import type { TargetSkill } from "./targeting";

// Computer+ — what a difficulty MEANS (issue #124).
//
// This is the file to read first, and the one place a difficulty is defined. It is also the
// clearest difference between Computer+ and the classic melee AI, so it is worth stating the
// contrast up front (docs/melee-ai.md "The difficulty spread" is the other half):
//
//   • The CLASSIC computer's difficulty is scattered across five Blizzard scripts as forty
//     `MeleeDifficulty() != MELEE_NEWBIE` guards, and INSANE is not in the scripts at all —
//     it is an engine cheat (double harvest, no fog). One rung is a build order with holes
//     punched in it and another is the same build order with a bigger bank.
//   • COMPUTER+ has no cheats at ANY rung — see `docs/computer-plus.md`. Every difference is
//     a number in the table below, and every one of them is something a HUMAN player varies:
//     how fast they notice, how much they build, how far they tech, whether they micro.
//
// **None of these numbers are Warcraft III's.** Nothing in the install describes an improved
// AI, so unlike `src/ai/human.ts` and its three siblings — where a number is Blizzard's unless
// a comment says otherwise — every value here is OURS, chosen to hit the brief in issue #124
// and stated with the reasoning beside it. Treat them as tuning, not as reference data.

/** One difficulty, in full. Everything the Computer+ brain reads about "how well do I play". */
export interface PlusProfile {
  /** `MeleeDifficulty()` — the lobby's Easy/Normal/Insane, as common.ai numbers it. Shared
   *  with the classic AI so a slot's difficulty means the same thing on both sides of the
   *  Computer+ checkbox. */
  readonly difficulty: number;

  // --- reaction: how long the AI takes to NOTICE things ---------------------------------
  /** Seconds between economy/production passes. A human checks their queues every couple of
   *  seconds when they are concentrating and much less often when they are not. */
  readonly buildPeriod: number;
  /** Seconds between army passes — re-aiming, retreating, regrouping. */
  readonly armyPeriod: number;
  /** Seconds between spell passes (see plus/casting.ts). */
  readonly castPeriod: number;
  /** How long an enemy has to stand in the base before the army turns around. THE single
   *  most-felt difficulty number: an easy computer lets you kill four peasants first. */
  readonly defendDelay: number;
  /** How long a fight has to have been going before a spell is pressed. A human does not
   *  Storm Bolt on the first frame of an engagement. */
  readonly castDelay: number;

  // --- aiming: how well it CHOOSES, as opposed to how fast it reacts ----------------------
  /**
   * How it reads a fight when it picks a target — for a spell and for the army alike
   * (plus/targeting.ts).
   *
   * `castDelay` above is how fast this player sees the fight; this is how well they understand
   * it, and the two are genuinely different axes. A `naive` player aims at the biggest body on
   * the screen: Storm Bolt goes on the Tauren, Death Coil on the Abomination, and the Shaman
   * behind them keeps casting. A `sound` one values what a unit IS. An `expert` also knows what
   * the SPELL is for — a nuke where it finishes something, a disable on the highest damage per
   * second, and never a full-length stun spent on a hero that only eats a third of it.
   */
  readonly castTargeting: TargetSkill;
  /**
   * Chance that a cast is aimed at a random legal target instead of at the best one.
   *
   * The other half of "aims badly": `castTargeting` is a consistently wrong MODEL of a fight,
   * this is ordinary sloppiness on top of it — the click that went on the wrong unit. Kept
   * small, because a computer that misclicks a third of its spells stops reading as a player
   * and starts reading as broken.
   */
  readonly castMistake: number;
  /**
   * How hard the kill-priority ladder is allowed to pull onto an enemy HERO. 0 = a hero is
   * just another soldier; 1 = the full curve in plus/targeting.ts.
   *
   * This is the knob on the single most-complained-about habit of Blizzard's own melee AI: it
   * drops everything to swing at the enemy hero, follows it out of the fight, and loses the
   * army to the units it walked past. Even at 1 the curve is conditional — a HEALTHY hero is
   * worth barely more than a soldier and only a hero that can be finished (`heroKillable`)
   * climbs — so a higher number here means "is better at spotting the kill", not "chases
   * harder". The army adds a second gate on top: it will not walk after one (`HERO_CHASE`).
   */
  readonly heroFocus: number;

  // --- economy --------------------------------------------------------------------------
  /** Workers per town it aims for.
   *
   *  A WC3 gold mine takes five at a time, so everything past the fifth is a lumberjack — and
   *  every one of them is 75 gold that did not become an army. The ladder's own answer for a
   *  one-base game is around five on gold and half a dozen in the trees, which is what these
   *  are; the top rung is higher because it expands and crews the second mine too. */
  readonly workers: number;
  /**
   * How many EXTRA towns it will take. 0 = it never expands, which is issue #124's "Easy must
   * not execute complex strategies like fast expansions".
   *
   * A CEILING and nothing else. WHEN a computer expands is the build order's business, not the
   * difficulty's — every strategy carries its own `expandAt` / `expandAgainAt` (plus/races.ts),
   * because taking a second mine early is what a fast-expand build IS. All the difficulty adds
   * is `expandDelay`.
   */
  readonly expansions: number;
  /** Seconds ADDED to whatever clock the build order set. A weaker player runs the same build
   *  late; they do not run a different build. */
  readonly expandDelay: number;

  // --- countering: rebuilding against what the enemy turns out to be fielding ---------------
  /**
   * How hard it re-weights its army mix against the enemy composition it has SCOUTED
   * (plus/counter.ts). 0 = it never counters; 1 = a unit's share moves by the full damage-table
   * advantage its attack type has against what it has seen.
   *
   * Applied as a nudge to the strategy's own weights rather than as a rewrite, so a countering
   * computer is still visibly playing the build it opened with.
   */
  readonly counterWeight: number;
  /** How many distinct enemy fighters it must have seen before it reacts at all. A bigger
   *  sample is a slower, more careful read — and a weaker player needs more of it. */
  readonly counterSample: number;
  /** …and the share of that sample a type must reach before it counts as a composition rather
   *  than as a sighting. Issue #124: "after scouting a certain percentage of units of a certain
   *  type". */
  readonly counterShare: number;
  /** How long a sighting stays in the memory. A short memory is a player who only reacts to
   *  what they saw a moment ago. */
  readonly counterMemory: number;

  // --- the ceiling on the army ------------------------------------------------------------
  /**
   * The HARD CAP on food spent on fighters — issue #124's "must NOT mass armies at all (must
   * have constraints for this)".
   *
   * It is a food number rather than a unit count because that is the only cap that means the
   * same thing to every race: 12 food is six Footmen, or four Grunts, or six Archers. Enforced
   * where production is asked for (plus/plan.ts `armyBudget`), not at the wave — an AI that
   * builds twenty Grunts and attacks with six still owns twenty Grunts when you walk into its
   * base.
   */
  readonly armyFood: number;
  /**
   * Is `armyFood` a ceiling on the WHOLE army, or on the build order's mix alone?
   *
   * `army` spends the ceiling as a SHARE PER ROW of whatever the mix is right now, so every
   * soldier standing outside those rows is on top of it: the opening Footmen a tier-2 mix no
   * longer names, the siege (`siegeLine`), the undead's Obsidian Statues (`always`) and the
   * anti-air (`antiAir`) — every one of which asks for its bodies with no reference to the
   * ceiling. Measured over thirty headless minutes (tools/ai-plus-ladder-test.cjs) a Normal
   * computer with a 17-food ceiling stood on up to 31 food of soldiers, the most at the end of the
   * game, where each new tier had added its rows beside the last one's survivors (issue #210:
   * "build smaller armies even on late game"). With this on, those bodies are priced out of the
   * mix's budget instead, so the ceiling is the army.
   *
   * Normal only. Easy's twelve was tuned with the leftovers standing beside it ("eight proved
   * TOO easy"), and Insane's ceiling is upkeep, not a handicap.
   */
  readonly wholeArmyCeiling: boolean;
  /** Towers it will ever put up. Easy builds none at all. */
  readonly towers: number;
  /**
   * SIEGE it keeps on the field once its second tier is standing — the race's own artillery
   * (`PlusRaceTable.siegeUnit`: Mortar Team, Demolisher, Meat Wagon, Glaive Thrower), ON TOP of
   * whatever the build order's mix asks for (plus/plan.ts `siegeLine`). OURS, and the number is
   * the developer's: "two demolishers or mortar teams or meat wagons or glaive throwers later
   * into the game would make a lot of sense" — only a few builds name a siege unit, so most
   * armies walked into a base full of towers with nothing that out-ranges them. Insane keeps
   * two, Normal one (it was two, until Normal was brought towards Easy); Easy stays on its
   * tier-1 soldiers.
   */
  readonly siegeUnits: number;
  /** How many heroes it fields. */
  readonly heroes: number;
  /** The highest hall tier it will build (1 Town Hall / 2 Keep / 3 Castle). Capping this is
   *  what keeps an easy computer on tier-1 units without a per-unit blacklist. */
  readonly techTier: number;
  /** The highest RANK of a repeatable upgrade (armour, weapons) it will research. */
  readonly upgradeRank: number;

  // --- fighting ---------------------------------------------------------------------------
  /** Seconds before the first wave may leave home, whatever it has built — the FLOOR of it. */
  readonly firstAttack: number;
  /**
   * …and how much LATER than that floor each seat's own first wave may be, rolled once per
   * seat off its own random stream (`Brain.firstAttackAt`, uniform in `[firstAttack,
   * firstAttack + firstAttackSpread]`). Reported of Easy: every Computer+ Easy player sat in its
   * base until seven minutes and then every one of them rushed out at once, which "feels very
   * scripted". The floor is the difficulty's promise not to attack early and it stays; the
   * spread is what stops four computers keeping the same clock. OURS, like every number here.
   */
  readonly firstAttackSpread: number;
  /** Quiet time between waves. */
  readonly waveGap: number;
  /**
   * …as a share of itself after a WON fight (`Brain.lastWon`): 0.5 = the next wave may leave
   * after half the gap. The developer's "more velocity between fights" — the army that just
   * beat theirs goes back out while the loser's heroes are still in the altar. 1 on Easy, which
   * is not meant to punish anybody. OURS.
   */
  readonly wonGap: number;
  /**
   * Army food that makes a wave.
   *
   * Kept at or below `CORE_ARMY_FOOD` (plus/plan.ts), which is the army the plan holds while it
   * is teching — so the AI fights with the army it has rather than waiting for the one it is
   * saving up for. Set it above that and the first wave lands only after the tier-up, the tech
   * buildings and the upgrades have all been paid for, which on a one-base map is most of the
   * game.
   */
  readonly attackFood: number;
  /** Group hit-point fraction that sends a wave home. 0 = it never retreats, which is what
   *  makes an easy computer's army feedable one clump at a time. */
  readonly retreatHp: number;
  /**
   * After the army FALLS BACK — a lost fight it walked or teleported out of, or a wave wiped
   * out to the last body — does the next wave wait for the WHOLE army again?
   *
   * Without it the only bar on the next wave is `attackFood`, and that is a bar the survivors
   * often already clear: the hero and two soldiers walk home, heal, `waveGap` runs out, and the
   * same broken party walks straight back into the fight that broke it. That is the developer's
   * report of the easy computer — "it re-attacks immediately after falling back" — and it reads
   * as a computer that has not noticed it lost. With this on, the latch set by the fall-back
   * holds every wave until the soldiers mustered at the rally point are the whole army the plan
   * is building (plus/plan.ts `armyTarget`), and the next wave to leave clears it.
   *
   * Easy only. The rungs above it already price a fight before they take it (`contactPass`,
   * `canClearCamp`) and pull out of one at `retreatHp`, so a wave they send back out has been
   * judged; the easy computer's is the one that has not.
   */
  readonly refill: boolean;
  /** Does the whole group pick ONE target and kill it? The clearest "this AI micros" tell. */
  readonly focusFire: boolean;
  /**
   * Hit-point fraction at which a unit standing in a fight is WALKED OUT of it. 0 = it never
   * is, which is Easy — and that is the whole of what the bottom rung gives up here.
   *
   * The other half of "this AI micros", and the half a player notices first: a Grunt on its
   * last quarter is one blow from being 200 gold spent on nothing, and pulling it behind the
   * line keeps the body — and the food it is standing in — in the game. It is a decision about
   * ONE unit, unlike `retreatHp`, which is the whole army leaving; the two are independent and
   * a wave that is winning still walks its wounded out one at a time.
   *
   * The threshold is the same at both rungs that have it, because "a quarter of my hit points"
   * is not a thing a better player knows more precisely — what a better player does is NOTICE
   * sooner, and that is `armyPeriod` (1.5 s against 0.5 s) rather than a second number here.
   *
   * See `PULL_BACK_DIST` / `PULL_BACK_HOLD` / `PULL_BACK_AGAIN` in plus/index.ts for how far
   * out, how long for, and the cooldown that stops the unit see-sawing in and out of the line.
   */
  readonly pullOutHp: number;
  /**
   * Does it STUTTER-STEP its ranged units? The player's micro between shots: the blow has gone
   * out, the weapon is cooling down, so the unit spends that dead time walking — away from a
   * melee unit that is on it, or after a target that is backing off — and is ordered back onto
   * its attack just before the weapon is ready (`stutterPass` in plus/index.ts). Insane only:
   * it is the same animation-cancelling that seat alone does (`SimWorld.cancelsBackswing`).
   */
  readonly stutterStep: boolean;
  /** Does it go and level its hero on creep camps? */
  readonly creeps: boolean;
  /**
   * Seconds before it will go creeping — its OWN clock, not `firstAttack`.
   *
   * This is the whole reason `creeps: true` used not to produce a computer that creeps.
   * Creeping was a rung of `pickTarget`, and `pickTarget` is only reached once the wave gates
   * have opened — `firstAttack` (then 300 s on Normal), `waveGap`, and `attackFood`. So a Normal
   * computer's first creep camp came at FIVE MINUTES, by which time a ladder player has three
   * camps and a level-4 hero, and its hero was still level 1 at the first fight.
   *
   * A creep camp is not an attack: it is the early game's other economy, it goes out with the
   * hero and a couple of units rather than with a wave, and it starts about when the hero
   * does. Hence a separate clock and a separate (much smaller) force — `creepFood`.
   */
  readonly creepAt: number;
  /** Army food that makes a creeping party, as `attackFood` is for a wave. Small on purpose:
   *  a hero and two soldiers clear a green camp, and waiting for a wave's worth is waiting
   *  until creeping is pointless. */
  readonly creepFood: number;
  /**
   * How many creep RUNS it will ever set off on (a run that is beaten counts too), the hardest
   * camp it will walk into (a level sum on plus/power.ts's own colour scale — `CAMP_GREEN_MAX`
   * is "green"), and how far from HOME a camp may be. Infinity for all three = creeping as the
   * rest of this file describes it.
   *
   * Easy's, and the developer's own: "let's make Computer+ Easy … also take/farm creep camps,
   * but only one to two green camps that are close to its base and that's it". So it is two
   * runs, green only, within the first ring of `CREEP_REACH` measured from its own town rather
   * than from wherever the party stands — a beginner's habit, not a route. OURS.
   */
  readonly creepCamps: number;
  readonly creepCampMax: number;
  readonly creepRange: number;
  /** In an enemy base, does it turn on the WORKERS rather than whatever swung first? */
  readonly harass: boolean;
  /** Does it send an early scout? (Only matters for finding expansions — a melee player is
   *  handed every start location, see AiPlayer.knows.) */
  readonly scout: boolean;
  /**
   * Seconds between EXPANSION SWEEPS — a worker sent round the mines an opponent could have
   * taken, after the opening tour is over (`ComputerPlusAi.sweepPass`). Infinity = it never
   * looks again, which is Easy (it does not scout at all).
   *
   * The opening tour sees the enemy's MAIN, which every melee player is handed anyway; the one
   * thing worth walking a worker across the map for later is the hall that went up somewhere
   * the map promised nobody, and a player who has been here before checks the likely spots
   * every couple of minutes. Ours.
   */
  readonly sweepEvery: number;
  /**
   * The chance a wave with a known enemy EXPANSION to go at picks it over the main base. An
   * expansion is the soft target — a hall, a mine and few towers, a long walk for the defence —
   * and trading an army for the main is how a computer loses one. "Most of the time", per the
   * developer; ours.
   */
  readonly expansionFirst: number;

  // --- items (plus/items.ts) ----------------------------------------------------------------
  /**
   * How many of a hero's six inventory slots it will fill by SHOPPING. 0 = it never shops,
   * which is Easy: a novice knows the shop is there and forgets about it.
   *
   * A ceiling on the habit rather than on the wallet — `itemReserve` is the wallet — so the
   * difference between the top two rungs is that one of them keeps a full belt.
   */
  readonly shopping: number;
  /**
   * Gold it will NOT spend on items.
   *
   * The gate docs/computer-plus.md warns about: item gold is gold `OneBuildLoop` was going to
   * spend, so a shopping list needs a place in the build ladder rather than a side budget. A
   * floor is that place expressed the only way a separate pass honestly can — the build loop
   * still gets first call on everything below it, and the shop only ever sees the surplus a
   * player would also be looking at. It is not a rung in the ladder, and it does not pretend
   * to be one: it is the surplus test, stated as a number.
   */
  readonly itemReserve: number;
  /**
   * Does it keep a Scroll of Town Portal on the hero, and REPLACE it as soon as it can?
   *
   * The clearest "this player has played before" tell there is, and the one item that changes
   * how a lost fight ends. It puts the scroll at the top of the shopping list rather than the
   * bottom, which is what makes the replacement prompt: the moment one is spent, the next
   * shopping trip buys another before it buys anything else.
   *
   * Off only on Easy, where nothing is bought at all.
   */
  readonly keepPortal: boolean;

  // --- manners ------------------------------------------------------------------------------
  /**
   * How long the position has to be hopeless before it says gg and leaves. A weaker player
   * takes longer to accept it — the ORDERING is what carries the meaning here, not the
   * absolute values.
   *
   * All three came down twice, after the wait was reported as too long both times. The dwell is
   * a guard against a position that recovers, and `hopeless` is five clauses of "there is no
   * move from here" plus a weighed reading (`despair`) on top of them: a third of a minute of a
   * decided game is a third of a minute nobody wants to play, and every term of both readings
   * un-latches the moment the position recovers anyway. So the dwell is the only thing paying
   * for a position that was never lost, and it does not have to be long to do that — a defence
   * that holds, a revived hero or one soldier out of a Barracks resets it inside a second.
   */
  readonly concedeAfter: number;
}

/**
 * Computer+ (Easy) — "must essentially be able to be beaten by players who have played MOBAs"
 * (issue #124).
 *
 * The shape of it: it builds one barracks' worth of tier-1 soldiers, never expands, never puts
 * up a tower, never teches past its Town Hall, and takes seven minutes to come and find you
 * with its hero and about three soldiers — and once it has been beaten back it does not come
 * again until it has its whole army again (`refill`). It reacts to an attack on its base
 * fifteen seconds late, it never pulls a broken army out of a fight, and it never notices what
 * you are building. It is a player who knows the buttons and nothing else.
 *
 * `techTier` 1 also decides which BUILDS it can roll: a strategy that aims higher than the
 * difficulty can reach is not offered to it (`rollStrategy`), so an easy computer only ever
 * plays its race's simplest openings.
 */
export const PLUS_EASY: PlusProfile = {
  difficulty: MELEE_NEWBIE,
  buildPeriod: 3, armyPeriod: 3, castPeriod: 2, defendDelay: 15, castDelay: 2.5,
  // It aims like a new player: at whatever is biggest. This is the requested behaviour in one
  // line — an easy computer's Storm Bolt lands on the Tauren and its Death Coil on the
  // Abomination — and it is why its casters never feel like they are answering your army.
  castTargeting: "naive", castMistake: 0.35, heroFocus: 0.3,
  workers: 8, expansions: 0, expandDelay: 0,
  // It does not counter at all: an easy computer builds what it opened with, whatever walks
  // into its base. This is the single biggest thing the top two difficulties do that it doesn't.
  counterWeight: 0, counterSample: Infinity, counterShare: 1, counterMemory: 0,
  // Twelve food of soldiers, and a wave of ten. It was twelve and ten, then eight and six after
  // "builds kinda big armies for beginner players" — the ceiling is spent PER ROW of the mix, so
  // the opening Footmen a rifle build falls back on stay standing when the Riflemen come online
  // beside them. Eight then proved TOO easy to beat ("about 2 units more"), so it is back to two
  // more bodies than that: twelve is six Footmen or three Riflemen, and the wave (`squadFood`
  // counts the hero's five) is the hero and about three soldiers.
  armyFood: 12, wholeArmyCeiling: false, towers: 0, siegeUnits: 0, heroes: 1, techTier: 1, upgradeRank: 1,
  // Seven minutes at the EARLIEST, and each seat somewhere in the three after it
  // (`firstAttackSpread`) — so a table of Easy computers does not all leave home on one tick.
  firstAttack: 420, firstAttackSpread: 180, waveGap: 150, wonGap: 1, attackFood: 10, retreatHp: 0, refill: true,
  // It never shops, so the purse below never matters. It DOES creep now, and only a little:
  // from four minutes, with the hero and a soldier or two, at most TWO green camps near its own
  // base and then never again (`creepCamps`) — the developer's "only one to two green camps
  // that are close to its base and that's it".
  // …and it does NOT micro its wounded out of a fight — issue #124's Easy is a player who
  // gives an order and then watches it happen. `pullOutHp` 0 is that in one number.
  focusFire: false, pullOutHp: 0, stutterStep: false, creeps: true, creepAt: 240, creepFood: 8,
  creepCamps: 2, creepCampMax: CAMP_GREEN_MAX, creepRange: 3000,
  harass: false, scout: false, sweepEvery: Infinity, expansionFirst: 0.5,
  shopping: 0, itemReserve: Infinity, keepPortal: false,
  concedeAfter: 24,
};

/**
 * Computer+ (Normal) — "a bit of a faster reaction time and executes simple build orders, but
 * again, NO unit massing".
 *
 * Two heroes, the whole tech tree, one expansion, one tower, and an army it will actually pull
 * out of a lost fight. Twenty food is a real army and well under half of what the map can feed,
 * which is the line the brief draws — and it is the FOOD ceiling, not the tech ceiling, that
 * carries "no unit massing". It counters, but late and half-heartedly (see `counterWeight`), it
 * upgrades only two ranks deep, and it is three minutes later to expand.
 *
 * Brought DOWN towards Easy on the developer's report that the step from Easy was "quite a
 * massive difference … not very friendly for beginners". Nearly every dial had been nearer
 * Insane's value than Easy's, so the cut is in the numbers a beginner FEELS — the size of the
 * army, when it first arrives, how levelled and how equipped its hero is when it does, and how
 * hard the base is to break — and not in what makes Normal a different player rather than a
 * bigger Easy (two heroes, tier 3, the expansion, the wounded walked out of a fight).
 */
export const PLUS_NORMAL: PlusProfile = {
  difficulty: MELEE_NORMAL,
  // `defendDelay` 10, not the 6 it was: the beginner's raid gets a few more seconds in the base
  // before the army comes home — still a third less than Easy's fifteen.
  // `castPeriod` and `castDelay` 1.5, not 1: a hero presses one button per spell pass, so at
  // one pass a second two heroes had emptied both bars within a few seconds of contact — the
  // developer's "not so fast at casting all of their heroes' abilities (just a bit)". Half a
  // second more on each; Easy's 2 / 2.5 is still slower.
  buildPeriod: 2, armyPeriod: 1.5, castPeriod: 1.5, defendDelay: 10, castDelay: 1.5,
  // It knows what the units are and mostly aims at the right one, and misclicks about one
  // spell in seven. It does not price a spell's effect — a nuke goes on whoever is lowest
  // rather than on whoever it can finish.
  castTargeting: "sound", castMistake: 0.15, heroFocus: 0.7,
  workers: 11, expansions: 1, expandDelay: 180,
  // It counters, badly: it wants to have seen a dozen enemy units and half its army to be one
  // thing before it believes it, it only moves its mix a third of the way, and it forgets in a
  // minute and a half. That reads as a player who noticed late and over-corrected slightly.
  counterWeight: 0.35, counterSample: 12, counterShare: 0.4, counterMemory: 90,
  // TIER 3. It used to stop at a Keep, which is a bigger handicap than it reads as: `techTier`
  // is also the filter on which BUILDS may be rolled (`rollStrategy`), so a tier-2 ceiling shut
  // a Normal computer out of most of its race's table — no Knights, no Bears, no Frost Wyrms,
  // no Tauren — and left it playing two or three openings for ever. A Normal player reaches
  // tier 3; they just take longer over it and stop short of the whole tree, which is what
  // `upgradeRank` and the clocks above already say.
  // 20 food: it was 30, then 26 on "reduce the target army size … by 1-2 units", and then 20
  // when the whole rung was brought towards Easy (see above) — 26 was more than twice Easy's
  // twelve, and the army is the first thing a beginner measures themselves against. Twenty is
  // ten Footmen or five Grunts, between Easy's ceiling and the old one. One tower and one siege
  // unit for the same reason: a base with two towers and two Demolishers behind the army is a
  // base a beginner's tier-1 push cannot break, and Insane keeps the developer's two.
  // …and 17 after "a little bit of a smaller army (just a little less)": one or two bodies off
  // the ceiling, still above `CORE_ARMY_FOOD` (16, plus/plan.ts) so the floor the plan keeps
  // while it saves is not cut with it, and above the twelve-food wave.
  // …and then 20 that is the WHOLE army (`wholeArmyCeiling`, issue #210): 17 was a ceiling on
  // the current mix alone, and the late game stood on 12–31 food of soldiers (20.9 on average
  // at thirty minutes, ten headless builds over the ceiling). Counted whole, 20 holds the same
  // average army a beginner already met — 22.4 — but stops the tail (17–34), and nothing past
  // the mix's leftovers is ever bought on top of it again. 22 was measured too and was the
  // bigger army of the two at every minute (23.9, up to 36), so not the one the issue asks for.
  armyFood: 20, wholeArmyCeiling: true, towers: 1, siegeUnits: 1, heroes: 2, techTier: 3, upgradeRank: 2,
  // Six minutes at the earliest and each seat somewhere in the two after it — it was five on the
  // dot, which is both two minutes sooner than Easy and the "every computer leaves on one tick"
  // habit `firstAttackSpread` was added to Easy to cure. A wave of twelve (the hero's five on top)
  // and two minutes between waves rather than a minute and a half.
  firstAttack: 360, firstAttackSpread: 120, waveGap: 120, wonGap: 0.5, attackFood: 12, retreatHp: 0.35, refill: false,
  // Creeps from four minutes with the hero and ten food behind it — about a hero, a couple of
  // soldiers and whatever else is standing around, which is what clears a green camp. It was two
  // and a half, and that was most of the gap to Easy on its own: a hero creeping from 2:30 met
  // the first fight at level 3–4 with a belt of potions, against an Easy hero still at level 1.
  // It does not focus-fire, but it DOES pull a soldier out of the line at a quarter health —
  // the one piece of micro a player picks up long before they learn to focus a target.
  focusFire: false, pullOutHp: 0.25, stutterStep: false, creeps: true, creepAt: 240, creepFood: 10,
  creepCamps: Infinity, creepCampMax: Infinity, creepRange: Infinity,
  harass: false, scout: true, sweepEvery: 120, expansionFirst: 0.75,
  // A third of a belt, and it keeps 500 gold back for the build order. It DOES keep a Town
  // Portal and replace it: a scroll is the difference between losing a fight and losing an army,
  // and a player at this level has learnt that much.
  //
  // Two, down from four, when the rung was brought towards Easy. This number is a ceiling on the
  // habit and it is counted against everything the hero is holding, so two slots is the race's
  // opening (`RACE_FIRST`) and little else: the MANA row behind it, which the fourth slot was
  // added for, is no longer reached here — a hero with a shorter bar is the point. What it does
  // not touch is `ESSENTIAL` (plus/items.ts) — the Town Portal, the Potion of Healing and the two
  // fight items are bought past the ceiling — so the belt is thinner, not empty. Insane keeps
  // the full six.
  shopping: 2, itemReserve: 500, keepPortal: true,
  concedeAfter: 14,
};

/**
 * Computer+ (Insane) — "should play as well as possible with little reaction times and it must
 * execute build orders fairly well".
 *
 * No artificial ceiling anywhere: it takes the whole tech tree, expands on its build order's
 * own clock, creeps its heroes up, focus-fires, retreats, goes for workers in your base, reads
 * your army composition and rebuilds against it, and thinks four times a second. `armyFood` is `UPKEEP_TIER2` rather than Infinity because that is where the
 * game itself says an army stops paying for itself — an AI that ignored upkeep would be
 * playing worse, not better.
 */
export const PLUS_INSANE: PlusProfile = {
  difficulty: MELEE_INSANE,
  buildPeriod: 1, armyPeriod: 0.5, castPeriod: 0.35, defendDelay: 1, castDelay: 0,
  // The whole ladder: kill shots, damage-per-second, and the game's own `herodur1` — so it
  // saves the Hex for the Shaman rather than spending it on a hero that eats a third of it.
  castTargeting: "expert", castMistake: 0, heroFocus: 1,
  workers: 14, expansions: 3, expandDelay: 0,
  // Full countering, off a small sample and a long memory: six units and a quarter of them one
  // type is enough to start shifting, and it remembers what it saw four minutes ago.
  counterWeight: 1, counterSample: 6, counterShare: 0.25, counterMemory: 240,
  armyFood: UPKEEP_TIER2, wholeArmyCeiling: false, towers: 4, siegeUnits: 2, heroes: 3, techTier: 3, upgradeRank: 3,
  firstAttack: 150, firstAttackSpread: 0, waveGap: 30, wonGap: 0.5, attackFood: 16, retreatHp: 0.4, refill: false,
  // Creeping starts at ninety seconds with the hero and eight food — the ladder's own answer,
  // which is "as soon as the hero walks out of the altar".
  focusFire: true, pullOutHp: 0.25, stutterStep: true, creeps: true, creepAt: 90, creepFood: 8,
  creepCamps: Infinity, creepCampMax: Infinity, creepRange: Infinity,
  harass: true, scout: true, sweepEvery: 75, expansionFirst: 0.85,
  // A full belt and a Town Portal on the hero. Both are what separates a player who has been
  // here before from one who has not.
  shopping: 6, itemReserve: 200, keepPortal: true,
  concedeAfter: 8,
};

/** The profile a lobby difficulty seats. Anything unrecognised plays Normal, which is what
 *  every seat was before the menu offered three. */
export function plusProfile(difficulty: number): PlusProfile {
  return difficulty === MELEE_NEWBIE ? PLUS_EASY : difficulty === MELEE_INSANE ? PLUS_INSANE : PLUS_NORMAL;
}
