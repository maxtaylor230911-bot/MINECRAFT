// ============================================================
// Voxelcraft — player entity: AABB physics tuned to match
// Minecraft Java movement values, walk/sprint/sneak/swim/fly,
// fall damage, drowning, lava damage. All original code.
// ============================================================

import { IS_SOLID, SOUND_OF, AIR, WATER, WORLD_HEIGHT } from './blocks';

export interface InputState {
  fwd: boolean; back: boolean; left: boolean; right: boolean;
  jump: boolean; sneak: boolean; sprint: boolean;
}

export interface WorldForPhysics {
  getBlock(x: number, y: number, z: number): number;
  chunkLoaded(x: number, z: number): boolean;
}

const HALF_W = 0.3;
const HEIGHT = 1.8;
const EYE = 1.62;
const EYE_SNEAK = 1.32;

// ---- Minecraft Java Edition movement values (blocks/sec) ----
const WALK = 4.317;
const SPRINT = 5.612;
const SNEAK = 1.295;
const FLY = 10.92;
const FLY_SPRINT = 21.78;
const SWIM = 2.2;

// MC gravity: 0.08 blocks/tick² with *0.98 drag per tick
const GRAV = 32;            // 0.08 * 20 * 20
const AIR_DRAG = 0.98;      // per-tick vertical drag factor
const MAX_FALL = 78.4;      // terminal velocity ≈ 3.92 b/tick
const JUMP_V = 8.7;         // tuned so continuous integration gives MC's 1.25-block jump
const JUMP_BOOST_SPRINT = 2.5; // sprint-jump forward kick (capped, no runaway)

// response rates (exponential smoothing k, per second)
const K_GROUND = 22;   // near-instant MC ground control
const K_AIR = 3.4;     // MC air control is weak on purpose
const K_WATER = 5.5;
const K_FLY = 7.5;

export type DeathCause = 'fall' | 'drown' | 'lava' | 'void' | 'generic';

export class Player {
  x = 0; y = 80; z = 0;
  vx = 0; vy = 0; vz = 0;
  yaw = 0; pitch = 0;
  onGround = false;
  flying = false;
  sneaking = false;
  sprinting = false;
  inWater = false;
  headInWater = false;
  inLava = false;
  headInLava = false;
  health = 20;
  air = 15;              // 15 bubbles = MC 300 ticks
  dead = false;
  fallDist = 0;
  wasOnGround = true;
  bobPhase = 0;
  bobAmp = 0;
  timeSinceDamage = 99;
  mode: 'creative' | 'survival' = 'survival';
  autoJump = false;
  deathCause: DeathCause = 'generic';

  onStep: ((family: string) => void) | null = null;
  onLand: ((fallBlocks: number) => void) | null = null;
  onDamage: ((cause: DeathCause) => void) | null = null;
  onSplash: (() => void) | null = null;
  onDeath: ((cause: DeathCause) => void) | null = null;

  private stepDist = 0;
  private eyeSmooth = EYE;
  private lavaTimer = 0;

  get eyeHeight(): number { return this.eyeSmooth; }

  eyePos(out: { x: number; y: number; z: number }): void {
    out.x = this.x; out.y = this.y + this.eyeHeight; out.z = this.z;
  }

