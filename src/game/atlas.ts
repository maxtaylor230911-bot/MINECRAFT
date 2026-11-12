// ============================================================
// Voxelcraft — procedural texture atlas
// All textures are original pixel art painted at runtime on a
// canvas. 16x16 tiles in a padded 512x512 atlas (8px edge
// extend per tile so mipmaps don't bleed).
// ============================================================

import { ATLAS_GRID, ATLAS_CELL, ATLAS_SIZE, ATLAS_PAD, T } from './blocks';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RGB = [number, number, number];
const rgb = (r: number, g: number, b: number): RGB => [r, g, b];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
function jitter(c: RGB, amt: number, r: () => number): RGB {
  const j = (r() * 2 - 1) * amt;
  return [Math.max(0, Math.min(255, c[0] + j)), Math.max(0, Math.min(255, c[1] + j)), Math.max(0, Math.min(255, c[2] + j))];
}

const TILE = 16;
const tileCanvases = new Map<number, HTMLCanvasElement>();

function makeTile(tile: number, paint: (p: Painter) => void): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = TILE; cv.height = TILE;
  const ctx = cv.getContext('2d')!;
  const r = rng(0x9e3779b9 ^ (tile * 2654435761));
  const p = new Painter(ctx, r);
  paint(p);
  tileCanvases.set(tile, cv);
  return cv;
}

class Painter {
  constructor(private ctx: CanvasRenderingContext2D, private r: () => number) {}
  px(x: number, y: number, c: RGB, a = 1): void {
    this.ctx.fillStyle = css(c, a);
    this.ctx.fillRect(x, y, 1, 1);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
    this.ctx.fillStyle = css(c, a);
    this.ctx.fillRect(x, y, w, h);
  }
  fill(c: RGB, amt = 10): void {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) this.px(x, y, jitter(c, amt, this.r));
  }
  fillAlpha(c: RGB, alpha: number, amt = 8): void {
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) this.px(x, y, jitter(c, amt, this.r), alpha);
  }
  speckle(c: RGB, count: number, a = 1): void {
    for (let i = 0; i < count; i++) {
      const x = (this.r() * TILE) | 0, y = (this.r() * TILE) | 0;
      this.px(x, y, jitter(c, 14, this.r), a);
    }
  }
  blobs(c: RGB, count: number, size = 2): void {
    for (let i = 0; i < count; i++) {
      const cx = (this.r() * TILE) | 0, cy = (this.r() * TILE) | 0;
      const s = 1 + ((this.r() * size) | 0);
      for (let dy = -s; dy <= s; dy++)
        for (let dx = -s; dx <= s; dx++) {
          if (dx * dx + dy * dy > s * s) continue;
          this.px((cx + dx + TILE) % TILE, (cy + dy + TILE) % TILE, jitter(c, 12, this.r));
        }
    }
  }
  vline(x: number, c: RGB, a = 1): void { this.rect(x, 0, 1, TILE, c, a); }
  hline(y: number, c: RGB, a = 1): void { this.rect(0, y, TILE, 1, c, a); }
  clear(): void { this.ctx.clearRect(0, 0, TILE, TILE); }
  get rand(): () => number { return this.r; }
}

// shared palette (original art)
const STONE_C = rgb(128, 128, 130);
const DIRT_C = rgb(134, 96, 67);
const GRASS_C = rgb(110, 170, 70);
const SAND_C = rgb(219, 207, 163);
const WOOD_C = rgb(160, 130, 78);
const WOOD_DARK = rgb(110, 87, 50);

