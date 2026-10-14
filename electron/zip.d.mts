// Types for electron/zip.mjs, which the renderer imports too (src/assets/downloadInstall.ts).

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where its LOCAL header starts. */
  offset: number;
}

export interface InstallEntry extends ZipEntry {
  /** Relative to the install folder, `/`-separated. */
  path: string;
}

export function readZipIndex(
  readRange: (start: number, endInclusive: number) => Promise<Uint8Array>,
  size: number,
): Promise<ZipEntry[]>;

export function installEntries(entries: ZipEntry[]): InstallEntry[];

export class ZipCursor {
  constructor(chunks: AsyncIterable<Uint8Array>);
  readonly pos: number;
  take(n: number): AsyncGenerator<Uint8Array>;
  bytes(n: number): Promise<Uint8Array>;
  skipTo(offset: number): Promise<void>;
  enter(entry: ZipEntry): Promise<void>;
  close(): Promise<void>;
}
