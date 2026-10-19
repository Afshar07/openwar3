import { grammarWords, words, type Lexicon } from "./parser";
import { readModelFile } from "./model";

// The words the recogniser is ALLOWED to hear — Vosk's grammar (src/voice/model.ts says why
// this is the whole trick on a slow machine).
//
// Two halves: the parser's own words (verbs, numbers, "here", "enemy", …) and every word of every
// NAME in the lexicon the match built for this utterance — the command card, the race's tech
// tree, what stands on the map. Read off the game's tables, so a Blood Mage's "Flame Strike" or
// a map's custom "Summon Candy Golem" is in the grammar the moment its button is on the card.
//
// A word the model has never heard of cannot be recognised at all — Kaldi decodes against its
// own pronunciation dictionary, and Vosk drops an unknown grammar word with a warning. Warcraft
// is full of compounds the dictionary lacks ("Blademaster", "Farseer", "Spellbreaker"), so a name
// word that is not in the dictionary is offered SPLIT into two words that are ("blade master"):
// the parser compares names with their spaces taken out (parser.ts `key`), so the split costs
// nothing downstream. The dictionary is the model's own word table, read once.

/** Every word the model can recognise, or null while unknown (then nothing is split). */
let dictionary: Set<string> | null = null;
let reading: Promise<Set<string> | null> | null = null;

/** OpenFst's symbol-table magic number (`SymbolTable::Write`), little-endian on disk. */
const SYMTAB_MAGIC = 2125658996;

/**
 * The model's word list. The small English model ships no `words.txt` beside its graph — the
 * table is EMBEDDED in `graph/Gr.fst`, as the grammar FST's output symbol table (its header
 * even names the file it was built from, `…/lgraph/words.txt`). OpenFst writes a table as:
 * magic, name, available key (int64), size (int64), then `size` × (string, key int64), every
 * string an int32 length and its bytes. Read once, off the copy the recogniser unpacked.
 */
function loadDictionary(): Promise<Set<string> | null> {
  reading ??= readModelFile("graph/Gr.fst")
    .then((b) => {
      if (!b) return null;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const latin1 = new TextDecoder("latin1");
      for (let i = 0; i < Math.min(b.length - 4, 4096); i++) {
        if (dv.getInt32(i, true) !== SYMTAB_MAGIC) continue;
        let p = i + 4;
        p += 4 + dv.getInt32(p, true); // the table's name
        p += 8; // available key
        const size = Number(dv.getBigInt64(p, true));
        p += 8;
        const set = new Set<string>();
        for (let k = 0; k < size && p < b.length; k++) {
          const len = dv.getInt32(p, true);
          p += 4;
          const w = latin1.decode(b.subarray(p, p + len));
          p += len + 8;
          if (w && !w.startsWith("<") && !w.startsWith("#") && w !== "!SIL" && w !== "[unk]") set.add(w);
        }
        dictionary = set;
        return set;
      }
      return null;
    })
    .catch(() => null);
  return reading;
}

/** `word` as dictionary words: itself, or the best two-way split, or itself regardless (Vosk
 *  will drop it, and the rest of the grammar still works). */
function spell(word: string, dict: Set<string> | null): string[] {
  if (!dict || dict.has(word)) return [word];
  for (let cut = 2; cut <= word.length - 2; cut++) {
    const a = word.slice(0, cut);
    const b = word.slice(cut);
    if (dict.has(a) && dict.has(b)) return [a, b];
  }
  // A plural the dictionary only has in the singular ("ghouls" → "ghoul").
  if (word.endsWith("s") && dict.has(word.slice(0, -1))) return [word.slice(0, -1)];
  return [word];
}

/** The grammar for one utterance: a JSON-able list of words, `[unk]` last so anything else
 *  the player says is heard as "not a command" rather than forced onto the nearest name. */
export async function grammarFor(lexicon: Lexicon): Promise<string[]> {
  const dict = dictionary ?? (await loadDictionary());
  const out = new Set<string>();
  for (const w of grammarWords()) for (const s of spell(w, dict)) out.add(s);
  for (const { entry } of lexicon.entries) {
    for (const w of words(entry.phrase)) {
      for (const s of spell(w, dict)) out.add(s);
      // Both numbers of every name: "train footmen" and "train a footman" are both said.
      if (!w.endsWith("s")) for (const s of spell(`${w}s`, dict)) if (!dict || dict.has(s)) out.add(s);
      if (w.endsWith("man")) for (const s of spell(`${w.slice(0, -3)}men`, dict)) out.add(s);
    }
  }
  for (let i = 0; i <= 12; i++) out.delete(String(i));
  const list = dict ? [...out].filter((w) => dict.has(w)) : [...out];
  list.push("[unk]");
  return list;
}
