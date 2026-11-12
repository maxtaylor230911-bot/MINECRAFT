// ============================================================
// Voxelcraft — dropped item entities: spinning, bobbing block
// cubes with gravity + pickup magnetism (Minecraft-style).
// All original code.
// ============================================================

import * as THREE from 'three';
import { BLOCKS, ATLAS_SIZE, uvRect, isFluid } from './blocks';

export interface Drop {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  pickupDelay: number;
  mesh: THREE.Mesh;
}

const DROP_SIZE = 0.26;
const MAX_DROPS = 90;
const DESPAWN = 300; // seconds

/** Build a small textured cube (or cross plane) geometry for a block id. */
export function dropGeometry(id: number): THREE.BufferGeometry {
  const def = BLOCKS[id];
  const geo = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const S = DROP_SIZE / 2;
  if (def && def.cross) {
    // flat sprite quad
    const u = uvRect(def.tiles[0]);
    const quad = (v: number[][]) => {
      const base = pos.length / 3;
      for (const p of v) pos.push(p[0], p[1], p[2]);
      uv.push(u[0], u[1], u[2], u[1], u[2], u[3], u[0], u[3]);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([[-S, -S, 0], [S, -S, 0], [S, S, 0], [-S, S, 0]]);
    quad([[S, -S, 0], [-S, -S, 0], [-S, S, 0], [S, S, 0]]);
  } else {
    const tiles = def ? def.tiles : [3, 3, 3, 3, 3, 3];
    // [+x, -x, +y(top), -y(bottom), +z, -z] faces
    const faces: { n: [number, number, number]; corners: [number, number, number][]; t: number }[] = [
      { n: [1, 0, 0], corners: [[S, -S, -S], [S, -S, S], [S, S, S], [S, S, -S]], t: tiles[0] },
      { n: [-1, 0, 0], corners: [[-S, -S, S], [-S, -S, -S], [-S, S, -S], [-S, S, S]], t: tiles[1] },
      { n: [0, 1, 0], corners: [[-S, S, S], [S, S, S], [S, S, -S], [-S, S, -S]], t: tiles[2] },
      { n: [0, -1, 0], corners: [[-S, -S, -S], [S, -S, -S], [S, -S, S], [-S, -S, S]], t: tiles[3] },
      { n: [0, 0, 1], corners: [[-S, -S, S], [S, -S, S], [S, S, S], [-S, S, S]], t: tiles[4] },
      { n: [0, 0, -1], corners: [[S, -S, -S], [-S, -S, -S], [-S, S, -S], [S, S, -S]], t: tiles[5] },
    ];
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const f of faces) {
      const u = uvRect(f.t);
      const base = pos.length / 3;
      for (let i = 0; i < 4; i++) {
        const c = f.corners[i];
        pos.push(c[0], c[1], c[2]);
        uv.push(u[0] + (u[2] - u[0]) * uvs[i][0], u[1] + (u[3] - u[1]) * uvs[i][1]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

interface WorldLike {
  getBlock(x: number, y: number, z: number): number;
}

export class DropManager {
  drops: Drop[] = [];
  private group = new THREE.Group();
  private matBase: THREE.MeshBasicMaterial;
  private geoCache = new Map<number, THREE.BufferGeometry>();

  constructor(scene: THREE.Scene, atlasTex: THREE.Texture) {
    scene.add(this.group);
    this.matBase = new THREE.MeshBasicMaterial({ map: atlasTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
  }

  private geoFor(id: number): THREE.BufferGeometry {
    let g = this.geoCache.get(id);
    if (!g) { g = dropGeometry(id); this.geoCache.set(id, g); }
    return g;
  }

  get count(): number { return this.drops.length; }

  spawn(id: number, x: number, y: number, z: number, spread = 0.12, delay = 0.5, vx = 0, vy = 2.4, vz = 0): void {
    if (id <= 0 || isFluid(id)) return;
    if (this.drops.length >= MAX_DROPS) {
      const old = this.drops.shift();
      if (old) this.remove(old);
    }
    const mat = this.matBase.clone();
    const mesh = new THREE.Mesh(this.geoFor(id), mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.drops.push({
      id,
      x: x + (Math.random() - 0.5) * spread,
      y: y + (Math.random() - 0.5) * spread * 0.5,
      z: z + (Math.random() - 0.5) * spread,
      vx: vx !== 0 ? vx : (Math.random() - 0.5) * 1.6,
      vy,
      vz: vz !== 0 ? vz : (Math.random() - 0.5) * 1.6,
      age: 0,
      pickupDelay: delay,
      mesh,
    });
  }

  /** throw an item (Q key): flies in look direction */
  throwItem(id: number, ex: number, ey: number, ez: number, dx: number, dy: number, dz: number): void {
    if (id <= 0) return;
    if (this.drops.length >= MAX_DROPS) {
      const old = this.drops.shift();
      if (old) this.remove(old);
    }
    const mat = this.matBase.clone();
    const mesh = new THREE.Mesh(this.geoFor(id), mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.drops.push({
      id, x: ex, y: ey, z: ez,
      vx: dx, vy: dy, vz: dz,
      age: 0, pickupDelay: 1.5, mesh,
    });
  }

  private remove(d: Drop): void {
    this.group.remove(d.mesh);
    (d.mesh.material as THREE.Material).dispose();
  }

  /**
   * Physics + pickup. `collect` returns true if the item should despawn
   * (e.g. it was added to an inventory).
   */
  update(dt: number, player: { x: number; y: number; z: number }, world: WorldLike, collect: (id: number) => boolean, lightAt: (x: number, y: number, z: number) => number): void {
    const now = performance.now() * 0.001;
    // substep so a laggy frame can never tunnel through the floor
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const sdt = dt / steps;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.pickupDelay -= dt;
      if (d.age > DESPAWN || d.y < -12) {
        // despawned (expired or fell out of the world)
        this.remove(d);
        this.drops.splice(i, 1);
        continue;
      }
      for (let s = 0; s < steps; s++) {
        // physics
        d.vy -= 18 * sdt;
        if (d.vy < -30) d.vy = -30;
        const nx = d.x + d.vx * sdt;
        let ny = d.y + d.vy * sdt;
        const nz = d.z + d.vz * sdt;
        // ground collision (block under the drop)
        const feet = world.getBlock(Math.floor(nx), Math.floor(ny - DROP_SIZE / 2), Math.floor(nz));
        const solid = feet !== 0 && !isFluid(feet) && feet !== 255;
        if (solid && d.vy < 0) {
          ny = Math.floor(ny - DROP_SIZE / 2) + 1 + DROP_SIZE / 2;
          d.vy = 0;
          d.vx *= Math.max(0, 1 - 8 * sdt); // friction on ground
          d.vz *= Math.max(0, 1 - 8 * sdt);
        }
        // side collision (very cheap): just cancel horizontal move into solid
        const side = world.getBlock(Math.floor(nx), Math.floor(d.y), Math.floor(nz));
        if (side !== 0 && !isFluid(side) && side !== 255) {
          d.vx *= -0.2; d.vz *= -0.2;
        } else {
          d.x = nx; d.z = nz;
        }
        d.y = ny;
        // horizontal drift damping in air
        d.vx *= Math.max(0, 1 - 0.6 * sdt);
        d.vz *= Math.max(0, 1 - 0.6 * sdt);
      }

      // pickup magnet + collect
      const pdx = player.x - d.x, pdy = (player.y + 0.9) - d.y, pdz = player.z - d.z;
      const dist = Math.hypot(pdx, pdy, pdz);
      if (d.pickupDelay <= 0 && dist < 2.0) {
        if (dist < 0.75) {
          if (collect(d.id)) {
            this.remove(d);
            this.drops.splice(i, 1);
            continue;
          }
        } else {
          const pull = Math.min(1, 8 * dt / dist);
          d.x += pdx * pull; d.y += pdy * pull; d.z += pdz * pull;
        }
      }

      // visuals: spin + bob + local light tint
      d.mesh.position.set(d.x, d.y + Math.sin(now * 2 + i * 1.3) * 0.045, d.z);
      d.mesh.rotation.y = now * 1.4 + i;
      const l = lightAt(Math.floor(d.x), Math.floor(d.y), Math.floor(d.z));
      const lum = 0.25 + 0.75 * Math.max((l >> 4) / 15, (l & 15) / 15);
      (d.mesh.material as THREE.MeshBasicMaterial).color.setRGB(lum, lum, lum);
    }
  }

  clear(): void {
    for (const d of this.drops) this.remove(d);
    this.drops = [];
  }

  dispose(): void {
    this.clear();
    for (const g of this.geoCache.values()) g.dispose();
    this.geoCache.clear();
  }
}

// avoid unused import warning for ATLAS_SIZE (kept for future atlas use)
void ATLAS_SIZE;
