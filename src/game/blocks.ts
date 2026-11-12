// ============================================================
// Voxelcraft — shared block registry (used by world worker
// AND renderer). Original voxel sandbox game.
// ============================================================

export const CHUNK = 16;
export const WORLD_HEIGHT = 128;
export const SEA_LEVEL = 62;

// Render block types
export const RB_SOLID = 0; // fully opaque cube
export const RB_CUTOUT = 1; // cube/plant with alpha-tested holes (leaves, torch, plants)
export const RB_WATER = 2; // translucent liquid
export const RB_GLASS = 3; // translucent cube (alpha blend, cull same-type faces)

export interface BlockDef {
  id: number;
  name: string;
  /** 0 = air-like, 1 = solid, 2 = liquid */
  solid: 0 | 1 | 2;
  /** render bucket */
  render: 0 | 1 | 2 | 3;
  /** blocks light fully */
  opaque: boolean;
  /** extra light attenuation for transparent blockers (leaves/water) */
  opacity: number;
  /** emits light 0..15 */
  emit: number;
  /** seconds to break by hand in survival */
  hardness: number;
  /** sound family */
  sound: 'grass' | 'stone' | 'wood' | 'sand' | 'glass' | 'snow' | 'wool' | 'liquid' | 'plant';
  /** atlas tile index per face: [+x, -x, +y(top), -y(bottom), +z, -z] */
  tiles: [number, number, number, number, number, number];
  /** tint applied to all faces */
  tint?: [number, number, number];
  /** cross-shaped billboard plant (two diagonal quads) */
  cross?: boolean;
  /** tinted by biome (grass tops, leaves, plants) */
  biomeTint?: boolean;
  /** shown in the creative palette */
  placeable?: boolean;
}

// ---- Atlas tile indices (procedurally painted in atlas.ts) ----
export const T = {
  grassTop: 0,
  grassSide: 1,
  dirt: 2,
  stone: 3,
  cobble: 4,
  planks: 5,
  logSide: 6,
  logTop: 7,
  birchSide: 8,
  birchTop: 9,
  spruceSide: 10,
  spruceTop: 11,
  leavesOak: 12,
  leavesBirch: 13,
  leavesSpruce: 14,
  sand: 15,
  sandstone: 16,
  sandstoneTop: 17,
  gravel: 18,
  water: 19,
  glass: 20,
  bricks: 21,
  coalOre: 22,
  ironOre: 23,
  goldOre: 24,
  diamondOre: 25,
  redstoneOre: 26,
  bedrock: 27,
  snow: 28,
  snowSide: 29,
  ice: 30,
  cactusSide: 31,
  cactusTop: 32,
  glowstone: 33,
  torch: 34,
  tallGrass: 35,
  poppy: 36,
  dandelion: 37,
  obsidian: 38,
  woolWhite: 39,
  woolRed: 40,
  woolOrange: 41,
  woolYellow: 42,
  woolGreen: 43,
  woolBlue: 44,
  woolPurple: 45,
  woolBlack: 46,
  bookshelf: 47,
  workbenchTop: 48,
  workbenchSide: 49,
  pumpkinSide: 50,
  pumpkinTop: 51,
  mossy: 52,
  clay: 53,
  lava: 54,
  lapisOre: 55,
  jungleLeaves: 56,
  sugarCane: 57,
} as const;

function b(
  id: number,
  name: string,
  opts: Partial<BlockDef> & { tiles: BlockDef['tiles'] }
): BlockDef {
  return {
    id,
    name,
    solid: 1,
    render: RB_SOLID,
    opaque: true,
    opacity: 15,
    emit: 0,
    hardness: 0.75,
    sound: 'stone',
    placeable: true,
    ...opts,
  };
}

const A = (t: number): BlockDef['tiles'] => [t, t, t, t, t, t];