export function buildAtlasCanvas(): HTMLCanvasElement {
  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_SIZE; atlas.height = ATLAS_SIZE;
  const actx = atlas.getContext('2d')!;

  const painters: Record<number, (p: Painter) => void> = {
    [T.grassTop]: (p) => {
      p.fill(GRASS_C, 16);
      p.speckle(rgb(90, 145, 55), 30);
      p.speckle(rgb(130, 190, 85), 30);
    },
    [T.grassSide]: (p) => {
      p.fill(DIRT_C, 14);
      p.speckle(rgb(110, 78, 52), 26);
      // grass fringe on top
      for (let x = 0; x < TILE; x++) {
        const depth = 2 + ((p.rand() * 3) | 0);
        for (let y = 0; y < depth; y++) p.px(x, y, jitter(GRASS_C, 16, p.rand));
      }
    },
    [T.dirt]: (p) => {
      p.fill(DIRT_C, 14);
      p.speckle(rgb(110, 78, 52), 30);
      p.speckle(rgb(150, 110, 78), 24);
    },
    [T.stone]: (p) => {
      p.fill(STONE_C, 12);
      p.speckle(rgb(105, 105, 108), 26);
      p.speckle(rgb(148, 148, 152), 22);
    },
    [T.cobble]: (p) => {
      p.fill(rgb(100, 100, 102), 8);
      // rounded stones
      const stones = [[3, 3, 4], [11, 4, 4], [5, 10, 4], [13, 12, 3], [0, 8, 3], [9, 0, 3]];
      for (const [sx, sy, s] of stones) {
        const base = jitter(rgb(132, 132, 136), 20, p.rand);
        for (let dy = -s; dy <= s; dy++)
          for (let dx = -s; dx <= s; dx++) {
            const d = dx * dx + dy * dy;
            if (d > s * s) continue;
            if (d > (s - 1) * (s - 1) && p.rand() < 0.5) continue;
            p.px((sx + dx + TILE) % TILE, (sy + dy + TILE) % TILE, jitter(base, 10, p.rand));
          }
      }
      p.speckle(rgb(80, 80, 82), 20);
    },
    [T.planks]: (p) => {
      p.fill(WOOD_C, 10);
      for (let y = 0; y < TILE; y += 4) {
        p.hline(y, WOOD_DARK, 0.9);
        for (let x = 0; x < TILE; x++) if (p.rand() < 0.3) p.px(x, y + 1 + ((p.rand() * 3) | 0), jitter(rgb(140, 112, 66), 8, p.rand));
      }
      p.vline(4, WOOD_DARK, 0.6); p.vline(12, WOOD_DARK, 0.6);
    },
    [T.logSide]: (p) => {
      p.fill(rgb(102, 81, 49), 8);
      for (let x = 0; x < TILE; x++) {
        if (p.rand() < 0.4) {
          const c = jitter(rgb(80, 62, 38), 10, p.rand);
          const y0 = (p.rand() * 6) | 0, len = 6 + ((p.rand() * 10) | 0);
          for (let y = y0; y < Math.min(TILE, y0 + len); y++) p.px(x, y, c);
        }
      }
    },
    [T.logTop]: (p) => {
      p.fill(WOOD_C, 8);
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (Math.abs(d - 5) < 0.6 || Math.abs(d - 3) < 0.6 || Math.abs(d - 1) < 0.6) p.px(x, y, jitter(WOOD_DARK, 8, p.rand));
          else if (d > 6.4) p.px(x, y, jitter(rgb(102, 81, 49), 8, p.rand));
        }
    },
    [T.birchSide]: (p) => {
      p.fill(rgb(216, 215, 210), 8);
      for (let i = 0; i < 7; i++) {
        const x = (p.rand() * TILE) | 0, y = (p.rand() * TILE) | 0, w = 1 + ((p.rand() * 3) | 0);
        p.rect(x, y, w, 1, rgb(60, 58, 54), 0.85);
      }
      p.speckle(rgb(190, 188, 182), 18);
    },
    [T.birchTop]: (p) => {
      p.fill(rgb(196, 180, 138), 8);
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (Math.abs(d - 5) < 0.7 || Math.abs(d - 2) < 0.7) p.px(x, y, jitter(rgb(150, 132, 96), 8, p.rand));
        }
    },
    [T.spruceSide]: (p) => {
      p.fill(rgb(70, 52, 32), 8);
      for (let x = 0; x < TILE; x++) {
        if (p.rand() < 0.45) {
          const c = jitter(rgb(52, 38, 24), 8, p.rand);
          const y0 = (p.rand() * 8) | 0, len = 5 + ((p.rand() * 10) | 0);
          for (let y = y0; y < Math.min(TILE, y0 + len); y++) p.px(x, y, c);
        }
      }
    },
    [T.spruceTop]: (p) => {
      p.fill(rgb(130, 100, 62), 8);
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (Math.abs(d - 4.5) < 0.7 || Math.abs(d - 1.5) < 0.7) p.px(x, y, jitter(rgb(92, 70, 44), 8, p.rand));
        }
    },
    [T.leavesOak]: (p) => {
      p.clear();
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          if (p.rand() < 0.82) p.px(x, y, jitter(rgb(60, 120, 40), 26, p.rand), 1);
        }
    },
    [T.leavesBirch]: (p) => {
      p.clear();
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          if (p.rand() < 0.82) p.px(x, y, jitter(rgb(108, 148, 70), 24, p.rand), 1);
        }
    },
    [T.leavesSpruce]: (p) => {
      p.clear();
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          if (p.rand() < 0.85) p.px(x, y, jitter(rgb(46, 92, 58), 20, p.rand), 1);
        }
    },
    [T.sand]: (p) => {
      p.fill(SAND_C, 10);
      p.speckle(rgb(198, 184, 138), 26);
      p.speckle(rgb(234, 224, 184), 22);
    },
    [T.sandstone]: (p) => {
      p.fill(rgb(216, 203, 155), 6);
      p.hline(0, rgb(190, 176, 128)); p.hline(5, rgb(198, 185, 138)); p.hline(10, rgb(198, 185, 138)); p.hline(15, rgb(190, 176, 128));
      p.speckle(rgb(200, 187, 140), 18);
    },
    [T.sandstoneTop]: (p) => { p.fill(rgb(222, 209, 160), 8); p.speckle(rgb(200, 187, 140), 20); },
    [T.gravel]: (p) => {
      p.fill(rgb(126, 122, 120), 10);
      p.blobs(rgb(148, 144, 140), 8, 1);
      p.blobs(rgb(100, 96, 94), 8, 1);
      p.speckle(rgb(160, 156, 150), 14);
    },
    [T.water]: (p) => {
      p.fillAlpha(rgb(48, 90, 200), 0.8, 8);
      for (let i = 0; i < 5; i++) {
        const y = (p.rand() * TILE) | 0;
        for (let x = 0; x < TILE; x++) if (p.rand() < 0.6) p.px(x, (y + ((x / 4) | 0)) % TILE, jitter(rgb(90, 140, 230), 10, p.rand), 0.7);
      }
    },
    [T.glass]: (p) => {
      p.clear();
      p.rect(0, 0, TILE, 1, rgb(210, 230, 235), 0.9);
      p.rect(0, TILE - 1, TILE, 1, rgb(210, 230, 235), 0.9);
      p.rect(0, 0, 1, TILE, rgb(210, 230, 235), 0.9);
      p.rect(TILE - 1, 0, 1, TILE, rgb(210, 230, 235), 0.9);
      p.px(3, 3, rgb(255, 255, 255), 0.55); p.px(4, 4, rgb(255, 255, 255), 0.4); p.px(5, 5, rgb(255, 255, 255), 0.25);
      p.rect(11, 2, 1, 3, rgb(255, 255, 255), 0.25);
      p.fillAlpha(rgb(200, 225, 235), 0.06, 4);
    },
    [T.bricks]: (p) => {
      p.fill(rgb(150, 90, 74), 6);
      const mortar = rgb(178, 172, 166);
      for (let y = 0; y < TILE; y += 4) {
        p.hline(y, mortar);
        const off = (y / 4) % 2 === 0 ? 0 : 4;
        for (let x = off; x < TILE; x += 8) p.rect(x, y, 1, 4, mortar);
      }
      p.speckle(rgb(132, 78, 62), 16);
    },
    [T.coalOre]: orePainter(rgb(38, 38, 40)),
    [T.ironOre]: orePainter(rgb(216, 174, 140)),
    [T.goldOre]: orePainter(rgb(250, 210, 60)),
    [T.diamondOre]: orePainter(rgb(90, 230, 225)),
    [T.redstoneOre]: orePainter(rgb(220, 40, 30)),
    [T.bedrock]: (p) => {
      p.fill(rgb(60, 60, 64), 20);
      p.blobs(rgb(30, 30, 34), 10, 2);
      p.blobs(rgb(95, 95, 100), 8, 1);
    },
    [T.snow]: (p) => { p.fill(rgb(240, 246, 250), 6); p.speckle(rgb(255, 255, 255), 14); },
    [T.snowSide]: (p) => {
      p.fill(DIRT_C, 14);
      p.speckle(rgb(110, 78, 52), 24);
      for (let x = 0; x < TILE; x++) {
        const depth = 3 + ((p.rand() * 2) | 0);
        for (let y = 0; y < depth; y++) p.px(x, y, jitter(rgb(240, 246, 250), 6, p.rand));
      }
    },
    [T.ice]: (p) => {
      p.fillAlpha(rgb(160, 200, 245), 0.75, 8);
      for (let i = 0; i < 4; i++) {
        let x = (p.rand() * TILE) | 0, y = (p.rand() * TILE) | 0;
        for (let s = 0; s < 6; s++) { p.px(x % TILE, y % TILE, rgb(210, 235, 255), 0.7); x += p.rand() < 0.5 ? 1 : 0; y += 1; }
      }
    },
    [T.cactusSide]: (p) => {
      p.fill(rgb(70, 130, 56), 8);
      p.vline(0, rgb(40, 90, 34)); p.vline(15, rgb(40, 90, 34));
      for (let y = 1; y < TILE; y += 4) for (let x = 3; x < TILE; x += 5) p.px(x, y, rgb(220, 235, 200));
    },
    [T.cactusTop]: (p) => {
      p.fill(rgb(84, 148, 66), 8);
      p.rect(0, 0, TILE, 1, rgb(40, 90, 34)); p.rect(0, TILE - 1, TILE, 1, rgb(40, 90, 34));
      p.rect(0, 0, 1, TILE, rgb(40, 90, 34)); p.rect(TILE - 1, 0, 1, TILE, rgb(40, 90, 34));
    },
    [T.glowstone]: (p) => {
      p.fill(rgb(150, 120, 70), 12);
      p.blobs(rgb(255, 220, 120), 8, 1);
      p.speckle(rgb(255, 240, 180), 24);
    },
    [T.torch]: (p) => {
      p.clear();
      // stick
      p.rect(7, 6, 2, 10, rgb(110, 87, 50));
      p.rect(7, 6, 1, 10, rgb(130, 104, 60));
      // glowing head
      p.rect(6, 3, 4, 3, rgb(255, 200, 80));
      p.rect(7, 2, 2, 1, rgb(255, 240, 160));
      p.px(6, 2, rgb(255, 170, 60), 0.8); p.px(9, 2, rgb(255, 170, 60), 0.8);
    },
    [T.tallGrass]: (p) => {
      p.clear();
      for (let i = 0; i < 9; i++) {
        const x = 1 + ((p.rand() * 14) | 0);
        const h = 6 + ((p.rand() * 9) | 0);
        const c = jitter(rgb(96, 158, 60), 22, p.rand);
        for (let y = 0; y < h; y++) p.px(x + (y > h * 0.6 && p.rand() < 0.3 ? 1 : 0), TILE - 1 - y, c);
      }
    },
    [T.poppy]: (p) => {
      p.clear();
      p.rect(7, 8, 1, 8, rgb(60, 120, 40));
      p.px(6, 11, rgb(60, 120, 40)); p.px(8, 12, rgb(60, 120, 40));
      p.rect(6, 4, 3, 3, rgb(210, 50, 40));
      p.px(7, 3, rgb(210, 50, 40)); p.px(7, 5, rgb(150, 30, 25)); p.px(6, 5, rgb(210, 50, 40)); p.px(8, 4, rgb(210, 50, 40));
    },
    [T.dandelion]: (p) => {
      p.clear();
      p.rect(7, 8, 1, 8, rgb(60, 120, 40));
      p.px(8, 11, rgb(60, 120, 40)); p.px(6, 12, rgb(60, 120, 40));
      p.rect(6, 4, 3, 3, rgb(250, 220, 60));
      p.px(7, 3, rgb(250, 220, 60)); p.px(6, 5, rgb(220, 180, 40)); p.px(8, 5, rgb(220, 180, 40)); p.px(8, 4, rgb(250, 220, 60));
    },
    [T.obsidian]: (p) => {
      p.fill(rgb(24, 18, 36), 8);
      p.speckle(rgb(50, 36, 74), 18);
      p.speckle(rgb(12, 8, 20), 16);
    },
    [T.bookshelf]: (p) => {
      p.fill(WOOD_C, 8);
      p.hline(0, WOOD_DARK); p.hline(7, WOOD_DARK); p.hline(8, WOOD_DARK); p.hline(15, WOOD_DARK);
      const bookCols = [rgb(150, 50, 44), rgb(60, 90, 150), rgb(70, 130, 60), rgb(160, 130, 50), rgb(120, 60, 130)];
      for (const yy of [1, 9]) {
        let x = 1;
        while (x < 15) {
          const w = 1 + ((p.rand() * 2) | 0);
          const c = bookCols[(p.rand() * bookCols.length) | 0];
          p.rect(x, yy, w, 6, jitter(c, 10, p.rand));
          p.rect(x, yy, w, 1, rgb(255, 255, 255), 0.18);
          x += w + (p.rand() < 0.25 ? 1 : 0);
        }
      }
    },
    [T.workbenchTop]: (p) => {
      p.fill(WOOD_C, 8);
      p.rect(0, 0, TILE, 1, WOOD_DARK); p.rect(0, 0, 1, TILE, WOOD_DARK);
      p.rect(2, 2, 12, 12, rgb(140, 112, 66));
      p.rect(4, 4, 8, 8, rgb(190, 158, 100));
      p.rect(7, 2, 2, 12, WOOD_DARK, 0.5); p.rect(2, 7, 12, 2, WOOD_DARK, 0.5);
    },
    [T.workbenchSide]: (p) => {
      p.fill(WOOD_C, 8);
      p.rect(0, 0, TILE, 2, rgb(120, 96, 58));
      p.rect(3, 4, 4, 6, rgb(150, 150, 155)); // saw
      p.rect(4, 5, 2, 6, rgb(110, 110, 116));
      p.rect(10, 4, 2, 7, rgb(120, 90, 60)); // handle
      p.hline(12, WOOD_DARK, 0.7);
    },
    [T.pumpkinSide]: (p) => {
      p.fill(rgb(214, 124, 32), 8);
      for (let x = 2; x < TILE; x += 4) p.vline(x, rgb(180, 98, 22), 0.8);
      p.hline(0, rgb(160, 88, 18)); p.hline(15, rgb(160, 88, 18));
      p.speckle(rgb(232, 150, 60), 10);
    },
    [T.pumpkinTop]: (p) => {
      p.fill(rgb(200, 116, 30), 8);
      p.rect(6, 6, 4, 4, rgb(96, 120, 48));
      p.rect(7, 7, 2, 2, rgb(70, 90, 36));
      for (let i = 0; i < 4; i++) { const x = 2 + i * 4; p.rect(x, 0, 1, TILE, rgb(170, 94, 22), 0.7); }
    },
    [T.mossy]: (p) => {
      p.fill(rgb(100, 100, 102), 8);
      const stones = [[3, 3, 4], [11, 4, 4], [5, 10, 4], [13, 12, 3], [0, 8, 3], [9, 0, 3]];
      for (const [sx, sy, s] of stones) {
        const base = jitter(rgb(128, 132, 128), 20, p.rand);
        for (let dy = -s; dy <= s; dy++)
          for (let dx = -s; dx <= s; dx++) {
            const d = dx * dx + dy * dy;
            if (d > s * s) continue;
            if (d > (s - 1) * (s - 1) && p.rand() < 0.5) continue;
            p.px((sx + dx + TILE) % TILE, (sy + dy + TILE) % TILE, jitter(base, 10, p.rand));
          }
      }
      p.blobs(rgb(70, 120, 60), 10, 2);
      p.speckle(rgb(80, 130, 66), 26);
    },
    [T.clay]: (p) => {
      p.fill(rgb(158, 164, 176), 8);
      p.speckle(rgb(140, 146, 160), 18);
      p.speckle(rgb(176, 182, 192), 18);
    },
    [T.lava]: (p) => {
      p.fill(rgb(207, 91, 16), 14);
      p.blobs(rgb(252, 166, 32), 9, 2);
      p.blobs(rgb(120, 32, 8), 6, 1);
      p.speckle(rgb(255, 220, 90), 20);
      p.speckle(rgb(90, 20, 6), 16);
    },
    [T.lapisOre]: orePainter(rgb(38, 97, 190)),
    [T.jungleLeaves]: (p) => {
      p.clear();
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          if (p.rand() < 0.86) p.px(x, y, jitter(rgb(48, 148, 30), 26, p.rand), 1);
        }
    },
    [T.sugarCane]: (p) => {
      p.clear();
      for (const x of [3, 7, 12]) {
        for (let y = 0; y < TILE; y++) {
          p.px(x, y, jitter(rgb(150, 200, 110), 14, p.rand));
          if (p.rand() < 0.4) p.px(x + 1, y, jitter(rgb(120, 170, 85), 14, p.rand));
        }
      }
    },
  };

  // register wool tiles
  const wools: [number, RGB][] = [
    [T.woolWhite, rgb(232, 232, 232)], [T.woolRed, rgb(176, 46, 38)], [T.woolOrange, rgb(224, 128, 40)],
    [T.woolYellow, rgb(230, 200, 60)], [T.woolGreen, rgb(84, 142, 50)], [T.woolBlue, rgb(58, 90, 176)],
    [T.woolPurple, rgb(134, 62, 156)], [T.woolBlack, rgb(28, 28, 32)],
  ];
  for (const [tile, c] of wools) {
    painters[tile] = woolPainter(c);
  }

  // paint every tile into its own canvas
  for (const key of Object.keys(painters)) {
    makeTile(Number(key), painters[Number(key)]);
  }

  // stamp tiles into atlas with 8px edge-extend padding (repeat-tile)
  for (const [tile, cv] of tileCanvases) {
    const col = tile % ATLAS_GRID, row = Math.floor(tile / ATLAS_GRID);
    const ox = col * ATLAS_CELL + ATLAS_PAD, oy = row * ATLAS_CELL + ATLAS_PAD;
    actx.save();
    actx.beginPath();
    actx.rect(col * ATLAS_CELL, row * ATLAS_CELL, ATLAS_CELL, ATLAS_CELL);
    actx.clip();
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        actx.drawImage(cv, ox + dx * TILE, oy + dy * TILE);
    actx.restore();
  }

  return atlas;
}

