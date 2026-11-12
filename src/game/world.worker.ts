// ============================================================
// Voxelcraft — world worker
// Owns the world database: terrain generation (11 biomes,
// rivers, caves, ores, trees), flood-fill lighting (sky +
// block), Minecraft-style flowing fluids (water 7 levels,
// lava 3 levels, water+lava → obsidian/cobble), and greedy
// face meshing with ambient occlusion. Runs off main thread.
// All original code.
// ============================================================

import {
  CHUNK, WORLD_HEIGHT, SEA_LEVEL, chunkKey, vidx,
  IS_OPAQUE, OPACITY, EMIT, RENDER, CROSS,
  WATER, LAVA, isWater, isLava, isFluid, fluidLevel, flowId, fluidMaxLevel,
} from './blocks';
import { uvRect } from './blocks';

/// ---------------- RNG + noise ----------------

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic Perlin noise (improved), seeded
class Perlin {
  private p = new Uint8Array(512);
  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }
  private static fade(t: number) { return t * t * t * (t * (t * 6 - 15) + 10); }
  private static lerp(a: number, b: number, t: number) { return a + t * (b - a); }
  private static grad(h: number, x: number, y: number, z: number) {
    switch (h & 15) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
      case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
      case 12: return x + y; case 13: return -y + z; case 14: return y - x; case 15: return -y - z;
    }
    return 0;
  }
  noise3(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = Perlin.fade(x), v = Perlin.fade(y), w = Perlin.fade(z);
    const p = this.p;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return Perlin.lerp(
      Perlin.lerp(
        Perlin.lerp(Perlin.grad(p[AA], x, y, z), Perlin.grad(p[BA], x - 1, y, z), u),
        Perlin.lerp(Perlin.grad(p[AB], x, y - 1, z), Perlin.grad(p[BB], x - 1, y - 1, z), u), v),
      Perlin.lerp(
        Perlin.lerp(Perlin.grad(p[AA + 1], x, y, z - 1), Perlin.grad(p[BA + 1], x - 1, y, z - 1), u),
        Perlin.lerp(Perlin.grad(p[AB + 1], x, y - 1, z - 1), Perlin.grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }
  noise2(x: number, z: number): number { return this.noise3(x, 0.5, z); }
  fbm2(x: number, z: number, oct: number, gain = 0.5, lac = 2): number {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += a * this.noise2(x * f, z * f);
      norm += a; a *= gain; f *= lac;
    }
    return sum / norm;
  }
  fbm3(x: number, y: number, z: number, oct: number): number {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += a * this.noise3(x * f, y * f, z * f);
      norm += a; a *= 0.5; f *= 2;
    }
    return sum / norm;
  }
}

// Fast deterministic hash for per-column decisions
function hash2(x: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/// ---------------- world state ----------------

interface Chunk {
  cx: number; cz: number;
  blocks: Uint8Array;   // 16*128*16
  light: Uint8Array;    // sky<<4 | block
  biomes: Uint8Array;   // 16*16 biome id
  heights: Uint8Array;  // 16*16 surface height
}

export const B = {
  AIR: 0, STONE: 1, GRASS: 2, DIRT: 3, COBBLE: 4, PLANKS: 5, SAND: 6, GRAVEL: 7,
  LOG: 8, LEAVES: 9, WATER: 10, GLASS: 11, COAL: 12, IRON: 13, GOLD: 14,
  DIAMOND: 15, REDSTONE: 16, BEDROCK: 17, SNOWGRASS: 18, ICE: 19, CACTUS: 20,
  SANDSTONE: 21, BIRCH_LOG: 22, BIRCH_LEAVES: 23, SPRUCE_LOG: 24, SPRUCE_LEAVES: 25,
  GLOWSTONE: 26, TORCH: 27, TALLGRASS: 28, POPPY: 29, DANDELION: 30, CLAY: 45,
  LAPIS: 57, JUNGLE_LEAVES: 58, SNOW_BLOCK: 59, SUGAR: 60, OBSIDIAN: 32, LAVA: 53,
};

const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, SNOWY: 5, MOUNTAIN: 6,
  JUNGLE: 7, TAIGA: 8, BIRCH: 9, SWAMP: 10, FLOWER: 11,
} as const;

let seedNum = 1337;
let terrain: Perlin;
let caveA: Perlin;
let caveB: Perlin;
let cheese: Perlin;
let riverN: Perlin;
let detailN: Perlin;

const chunks = new Map<number, Chunk>();
const edits = new Map<number, Map<number, number>>(); // chunkKey -> (idx -> blockId)
let smoothLighting = true;

// fluid simulation queue: chunkKey -> Set(local packed idx)
const fluidQueue = new Map<number, Set<number>>();
let fluidParity = 0;

function getChunk(cx: number, cz: number): Chunk | undefined {
  return chunks.get(chunkKey(cx, cz));
}
function getBlockG(x: number, y: number, z: number): number {
  if (y < 0) return B.BEDROCK;
  if (y >= WORLD_HEIGHT) return B.AIR;
  const c = getChunk(x >> 4, z >> 4);
  if (!c) return 255; // unknown
  return c.blocks[vidx(x & 15, y, z & 15)];
}
function getLightG(x: number, y: number, z: number): number {
  if (y >= WORLD_HEIGHT) return 0xf0;
  if (y < 0) return 0;
  const c = getChunk(x >> 4, z >> 4);
  if (!c) return 0;
  return c.light[vidx(x & 15, y, z & 15)];
}
function setLightG(x: number, y: number, z: number, v: number, touched: Set<number>): void {
  const c = getChunk(x >> 4, z >> 4);
  if (!c || y < 0 || y >= WORLD_HEIGHT) return;
  c.light[vidx(x & 15, y, z & 15)] = v;
  touched.add(chunkKey(x >> 4, z >> 4));
}

/// ---------------- terrain generation ----------------

interface ColInfo { h: number; biome: number; temp: number; hum: number; grassR: number; grassG: number; grassB: number; }

function grassTintFor(biome: number, temp: number, hum: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, temp)), u = Math.max(-1, Math.min(1, hum));
  const dry = (t + 1) / 2, lush = (u + 1) / 2;
  switch (biome) {
    case BIOME.JUNGLE: return [0.30, 0.88, 0.24];
    case BIOME.SWAMP: return [0.45, 0.52, 0.30];
    case BIOME.TAIGA: return [0.48, 0.74, 0.56];
    case BIOME.SNOWY: return [0.62, 0.80, 0.66];
    case BIOME.DESERT: return [0.72, 0.78, 0.42];
    default: {
      const r = 0.42 + dry * 0.28 - lush * 0.12;
      const g = 0.68 + lush * 0.12 - dry * 0.12;
      const b = 0.30 + (1 - lush) * 0.18;
      return [r, Math.min(g, 0.85), b];
    }
  }
}