export const BLOCKS: BlockDef[] = [
  b(0, 'Air', { tiles: A(0), solid: 0, opaque: false, opacity: 0, placeable: false, hardness: 0 }),
  b(1, 'Stone', { tiles: A(T.stone), hardness: 2.2 }),
  b(2, 'Grass Block', { tiles: [T.grassSide, T.grassSide, T.grassTop, T.dirt, T.grassSide, T.grassSide], biomeTint: true, sound: 'grass', hardness: 0.9 }),
  b(3, 'Dirt', { tiles: A(T.dirt), sound: 'grass', hardness: 0.75 }),
  b(4, 'Cobblestone', { tiles: A(T.cobble), hardness: 2.5 }),
  b(5, 'Oak Planks', { tiles: A(T.planks), sound: 'wood', hardness: 1.5 }),
  b(6, 'Sand', { tiles: A(T.sand), sound: 'sand', hardness: 0.7 }),
  b(7, 'Gravel', { tiles: A(T.gravel), sound: 'sand', hardness: 0.8 }),
  b(8, 'Oak Log', { tiles: [T.logSide, T.logSide, T.logTop, T.logTop, T.logSide, T.logSide], sound: 'wood', hardness: 1.6 }),
  b(9, 'Oak Leaves', { tiles: A(T.leavesOak), render: RB_CUTOUT, opaque: false, opacity: 1, biomeTint: true, sound: 'plant', hardness: 0.3 }),
  b(10, 'Water', { tiles: A(T.water), solid: 2, render: RB_WATER, opaque: false, opacity: 2, placeable: false, hardness: 0, sound: 'liquid' }),
  b(11, 'Glass', { tiles: A(T.glass), render: RB_GLASS, opaque: false, opacity: 0, sound: 'glass', hardness: 0.4 }),
  b(12, 'Coal Ore', { tiles: A(T.coalOre), hardness: 3 }),
  b(13, 'Iron Ore', { tiles: A(T.ironOre), hardness: 3.5 }),
  b(14, 'Gold Ore', { tiles: A(T.goldOre), hardness: 3.5 }),
  b(15, 'Diamond Ore', { tiles: A(T.diamondOre), hardness: 4.5 }),
  b(16, 'Redstone Ore', { tiles: A(T.redstoneOre), hardness: 4 }),
  b(17, 'Bedrock', { tiles: A(T.bedrock), hardness: 1e9, placeable: true }),
  b(18, 'Snowy Grass', { tiles: [T.snowSide, T.snowSide, T.snow, T.dirt, T.snowSide, T.snowSide], sound: 'snow', hardness: 0.8 }),
  b(19, 'Ice', { tiles: A(T.ice), render: RB_GLASS, opaque: false, opacity: 2, sound: 'glass', hardness: 0.6 }),
  b(20, 'Cactus', { tiles: [T.cactusSide, T.cactusSide, T.cactusTop, T.cactusTop, T.cactusSide, T.cactusSide], sound: 'plant', hardness: 0.6 }),
  b(21, 'Sandstone', { tiles: [T.sandstone, T.sandstone, T.sandstoneTop, T.sandstoneTop, T.sandstone, T.sandstone], hardness: 2 }),
  b(22, 'Birch Log', { tiles: [T.birchSide, T.birchSide, T.birchTop, T.birchTop, T.birchSide, T.birchSide], sound: 'wood', hardness: 1.6 }),
  b(23, 'Birch Leaves', { tiles: A(T.leavesBirch), render: RB_CUTOUT, opaque: false, opacity: 1, sound: 'plant', hardness: 0.3 }),
  b(24, 'Spruce Log', { tiles: [T.spruceSide, T.spruceSide, T.spruceTop, T.spruceTop, T.spruceSide, T.spruceSide], sound: 'wood', hardness: 1.6 }),
  b(25, 'Spruce Leaves', { tiles: A(T.leavesSpruce), render: RB_CUTOUT, opaque: false, opacity: 1, biomeTint: true, sound: 'plant', hardness: 0.3 }),
  b(26, 'Glowstone', { tiles: A(T.glowstone), emit: 15, sound: 'glass', hardness: 0.5 }),
  b(27, 'Torch', { tiles: A(T.torch), render: RB_CUTOUT, cross: true, opaque: false, opacity: 0, emit: 14, sound: 'wood', hardness: 0.05 }),
  b(28, 'Tall Grass', { tiles: A(T.tallGrass), render: RB_CUTOUT, cross: true, solid: 0, opaque: false, opacity: 0, biomeTint: true, sound: 'plant', hardness: 0.05 }),
  b(29, 'Poppy', { tiles: A(T.poppy), render: RB_CUTOUT, cross: true, solid: 0, opaque: false, opacity: 0, sound: 'plant', hardness: 0.05 }),
  b(30, 'Dandelion', { tiles: A(T.dandelion), render: RB_CUTOUT, cross: true, solid: 0, opaque: false, opacity: 0, sound: 'plant', hardness: 0.05 }),
  b(31, 'Bricks', { tiles: A(T.bricks), hardness: 2.5 }),
  b(32, 'Obsidian', { tiles: A(T.obsidian), hardness: 12 }),
  b(33, 'White Wool', { tiles: A(T.woolWhite), sound: 'wool', hardness: 0.9 }),
  b(34, 'Red Wool', { tiles: A(T.woolRed), sound: 'wool', hardness: 0.9 }),
  b(35, 'Orange Wool', { tiles: A(T.woolOrange), sound: 'wool', hardness: 0.9 }),
  b(36, 'Yellow Wool', { tiles: A(T.woolYellow), sound: 'wool', hardness: 0.9 }),
  b(37, 'Green Wool', { tiles: A(T.woolGreen), sound: 'wool', hardness: 0.9 }),
  b(38, 'Blue Wool', { tiles: A(T.woolBlue), sound: 'wool', hardness: 0.9 }),
  b(39, 'Purple Wool', { tiles: A(T.woolPurple), sound: 'wool', hardness: 0.9 }),
  b(40, 'Black Wool', { tiles: A(T.woolBlack), sound: 'wool', hardness: 0.9 }),
  b(41, 'Bookshelf', { tiles: [T.bookshelf, T.bookshelf, T.planks, T.planks, T.bookshelf, T.bookshelf], sound: 'wood', hardness: 1.8 }),
  b(42, 'Crafting Bench', { tiles: [T.workbenchSide, T.workbenchSide, T.workbenchTop, T.planks, T.workbenchSide, T.workbenchSide], sound: 'wood', hardness: 1.8 }),
  b(43, 'Pumpkin', { tiles: [T.pumpkinSide, T.pumpkinSide, T.pumpkinTop, T.pumpkinTop, T.pumpkinSide, T.pumpkinSide], sound: 'wood', hardness: 1.2 }),
  b(44, 'Mossy Cobblestone', { tiles: A(T.mossy), hardness: 2.5 }),
  b(45, 'Clay', { tiles: A(T.clay), sound: 'sand', hardness: 0.8 }),
  b(57, 'Lapis Lazuli Ore', { tiles: A(T.lapisOre), hardness: 3.2 }),
  b(58, 'Jungle Leaves', { tiles: A(T.jungleLeaves), render: RB_CUTOUT, opaque: false, opacity: 1, sound: 'plant', hardness: 0.3 }),
  b(59, 'Snow Block', { tiles: A(T.snow), sound: 'snow', hardness: 0.5 }),
  b(60, 'Sugar Cane', { tiles: A(T.sugarCane), render: RB_CUTOUT, cross: true, solid: 0, opaque: false, opacity: 0, sound: 'plant', hardness: 0.05 }),
];