function orePainter(oreColor: RGB): (p: Painter) => void {
  return (p) => {
    p.fill(STONE_C, 12);
    p.speckle(rgb(105, 105, 108), 20);
    p.speckle(rgb(148, 148, 152), 16);
    // ore nuggets
    const spots = [[3, 3], [10, 4], [5, 9], [12, 11], [8, 13], [2, 12]];
    for (const [x, y] of spots) {
      if (p.rand() < 0.25) continue;
      p.rect(x, y, 2, 2, jitter(oreColor, 14, p.rand));
      p.px(x, y, jitter(oreColor, 30, p.rand));
      if (p.rand() < 0.5) p.px(x + 2, y + 1, jitter(oreColor, 20, p.rand));
    }
  };
}

function woolPainter(c: RGB): (p: Painter) => void {
  return (p) => {
    p.fill(c, 8);
    p.speckle(jitter(c, 24, p.rand), 20);
    for (let i = 0; i < 10; i++) {
      const x = (p.rand() * 15) | 0, y = (p.rand() * 15) | 0;
      p.px(x, y, jitter(c, 30, p.rand), 0.8);
      p.px(x + 1, y, jitter(c, 30, p.rand), 0.8);
    }
  };
}

// --- average colors per tile (for particles) ---

/** data URL of a single tile (used for menu backgrounds) */
export function getTileDataURL(tile: number): string {
  const cv = tileCanvases.get(tile);
  return cv ? cv.toDataURL() : '';
}