function columnInfo(wx: number, wz: number): ColInfo {
  const cont = terrain.fbm2(wx * 0.0016, wz * 0.0016, 4);
  const hills = terrain.fbm2(wx * 0.012 + 100, wz * 0.012 - 100, 3);
  const ridged = 1 - Math.abs(terrain.fbm2(wx * 0.0045 + 400, wz * 0.0045 + 400, 4));
  const mountainMask = Math.min(1, Math.max(0, (cont - 0.05) / 0.45));
  const mountains = ridged * ridged * mountainMask;
  let h = 64 + cont * 26 + hills * 6 + mountains * 44;
  // flatten deep ocean floors a bit
  if (h < SEA_LEVEL - 4) h = SEA_LEVEL - 4 - (SEA_LEVEL - 4 - h) * 0.55;

  // ---- rivers: carve winding channels down to below sea level ----
  const riv = riverN.fbm2(wx * 0.0007 + 5555, wz * 0.0007 - 5555, 3);
  const rv = Math.abs(riv);
  const riverHere = rv < 0.017 && h < 90;
  if (riverHere) {
    const depth = (0.017 - rv) * 300; // up to ~5 deep at center
    h = Math.min(h, SEA_LEVEL - 1 - depth);
  }

  const temp = terrain.fbm2(wx * 0.0009 + 900, wz * 0.0009 - 900, 2) - Math.max(0, (h - 88) * 0.012);
  const hum = terrain.fbm2(wx * 0.0011 - 900, wz * 0.0011 + 900, 2);
  h = Math.max(4, Math.min(WORLD_HEIGHT - 10, h));
  const Hi = Math.floor(h);

  let biome: number;
  if (Hi < SEA_LEVEL - 1) biome = BIOME.OCEAN;
  else if (Hi <= SEA_LEVEL + 1) biome = temp < -0.25 ? BIOME.SNOWY : BIOME.BEACH;
  else if (Hi > 92 + hills * 6) biome = BIOME.MOUNTAIN;
  else if (temp < -0.32) biome = BIOME.SNOWY;
  else if (temp < -0.12) biome = BIOME.TAIGA;
  else if (temp > 0.3 && hum > 0.25) biome = BIOME.JUNGLE;
  else if (temp > 0.32 && hum < -0.05) biome = BIOME.DESERT;
  else if (hum > 0.42 && Hi <= SEA_LEVEL + 3) biome = BIOME.SWAMP;
  else if (hum > 0.08) {
    const bir = terrain.fbm2(wx * 0.0022 + 7777, wz * 0.0022 - 7777, 2);
    biome = bir > 0.22 ? BIOME.BIRCH : BIOME.FOREST;
  } else {
    const flw = terrain.fbm2(wx * 0.003 - 4444, wz * 0.003 + 4444, 2);
    biome = flw > 0.32 ? BIOME.FLOWER : BIOME.PLAINS;
  }

  // swamp pools: dip some columns under water
  if (biome === BIOME.SWAMP) {
    const pool = detailN.fbm2(wx * 0.05 + 321, wz * 0.05 - 321, 2);
    if (pool > 0.24 && Hi >= SEA_LEVEL) h = SEA_LEVEL - 1;
  }

  const [gr, gg, gb] = grassTintFor(biome, temp, hum);
  return { h: Math.floor(h), biome, temp, hum, grassR: gr, grassG: gg, grassB: gb };
}