// ---- Fluids: Minecraft-style 8-level liquids ----
// Water: id 10 = source (level 0). Flowing water levels 1..7 = ids 46..52.
// Lava: id 53 = source. Flowing lava levels 1..3 = ids 54..56.
// Level 1 is closest to a source, 7 is the dry edge.
export const WATER = 10;
export const LAVA = 53;
export const WATER_FLOW_BASE = 46; // ids 46..52 → levels 1..7
export const LAVA_FLOW_BASE = 54;  // ids 54..56 → levels 1..3

for (let lv = 1; lv <= 7; lv++) {
  BLOCKS[46 + lv - 1] = b(45 + lv, `Water`, {
    tiles: A(T.water), solid: 2, render: RB_WATER, opaque: false, opacity: 2,
    placeable: false, hardness: 0, sound: 'liquid',
  });
}
BLOCKS[53] = b(53, 'Lava', {
  tiles: A(T.lava), solid: 2, render: RB_WATER, opaque: false, opacity: 3,
  emit: 15, placeable: false, hardness: 0, sound: 'liquid',
});
for (let lv = 1; lv <= 3; lv++) {
  BLOCKS[54 + lv - 1] = b(53 + lv, `Lava`, {
    tiles: A(T.lava), solid: 2, render: RB_WATER, opaque: false, opacity: 3,
    emit: 15, placeable: false, hardness: 0, sound: 'liquid',
  });
}

export const AIR = 0;
export const BEDROCK = 17;

