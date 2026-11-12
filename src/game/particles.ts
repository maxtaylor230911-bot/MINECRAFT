// ============================================================
// Voxelcraft — block break / place particles. Original code.
// ============================================================

import * as THREE from 'three';

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  life: number;
  maxLife: number;
}

export class ParticleSystem {
  private bursts: Burst[] = [];
  private group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** multiplier: all=1, decreased=0.4, minimal=0.15 */
  setScale(s: number): void {
    this.scale = s;
  }
  private scale = 1;

  // ---------------- rain ----------------

  private rain: THREE.LineSegments | null = null;
  private rainPos: Float32Array | null = null;
  private readonly RAIN_COUNT = 420;
  private readonly RAIN_BOX = 30; // horizontal span around camera
  private readonly RAIN_TOP = 14; // spawn height above camera
  private readonly RAIN_BOT = -16; // despawn below camera

  setRain(on: boolean): void {
    if (on && !this.rain) {
      const n = this.RAIN_COUNT;
      const pos = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        const x = (Math.random() - 0.5) * this.RAIN_BOX;
        const y = Math.random() * (this.RAIN_TOP - this.RAIN_BOT) + this.RAIN_BOT;
        const z = (Math.random() - 0.5) * this.RAIN_BOX;
        pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
        pos[i * 6 + 3] = x - 0.06; pos[i * 6 + 4] = y + 0.5; pos[i * 6 + 5] = z - 0.02;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x9db8d6, transparent: true, opacity: 0.34, depthWrite: false, fog: false,
      });
      this.rain = new THREE.LineSegments(geo, mat);
      this.rain.frustumCulled = false;
      this.rain.renderOrder = 40;
      this.rainPos = pos;
      this.group.add(this.rain);
    } else if (!on && this.rain) {
      this.group.remove(this.rain);
      this.rain.geometry.dispose();
      (this.rain.material as THREE.Material).dispose();
      this.rain = null;
      this.rainPos = null;
    }
  }

  private updateRain(dt: number, cam: { x: number; y: number; z: number }): void {
    if (!this.rain || !this.rainPos) return;
    const arr = this.rainPos;
    const fall = 23 * dt, drift = 2.2 * dt;
    for (let i = 0; i < this.RAIN_COUNT; i++) {
      const o = i * 6;
      arr[o] += drift; arr[o + 1] -= fall; arr[o + 2] += drift * 0.4;
      arr[o + 3] = arr[o] - 0.06; arr[o + 4] = arr[o + 1] + 0.5; arr[o + 5] = arr[o + 2] - 0.02;
      if (arr[o + 1] < cam.y + this.RAIN_BOT) {
        const x = (Math.random() - 0.5) * this.RAIN_BOX;
        const z = (Math.random() - 0.5) * this.RAIN_BOX;
        const y = cam.y + this.RAIN_TOP * (0.7 + Math.random() * 0.3);
        arr[o] = x; arr[o + 1] = y; arr[o + 2] = z;
        arr[o + 3] = x - 0.06; arr[o + 4] = y + 0.5; arr[o + 5] = z - 0.02;
      } else if (Math.abs(arr[o] - cam.x) > this.RAIN_BOX / 2 || Math.abs(arr[o + 2] - cam.z) > this.RAIN_BOX / 2) {
        // keep the storm around the player
        const x = cam.x + (Math.random() - 0.5) * this.RAIN_BOX;
        const z = cam.z + (Math.random() - 0.5) * this.RAIN_BOX;
        const y = cam.y + this.RAIN_TOP * (0.5 + Math.random() * 0.5);
        arr[o] = x; arr[o + 1] = y; arr[o + 2] = z;
        arr[o + 3] = x - 0.06; arr[o + 4] = y + 0.5; arr[o + 5] = z - 0.02;
      }
    }
    (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  spawnBlockBreak(x: number, y: number, z: number, color: [number, number, number], count: number): void {
    const n = Math.max(1, Math.round(count * this.scale));
    if (n <= 0 || count === 0) return;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = x + 0.15 + Math.random() * 0.7;
      pos[i * 3 + 1] = y + 0.15 + Math.random() * 0.7;
      pos[i * 3 + 2] = z + 0.15 + Math.random() * 0.7;
      vel[i * 3] = (Math.random() - 0.5) * 3.2;
      vel[i * 3 + 1] = 1.5 + Math.random() * 3;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
      const v = 0.75 + Math.random() * 0.5;
      cols[i * 3] = (color[0] / 255) * v;
      cols[i * 3 + 1] = (color[1] / 255) * v;
      cols[i * 3 + 2] = (color[2] / 255) * v;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.PointsMaterial({ size: 0.14, vertexColors: true, sizeAttenuation: true });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.bursts.push({ points: pts, vel, life: 0, maxLife: 0.7 + Math.random() * 0.25 });
  }

  update(dt: number, camX?: number, camY?: number, camZ?: number): void {
    if (this.rain && camX !== undefined) {
      this.updateRain(dt, { x: camX, y: camY || 0, z: camZ || 0 });
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life += dt;
      if (b.life >= b.maxLife) {
        this.group.remove(b.points);
        b.points.geometry.dispose();
        (b.points.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      const arr = (b.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let j = 0; j < arr.length; j += 3) {
        b.vel[j + 1] -= 13 * dt;
        arr[j] += b.vel[j] * dt;
        arr[j + 1] += b.vel[j + 1] * dt;
        arr[j + 2] += b.vel[j + 2] * dt;
        // crude floor collision
        if (b.vel[j + 1] < 0 && Math.random() < 0.5) { b.vel[j + 1] *= -0.3; }
      }
      (b.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const fade = 1 - b.life / b.maxLife;
      (b.points.material as THREE.PointsMaterial).opacity = fade;
      (b.points.material as THREE.PointsMaterial).transparent = true;
    }
  }

  dispose(): void {
    this.setRain(false);
    for (const b of this.bursts) {
      this.group.remove(b.points);
      b.points.geometry.dispose();
      (b.points.material as THREE.Material).dispose();
    }
    this.bursts = [];
  }
}