function generateChunk(cx: number, cz: number): Chunk {
  const blocks = new Uint8Array(CHUNK * CHUNK * WORLD_HEIGHT);
  const biomes = new Uint8Array(CHUNK * CHUNK);
  const heights = new Uint8Array(CHUNK * CHUNK);
  const c: Chunk = { cx, cz, blocks, light: new Uint8Array(CHUNK * CHUNK * WORLD_HEIGHT), biomes, heights };

  // margin height cache for trees (-3..18)
  const M = 3, W = CHUNK + M * 2;
  const cols: ColInfo[] = new Array(W * W);
  for (let z = 0; z < W; z++)
    for (let x = 0; x < W; x++)
      cols[z * W + x] = columnInfo(cx * CHUNK + x - M, cz * CHUNK + z - M);

  for (let z = 0; z < CHUNK; z++) {
    for (let x = 0; x < CHUNK; x++) {
      const info = cols[(z + M) * W + (x + M)];
      const wx = cx * CHUNK + x, wz = cz * CHUNK + z;
      const h = info.h;
      biomes[z * 16 + x] = info.biome;
      heights[z * 16 + x] = h;

      for (let y = 0; y <= h; y++) {
        let id = B.STONE;
        const depth = h - y;
        if (y === 0) id = B.BEDROCK;
        else if (y <= 3 && hash2(wx * 7 + y, wz * 13 - y, seedNum) < 0.5) id = B.BEDROCK;
        else if (info.biome === BIOME.OCEAN) {
          if (depth === 0) id = hash2(wx, wz, seedNum + 5) < 0.35 ? B.GRAVEL : (hash2(wx, wz, seedNum + 6) < 0.2 ? B.CLAY : B.SAND);
          else if (depth < 4) id = B.SAND;
        } else if (info.biome === BIOME.DESERT) {
          if (depth === 0) id = B.SAND;
          else if (depth < 4) id = B.SAND;
          else if (depth < 7) id = B.SANDSTONE;
        } else if (info.biome === BIOME.BEACH) {
          if (depth < 4) id = B.SAND;
        } else if (info.biome === BIOME.SNOWY) {
          if (depth === 0) id = B.SNOWGRASS;
          else if (depth < 4) id = B.DIRT;
        } else if (info.biome === BIOME.MOUNTAIN) {
          if (depth === 0 && h > 98) id = B.SNOWGRASS;
          else if (depth === 0 && h < 80) id = B.GRASS;
          else if (depth < 3 && h < 80) id = B.DIRT;
        } else if (info.biome === BIOME.SWAMP) {
          if (depth === 0) id = h < SEA_LEVEL ? B.CLAY : (hash2(wx, wz, seedNum + 9) < 0.3 ? B.CLAY : B.GRASS);
          else if (depth < 3) id = B.DIRT;
        } else {
          if (depth === 0) id = B.GRASS;
          else if (depth < 4) id = B.DIRT;
        }
        blocks[vidx(x, y, z)] = id;
      }
      // water / ice
      if (h < SEA_LEVEL) {
        for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[vidx(x, y, z)] = B.WATER;
        if (info.temp < -0.28 && info.biome !== BIOME.SWAMP) blocks[vidx(x, SEA_LEVEL, z)] = B.ICE;
      }

      // ---- caves: spaghetti tunnels + cheese caverns ----
      // Ocean floor is protected (no carving within 8 blocks under a
      // water column) so oceans never drain into caves.
      const protect = h < SEA_LEVEL + 2;
      const caveTop = protect ? h - 8 : h + 1;
      for (let y = 5; y < caveTop && y < WORLD_HEIGHT; y++) {
        const i = vidx(x, y, z);
        const cur = blocks[i];
        if (cur === B.AIR || cur === B.BEDROCK || cur === B.WATER) continue;
        const n1 = caveA.noise3(wx * 0.021, y * 0.032, wz * 0.021);
        const n2 = caveB.noise3(wx * 0.021 + 300, y * 0.032, wz * 0.021 - 300);
        let carved = false;
        if (n1 * n1 + n2 * n2 < 0.011) carved = true;          // wide tunnels
        else if (y < 52) {
          const ch = cheese.noise3(wx * 0.016, y * 0.024, wz * 0.016);
          if (ch > 0.52) carved = true;                        // cheese caverns
          else if (y < 24) {
            const ch2 = cheese.noise3(wx * 0.03 + 900, y * 0.05, wz * 0.03 - 900);
            if (ch2 > 0.6) carved = true;                      // deep pockets
          }
        }
        if (carved) blocks[i] = (y <= 9) ? B.LAVA : B.AIR;     // lava level
      }
    }
  }

  // ores (random walk veins)
  const rnd = mulberry32(((cx & 0xffff) << 16) ^ (cz & 0xffff) ^ seedNum);
  const veins: [number, number, number, number][] = [
    // [block, tries, minY, maxY]
    [B.COAL, 18, 8, 118], [B.IRON, 12, 5, 68], [B.GOLD, 4, 5, 34],
    [B.REDSTONE, 6, 5, 16], [B.DIAMOND, 3, 5, 15], [B.LAPIS, 3, 6, 32],
  ];
  for (const [ore, tries, minY, maxY] of veins) {
    for (let t = 0; t < tries; t++) {
      let x = Math.floor(rnd() * 16), z = Math.floor(rnd() * 16);
      let y = minY + Math.floor(rnd() * (maxY - minY));
      const size = 3 + Math.floor(rnd() * 5);
      for (let s = 0; s < size; s++) {
        if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 3 && y < WORLD_HEIGHT) {
          const i = vidx(x, y, z);
          if (blocks[i] === B.STONE) blocks[i] = ore;
        }
        x += Math.floor(rnd() * 3) - 1; y += Math.floor(rnd() * 3) - 1; z += Math.floor(rnd() * 3) - 1;
      }
    }
  }

  // trees & decorations (with margin so canopies cross borders seamlessly)
  for (let z = -M; z < CHUNK + M; z++) {
    for (let x = -M; x < CHUNK + M; x++) {
      const info = cols[(z + M) * W + (x + M)];
      const wx = cx * CHUNK + x, wz = cz * CHUNK + z;
      const r = hash2(wx, wz, seedNum + 99);
      const r2 = hash2(wx, wz, seedNum + 1234);
      const h = info.h;
      if (h <= SEA_LEVEL - 2) continue;
      const local = x >= 0 && x < 16 && z >= 0 && z < 16;
      const groundId = local ? blocks[vidx(x, h, z)] : B.AIR;
      const wet = h < SEA_LEVEL;

      // sugar cane on wet shores
      if (local && !wet && h <= SEA_LEVEL + 1 && (groundId === B.SAND || groundId === B.GRASS || groundId === B.CLAY) && r > 0.985) {
        const caneH = 2 + Math.floor(r2 * 2);
        for (let i = 1; i <= caneH; i++) if (h + i < WORLD_HEIGHT) blocks[vidx(x, h + i, z)] = B.SUGAR;
        continue;
      }

      const isGrassy = groundId === B.GRASS || groundId === B.SNOWGRASS || (!local && h > SEA_LEVEL);
      if (isGrassy) {
        let treeKind = -1, density = 0; // 0 oak, 1 birch, 2 spruce, 3 jungle, 4 swamp oak
        switch (info.biome) {
          case BIOME.FOREST: treeKind = r2 < 0.25 ? 1 : 0; density = 0.03; break;
          case BIOME.FLOWER: treeKind = 0; density = 0.002; break;
          case BIOME.PLAINS: treeKind = 0; density = 0.0035; break;
          case BIOME.BIRCH: treeKind = 1; density = 0.032; break;
          case BIOME.JUNGLE: treeKind = r2 < 0.2 ? 0 : 3; density = 0.03; break;
          case BIOME.TAIGA: treeKind = 2; density = 0.028; break;
          case BIOME.SNOWY: treeKind = 2; density = 0.012; break;
          case BIOME.MOUNTAIN: if (h < 88) { treeKind = 2; density = 0.006; } break;
          case BIOME.SWAMP: treeKind = 4; density = 0.009; break;
        }
        if (treeKind >= 0 && r < density) {
          stampTree(blocks, x, h, z, treeKind, hash2(wx, wz, seedNum + 77));
          continue;
        }
        // ground cover
        if (local && groundId === B.GRASS) {
          const flowerBiome = info.biome === BIOME.FLOWER || info.biome === BIOME.PLAINS || info.biome === BIOME.FOREST || info.biome === BIOME.JUNGLE;
          const grassChance = info.biome === BIOME.JUNGLE ? 0.28 : info.biome === BIOME.SWAMP ? 0.16 : 0.1;
          if (r > 0.86 && r < 0.86 + grassChance) blocks[vidx(x, h + 1, z)] = B.TALLGRASS;
          else if (flowerBiome && r >= 0.985 && r < 0.9925) blocks[vidx(x, h + 1, z)] = B.POPPY;
          else if (flowerBiome && r >= 0.9925 && r < 1.0) blocks[vidx(x, h + 1, z)] = B.DANDELION;
          if (info.biome === BIOME.PLAINS && r > 0.9994) blocks[vidx(x, h + 1, z)] = 43; // pumpkin
        }
      } else if (local && info.biome === BIOME.DESERT && groundId === B.SAND && r < 0.008) {
        const ch = 1 + Math.floor(r2 * 3);
        for (let i = 1; i <= ch; i++) if (h + i < WORLD_HEIGHT) blocks[vidx(x, h + i, z)] = B.CACTUS;
      }
    }
  }

  // apply saved player edits
  const ed = edits.get(chunkKey(cx, cz));
  if (ed) for (const [idx, id] of ed) blocks[idx] = id;

  // schedule every generated fluid cell so oceans/rivers immediately
  // react to any opening (they settle to no-ops within a tick or two)
  const fq = new Set<number>();
  for (let y = 0; y < WORLD_HEIGHT; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const i = vidx(x, y, z);
        if (isFluid(blocks[i])) fq.add(i);
      }
  if (fq.size) fluidQueue.set(chunkKey(cx, cz), fq);
  // neighbors may now flow across the border
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nc = getChunk(cx + dx, cz + dz);
      if (nc) scheduleChunkFluids(nc);
    }

  return c;
}

