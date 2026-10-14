// Reading a .zip of a Warcraft III folder straight off a URL — the gate's "Download game files"
// (src/ui/gate.ts). The developer keeps a zipped copy of their OWN install in their own cloud
// storage and points a new machine at it; nothing here names a URL, and none is shipped.
//
// **Why this is shared, and pure.** Two callers stream the same archive: the BROWSER, which
// unpacks into OPFS (src/assets/downloadInstall.ts), and the DESKTOP shell, which unpacks into a
// real folder (electron/download.mjs). Both need the same two answers — where each entry starts
// and which entries make up the install — and two parsers of one format are two answers that
// agree until the day they do not. So this file imports nothing and touches no I/O: the caller
// hands it a ranged reader and a stream of bytes, and keeps its own sink.
//
// **Why the central directory first.** A zip's LOCAL headers may defer their sizes to a data
// descriptor written AFTER the data (general-purpose bit 3 — every entry of a Windows-made
// archive does), so a front-to-back reader cannot know where a deflated entry ends without
// inflating it. The central directory at the end of the file states every size up front. One
// ranged read for it, then ONE sequential download of the whole file, walking entries in offset
// order and skipping what is not wanted — a single connection, and the progress is just bytes.

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const U32 = 0xffffffff;

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const utf8 = new TextDecoder();

/**
 * Every entry of the archive behind `readRange`, from its central directory.
 *
 * `readRange(start, endInclusive)` resolves to exactly those bytes; `size` is the archive's
 * length. ZIP64 is honoured (a Windows "Send to → Compressed folder" of a bigger install writes
 * it), though this 1.9 GB one does not need it.
 */
export async function readZipIndex(readRange, size) {
  // The end-of-central-directory record is 22 bytes plus a comment of up to 65535.
  const tailStart = Math.max(0, size - (22 + 0xffff));
  const tail = await readRange(tailStart, size - 1);
  const dv = view(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === EOCD) { at = i; break; }
  }
  if (at < 0) throw new Error("That file is not a .zip archive.");

  let count = dv.getUint16(at + 10, true);
  let cdSize = dv.getUint32(at + 12, true);
  let cdOffset = dv.getUint32(at + 16, true);
  if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
    const loc = at - 20;
    if (loc < 0 || dv.getUint32(loc, true) !== EOCD64_LOCATOR) throw new Error("The .zip archive is damaged (no ZIP64 locator).");
    const recAt = Number(dv.getBigUint64(loc + 8, true));
    const rec = view(await readRange(recAt, recAt + 55));
    if (rec.getUint32(0, true) !== EOCD64) throw new Error("The .zip archive is damaged (no ZIP64 record).");
    count = Number(rec.getBigUint64(32, true));
    cdSize = Number(rec.getBigUint64(40, true));
    cdOffset = Number(rec.getBigUint64(48, true));
  }

  const cd = await readRange(cdOffset, cdOffset + cdSize - 1);
  const cv = view(cd);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cv.getUint32(p, true) !== CENTRAL) throw new Error("The .zip archive is damaged (bad central directory).");
    const method = cv.getUint16(p + 10, true);
    let compressedSize = cv.getUint32(p + 20, true);
    let uncompressedSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let offset = cv.getUint32(p + 42, true);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");

    // ZIP64 extra field: the 64-bit values, in this order, for exactly the fields saturated above.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cv.getUint16(e, true);
      const len = cv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let f = e + 4;
        if (uncompressedSize === U32) { uncompressedSize = Number(cv.getBigUint64(f, true)); f += 8; }
        if (compressedSize === U32) { compressedSize = Number(cv.getBigUint64(f, true)); f += 8; }
        if (offset === U32) { offset = Number(cv.getBigUint64(f, true)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, uncompressedSize, offset });
    p = extraEnd + commentLen;
  }
  return entries;
}

/**
 * The entries that make up the INSTALL, with paths relative to its folder, in archive order.
 *
 * Whoever zipped the folder decides whether there is a wrapper directory (this one has
 * `Warcraft III/`, a zip of the folder's CONTENTS has none), so the root is found rather than
 * assumed: it is wherever `.build.info` sits (CASC, 1.30+), else wherever `war3.mpq` does (an
 * MPQ-era folder). Directory entries are dropped, and so is any name that would climb out of the
 * destination (`..`, an absolute path) — the archive is a file off the internet.
 */
export function installEntries(entries) {
  const marker = (re) => entries
    .filter((e) => re.test(e.name))
    .sort((a, b) => a.name.length - b.name.length)[0];
  const found = marker(/(^|\/)\.build\.info$/i) ?? marker(/(^|\/)war3\.mpq$/i);
  if (!found) throw new Error("That archive does not hold a Warcraft III folder.");
  const root = found.name.slice(0, found.name.lastIndexOf("/") + 1);
  return entries
    .filter((e) => e.name.startsWith(root) && !e.name.endsWith("/"))
    .map((e) => ({ ...e, path: e.name.slice(root.length) }))
    .filter((e) => e.path && !e.path.startsWith("/") && !e.path.split("/").includes(".."))
    .sort((a, b) => a.offset - b.offset);
}

/**
 * A forward-only reader over the archive's bytes, as one sequential download delivers them.
 * `pos` is how far through the file it is, which is the whole of the progress bar.
 */
export class ZipCursor {
  constructor(chunks) {
    this.it = chunks[Symbol.asyncIterator]();
    this.buf = new Uint8Array(0);
    this.at = 0;
    this.pos = 0;
  }

  async more() {
    const next = await this.it.next();
    if (next.done) throw new Error("The download ended early.");
    this.buf = next.value;
    this.at = 0;
  }

  /** The next `n` bytes, as the pieces they arrived in (no copy). */
  async *take(n) {
    while (n > 0) {
      if (this.at >= this.buf.length) await this.more();
      const k = Math.min(n, this.buf.length - this.at);
      const piece = this.buf.subarray(this.at, this.at + k);
      this.at += k;
      this.pos += k;
      n -= k;
      yield piece;
    }
  }

  async bytes(n) {
    const out = new Uint8Array(n);
    let o = 0;
    for await (const piece of this.take(n)) { out.set(piece, o); o += piece.length; }
    return out;
  }

  async skipTo(offset) {
    if (offset < this.pos) throw new Error("The .zip archive is damaged (overlapping entries).");
    for await (const piece of this.take(offset - this.pos)) void piece;
  }

  /** Stop reading. Everything after the last wanted entry is unwanted (the central directory, and
   *  in the browser the game's executables), so the download is dropped rather than drained. */
  async close() {
    await this.it.return?.();
  }

  /** Step over `entry`'s local header, leaving the cursor on its first data byte. The local
   *  header's name and extra field need not match the central directory's lengths, so they are
   *  read here rather than assumed. */
  async enter(entry) {
    await this.skipTo(entry.offset);
    const head = view(await this.bytes(30));
    if (head.getUint32(0, true) !== LOCAL) throw new Error(`The .zip archive is damaged at ${entry.name}.`);
    await this.skipTo(this.pos + head.getUint16(26, true) + head.getUint16(28, true));
  }
}