export function tileAvgColor(atlas: HTMLCanvasElement, tile: number): RGB {
  const ctx = atlas.getContext('2d')!;
  const col = tile % ATLAS_GRID, row = Math.floor(tile / ATLAS_GRID);
  const d = ctx.getImageData(col * ATLAS_CELL + ATLAS_PAD, row * ATLAS_CELL + ATLAS_PAD, TILE, TILE).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) return [128, 128, 128];
  return [r / n, g / n, b / n];
}

// --- crack overlay textures (10 stages) ---
export function buildCrackCanvases(): HTMLCanvasElement[] {
  const stages: HTMLCanvasElement[] = [];
  for (let s = 0; s < 10; s++) {
    const cv = document.createElement('canvas');
    cv.width = TILE; cv.height = TILE;
    const ctx = cv.getContext('2d')!;
    const r = rng(1234567 + s);
    const cracks = 2 + s;
    ctx.strokeStyle = 'rgba(20,16,12,0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i < cracks; i++) {
      let x = 2 + r() * 12, y = 2 + r() * 12;
      ctx.beginPath();
      ctx.moveTo(x, y);
      const steps = 3 + ((r() * 4) | 0);
      for (let st = 0; st < steps; st++) {
        x += (r() * 2 - 1) * 5; y += (r() * 2 - 1) * 5;
        ctx.lineTo(Math.max(0, Math.min(TILE, x)), Math.max(0, Math.min(TILE, y)));
      }
      ctx.stroke();
    }
    if (s > 5) {
      ctx.fillStyle = `rgba(20,16,12,${(s - 5) * 0.06})`;
      ctx.fillRect(0, 0, TILE, TILE);
    }
    stages.push(cv);
  }
  return stages;
}