function stampTree(blocks: Uint8Array, x: number, h: number, z: number, kind: number, r: number): void {
  if (kind === 0 || kind === 1) {
    // oak / birch
    const birch = kind === 1;
    const trunkH = (birch ? 5 : 4) + Math.floor(r * 3) + (birch ? 1 : 0);
    const logId = birch ? B.BIRCH_LOG : B.LOG;
    const leafId = birch ? B.BIRCH_LEAVES : B.LEAVES;
    const top = h + trunkH;
    for (let dy = -2; dy <= 1; dy++) {
      const rad = dy < 0 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++)
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy >= 0 || hash2(x + dx, z + dz + dy * 31, 7) < 0.5)) continue;
          setLocalAir(blocks, x + dx, top + dy, z + dz, leafId);
        }
    }
    for (let y = h + 1; y <= top; y++) setLocalForce(blocks, x, y, z, logId);
  } else if (kind === 2) {
    // spruce (conical)
    const trunkH = 6 + Math.floor(r * 4);
    const top = h + trunkH;
    setLocalAir(blocks, x, top + 1, z, B.SPRUCE_LEAVES);
    for (let dy = trunkH; dy >= 2; dy--) {
      const rr = dy === trunkH ? 1 : (dy >= trunkH - 2 ? 1 : (((trunkH - dy) & 1) ? 2 : 1));
      for (let dx = -rr; dx <= rr; dx++)
        for (let dz = -rr; dz <= rr; dz++) {
          if (dx === 0 && dz === 0 && dy < trunkH) continue;
          if (Math.abs(dx) === rr && Math.abs(dz) === rr && rr > 1) continue;
          setLocalAir(blocks, x + dx, h + dy, z + dz, B.SPRUCE_LEAVES);
        }
    }
    for (let y = h + 1; y <= top; y++) setLocalForce(blocks, x, y, z, B.SPRUCE_LOG);
  } else if (kind === 3) {
    // jungle — tall trunk, wide canopy
    const trunkH = 8 + Math.floor(r * 5);
    const top = h + trunkH;
    for (let dy = -1; dy <= 1; dy++) {
      const rad = dy === 1 ? 1 : 3 - (dy < 0 ? 0 : 1);
      const ly = top + dy;
      for (let dx = -rad; dx <= rad; dx++)
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy === 1 || hash2(x + dx * 3, z + dz * 3, ly) < 0.4)) continue;
          setLocalAir(blocks, x + dx, ly, z + dz, B.JUNGLE_LEAVES);
        }
    }
    setLocalAir(blocks, x, top + 2, z, B.JUNGLE_LEAVES);
    for (let y = h + 1; y <= top; y++) setLocalForce(blocks, x, y, z, B.LOG);
  } else {
    // swamp oak — short trunk, wide flat cap
    const trunkH = 4 + Math.floor(r * 3);
    const top = h + trunkH;
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++) {
        const d = Math.abs(dx) + Math.abs(dz);
        if (d > 4) continue;
        if (Math.abs(dx) === 3 && Math.abs(dz) === 3) continue;
        if (d >= 3 && hash2(x + dx * 5, z + dz * 5, top) < 0.45) continue;
        setLocalAir(blocks, x + dx, top, z + dz, B.LEAVES);
      }
    setLocalAir(blocks, x, top + 1, z, B.LEAVES);
    for (let y = h + 1; y <= top; y++) setLocalForce(blocks, x, y, z, B.LOG);
  }
}
function setLocalAir(blocks: Uint8Array, x: number, y: number, z: number, id: number): void {
  if (x < 0 || x > 15 || z < 0 || z > 15 || y < 1 || y >= WORLD_HEIGHT) return;
  const i = vidx(x, y, z);
  if (blocks[i] === B.AIR) blocks[i] = id;
}
function setLocalForce(blocks: Uint8Array, x: number, y: number, z: number, id: number): void {
  if (x < 0 || x > 15 || z < 0 || z > 15 || y < 1 || y >= WORLD_HEIGHT) return;
  blocks[vidx(x, y, z)] = id;
}

/// ---------------- lighting ----------------

// recompute the direct skylight column for x,z; returns list of changed cells
function relightColumn(cx: number, cz: number, lx: number, lz: number, changed: number[], oldVals: number[]): void {
  const c = getChunk(cx, cz);
  if (!c) return;
  let level = 15;
  for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
    const i = vidx(lx, y, lz);
    const id = c.blocks[i];
    if (IS_OPAQUE[id]) level = 0;
    else if (OPACITY[id] > 0) level = Math.max(0, level - OPACITY[id]);
    const sky = c.light[i] >> 4;
    if (sky !== level) { changed.push(i); oldVals.push(sky); }
    c.light[i] = (c.light[i] & 0x0f) | (level << 4);
    if (level === 0) {
      // zero-out cells below that had sky light (e.g. under overhangs)
      for (let yy = y - 1; yy >= 0; yy--) {
        const ii = vidx(lx, yy, lz);
        const s = c.light[ii] >> 4;
        if (s !== 0) { changed.push(ii); oldVals.push(s); c.light[ii] = c.light[ii] & 0x0f; }
      }
      break;
    }
  }
}

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Additive BFS for one channel. ch: 0 sky, 1 block
function addLightBFS(ch: number, seeds: number[], touched: Set<number>): void {
  // seeds: packed world coords list [x,y,z,...]
  const q = seeds.slice();
  for (let si = 0; si < q.length; si += 3) {
    const x = q[si], y = q[si + 1], z = q[si + 2];
    const L = ch === 0 ? (getLightG(x, y, z) >> 4) : (getLightG(x, y, z) & 15);
    if (L <= 1) continue;
    for (let d = 0; d < 6; d++) {
      const nx = x + DIRS[d][0], ny = y + DIRS[d][1], nz = z + DIRS[d][2];
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const nb = getBlockG(nx, ny, nz);
      if (nb === 255) continue;
      if (IS_OPAQUE[nb]) continue;
      const att = Math.max(1, OPACITY[nb]);
      let target: number;
      if (ch === 0 && d === 3 && L === 15 && OPACITY[nb] === 0) target = 15; // skylight falls straight down undimmed
      else target = L - att;
      if (target <= 0) continue;
      const cur = ch === 0 ? (getLightG(nx, ny, nz) >> 4) : (getLightG(nx, ny, nz) & 15);
      if (cur < target) {
        const old = getLightG(nx, ny, nz);
        const v = ch === 0 ? ((old & 0x0f) | (target << 4)) : ((old & 0xf0) | target);
        setLightG(nx, ny, nz, v, touched);
        q.push(nx, ny, nz);
      }
    }
  }
}

// Removal BFS: clears light that was sourced from (x,y,z) with value L, collecting re-add seeds
function removeLightBFS(ch: number, x: number, y: number, z: number, L: number, touched: Set<number>, addSeeds: number[]): void {
  const q: number[] = [x, y, z, L];
  const old = getLightG(x, y, z);
  setLightG(x, y, z, ch === 0 ? (old & 0x0f) : (old & 0xf0), touched);
  for (let qi = 0; qi < q.length; qi += 4) {
    const cx = q[qi], cy = q[qi + 1], cz = q[qi + 2], cl = q[qi + 3];
    for (let d = 0; d < 6; d++) {
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1], nz = cz + DIRS[d][2];
      if (ny < 0 || ny >= WORLD_HEIGHT) continue;
      const nb = getBlockG(nx, ny, nz);
      if (nb === 255) continue;
      const nL = ch === 0 ? (getLightG(nx, ny, nz) >> 4) : (getLightG(nx, ny, nz) & 15);
      if (nL === 0) continue;
      const fedByUs = nL < cl || (ch === 0 && cl === 15 && d === 3 && nL === 15);
      if (fedByUs) {
        setLightG(nx, ny, nz, ch === 0 ? (getLightG(nx, ny, nz) & 0x0f) : (getLightG(nx, ny, nz) & 0xf0), touched);
        q.push(nx, ny, nz, nL);
      } else {
        addSeeds.push(nx, ny, nz);
      }
    }
  }
}