  private collides(px: number, py: number, pz: number, w: WorldForPhysics): boolean {
    const x0 = Math.floor(px - HALF_W), x1 = Math.floor(px + HALF_W);
    const y0 = Math.floor(py), y1 = Math.floor(py + HEIGHT - 0.001);
    const z0 = Math.floor(pz - HALF_W), z1 = Math.floor(pz + HALF_W);
    for (let y = y0; y <= y1; y++) {
      if (y < 0) return true;
      if (y >= WORLD_HEIGHT) continue;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const id = w.getBlock(x, y, z);
          if (IS_SOLID[id] === 1) return true;
        }
    }
    return false;
  }

  private hasGroundBelow(px: number, py: number, pz: number, w: WorldForPhysics): boolean {
    const y = Math.floor(py - 0.06);
    const x0 = Math.floor(px - HALF_W), x1 = Math.floor(px + HALF_W);
    const z0 = Math.floor(pz - HALF_W), z1 = Math.floor(pz + HALF_W);
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const id = w.getBlock(x, y, z);
        if (IS_SOLID[id] === 1) return true;
      }
    return false;
  }

  update(dt: number, input: InputState, w: WorldForPhysics): void {
    if (this.dead) return;
    this.timeSinceDamage += dt;

    // fluid checks
    const wasInWater = this.inWater;
    const fx = Math.floor(this.x), fz = Math.floor(this.z);
    const feetId = w.getBlock(fx, Math.floor(this.y + 0.2), fz);
    const headId = w.getBlock(fx, Math.floor(this.y + this.eyeHeight), fz);
    this.inWater = feetId === WATER || headId === WATER;
    this.headInWater = headId === WATER;
    this.inLava = IS_SOLID[feetId] === 2 && feetId !== WATER || IS_SOLID[headId] === 2 && headId !== WATER;
    this.headInLava = IS_SOLID[headId] === 2 && headId !== WATER;
    if (this.inWater && !wasInWater && this.vy < -4) this.onSplash?.();

    this.sneaking = input.sneak && !this.flying;
    const moving = input.fwd || input.back || input.left || input.right;
    const wantSprint = input.sprint && moving;
    this.sprinting = wantSprint && !this.sneaking;

    // horizontal target speed
    let speed = this.flying ? (wantSprint ? FLY_SPRINT : FLY)
      : this.inWater ? SWIM
        : this.sneaking ? SNEAK
          : wantSprint ? SPRINT : WALK;
    if (this.mode === 'survival' && this.flying) this.flying = false;

    // direction in world space
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let mx = 0, mz = 0;
    if (input.fwd) { mx -= sin; mz -= cos; }
    if (input.back) { mx += sin; mz += cos; }
    if (input.left) { mx -= cos; mz += sin; }
    if (input.right) { mx += cos; mz -= sin; }
    const ml = Math.hypot(mx, mz);
    if (ml > 0) { mx /= ml; mz /= ml; }

    // smooth acceleration — snappy ground, weak air (MC feel)
    const k = this.flying ? K_FLY : this.inWater ? K_WATER : this.onGround ? K_GROUND : K_AIR;
    const a = 1 - Math.exp(-k * dt);
    this.vx += (mx * speed - this.vx) * a;
    this.vz += (mz * speed - this.vz) * a;

    // vertical
    if (this.flying) {
      const vt = input.jump ? 8.2 : input.sneak ? -8.2 : 0;
      this.vy += (vt - this.vy) * (1 - Math.exp(-9 * dt));
      this.fallDist = 0;
    } else if (this.inWater || this.inLava) {
      // MC water physics: mild gravity, jump key swims up, strong damping
      this.vy -= (this.inLava ? 9 : 5.5) * dt;
      if (input.jump) this.vy = Math.min(this.vy + 26 * dt, this.inLava ? 2.2 : 3.1);
      if (input.sneak) this.vy = Math.max(this.vy - 18 * dt, -3.6);
      this.vy = Math.max(this.vy, this.inLava ? -1.6 : -2.6);
      this.vy *= 1 - Math.min(1, (this.inLava ? 3.4 : 2.6) * dt);
      this.fallDist = 0;
    } else {
      // MC gravity with per-tick air drag: vy = (vy - 32dt) * 0.98^(20dt)
      this.vy = (this.vy - GRAV * dt) * Math.pow(AIR_DRAG, dt * 20);
      if (this.vy < -MAX_FALL) this.vy = -MAX_FALL;
      if (input.jump && this.onGround) {
        this.vy = JUMP_V;
        this.onGround = false;
        // MC sprint-jump: forward kick in LOOK direction, absolute not
        // multiplicative (multiplying caused the fake-flight oscillation)
        if (this.sprinting) {
          const b = JUMP_BOOST_SPRINT;
          this.vx += -sin * b;
          this.vz += -cos * b;
          const hs = Math.hypot(this.vx, this.vz);
          const cap = SPRINT * 1.65;
          if (hs > cap) { this.vx = this.vx / hs * cap; this.vz = this.vz / hs * cap; }
        }
      }
    }

    // integrate per-axis with collision (substepped to avoid tunneling)
    const wasOnGround = this.onGround;
    this.onGround = false;

    const moveAxis = (axis: 'x' | 'y' | 'z', delta: number): number => {
      if (delta === 0) return axis === 'x' ? this.x : axis === 'y' ? this.y : this.z;
      const start = axis === 'x' ? this.x : axis === 'y' ? this.y : this.z;
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.4));
      let cur = start;
      for (let i = 1; i <= steps; i++) {
        const t = start + (delta * i) / steps;
        const px = axis === 'x' ? t : this.x;
        const py = axis === 'y' ? t : this.y;
        const pz = axis === 'z' ? t : this.z;
        if (this.collides(px, py, pz, w)) break;
        cur = t;
      }
      return cur;
    };

    // X
    let nx = moveAxis('x', this.vx * dt);
    if (nx === this.x && this.vx !== 0) {
      if (this.autoJump && wasOnGround && !this.flying && !this.inWater &&
        !this.collides(nx, this.y + 1.02, this.z, w)) {
        this.vy = JUMP_V;
      } else {
        this.vx = 0;
      }
    }
    if (this.sneaking && wasOnGround && !this.flying) {
      if (!this.hasGroundBelow(nx, this.y, this.z, w)) { nx = this.x; this.vx = 0; }
    }
    this.x = nx;

    // Z
    let nz = moveAxis('z', this.vz * dt);
    if (nz === this.z && this.vz !== 0) {
      if (this.autoJump && wasOnGround && !this.flying && !this.inWater &&
        !this.collides(this.x, this.y + 1.02, nz, w)) {
        this.vy = JUMP_V;
      } else {
        this.vz = 0;
      }
    }
    if (this.sneaking && wasOnGround && !this.flying) {
      if (!this.hasGroundBelow(this.x, this.y, nz, w)) { nz = this.z; this.vz = 0; }
    }
    this.z = nz;

    // Y
    const dy = this.vy * dt;
    const ny = moveAxis('y', dy);
    const landed = dy < 0 && ny === this.y && dy !== 0;
    const bonked = dy > 0 && ny === this.y && dy !== 0;
    if (landed) {
      this.onGround = true;
      const fall = this.fallDist;
      this.fallDist = 0;
      if (!wasOnGround && fall > 0.8) {
        const groundId = w.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z));
        this.onStep?.(SOUND_OF[groundId] || 'stone');
        this.onLand?.(fall);
      }
      this.vy = 0;
    } else if (bonked) {
      this.vy = 0;
    } else {
      if (this.vy < -0.1) this.fallDist += -dy;
      else if (this.vy > 0.5 || this.inWater || this.flying) this.fallDist = 0;
    }
    this.y = ny;
    if (!this.onGround && Math.abs(this.vy) < 0.01 && !this.flying && !this.inWater) {
      if (this.collides(this.x, this.y - 0.04, this.z, w)) this.onGround = true;
    }

    // smooth eye height when sneaking (MC does a fast lerp)
    const eyeTarget = this.sneaking ? EYE_SNEAK : EYE;
    this.eyeSmooth += (eyeTarget - this.eyeSmooth) * Math.min(1, dt * 14);

    // step sounds + bobbing
    const hSpeed = Math.hypot(this.vx, this.vz);
    if (this.onGround && hSpeed > 0.5) {
      this.stepDist += hSpeed * dt;
      this.bobPhase += hSpeed * dt * 1.6;
      this.bobAmp = Math.min(1, this.bobAmp + dt * 6);
      if (this.stepDist > 2.1) {
        this.stepDist = 0;
        const groundId = w.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z));
        if (groundId !== AIR) this.onStep?.(SOUND_OF[groundId] || 'stone');
      }
    } else {
      this.bobAmp = Math.max(0, this.bobAmp - dt * 6);
    }

    // lava damage (survival) — MC burns fast
    if (this.inLava && this.mode === 'survival') {
      this.lavaTimer -= dt;
      if (this.lavaTimer <= 0) { this.lavaTimer = 0.5; this.damage(3, 'lava'); }
    } else {
      this.lavaTimer = 0;
    }

    // drowning — 15s of air, then 1 damage per second (MC values)
    if (this.headInWater && this.mode === 'survival') {
      this.air -= dt;
      if (this.air < 0) {
        this.air = 0;
        this.drownTimer -= dt;
        if (this.drownTimer <= 0) { this.drownTimer = 1; this.damage(2, 'drown'); }
      }
    } else {
      this.air = Math.min(15, this.air + dt * 6);
      this.drownTimer = 0.5;
    }

    // regen (peaceful-style fast regen keeps solo play fun)
    if (this.mode === 'survival' && this.health > 0 && this.health < 20 && this.timeSinceDamage > 4) {
      this.health = Math.min(20, this.health + dt * 0.8);
    }

    // fell out of the world
    if (this.y < -12) this.damage(10 * dt, 'void');
  }

  private drownTimer = 0.5;

  damage(hp: number, cause: DeathCause = 'generic'): void {
    if (this.dead || this.mode === 'creative') return;
    if (hp <= 0) return;
    this.health -= hp;
    this.timeSinceDamage = 0;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.deathCause = cause;
      this.onDeath?.(cause);
    } else {
      this.onDamage?.(cause);
    }
  }

  landDamage(fallBlocks: number): void {
    const dmg = Math.floor(fallBlocks - 3);
    if (dmg > 0) {
      this.damage(dmg, 'fall');
    }
  }

  respawn(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z;
    this.vx = this.vy = this.vz = 0;
    this.health = 20; this.air = 15; this.dead = false;
    this.fallDist = 0; this.flying = false;
  }

  serialize(): { x: number; y: number; z: number; yaw: number; pitch: number; health: number } {
    return { x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch, health: this.health };
  }
  deserialize(d: { x: number; y: number; z: number; yaw: number; pitch: number; health: number }): void {
    this.x = d.x; this.y = d.y; this.z = d.z; this.yaw = d.yaw; this.pitch = d.pitch;
    this.health = typeof d.health === 'number' ? d.health : 20;
  }
}