// --- isometric block icon for hotbar / palette ---
export function drawBlockIcon(cv: HTMLCanvasElement, tileTop: number, tileSide1: number, tileSide2: number, cross: boolean): void {
  const ctx = cv.getContext('2d')!;
  const S = cv.width;
  ctx.clearRect(0, 0, S, S);
  const top = tileCanvases.get(tileTop);
  const s1 = tileCanvases.get(tileSide1);
  const s2 = tileCanvases.get(tileSide2);
  if (cross || !top || !s1 || !s2) {
    // flat sprite
    const flat = top || s1;
    if (flat) ctx.drawImage(flat, S * 0.08, S * 0.08, S * 0.84, S * 0.84);
    return;
  }
  // top face (parallelogram)
  ctx.save();
  ctx.translate(S / 2, S * 0.26);
  ctx.transform(1, 0.5, -1, 0.5, 0, 0);
  ctx.drawImage(top, -S * 0.25, -S * 0.25, S * 0.5, S * 0.5);
  ctx.restore();
  // left face
  ctx.save();
  ctx.translate(S * 0.25 - S * 0.0, S * 0.26 + S * 0.25 * 1);
  ctx.transform(1, 0.5, 0, 1, 0, 0);
  ctx.filter = 'brightness(78%)';
  ctx.drawImage(s1, -S * 0.0, -S * 0.25, S * 0.5, S * 0.5);
  ctx.restore();
  // right face
  ctx.save();
  ctx.translate(S * 0.5, S * 0.26 + S * 0.25 * 2);
  ctx.transform(1, -0.5, 0, 1, 0, 0);
  ctx.filter = 'brightness(60%)';
  ctx.drawImage(s2, 0, -S * 0.25, S * 0.5, S * 0.5);
  ctx.restore();
  ctx.filter = 'none';
}