/** true for source + all flowing levels of water */
export function isWater(id: number): boolean {
  return id === WATER || (id >= WATER_FLOW_BASE && id < WATER_FLOW_BASE + 7);
}
/** true for source + all flowing levels of lava */
export function isLava(id: number): boolean {
  return id === LAVA || (id >= LAVA_FLOW_BASE && id < LAVA_FLOW_BASE + 3);
}
export function isFluid(id: number): boolean {
  return isWater(id) || isLava(id);
}
/** fluid level: 0 = source, 1..7 flowing, -1 not a fluid */
export function fluidLevel(id: number): number {
  if (id === WATER || id === LAVA) return 0;
  if (id >= WATER_FLOW_BASE && id < WATER_FLOW_BASE + 7) return id - WATER_FLOW_BASE + 1;
  if (id >= LAVA_FLOW_BASE && id < LAVA_FLOW_BASE + 3) return id - LAVA_FLOW_BASE + 1;
  return -1;
}
/** block id for flowing fluid of the given level */
export function flowId(sourceId: number, level: number): number {
  return sourceId === WATER ? WATER_FLOW_BASE + level - 1 : LAVA_FLOW_BASE + level - 1;
}
/** max horizontal spread level (7 for water, 3 for lava) */
export function fluidMaxLevel(sourceId: number): number {
  return sourceId === WATER ? 7 : 3;
}

/** Fast lookup arrays for hot paths */
export const IS_OPAQUE = new Uint8Array(256);
export const IS_SOLID = new Uint8Array(256); // for collision (1 solid cube, 2 liquid)
export const OPACITY = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const RENDER = new Uint8Array(256);
export const CROSS = new Uint8Array(256);
export const HARDNESS = new Float32Array(256);
export const PLACEABLE = new Uint8Array(256);
export const SOUND_OF = new Array(256).fill('stone');
export const NAME_OF = new Array(256).fill('Unknown');

for (const blk of BLOCKS) {
  if (!blk) continue;
  IS_OPAQUE[blk.id] = blk.opaque ? 1 : 0;
  IS_SOLID[blk.id] = blk.solid;
  OPACITY[blk.id] = blk.opacity;
  EMIT[blk.id] = blk.emit;
  RENDER[blk.id] = blk.render;
  CROSS[blk.id] = blk.cross ? 1 : 0;
  HARDNESS[blk.id] = blk.hardness;
  PLACEABLE[blk.id] = blk.placeable ? 1 : 0;
  SOUND_OF[blk.id] = blk.sound;
  NAME_OF[blk.id] = blk.name;
}

/** Blocks available in the creative palette, in display order */
export const PALETTE: number[] = BLOCKS.filter((x) => x.placeable && x.id !== 0).map((x) => x.id);

export const DEFAULT_HOTBAR = [2, 3, 1, 5, 8, 11, 26, 27, 4];

/** Numeric chunk key from chunk coords (limited to ±2048 chunk range) */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 2048) * 4096 + (cz + 2048);
}
export function keyToCXZ(key: number): [number, number] {
  const cz = (key % 4096) - 2048;
  const cx = Math.floor(key / 4096) - 2048;
  return [cx, cz];
}

/** Flat voxel index inside a chunk */
export function vidx(x: number, y: number, z: number): number {
  return (y << 8) | (z << 4) | x;
}

// ---- Texture atlas layout (must match atlas.ts painter) ----
export const ATLAS_GRID = 16; // 16x16 tiles
export const ATLAS_TILE = 16; // core tile pixels
export const ATLAS_PAD = 8; // edge-extend padding around each tile
export const ATLAS_CELL = ATLAS_TILE + ATLAS_PAD * 2; // 32px cell
export const ATLAS_SIZE = ATLAS_GRID * ATLAS_CELL; // 512px

/** UV rect [u0, v0, u1, v1] for a tile index, half-texel inset, flipY-aware */
export function uvRect(tile: number): [number, number, number, number] {
  const col = tile % ATLAS_GRID;
  const row = Math.floor(tile / ATLAS_GRID);
  const S = ATLAS_SIZE;
  const x0 = col * ATLAS_CELL + ATLAS_PAD + 0.5;
  const y0 = row * ATLAS_CELL + ATLAS_PAD + 0.5; // from top of canvas
  const w = ATLAS_TILE - 1;
  // canvas is flipped vertically when uploaded (three.js flipY)
  const u0 = x0 / S;
  const u1 = (x0 + w) / S;
  const v1 = 1 - y0 / S;
  const v0 = 1 - (y0 + w) / S;
  return [u0, v0, u1, v1];
}