function computeInitialLight(c: Chunk, touched: Set<number>): void {
  const seeds: number[] = [];
  // direct skylight columns
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      let level = 15;
      for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
        const i = vidx(x, y, z);
        const id = c.blocks[i];
        if (IS_OPAQUE[id]) { level = 0; }
        else if (OPACITY[id] > 0) level = Math.max(0, level - OPACITY[id]);
        c.light[i] = level << 4;
        if (level === 0) {
          // remaining cells below stay 0 for now
          for (let yy = y - 1; yy >= 0; yy--) c.light[vidx(x, yy, z)] &= 0x0f;
          break;
        }
      }
    }
  }
  // seed BFS from every lit cell bordering a darker transparent cell (cheap approx: all lit cells with L>1)
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = vidx(x, y, z);
        const L = c.light[i] >> 4;
        if (L > 1) seeds.push(c.cx * 16 + x, y, c.cz * 16 + z);
        const e = EMIT[c.blocks[i]];
        if (e > 0) c.light[i] = (c.light[i] & 0xf0) | e;
      }
    }
  }
  // also seed from neighbor chunks' border lights
  const nseeds: number[] = [];
  for (let d = 0; d < 4; d++) {
    const nx = c.cx + DIRS[d][0], nz = c.cz + DIRS[d][2];
    const nc = getChunk(nx, nz);
    if (!nc) continue;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let t = 0; t < 16; t++) {
        const lx = d === 0 ? 0 : d === 1 ? 15 : t;
        const lz = d === 2 ? 0 : d === 3 ? 15 : t;
        const i = vidx(lx, y, lz);
        const L = nc.light[i];
        if ((L >> 4) > 1 || (L & 15) > 1) nseeds.push(nx * 16 + lx, y, nz * 16 + lz);
        const e = EMIT[nc.blocks[i]];
        if (e > 0) nseeds.push(nx * 16 + lx, y, nz * 16 + lz);
      }
    }
  }
  addLightBFS(0, seeds.concat(nseeds), touched);
  addLightBFS(1, nseeds, touched);
  // re-derive block-light seeds from emitters inside this chunk too
  const bseeds: number[] = [];
  for (let y = 0; y < WORLD_HEIGHT; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const i = vidx(x, y, z);
        if (EMIT[c.blocks[i]] > 0) bseeds.push(c.cx * 16 + x, y, c.cz * 16 + z);
      }
  addLightBFS(1, bseeds, touched);
}

/// ---------------- fluids (Minecraft-style) ----------------

function scheduleFluid(x: number, y: number, z: number): void {
  if (y < 0 || y >= WORLD_HEIGHT) return;
  const cx = x >> 4, cz = z >> 4;
  const c = getChunk(cx, cz);
  if (!c) return;
  const key = chunkKey(cx, cz);
  let set = fluidQueue.get(key);
  if (!set) { set = new Set<number>(); fluidQueue.set(key, set); }
  set.add(vidx(x & 15, y, z & 15));
}

function scheduleChunkFluids(c: Chunk): void {
  let set = fluidQueue.get(chunkKey(c.cx, c.cz));
  if (!set) { set = new Set<number>(); fluidQueue.set(chunkKey(c.cx, c.cz), set); }
  for (let y = 0; y < WORLD_HEIGHT; y++)
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) {
        const i = vidx(x, y, z);
        if (isFluid(c.blocks[i])) set.add(i);
      }
}

/** fluid can replace air and cross plants (which it destroys) */
function canFlowInto(id: number): boolean {
  return id === B.AIR || CROSS[id] === 1;
}

