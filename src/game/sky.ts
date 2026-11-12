// ============================================================
// Voxelcraft — sky: gradient dome, sun & moon, stars, clouds,
// fog color, full day/night cycle. Original implementation.
// ============================================================

import * as THREE from 'three';

const DAY_LENGTH = 1200; // seconds = 20 minutes

function radialTexture(inner: string, outer: string, size = 64): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FS = `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 sunDir;
uniform float glowStrength;
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, -1.0, 1.0);
  float t = pow(max(0.0, 1.0 - h), 1.6);
  vec3 col = mix(topColor, horizonColor, t);
  float sunAmt = pow(max(0.0, dot(normalize(vDir), normalize(sunDir))), 8.0);
  col += horizonColor * sunAmt * glowStrength;
  // below horizon: darker haze
  if (h < 0.0) col *= 1.0 + h * 0.55;
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkySystem {
  group = new THREE.Group();
  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private celestial = new THREE.Group();
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh | null = null;
  private cloudMat: THREE.MeshBasicMaterial;
  private cloudMode: 'fancy' | 'fast' | 'off' = 'fancy';
  private cloudSeed = 777;
  private cloudSpan = 48 * 12;

  /** time of day 0..1 (0 = dawn) */
  time = 0.05;
  dayFactor = 1;      // 1 noon, 0 midnight
  sunsetFactor = 0;   // 1 when sun near horizon
  weather: 'clear' | 'rain' | 'thunder' = 'clear';
  fogColor = new THREE.Color(0xbcd8ff);
  skyZenith = new THREE.Color(0x5f9ae8);
  skyHorizon = new THREE.Color(0xbcd8ff);

  constructor(scene: THREE.Scene) {
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: this.skyZenith },
        horizonColor: { value: this.skyHorizon },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        glowStrength: { value: 0.4 },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(640, 20, 14), this.domeMat);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // celestial bodies
    const sunTex = radialTexture('rgba(255,252,230,1)', 'rgba(255,220,120,0)');
    const moonTex = radialTexture('rgba(230,236,255,1)', 'rgba(190,200,230,0)');
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(110, 110),
      new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
    );
    this.sun.position.set(0, 560, 0);
    this.sun.rotation.x = Math.PI / 2; // face down toward world
    this.sun.renderOrder = -90;
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
    );
    this.moon.position.set(0, -560, 0);
    this.moon.rotation.x = -Math.PI / 2;
    this.moon.renderOrder = -90;
    this.celestial.add(this.sun, this.moon);
    this.group.add(this.celestial);

    // stars
    const starCount = 700;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // random on sphere
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = 590 * r * Math.cos(a);
      pos[i * 3 + 1] = 590 * u;
      pos[i * 3 + 2] = 590 * r * Math.sin(a);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xcfd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -95;
    this.celestial.add(this.stars);

    this.cloudMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false, fog: false,
      side: THREE.DoubleSide,
    });

    scene.add(this.group);
    this.rebuildClouds('fancy');
  }

  setCloudMode(mode: 'fancy' | 'fast' | 'off'): void {
    if (mode === this.cloudMode) return;
    this.cloudMode = mode;
    this.rebuildClouds(mode);
  }

  private rebuildClouds(mode: 'fancy' | 'fast' | 'off'): void {
    if (this.clouds) {
      this.group.remove(this.clouds);
      this.clouds.geometry.dispose();
      this.clouds = null;
    }
    if (mode === 'off') return;
    const N = 48, CELL = 12, Y = 132;
    const positions: number[] = [];
    const indices: number[] = [];
    const at = (i: number, j: number): boolean => {
      const s = Math.sin(i * 127.1 + j * 311.7 + this.cloudSeed) * 43758.5453;
      const h = s - Math.floor(s);
      const s2 = Math.sin(i * 269.5 + j * 183.3 + this.cloudSeed * 1.7) * 24634.6345;
      const h2 = s2 - Math.floor(s2);
      return h > 0.42 && h2 > 0.32;
    };
    const pushQuad = (v: number[]) => {
      const base = positions.length / 3;
      for (const p of v) positions.push(p);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (!at(i, j)) continue;
        const x = i * CELL, z = j * CELL;
        if (mode === 'fast') {
          pushQuad([x, Y, z, x + CELL, Y, z, x + CELL, Y, z + CELL, x, Y, z + CELL]);
        } else {
          const H = 4;
          // top
          pushQuad([x, Y + H, z, x + CELL, Y + H, z, x + CELL, Y + H, z + CELL, x, Y + H, z + CELL]);
          // bottom
          pushQuad([x, Y, z + CELL, x + CELL, Y, z + CELL, x + CELL, Y, z, x, Y, z]);
          // sides
          if (!at(i + 1, j)) pushQuad([x + CELL, Y, z, x + CELL, Y, z + CELL, x + CELL, Y + H, z + CELL, x + CELL, Y + H, z]);
          if (!at(i - 1, j)) pushQuad([x, Y, z + CELL, x, Y, z, x, Y + H, z, x, Y + H, z + CELL]);
          if (!at(i, j + 1)) pushQuad([x + CELL, Y, z + CELL, x, Y, z + CELL, x, Y + H, z + CELL, x + CELL, Y + H, z + CELL]);
          if (!at(i, j - 1)) pushQuad([x, Y, z, x + CELL, Y, z, x + CELL, Y + H, z, x, Y + H, z]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.clouds.renderOrder = 10;
    this.clouds.frustumCulled = false;
    this.group.add(this.clouds);
  }

  /** update; camX/camZ to anchor sky to camera */
  update(dt: number, camX: number, camY: number, camZ: number, underwater: boolean): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    const ang = this.time * Math.PI * 2; // 0 = sunrise
    // sun direction: rises in +x, sets in -x
    const sunY = Math.sin(ang), sunX = Math.cos(ang);
    this.celestial.rotation.z = -(ang - Math.PI / 2); // rotate so sun starts east
    // day factor from sun height
    const h = sunY;
    const day = THREE.MathUtils.clamp((h + 0.12) / 0.35, 0, 1);
    this.dayFactor = day * day * (3 - 2 * day);
    const sunset = THREE.MathUtils.clamp(1 - Math.abs(h) / 0.28, 0, 1) * THREE.MathUtils.clamp((h + 0.4) / 0.5, 0, 1);
    this.sunsetFactor = sunset;

    // colors
    const dayZen = new THREE.Color(0x69a4ee), dayHor = new THREE.Color(0xbcd8ff);
    const nightZen = new THREE.Color(0x020610), nightHor = new THREE.Color(0x0a1224);
    const setHor = new THREE.Color(0xf2a45c), setZen = new THREE.Color(0x3a5a9c);
    const zen = nightZen.clone().lerp(dayZen, this.dayFactor).lerp(setZen, sunset * 0.45);
    const hor = nightHor.clone().lerp(dayHor, this.dayFactor).lerp(setHor, sunset * 0.75);
    // storm darkening
    if (this.weather !== 'clear') {
      const stormZen = new THREE.Color(0x39424f), stormHor = new THREE.Color(0x4d565f);
      const w = this.weather === 'thunder' ? 0.78 : 0.6;
      zen.lerp(stormZen, w * Math.max(this.dayFactor, 0.25));
      hor.lerp(stormHor, w * Math.max(this.dayFactor, 0.25));
    }
    if (underwater) {
      zen.setRGB(0.03, 0.12, 0.22);
      hor.setRGB(0.05, 0.18, 0.3);
    }
    this.skyZenith.copy(zen);
    this.skyHorizon.copy(hor);
    this.fogColor.copy(hor);
    this.domeMat.uniforms.sunDir.value.set(sunX, sunY, 0.25).normalize();
    this.domeMat.uniforms.glowStrength.value = 0.25 + sunset * 0.8;
    this.starMat.opacity = (1 - this.dayFactor) * 0.9;
    this.cloudMat.opacity = 0.22 + this.dayFactor * 0.5;

    // anchor to camera (grid-snapped for clouds so they feel infinite)
    this.group.position.set(camX, 0, camZ);
    this.dome.position.y = camY;
    this.celestial.position.y = camY;
    if (this.clouds) {
      const span = this.cloudSpan;
      const drift = (performance.now() * 0.0004) % span;
      this.clouds.position.set(
        Math.floor(camX / span) * span - span / 2 + drift,
        0,
        Math.floor(camZ / span) * span - span / 2
      );
    }
  }

  /** multiply sun brightness for terrain lighting */
  get sunIntensity(): number {
    const rain = this.weather !== 'clear' ? 0.72 : 1;
    return (0.08 + this.dayFactor * 0.92) * rain;
  }
}
