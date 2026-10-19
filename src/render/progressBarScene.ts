import ModelViewerCtor from "mdx-m3-viewer/dist/cjs/viewer/viewer";
import mdxHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler";
import blpHandler from "mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler";
import { separateAlphaBlend } from "./loadingScene";
import type { DataSource } from "../vfs/types";

// The Battle.net PROGRESS BAR — the bar the game's own "Downloading Update" box fills while it
// fetches a patch (`UI\FrameDef\Glue\MainMenu.fdf` `BattleNetPatchDialog`, sprite
// `PatchProgressBar`, BackgroundArt `UI\Glues\BattleNet\ProgressBar\BattlenetProgressBar.mdl`).
// OpenWar3 downloads exactly one thing from inside a dialog — Voice Control's speech model
// (ui/voiceDownload.ts) — so that is where it is drawn.
//
// It is the load bar's little brother, and it fills itself the same way (render/loadingScene.ts
// `setProgress`): dumped from the install, its ONE sequence is "Birth" 3333…63333, and its
// `Loading Bar Fill` / `Loading Bar Glow` bones each carry a two-key `KGSC` scaling track — x
// 0.0123 at frame 3333 and x 1.0 at 63333 — so the progress IS the playhead and the engine only
// seeks it. Its five quads (`BnetProgress-BarBorder`, the load bar's Background/Glass/Fill/Glow
// textures) are flat, authored in UI units with the origin at the bar's bottom-left: x 0…0.229,
// y 0…0.0571. So the camera is an orthographic window over exactly that box and the canvas is
// sized to the box — there is nothing else to frame.

/** The model the FDF names, with the `.mdx` the archives actually hold (the FDF's `.mdl` is
 *  the authoring name; every BackgroundArt is resolved this way). */
export const PROGRESS_BAR_MODEL = "UI\\Glues\\BattleNet\\ProgressBar\\BattlenetProgressBar.mdx";

/** The bar's authored extent in UI units (see the header). */
export const PROGRESS_BAR_W = 0.229;
export const PROGRESS_BAR_H = 0.0571;

type Solver = (src: unknown) => unknown;
interface Scene {
  alpha: boolean;
  color: Float32Array;
  viewport: Float32Array;
  camera: {
    ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): void;
    moveToAndFace(from: Float32Array, to: Float32Array, up: Float32Array): void;
  };
}
interface Viewer {
  gl: WebGLRenderingContext;
  startFrame(): void;
  addHandler(handler: unknown, ...args: unknown[]): boolean;
  addScene(): Scene;
  load(src: unknown, solver?: Solver): Promise<unknown>;
  whenAllLoaded(): Promise<unknown>;
  updateAndRender(dt: number): void;
}
interface MdxInstance {
  frame: number;
  timeScale: number;
  setScene(scene: unknown): void;
  setSequence(index: number): void;
  setSequenceLoopMode(mode: number): void;
}
interface MdxModel {
  sequences: Array<{ name: string; interval: Int32Array | number[] }>;
  addInstance(): MdxInstance;
}
const ViewerClass = ModelViewerCtor as unknown as {
  new(canvas: HTMLCanvasElement, options?: WebGLContextAttributes): Viewer;
};

export class ProgressBarScene {
  private viewer: Viewer;
  private scene: Scene;
  private bar: { instance: MdxInstance; start: number; end: number } | null = null;
  private progress = 0;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, private vfs: DataSource) {
    const viewer = new ViewerClass(canvas, { alpha: true });
    const solver: Solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    viewer.addHandler(mdxHandler, solver, false);
    viewer.addHandler(blpHandler);
    // See-through, over the dialog's own backdrop — the load bar's update-overlay treatment
    // (render/loadingScene.ts), for the same glow layer.
    viewer.startFrame = (): void => {
      const gl = viewer.gl;
      gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };
    separateAlphaBlend(viewer.gl);
    const scene = viewer.addScene();
    scene.alpha = true;
    this.viewer = viewer;
    this.scene = scene;
  }

  /** Read the bar out of the install. Resolves false when it is not there — the dialog still
   *  stands, with its percentage doing the job alone. */
  async load(): Promise<boolean> {
    if (!this.vfs.exists(PROGRESS_BAR_MODEL)) return false;
    const solver: Solver = (src) => (typeof src === "string" ? this.vfs.read(src) : src);
    const model = (await this.viewer.load(await this.vfs.read(PROGRESS_BAR_MODEL), solver)) as MdxModel | null;
    const birth = model?.sequences.findIndex((s) => /^birth$/i.test(s.name)) ?? -1;
    if (!model || birth < 0) return false;
    const instance = model.addInstance();
    instance.setScene(this.scene);
    instance.setSequenceLoopMode(1); // hold the last frame (see loadingScene.ts HOLD_AT_END)
    instance.setSequence(birth);
    instance.timeScale = 0; // seeked, never played
    const seq = model.sequences[birth];
    this.bar = { instance, start: seq.interval[0], end: seq.interval[1] };
    this.seek();
    await this.viewer.whenAllLoaded();
    return true;
  }

  /** 0…1. */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
    this.seek();
  }

  start(): void {
    if (this.raf) return;
    const frame = (): void => {
      this.fit();
      this.seek();
      this.viewer.updateAndRender(16);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.bar = null;
  }

  private seek(): void {
    if (this.bar) this.bar.instance.frame = this.bar.start + this.progress * (this.bar.end - this.bar.start);
  }

  /** Keep the drawing buffer at the canvas's on-screen size (the dialog scales with the
   *  window), and the camera over the bar's own box. */
  private fit(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scene.viewport.set([0, 0, w, h]);
    const cx = PROGRESS_BAR_W / 2;
    const cy = PROGRESS_BAR_H / 2;
    this.scene.camera.ortho(-cx, cx, -cy, cy, 1, 2000);
    this.scene.camera.moveToAndFace(new Float32Array([cx, cy, 1000]), new Float32Array([cx, cy, 0]), new Float32Array([0, 1, 0]));
  }
}