const DIRS4H = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** one simulation step for the fluid at (x,y,z) with block id `id` */
function fluidStep(x: number, y: number, z: number, id: number, touched: Set<number>): void {
  const src = isWater(id) ? WATER : LAVA;
  let lvl = fluidLevel(id);
  const maxL = fluidMaxLevel(src);
  const sameFamily = (nid: number) => (src === WATER ? isWater(nid) : isLava(nid));

  // lava + water → stone interactions (checked before flowing)
  if (src === LAVA) {
    for (let d = 0; d < 6; d++) {
      const nid = getBlockG(x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      if (isWater(nid)) {
        // water touching lava solidifies it
        applyEdit(x, y, z, lvl === 0 ? B.OBSIDIAN : B.COBBLE, false, touched);
        return;
      }
    }
  } else {
    // water falling onto / beside lava also solidifies the lava
    const below = getBlockG(x, y - 1, z);
    if (isLava(below)) applyEdit(x, y - 1, z, fluidLevel(below) === 0 ? B.OBSIDIAN : B.COBBLE, false, touched);
  }

  // flowing cells must stay fed, otherwise decay away
  if (lvl > 0) {
    let best = 999;
    const upId = getBlockG(x, y + 1, z);
    if (sameFamily(upId)) best = 0;
    for (const [dx, dz] of DIRS4H) {
      const nid = getBlockG(x + dx, y, z + dz);
      if (sameFamily(nid)) best = Math.min(best, fluidLevel(nid));
    }
    if (best === 999 || best + 1 > maxL) {
      applyEdit(x, y, z, B.AIR, false, touched);
      return;
    }
    if (best + 1 !== lvl) {
      const newId = flowId(src, best + 1);
      applyEdit(x, y, z, newId, false, touched);
      id = newId;
      lvl = best + 1;
    }
  }

  // flow downward first (falling column, full strength)
  const below = getBlockG(x, y - 1, z);
  if (canFlowInto(below) || (sameFamily(below) && fluidLevel(below) > 1)) {
    if (below !== flowId(src, 1)) applyEdit(x, y - 1, z, flowId(src, 1), false, touched);
    return; // falling water doesn't spread sideways (MC rule)
  }

  // spread horizontally on a floor
  if (lvl < maxL) {
    for (const [dx, dz] of DIRS4H) {
      const nx = x + dx, nz = z + dz;
      const nid = getBlockG(nx, y, nz);
      const want = flowId(src, lvl + 1);
      if (canFlowInto(nid)) {
        applyEdit(nx, y, nz, want, false, touched);
      } else if (sameFamily(nid) && fluidLevel(nid) > lvl + 1) {
        applyEdit(nx, y, nz, want, false, touched);
      }
    }
  }
}

function tickFluids(): void {
  fluidParity++;
  const waterTick = true;
  const lavaTick = fluidParity % 4 === 0;
  const touched = new Set<number>();
  let budget = 5000;

  const keys = [...fluidQueue.keys()];
  for (const ck of keys) {
    const set = fluidQueue.get(ck);
    if (!set || set.size === 0) { fluidQueue.delete(ck); continue; }
    const c = chunks.get(ck);
    if (!c) { fluidQueue.delete(ck); continue; }
    const [cx, cz] = [Math.floor(ck / 4096) - 2048, (ck % 4096) - 2048];
    const cells = [...set];
    set.clear();
    for (const li of cells) {
      if (budget-- <= 0) {
        // re-queue the rest for next tick
        for (let j = cells.indexOf(li); j < cells.length; j++) set.add(cells[j]);
        break;
      }
      const y = li >> 8, lz = (li >> 4) & 15, lx = li & 15;
      const id = c.blocks[li];
      if (!isFluid(id)) continue;
      if (isLava(id) && !lavaTick) { set.add(li); continue; }
      void waterTick;
      const x = cx * 16 + lx, z = cz * 16 + lz;
      fluidStep(x, y, z, id, touched);
    }
    if (set.size === 0) fluidQueue.delete(ck);
  }

  // remesh touched chunks once
  if (touched.size) {
    for (const k of touched) {
      const tc = chunks.get(k);
      if (tc) postChunk(tc, 'mesh');
    }
  }
}

/// ---------------- meshing ----------------

const FACE_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// corner positions per face (unit cube), CCW from outside
const FACE_CORNERS: number[][][] = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
// uv corner (u,v) per face corner
const FACE_UVS: number[][][] = [
  [[0, 0], [0, 1], [1, 1], [1, 0]],
  [[0, 0], [0, 1], [1, 1], [1, 0]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
  [[0, 0], [1, 0], [1, 1], [0, 1]],
];
const FACE_SHADE = [0.65, 0.65, 1.0, 0.55, 0.82, 0.82];

interface Geom { pos: Float32Array; uv: Float32Array; light: Float32Array; tint: Float32Array; idx: Uint32Array; }
function packBuf(b: { pos: number[]; uv: number[]; light: number[]; tint: number[]; idx: number[] }): Geom {
  return {
    pos: new Float32Array(b.pos), uv: new Float32Array(b.uv), light: new Float32Array(b.light),
    tint: new Float32Array(b.tint), idx: new Uint32Array(b.idx),
  };
}

interface MeshOut { solid: Geom | null; cutout: Geom | null; trans: Geom | null; }

function meshChunk(c: Chunk): MeshOut {
  const solid = { pos: [] as number[], uv: [] as number[], light: [] as number[], tint: [] as number[], idx: [] as number[] };
  const cutout = { pos: [] as number[], uv: [] as number[], light: [] as number[], tint: [] as number[], idx: [] as number[] };
  const trans = { pos: [] as number[], uv: [] as number[], light: [] as number[], tint: [] as number[], idx: [] as number[] };

  const ox = c.cx * 16, oz = c.cz * 16;
  const tileUV = new Array(64);
  for (let t = 0; t < 64; t++) tileUV[t] = uvRect(t);

  const grassTintPerCol = new Float32Array(16 * 16 * 3);
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const info = columnInfo(ox + x, oz + z);
      grassTintPerCol[(z * 16 + x) * 3] = info.grassR;
      grassTintPerCol[(z * 16 + x) * 3 + 1] = info.grassG;
      grassTintPerCol[(z * 16 + x) * 3 + 2] = info.grassB;
    }

  const smooth = smoothLighting;
  const aoVals = [0.42, 0.62, 0.82, 1.0];

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const id = c.blocks[vidx(x, y, z)];
        if (id === 0 || id === 255) continue;
        const wx = ox + x, wz = oz + z;
        const render = RENDER[id];
        const isCross = CROSS[id] === 1;
        const fluid = isFluid(id);
        // lava renders opaque (glowing); water renders translucent
        const bucket = (render === 0 || isLava(id)) ? solid : render === 1 ? cutout : trans;

        if (isCross) {
          // two diagonal quads, both windings
          const li = getLightG(wx, y, wz);
          const sky = (li >> 4) / 15, blk = (li & 15) / 15;
          const tintCol = (z * 16 + x) * 3;
          const tr = grassTintPerCol[tintCol], tg = grassTintPerCol[tintCol + 1], tb = grassTintPerCol[tintCol + 2];
          const uv = tileUV[tileOfId(id, 0)];
          const a = 0.146, b2 = 0.854;
          const quads = [
            [[a, 0, a], [b2, 0, b2], [b2, 1, b2], [a, 1, a]],
            [[b2, 0, b2], [a, 0, a], [a, 1, a], [b2, 1, b2]],
            [[a, 0, b2], [b2, 0, a], [b2, 1, a], [a, 1, b2]],
            [[b2, 0, a], [a, 0, b2], [a, 1, b2], [b2, 1, a]],
          ];
          const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
          for (const q of quads) {
            const base = bucket.pos.length / 3;
            for (let vi = 0; vi < 4; vi++) {
              bucket.pos.push(x + q[vi][0], y + q[vi][1], z + q[vi][2]);
              bucket.uv.push(uv[0] + (uv[2] - uv[0]) * uvs[vi][0], uv[1] + (uv[3] - uv[1]) * uvs[vi][1]);
              bucket.light.push(sky, blk);
              bucket.tint.push(tr * 0.95, tg * 0.95, tb * 0.95);
            }
            bucket.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
          continue;
        }

        // fluid surface height
        let topY = 1;
        if (fluid) {
          const above = getBlockG(wx, y + 1, wz);
          if (isFluid(above) && (isWater(above) === isWater(id))) topY = 1; // column continues above
          else if (fluidLevel(id) === 0) topY = 0.875;                     // source surface
          else topY = Math.max(0.15, ((8 - fluidLevel(id)) / 8) * 0.875);  // flowing wedge
        }

        for (let f = 0; f < 6; f++) {
          const d = FACE_DIRS[f];
          const nx = wx + d[0], ny = y + d[1], nz = wz + d[2];
          const nid = getBlockG(nx, ny, nz);
          if (ny < 0) continue;
          if (nid === 255) continue; // unknown neighbor -> skip (remeshed when neighbor loads)
          // visibility rules
          if (isWater(id)) {
            if (isWater(nid) || nid === B.ICE) continue;
            if (IS_OPAQUE[nid]) continue;
          } else if (isLava(id)) {
            if (isLava(nid) || IS_OPAQUE[nid]) continue;
          } else if (render === 3) { // glass / ice
            if (nid === id || IS_OPAQUE[nid]) continue;
          } else if (render === 1) { // leaves
            if (nid === id || IS_OPAQUE[nid]) continue;
          } else {
            if (IS_OPAQUE[nid]) continue;
          }

          const tile = tileOfId(id, f);
          const uv = tileUV[tile];
          const shade = FACE_SHADE[f];
          const tintCol = (z * 16 + x) * 3;
          let tr = 1, tg = 1, tb = 1;
          const biomeTint = (id === B.GRASS && f === 2) || id === B.LEAVES || id === B.SPRUCE_LEAVES || id === B.TALLGRASS;
          const snowyTint = (id === B.SNOWGRASS && f === 2);
          if (biomeTint) { tr = grassTintPerCol[tintCol]; tg = grassTintPerCol[tintCol + 1]; tb = grassTintPerCol[tintCol + 2]; }
          if (snowyTint) { tr = 0.9; tg = 0.95; tb = 1.0; }

          const corners = FACE_CORNERS[f];
          const uvc = FACE_UVS[f];
          const base = bucket.pos.length / 3;
          const skyA = [0, 0, 0, 0], blkA = [0, 0, 0, 0], aoA = [0, 0, 0, 0];

          for (let vi = 0; vi < 4; vi++) {
            const corner = corners[vi];
            let px = x + corner[0], py = y + corner[1], pz = z + corner[2];
            if (fluid && corner[1] === 1) py = y + topY;
            bucket.pos.push(px, py, pz);
            bucket.uv.push(uv[0] + (uv[2] - uv[0]) * uvc[vi][0], uv[1] + (uv[3] - uv[1]) * uvc[vi][1]);

            let sky = 0, blk = 0, ao = 3;
            if (smooth && render !== 2 && !isLava(id)) {
              // sample the 4 cells around this corner on the outer side of the face
              let ax: number, az: number; // offsets in the two tangent directions toward the corner
              if (f < 2) { ax = corner[1] === 1 ? 1 : -1; az = corner[2] === 1 ? 1 : -1; }
              else if (f < 4) { ax = corner[0] === 1 ? 1 : -1; az = corner[2] === 1 ? 1 : -1; }
              else { ax = corner[0] === 1 ? 1 : -1; az = corner[1] === 1 ? 1 : -1; }
              let ex: number, ey: number, ez: number, fx2: number, fy2: number, fz2: number, gx: number, gy: number, gz: number;
              if (f < 2) { // ±x faces: tangents are y and z
                ex = nx; ey = ny + ax; ez = nz;
                fx2 = nx; fy2 = ny; fz2 = nz + az;
                gx = nx; gy = ny + ax; gz = nz + az;
              } else if (f < 4) { // ±y faces: tangents are x and z
                ex = nx + ax; ey = ny; ez = nz;
                fx2 = nx; fy2 = ny; fz2 = nz + az;
                gx = nx + ax; gy = ny; gz = nz + az;
              } else { // ±z faces: tangents are x and y
                ex = nx + ax; ey = ny; ez = nz;
                fx2 = nx; fy2 = ny + az; fz2 = nz;
                gx = nx + ax; gy = ny + az; gz = nz;
              }
              const cells = [[nx, ny, nz], [ex, ey, ez], [fx2, fy2, fz2], [gx, gy, gz]];
              let sumS = 0, sumB = 0, opq = 0;
              const opqFlags = [0, 0, 0, 0];
              for (let ci = 0; ci < 4; ci++) {
                const cxx = cells[ci][0], cyy = cells[ci][1], czz = cells[ci][2];
                const bid = getBlockG(cxx, cyy, czz);
                const isOpq = bid === 255 || (bid !== 0 && IS_OPAQUE[bid]);
                opqFlags[ci] = isOpq ? 1 : 0;
                if (isOpq) { opq++; continue; }
                const l = getLightG(cxx, cyy, czz);
                sumS += (l >> 4); sumB += (l & 15);
              }
              if (opq === 4) { sumS = 0; sumB = 0; }
              const s1 = opqFlags[1], s2 = opqFlags[2];
              ao = (s1 && s2) ? 0 : 3 - (s1 + s2 + opqFlags[3]);
              if (opq === 4) ao = 0;
              sky = sumS / (4 * 15); blk = sumB / (4 * 15);
            } else {
              const l = getLightG(nx, ny, nz);
              sky = (l >> 4) / 15; blk = (l & 15) / 15;
              if (render === 2 || isLava(id)) { // fluids: slight self-glow so they never go pitch black
                sky = Math.max(sky, 0.25); blk = Math.max(blk, isLava(id) ? 1.0 : 0.05);
              }
            }
            skyA[vi] = sky; blkA[vi] = blk; aoA[vi] = ao;
            const aoM = smooth ? aoVals[Math.max(0, Math.min(3, ao))] : 1;
            bucket.light.push(sky, blk);
            bucket.tint.push(tr * shade * aoM, tg * shade * aoM, tb * shade * aoM);
          }
          // flip quad diagonal for consistent AO interpolation
          if (aoA[0] + aoA[2] < aoA[1] + aoA[3]) {
            bucket.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base + 0);
          } else {
            bucket.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
        }
      }
    }
  }

  const out: MeshOut = {
    solid: solid.idx.length ? packBuf(solid) : null,
    cutout: cutout.idx.length ? packBuf(cutout) : null,
    trans: trans.idx.length ? packBuf(trans) : null,
  };
  return out;
}

