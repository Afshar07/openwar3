import type { SimUnit } from "../sim/world";

/**
 * The numbers on Voice Control's name tags ("Fiend 4", "Farm 2") — what lets a player SAY one
 * body out of several of a kind ("select fiend 4"). Ours: Warcraft III names nothing over a unit.
 *
 * A number belongs to the UNIT and keeps it: the lowest free number of its type is handed out the
 * first time the unit is seen and given back when it dies, so "Fiend 4" is still Fiend 4 after
 * Fiend 2 falls — a tag that renumbered itself would point the player's next sentence at a
 * different unit than the one they were looking at. It is SHOWN only while there are two or more
 * of the type (a lone Altar needs no number), but kept, so the tag does not change when a second
 * one arrives and goes again.
 */
export class VoiceLabels {
  /** sim id → its number. */
  private readonly numbers = new Map<number, number>();
  /** type → numbers in use. */
  private readonly taken = new Map<string, Set<number>>();
  /** type → how many of ours stand right now. */
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<number>();

  /** Once a frame, with this player's living units and buildings. */
  update(own: Iterable<SimUnit>): void {
    this.counts.clear();
    this.seen.clear();
    for (const u of own) {
      this.seen.add(u.id);
      this.counts.set(u.typeId, (this.counts.get(u.typeId) ?? 0) + 1);
      if (this.numbers.has(u.id)) continue;
      let used = this.taken.get(u.typeId);
      if (!used) this.taken.set(u.typeId, (used = new Set()));
      let n = 1;
      while (used.has(n)) n++;
      used.add(n);
      this.numbers.set(u.id, n);
      this.types.set(u.id, u.typeId);
    }
    for (const [id, n] of this.numbers) {
      if (this.seen.has(id)) continue;
      this.taken.get(this.types.get(id) ?? "")?.delete(n);
      this.numbers.delete(id);
      this.types.delete(id);
    }
  }

  private readonly types = new Map<number, string>();

  /** The number a unit's tag SHOWS, or null when it is the only one of its type. */
  shown(id: number): number | null {
    const t = this.types.get(id);
    if (t === undefined || (this.counts.get(t) ?? 0) < 2) return null;
    return this.numbers.get(id) ?? null;
  }

  /** The number a unit holds, shown or not ("select fiend 2" still finds the last Fiend standing
   *  if it was Fiend 2 — it is what the player last read). */
  numberOf(id: number): number | null {
    return this.numbers.get(id) ?? null;
  }

  clear(): void {
    this.numbers.clear();
    this.taken.clear();
    this.counts.clear();
    this.types.clear();
  }
}