function tileOfId(id: number, face: number): number {
  return TILE_TABLE[id * 6 + face];
}
// built at init from BLOCKS
import { BLOCKS } from './blocks';
const TILE_TABLE = new Uint8Array(256 * 6);
for (const blk of BLOCKS) {
  if (!blk) continue;
  for (let f = 0; f < 6; f++) TILE_TABLE[blk.id * 6 + f] = blk.tiles[f];
}

/// ---------------- edit + relight ----------------

/**
 * Apply a block change. `record=true` persists the edit in the save file;
 * fluid-sim updates pass false so saves stay small.
 * If `touched` is provided, remeshing is left to the caller.
 */
function applyEdit(wx: number, wy: number, wz: number, newId: number, record = true, touchedIn?: Set<number>): Set<number> {
  const touched = touchedIn || new Set<number>();
  const cx = wx >> 4, cz = wz >> 4;
  const c = getChunk(cx, cz);
  if (!c || wy < 0 || wy >= WORLD_HEIGHT) return touched;
  const lx = wx & 15, lz = wz & 15;
  const i = vidx(lx, wy, lz);
  const oldId = c.blocks[i];
  if (oldId === newId) return touched;
  c.blocks[i] = newId;
  touched.add(chunkKey(cx, cz));

  if (record) {
    let em = edits.get(chunkKey(cx, cz));
    if (!em) { em = new Map(); edits.set(chunkKey(cx, cz), em); }
    em.set(i, newId);
  }

  // ---- sky channel ----
  const changed: number[] = [], oldVals: number[] = [];
  relightColumn(cx, cz, lx, lz, changed, oldVals);
  const addSeeds: number[] = [];
  for (let k = 0; k < changed.length; k++) {
    const ii = changed[k];
    const oldL = oldVals[k] >> 4;
    const y = ii >> 8;
    const curSky = c.light[ii] >> 4;
    if (oldL > curSky) {
      // decreased: full removal pass from this cell
      removeLightBFS(0, wx, y, wz, oldL, touched, addSeeds);
      // restore this cell's own (reduced) value
      const now = getLightG(wx, y, wz);
      setLightG(wx, y, wz, (now & 0x0f) | (curSky << 4), touched);
      if (curSky > 0) addSeeds.push(wx, y, wz);
    } else if (curSky > oldL) {
      addSeeds.push(wx, y, wz);
    }
  }
  addLightBFS(0, addSeeds, touched);

  // ---- block channel ----
  const oldEmit = EMIT[oldId], newEmit = EMIT[newId];
  const oldStored = c.light[i] & 15;
  const bAdd: number[] = [];
  if (oldStored > 0) {
    removeLightBFS(1, wx, wy, wz, oldStored, touched, bAdd);
  }
  if (newEmit > 0) {
    const now = getLightG(wx, wy, wz);
    setLightG(wx, wy, wz, (now & 0xf0) | newEmit, touched);
    bAdd.push(wx, wy, wz);
  } else {
    // cell may receive light from neighbors now (e.g. block removed)
    let best = 0;
    for (let d = 0; d < 6; d++) {
      const nx = wx + DIRS[d][0], ny = wy + DIRS[d][1], nz = wz + DIRS[d][2];
      const nl = getLightG(nx, ny, nz) & 15;
      const att = Math.max(1, OPACITY[newId]);
      best = Math.max(best, nl - att);
    }
    if (best > 0) {
      const now = getLightG(wx, wy, wz);
      setLightG(wx, wy, wz, (now & 0xf0) | best, touched);
      bAdd.push(wx, wy, wz);
    }
  }
  addLightBFS(1, bAdd, touched);

  // neighbors of the edited chunk need remesh too (face culling / AO)
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      if (getChunk(cx + dx, cz + dz)) touched.add(chunkKey(cx + dx, cz + dz));

  // wake up fluids around the change
  for (let d = 0; d < 6; d++) {
    const nx = wx + DIRS[d][0], ny = wy + DIRS[d][1], nz = wz + DIRS[d][2];
    const nid = getBlockG(nx, ny, nz);
    if (isFluid(nid)) scheduleFluid(nx, ny, nz);
  }
  if (isFluid(newId)) scheduleFluid(wx, wy, wz);

  return touched;
}

/// ---------------- messaging ----------------

function postChunk(c: Chunk, type: 'chunk' | 'mesh'): void {
  const m = meshChunk(c);
  const payload: Record<string, unknown> = { t: type, cx: c.cx, cz: c.cz };
  const transfers: ArrayBuffer[] = [];
  // always ship the authoritative block+light arrays so the main
  // thread's physics/raycast/placement see fluid-simmed changes
  payload.blocks = c.blocks.slice().buffer;
  payload.light = c.light.slice().buffer;
  transfers.push(payload.blocks as ArrayBuffer, payload.light as ArrayBuffer);
  if (type === 'chunk') {
    payload.biomes = c.biomes.slice().buffer;
    payload.heights = c.heights.slice().buffer;
    transfers.push(payload.biomes as ArrayBuffer, payload.heights as ArrayBuffer);
  }
  for (const [name, g] of [['solid', m.solid], ['cutout', m.cutout], ['trans', m.trans]] as const) {
    if (g) {
      payload[name] = {
        pos: g.pos.buffer as ArrayBuffer, uv: g.uv.buffer as ArrayBuffer, light: g.light.buffer as ArrayBuffer,
        tint: g.tint.buffer as ArrayBuffer, idx: g.idx.buffer as ArrayBuffer,
      };
      transfers.push(g.pos.buffer as ArrayBuffer, g.uv.buffer as ArrayBuffer, g.light.buffer as ArrayBuffer,
        g.tint.buffer as ArrayBuffer, g.idx.buffer as ArrayBuffer);
    } else {
      payload[name] = null;
    }
  }
  (self as unknown as Worker).postMessage(payload, transfers);
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'init': {
      seedNum = Math.floor(msg.seed) | 0 || 1337;
      terrain = new Perlin(seedNum);
      caveA = new Perlin(seedNum + 101);
      caveB = new Perlin(seedNum + 202);
      cheese = new Perlin(seedNum + 303);
      riverN = new Perlin(seedNum + 404);
      detailN = new Perlin(seedNum + 505);
      smoothLighting = !!msg.smooth;
      chunks.clear();
      fluidQueue.clear();
      if (msg.edits) {
        for (const k of Object.keys(msg.edits)) {
          const [cx, cz] = k.split(',').map(Number);
          const m = new Map<number, number>();
          const arr = msg.edits[k] as number[];
          for (let i = 0; i < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
          edits.set(chunkKey(cx, cz), m);
        }
      }
      (self as unknown as Worker).postMessage({ t: 'ready' });
      break;
    }
    case 'smooth': {
      smoothLighting = !!msg.on;
      break;
    }
    case 'gen': {
      const cx = msg.cx, cz = msg.cz;
      const key = chunkKey(cx, cz);
      if (chunks.has(key)) { postChunk(chunks.get(key)!, 'mesh'); break; }
      const c = generateChunk(cx, cz);
      chunks.set(key, c);
      const touched = new Set<number>();
      touched.add(key);
      computeInitialLight(c, touched);
      // neighbors must be remeshed (borders + light spill)
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const nc = getChunk(cx + dx, cz + dz);
          if (nc) touched.add(chunkKey(cx + dx, cz + dz));
        }
      for (const k of touched) {
        const tc = chunks.get(k);
        if (tc) postChunk(tc, k === key ? 'chunk' : 'mesh');
      }
      break;
    }
    case 'edit': {
      const touched = applyEdit(msg.x, msg.y, msg.z, msg.id, true);
      for (const k of touched) {
        const tc = chunks.get(k);
        if (tc) postChunk(tc, 'mesh');
      }
      break;
    }
    case 'tick': {
      tickFluids();
      break;
    }
    case 'unload': {
      chunks.delete(chunkKey(msg.cx, msg.cz));
      fluidQueue.delete(chunkKey(msg.cx, msg.cz));
      break;
    }
    case 'colinfo': {
      // biome/height query without generating chunks (debug + biome locator)
      const infos: Record<string, unknown>[] = [];
      const pts: [number, number][] = msg.pts;
      for (const [x, z] of pts) {
        const ii = columnInfo(x, z);
        infos.push({ x, z, h: ii.h, biome: ii.biome });
      }
      (self as unknown as Worker).postMessage({ t: 'colinfo', id: msg.id, infos });
      break;
    }
    case 'spawn': {
      // spiral out from origin for a dry, pleasant spawn column
      let sx = 0, sz = 0, sy = SEA_LEVEL + 2;
      let found = false;
      outer: for (let r = 0; r < 1024; r += 4) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const x = Math.round(Math.cos(ang) * r), z = Math.round(Math.sin(ang) * r);
          const info = columnInfo(x, z);
          if (info.h > SEA_LEVEL + 1 && (info.biome === BIOME.PLAINS || info.biome === BIOME.FOREST || info.biome === BIOME.FLOWER || info.biome === BIOME.BIRCH)) {
            sx = x; sz = z; sy = info.h + 2; found = true; break outer;
          }
        }
      }
      if (!found) {
        // fallback: any dry land
        outer2: for (let r = 0; r < 1024; r += 4) {
          for (let a = 0; a < 16; a++) {
            const ang = (a / 16) * Math.PI * 2;
            const x = Math.round(Math.cos(ang) * r), z = Math.round(Math.sin(ang) * r);
            const info = columnInfo(x, z);
            if (info.h > SEA_LEVEL + 1 && info.biome !== BIOME.OCEAN) { sx = x; sz = z; sy = info.h + 2; found = true; break outer2; }
          }
        }
      }
      (self as unknown as Worker).postMessage({ t: 'spawn', x: sx + 0.5, y: sy, z: sz + 0.5 });
      break;
    }
    case 'save': {
      const out: Record<string, number[]> = {};
      for (const [key, m] of edits) {
        if (m.size === 0) continue;
        const [cx, cz] = [Math.floor(key / 4096) - 2048, (key % 4096) - 2048];
        const arr: number[] = [];
        for (const [idx, id] of m) { arr.push(idx, id); }
        out[`${cx},${cz}`] = arr;
      }
      (self as unknown as Worker).postMessage({ t: 'saved', edits: out });
      break;
    }
  }
};
