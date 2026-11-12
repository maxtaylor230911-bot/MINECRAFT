// ============================================================
// Voxelcraft — main engine: renderer, chunk streaming, custom
// terrain shaders, input, block interaction, game loop.
// All original code.
// ============================================================

import * as THREE from 'three';
import { CHUNK, WORLD_HEIGHT, chunkKey, IS_SOLID, CROSS, RENDER, AIR, BLOCKS, HARDNESS, PLACEABLE, SOUND_OF, DEFAULT_HOTBAR, NAME_OF, isFluid } from './blocks';
import { buildAtlasCanvas, tileAvgColor, buildCrackCanvases, drawBlockIcon } from './atlas';
import { Player } from './player';
import { SkySystem } from './sky';
import { ParticleSystem } from './particles';
import { SoundEngine } from './sound';
import { DropManager, dropGeometry } from './drops';
import { useUI, useSettings, Settings, WorldMeta } from '../state/gameStore';

// ---------------- shaders ----------------

const TERRAIN_VS = `
attribute vec2 lightv;
attribute vec3 tintv;
varying vec2 vUv;
varying vec2 vLight;
varying vec3 vTint;
varying float vFogDepth;
void main() {
  vUv = uv;
  vLight = lightv;
  vTint = tintv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const TERRAIN_FS = `
uniform sampler2D map;
uniform float dayFactor;
uniform float brightness;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float alpha;
uniform float time;
varying vec2 vUv;
varying vec2 vLight;
varying vec3 vTint;
varying float vFogDepth;
void main() {
  vec2 uv2 = vUv;
  #ifdef WATER
  // BOUNDED wobble — never leaves the tile (the old unbounded
  // time*0.0011 drift eventually sampled the grass tiles!)
  uv2 += vec2(sin(time * 1.1) * 0.0011, sin(time * 0.73 + 1.7) * 0.0009);
  #endif
  vec4 tex = texture2D(map, uv2);
  #ifdef CUTOUT
  if (tex.a < 0.5) discard;
  #endif
  float sky = vLight.x * dayFactor;
  float L = max(sky, vLight.y);
  float lum = pow(L, 1.45) * 0.96 + 0.04;
  lum = clamp(lum + brightness * (1.0 - lum) * 0.5, 0.0, 1.0);
  vec3 col = tex.rgb * vTint * lum;
  float fogF = smoothstep(fogNear, fogFar, vFogDepth);
  col = mix(col, fogColor, fogF);
  #ifdef CUTOUT
  gl_FragColor = vec4(col, tex.a);
  #else
  gl_FragColor = vec4(col, alpha * tex.a);
  #endif
}`;

interface GeomData { pos: ArrayBuffer; uv: ArrayBuffer; light: ArrayBuffer; tint: ArrayBuffer; idx: ArrayBuffer; }

interface ChunkView {
  cx: number;
  cz: number;
  blocks: Uint8Array | null;
  light: Uint8Array | null;
  biomes: Uint8Array | null;
  meshes: { solid?: THREE.Mesh; cutout?: THREE.Mesh; trans?: THREE.Mesh };
}

export interface DebugInfo {
  fps: number;
  x: number; y: number; z: number;
  chunkX: number; chunkZ: number;
  facing: string;
  yaw: number; pitch: number;
  biome: string;
  lightFeet: number;
  dayTime: number;
  chunks: number;
  drawCalls: number;
  tris: number;
  mode: string;
  mem: number;
}

const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Plains', 'Mountains', 'Jungle', 'Taiga', 'Birch Forest', 'Swamp', 'Flower Plains'];

/** what a block drops when broken in survival (0 = nothing) */
const DROP_TABLE: Record<number, number> = {
  1: 4, // stone → cobblestone
  2: 3, // grass block → dirt
  18: 3, // snowy grass → dirt
  9: 0, 23: 0, 25: 0, 58: 0, // leaves
  11: 0, // glass shatters
  17: 0, // bedrock
};
const DEATH_MESSAGES: Record<string, string> = {
  fall: 'Player fell from a high place',
  drown: 'Player drowned',
  lava: 'Player tried to swim in lava',
  void: 'Player fell out of the world',
  generic: 'Player died',
};

export class Engine {
  // three
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  // systems
  player = new Player();
  sky: SkySystem;
  particles: ParticleSystem;
  sound = new SoundEngine();
  drops: DropManager;
  weather: 'clear' | 'rain' | 'thunder' = 'clear';
  // world
  worker: Worker;
  views = new Map<number, ChunkView>();
  pending = new Set<number>();
  seed = 0;
  mode: 'panorama' | 'game' | 'idle' = 'idle';
  worldMeta: WorldMeta | null = null;
  private savedEdits: Record<string, number[]> = {};
  // materials
  private atlasCanvas!: HTMLCanvasElement;
  private atlasTex!: THREE.CanvasTexture;
  private matSolid!: THREE.ShaderMaterial;
  private matCutout!: THREE.ShaderMaterial;
  private matWater!: THREE.ShaderMaterial;
  private uniforms!: Record<string, THREE.IUniform>;
  // interaction
  private outline: THREE.LineSegments;
  private crackMesh: THREE.Mesh;
  private crackTex: THREE.Texture[] = [];
  private breakTarget: { x: number; y: number; z: number } | null = null;
  private breakProgress = 0;
  private placeCooldown = 0;
  private creativeBreakTimer = 0;
  private digSoundTimer = 0;
  // input
  private keysDown = new Set<string>();
  private mouseL = false;
  private mouseR = false;
  private lastSpaceTap = 0;
  private lastWTap = 0;
  private sprintByDouble = false;
  // touch input (iPad / mobile)
  readonly isTouch: boolean = typeof window !== 'undefined' &&
    ((typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window);
  private touchMove = { x: 0, y: 0 };
  private touchJump = false;
  private touchSneak = false;
  private touchSprint = false;
  private touchBreak = false;
  private touchPlaceQ = false;
  private lastJumpTap = 0;
  input: { fwd: boolean; back: boolean; left: boolean; right: boolean; jump: boolean; sneak: boolean; sprint: boolean } = {
    fwd: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false,
  };
  // loop
  private running = false;
  private lastFrame = 0;
  private frameAcc = 0;
  private fpsEMA = 60;
  private rafId = 0;
  private timeoutId = 0;
  private renderCalls = 0;
  // misc
  private canvas: HTMLCanvasElement;
  private debug: DebugInfo = {
    fps: 0, x: 0, y: 0, z: 0, chunkX: 0, chunkZ: 0, facing: 'south', biome: '—', yaw: 0, pitch: 0,
    lightFeet: 15, dayTime: 0, chunks: 0, drawCalls: 0, tris: 0, mode: 'creative', mem: 0,
  };
  private lastChunkX = 1e9;
  private lastChunkZ = 1e9;
  private saveTimer = 0;
  private caveDroneTimer = 20;
  private tileAvg = new Map<number, [number, number, number]>();
  // fluids / weather / held item
  private fluidTimer = 0.25;
  private thunderTimer = 10;
  private heldGroup = new THREE.Group();
  private heldMesh: THREE.Mesh | null = null;
  private heldMat: THREE.MeshBasicMaterial | null = null;
  private heldId = -1;
  private swingT = 1;
  private heldLightTimer = 0;
  private unsubscribeSettings: () => void = () => {};
  private disposed = false;
  private panoramaAngle = 0;
  private wantedRenderDist = 8;
  underwater = false;
  paused = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x8cb8ff);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.08, 1400);

    this.sky = new SkySystem(this.scene);
    this.particles = new ParticleSystem(this.scene);

    this.buildMaterials();

    // dropped item entities
    this.drops = new DropManager(this.scene, this.atlasTex);

    // held item view model (child of camera, renders over the world)
    this.heldMat = new THREE.MeshBasicMaterial({
      map: this.atlasTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, depthTest: false,
    });
    this.heldGroup.visible = false;
    this.camera.add(this.heldGroup);
    this.scene.add(this.camera);

    // selection outline
    const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }));
    this.outline.visible = false;
    this.scene.add(this.outline);

    // crack overlay
    this.crackMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1.004, 1.004, 1.004),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    this.crackMesh.visible = false;
    this.scene.add(this.crackMesh);

    // worker
    this.worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (err) => {
      console.error('World worker error:', err.message || err);
    };

    this.bindEvents();
    this.crackTexturesInit();
    this.resize();
  }

  // ---------------- setup ----------------

  private buildMaterials(): void {
    this.atlasCanvas = buildAtlasCanvas();
    this.atlasTex = new THREE.CanvasTexture(this.atlasCanvas);
    this.atlasTex.magFilter = THREE.NearestFilter;
    this.atlasTex.wrapS = this.atlasTex.wrapT = THREE.ClampToEdgeWrapping;
    this.applyMipmap(4);

    // average tile colors for particles
    for (const blk of BLOCKS) {
      if (!blk || this.tileAvg.has(blk.tiles[2])) continue;
      this.tileAvg.set(blk.tiles[2], tileAvgColor(this.atlasCanvas, blk.tiles[2]));
    }

    this.uniforms = {
      map: { value: this.atlasTex },
      dayFactor: { value: 1 },
      brightness: { value: 0.5 },
      fogColor: { value: new THREE.Color(0xbcd8ff) },
      fogNear: { value: 40 },
      fogFar: { value: 120 },
      alpha: { value: 1 },
      time: { value: 0 },
    };
    const mk = (defines: Record<string, string>, transparent: boolean, alphaVal: number) => new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VS,
      fragmentShader: TERRAIN_FS,
      uniforms: { ...this.uniforms, alpha: { value: alphaVal } },
      defines,
      transparent,
      ...(transparent ? { depthWrite: false } : {}),
    });
    this.matSolid = mk({}, false, 1);
    this.matCutout = mk({ CUTOUT: '' }, false, 1);
    this.matWater = mk({ WATER: '' }, true, 0.78);
  }

  private applyMipmap(levels: number): void {
    const t = this.atlasTex;
    if (levels > 0) {
      t.generateMipmaps = true;
      t.minFilter = THREE.NearestMipmapLinearFilter;
    } else {
      t.generateMipmaps = false;
      t.minFilter = THREE.NearestFilter;
    }
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
  }

  // ---------------- lifecycle ----------------

  startPanorama(): void {
    this.mode = 'panorama';
    this.panoramaAngle = 0;
    this.initWorld(2024, {}, 'creative');
    this.player.x = 8; this.player.y = 90; this.player.z = 8;
    this.heldGroup.visible = false;
    this.drops.clear();
    this.running = true;
    this.paused = false;
    this.lastFrame = performance.now();
    this.scheduleFrame();
  }

  startWorld(meta: WorldMeta, saved: { edits: Record<string, number[]>; player?: { x: number; y: number; z: number; yaw: number; pitch: number; health: number }; time?: number; hotbar?: number[]; inv?: Record<number, number>; weather?: string }): void {
    this.mode = 'game';
    this.worldMeta = meta;
    this.savedEdits = saved.edits || {};
    this.initWorld(meta.seed, this.savedEdits, meta.mode);
    if (saved.player) {
      this.player.deserialize(saved.player);
    } else {
      // will be positioned on spawn message
      this.player.x = 0.5; this.player.y = WORLD_HEIGHT - 8; this.player.z = 0.5;
      this.needSpawn = true;
    }
    this.player.mode = meta.mode;
    this.sky.time = typeof saved.time === 'number' ? saved.time : 0.05;
    const ui = useUI.getState();
    this.drops.clear();
    this.swingT = 1;
    this.heldId = -1;
    this.heldGroup.visible = true;
    ui.set({ chatLog: [], inv: saved.inv ? { ...saved.inv } : {}, skyFlash: 0 });
    if (saved.hotbar && saved.hotbar.length === 9) ui.set({ hotbar: saved.hotbar });
    else ui.set({ hotbar: meta.mode === 'survival' ? [0, 0, 0, 0, 0, 0, 0, 0, 0] : [...DEFAULT_HOTBAR] });
    this.setWeather(saved.weather === 'rain' || saved.weather === 'thunder' ? saved.weather : 'clear');
    ui.addChat(`Welcome to Voxelcraft 1.2 — seed ${meta.seed}`, 'system');
    ui.addChat('T = chat · / = commands · Q = drop item · E = blocks', 'system');
    this.lastChunkX = 1e9;
    this.running = true;
    this.paused = false;
    this.lastFrame = performance.now();
    this.scheduleFrame();
  }

  private needSpawn = false;
  private spawnSent = false;

  private initWorld(seed: number, edits: Record<string, number[]>, mode: string): void {
    this.seed = seed;
    // clear existing views
    for (const [, v] of this.views) this.disposeView(v);
    this.views.clear();
    this.pending.clear();
    this.lastChunkX = 1e9;
    const s = useSettings.getState().settings;
    this.worker.postMessage({ t: 'init', seed, edits, smooth: s.smoothLighting });
    this.worker.postMessage({ t: 'spawn' });
    this.spawnSent = false;
    this.needSpawn = false;
    this.player.mode = mode as 'creative' | 'survival';
    void mode;
  }

  quitToTitle(): void {
    this.saveNow();
    this.mode = 'idle';
    this.running = false;
    this.paused = true;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.timeoutId);
    this.worker.postMessage({ t: 'init', seed: 1, edits: {}, smooth: true }); // stop further gen
    this.drops.clear();
    this.heldGroup.visible = false;
    this.setWeather('clear');
    for (const [, v] of this.views) this.disposeView(v);
    this.views.clear();
  }

  quitAndPanorama(): void {
    this.quitToTitle();
    // small delay then panorama
    setTimeout(() => { if (!this.disposed) this.startPanorama(); }, 60);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.timeoutId);
    this.unsubscribeSettings();
    this.unbindEvents();
    this.worker.terminate();
    this.sound.dispose();
    this.particles.dispose();
    this.drops.dispose();
    for (const [, v] of this.views) this.disposeView(v);
    this.views.clear();
    this.renderer.dispose();
  }

  // ---------------- worker protocol ----------------

  private onWorkerMessage(msg: Record<string, unknown>): void {
    const t = msg.t as string;
    if (t === 'ready') return;
    if (t === 'colinfo') {
      const cb = this.colinfoWaiters.get(msg.id as number);
      if (cb) { cb(msg.infos as { x: number; z: number; h: number; biome: number }[]); this.colinfoWaiters.delete(msg.id as number); }
      return;
    }
    if (t === 'spawn') {
      this.spawnPoint = { x: msg.x as number, y: msg.y as number, z: msg.z as number };
      if (this.needSpawn && this.mode === 'game') {
        this.player.x = msg.x as number;
        this.player.y = msg.y as number;
        this.player.z = msg.z as number;
        this.needSpawn = false;
      }
      return;
    }
    if (t === 'saved') {
      this.persistWorld(msg.edits as Record<string, number[]>);
      return;
    }
    if (t === 'chunk' || t === 'mesh') {
      const cx = msg.cx as number, cz = msg.cz as number;
      const key = chunkKey(cx, cz);
      let view = this.views.get(key);
      if (!view) {
        view = { cx, cz, blocks: null, light: null, biomes: null, meshes: {} };
        this.views.set(key, view);
      }
      this.pending.delete(key);
      if (t === 'chunk') {
        view.blocks = new Uint8Array(msg.blocks as ArrayBuffer);
        view.light = new Uint8Array(msg.light as ArrayBuffer);
        view.biomes = new Uint8Array(msg.biomes as ArrayBuffer);
      } else if (!view.blocks) {
        // mesh for unknown chunk — ignore
        return;
      }
      if (msg.blocks) view.blocks = new Uint8Array(msg.blocks as ArrayBuffer);
      if (msg.light) view.light = new Uint8Array(msg.light as ArrayBuffer);
      this.applyGeom(view, 'solid', msg.solid as GeomData | null);
      this.applyGeom(view, 'cutout', msg.cutout as GeomData | null);
      this.applyGeom(view, 'trans', msg.trans as GeomData | null);
      return;
    }
  }

  private applyGeom(view: ChunkView, bucket: 'solid' | 'cutout' | 'trans', data: GeomData | null): void {
    const existing = view.meshes[bucket];
    if (!data) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        delete view.meshes[bucket];
      }
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(data.pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(data.uv), 2));
    geo.setAttribute('lightv', new THREE.BufferAttribute(new Float32Array(data.light), 2));
    geo.setAttribute('tintv', new THREE.BufferAttribute(new Float32Array(data.tint), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(data.idx), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, WORLD_HEIGHT / 2, 8), 130);
    const mat = bucket === 'solid' ? this.matSolid : bucket === 'cutout' ? this.matCutout : this.matWater;
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(view.cx * CHUNK, 0, view.cz * CHUNK);
      mesh.renderOrder = bucket === 'trans' ? 5 : 0;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      view.meshes[bucket] = mesh;
    }
  }

  private disposeView(v: ChunkView): void {
    for (const k of ['solid', 'cutout', 'trans'] as const) {
      const m = v.meshes[k];
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
      }
    }
    this.worker.postMessage({ t: 'unload', cx: v.cx, cz: v.cz });
  }

  // ---------------- streaming ----------------

  private updateStreaming(px: number, pz: number): void {
    const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
    if (ccx === this.lastChunkX && ccz === this.lastChunkZ && this.pending.size < 160) return;
    this.lastChunkX = ccx; this.lastChunkZ = ccz;
    const rd = this.wantedRenderDist;
    const wanted: { key: number; cx: number; cz: number; d: number }[] = [];
    for (let dz = -rd; dz <= rd; dz++)
      for (let dx = -rd; dx <= rd; dx++) {
        const d = dx * dx + dz * dz;
        if (d > (rd + 0.5) * (rd + 0.5)) continue;
        const cx = ccx + dx, cz = ccz + dz;
        const key = chunkKey(cx, cz);
        if (this.views.has(key) || this.pending.has(key)) continue;
        wanted.push({ key, cx, cz, d });
      }
    wanted.sort((a, b) => a.d - b.d);
    for (const w of wanted) {
      if (this.pending.size >= 220) break;
      this.pending.add(w.key);
      this.worker.postMessage({ t: 'gen', cx: w.cx, cz: w.cz });
    }
    // unload far chunks
    const maxD = (rd + 3) * (rd + 3);
    for (const [key, v] of this.views) {
      const dx = v.cx - ccx, dz = v.cz - ccz;
      if (dx * dx + dz * dz > maxD) {
        this.disposeView(v);
        this.views.delete(key);
      }
    }
  }

  // ---------------- world access ----------------

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return 17; // bedrock
    if (y >= WORLD_HEIGHT) return AIR;
    const v = this.views.get(chunkKey(x >> 4, z >> 4));
    if (!v || !v.blocks) return 1; // unloaded treated as stone (solid barrier)
    return v.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  chunkLoaded(x: number, z: number): boolean {
    const v = this.views.get(chunkKey(x >> 4, z >> 4));
    return !!(v && v.blocks);
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 1 || y >= WORLD_HEIGHT) return;
    const v = this.views.get(chunkKey(x >> 4, z >> 4));
    if (v && v.blocks) v.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)] = id;
    this.worker.postMessage({ t: 'edit', x, y, z, id });
  }

  // ---------------- events ----------------

  private onResize = () => this.resize();
  private onKeyDown = (e: KeyboardEvent) => this.handleKey(e, true);
  private onKeyUp = (e: KeyboardEvent) => this.handleKey(e, false);
  private onMouseDown = (e: MouseEvent) => this.handleMouse(e, true);
  private onMouseUp = (e: MouseEvent) => this.handleMouse(e, false);
  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    const s = useSettings.getState().settings;
    const sens = 0.0023 * (s.sensitivity / 100);
    this.player.yaw -= e.movementX * sens;
    this.player.pitch += (s.invertY ? 1 : -1) * e.movementY * sens;
    const lim = Math.PI / 2 - 0.001;
    this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
  };
  private onWheel = (e: WheelEvent) => {
    if (useUI.getState().screen !== 'playing') return;
    const ui = useUI.getState();
    const dir = e.deltaY > 0 ? 1 : -1;
    ui.set({ selectedSlot: (ui.selectedSlot + dir + 9) % 9 });
  };
  private onLockChange = () => {
    if (this.isTouch) return;
    const ui = useUI.getState();
    if (document.pointerLockElement !== this.canvas) {
      if (!this.hadLock) return; // never actually had lock — ignore spurious events
      this.hadLock = false;
      this.keysDown.clear();
      this.mouseL = false;
      this.mouseR = false;
      if (ui.screen === 'playing') {
        ui.set({ screen: 'paused', pauseReason: null });
        this.paused = true;
      }
    } else {
      this.hadLock = true;
      this.lockFailed = false;
      this.paused = false;
      this.sound.ensure();
    }
  };
  private onContext = (e: Event) => e.preventDefault();
  private onLockError = () => {
    // pointer lock unavailable (sandboxed iframe, headless, kiosk) —
    // keep the game playable without mouse-look instead of soft-locking
    this.lockFailed = true;
  };
  private hadLock = false;
  lockFailed = false;
  private onCanvasClick = () => {
    const ui = useUI.getState();
    if (ui.screen === 'playing' && document.pointerLockElement !== this.canvas) {
      this.resumeLock();
    }
  };
  private onBeforeUnload = () => { if (this.mode === 'game') this.saveNow(); };

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    this.canvas.addEventListener('contextmenu', this.onContext);
    this.canvas.addEventListener('click', this.onCanvasClick);
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }
  private unbindEvents(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    this.canvas.removeEventListener('contextmenu', this.onContext);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  private handleKey(e: KeyboardEvent, down: boolean): void {
    const ui = useUI.getState();
    const s = useSettings.getState().settings;
    const code = e.code;

    // always track raw keys so nothing gets stuck
    if (down) this.keysDown.add(code);
    else this.keysDown.delete(code);

    // global function keys
    if (down && code === s.keys.toggleDebug && (ui.screen === 'playing' || ui.screen === 'paused')) {
      e.preventDefault();
      ui.set({ debugOpen: !ui.debugOpen });
      return;
    }
    if (down && code === s.keys.screenshot && ui.screen === 'playing') {
      e.preventDefault();
      void this.screenshot();
      return;
    }
    if (down && code === s.keys.toggleFullscreen && ui.screen !== 'options') {
      e.preventDefault();
      useSettings.getState().update('fullscreen', !s.fullscreen);
      return;
    }
    if (down && code === 'Escape') {
      if (ui.screen === 'paused') {
        ui.set({ screen: 'playing', pauseReason: null });
        this.resumeLock();
        return;
      }
    }
    if (ui.screen !== 'playing') return;

    if (down && !e.repeat && (code === 'KeyT' || code === 'Slash') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.openChat(code === 'Slash' ? '/' : '');
      return;
    }
    if (down && !e.repeat && code === 'KeyQ') {
      e.preventDefault();
      this.dropSelected();
      return;
    }
    if (down && code === s.keys.inventory) {
      e.preventDefault();
      ui.set({ screen: 'inventory' });
      document.exitPointerLock();
      this.sound.click();
      return;
    }
    if (down && code.startsWith('Digit')) {
      const n = parseInt(code.slice(5), 10);
      if (n >= 1 && n <= 9) ui.set({ selectedSlot: n - 1 });
    }
    if (down && !e.repeat && code === s.keys.jump) {
      const now = performance.now();
      if (now - this.lastSpaceTap < 280 && this.player.mode === 'creative') {
        this.player.flying = !this.player.flying;
        this.player.vy = 0;
        this.lastSpaceTap = 0;
      } else {
        this.lastSpaceTap = now;
      }
    }
    if (down && !e.repeat && code === s.keys.forward) {
      const now = performance.now();
      if (now - this.lastWTap < 280) this.sprintByDouble = true;
      this.lastWTap = now;
    }
    if (down && code === 'F5') e.preventDefault();
  }

  resumeLock(): void {
    if (this.isTouch) {
      // touch devices have no pointer lock — just unpause
      this.paused = false;
      this.sound.ensure();
      return;
    }
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* ignore */ }
  }

  // ---------------- touch API (used by TouchControls overlay) ----------------

  /** Analog joystick, x in [-1,1] (right/left), y in [-1,1] (back/forward). */
  setTouchMove(x: number, y: number): void {
    this.touchMove.x = x;
    this.touchMove.y = y;
  }

  setTouchKey(key: 'jump' | 'sneak' | 'sprint', down: boolean): void {
    if (key === 'jump') {
      this.touchJump = down;
      if (down) {
        // double-tap jump toggles flying in creative, same as keyboard
        const now = performance.now();
        if (now - this.lastJumpTap < 280 && this.player.mode === 'creative') {
          this.player.flying = !this.player.flying;
          this.player.vy = 0;
          this.lastJumpTap = 0;
        } else {
          this.lastJumpTap = now;
        }
      }
    } else if (key === 'sneak') {
      this.touchSneak = down;
    } else {
      this.touchSprint = down;
    }
  }

  /** Drag-to-look, in pixels. */
  touchLook(dx: number, dy: number): void {
    const s = useSettings.getState().settings;
    const sens = 0.0023 * (s.sensitivity / 100) * 2.4;
    this.player.yaw -= dx * sens;
    this.player.pitch += (s.invertY ? 1 : -1) * dy * sens;
    const lim = Math.PI / 2 - 0.001;
    this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
  }

  setTouchBreak(down: boolean): void {
    this.touchBreak = down;
    if (!down) {
      this.breakTarget = null;
      this.breakProgress = 0;
    }
  }

  /** Queue a single block placement (quick tap on the look area). */
  touchPlaceOnce(): void {
    this.touchPlaceQ = true;
    this.placeCooldown = 0; // taps always place immediately
  }

  /** Pause from a touch UI button (no pointer lock involved). */
  pauseGame(): void {
    this.paused = true;
    this.keysDown.clear();
    this.touchMove.x = 0;
    this.touchMove.y = 0;
    this.touchJump = false;
    this.touchSneak = false;
    this.touchSprint = false;
    this.touchBreak = false;
    this.touchPlaceQ = false;
    this.mouseL = false;
    this.mouseR = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private handleMouse(e: MouseEvent, down: boolean): void {
    const ui = useUI.getState();
    if (ui.screen !== 'playing') return;
    if (down && document.pointerLockElement !== this.canvas) return;
    const s = useSettings.getState().settings;
    if (e.button === 0) {
      this.mouseL = down;
      if (down) this.swingT = 0; // swing even at air, like MC
    }
    if (e.button === 2) {
      this.mouseR = down;
      // a fresh right-click always places instantly — no leftover cooldown
      if (down) this.placeCooldown = 0;
    }
    if (down && e.button === 1) {
      e.preventDefault();
      if (s.keys.pickBlock === 'MiddleClick') this.pickBlock();
    }
  }

  // ---------------- chat & commands ----------------

  private openChat(prefill: string): void {
    const ui = useUI.getState();
    ui.set({ screen: 'chat', chatDraft: prefill });
    this.keysDown.clear();
    this.mouseL = false;
    this.mouseR = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  closeChat(): void {
    const ui = useUI.getState();
    if (ui.screen === 'chat') ui.set({ screen: 'playing', chatDraft: '' });
    this.resumeLock();
  }

  submitChat(text: string): void {
    const ui = useUI.getState();
    ui.set({ screen: 'playing', chatDraft: '' });
    const t = text.trim();
    if (!t) {
      this.resumeLock();
      return;
    }
    if (t.startsWith('/')) {
      this.runCommand(t);
    } else {
      ui.addChat(`<Player> ${t}`, 'chat');
    }
    this.resumeLock();
  }

  private rel(s: string, cur: number): number {
    if (s === '~') return cur;
    if (s.startsWith('~')) return cur + (parseFloat(s.slice(1)) || 0);
    return parseFloat(s);
  }

  private findBlockId(name: string): number {
    const q = name.toLowerCase().replace(/_/g, ' ');
    if (/^\d+$/.test(q)) {
      const n = parseInt(q, 10);
      if (BLOCKS[n] && n !== 0 && !isFluid(n)) return n;
      return -1;
    }
    let exact = -1, part = -1;
    for (const b of BLOCKS) {
      if (!b || b.id === 0) continue;
      const nm = b.name.toLowerCase();
      if (nm === q) exact = b.id;
      else if (part < 0 && (nm.startsWith(q) || nm.replace(/ /g, '_') === q)) part = b.id;
    }
    return exact >= 0 ? exact : part;
  }

  private runCommand(raw: string): void {
    const ui = useUI.getState();
    const say = (t: string, kind: 'system' | 'error' = 'system') => ui.addChat(t, kind);
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const p = this.player;
    switch (cmd) {
      case 'help':
        say('/gamemode <creative|survival>');
        say('/time set <day|noon|sunset|night|midnight|sunrise|ticks>');
        say('/time add <ticks>');
        say('/tp <x> <y> <z>   (~ = relative)');
        say('/give <block> [count]');
        say('/weather <clear|rain|thunder>');
        say('/setblock <x> <y> <z> <block>');
        say('/seed · /kill · /spawnpoint · /clear');
        break;
      case 'gamemode': {
        const m = (parts[1] || '').toLowerCase();
        if (m === 'creative' || m === 'c' || m === '1') {
          p.mode = 'creative';
          say('Set own game mode to Creative Mode');
        } else if (m === 'survival' || m === 's' || m === '0') {
          p.mode = 'survival';
          p.flying = false;
          say('Set own game mode to Survival Mode');
        } else say('Usage: /gamemode <creative|survival>', 'error');
        break;
      }
      case 'time': {
        const sub = (parts[1] || '').toLowerCase();
        const map: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };
        if (sub === 'set') {
          const v = (parts[2] || '').toLowerCase();
          const ticks = v in map ? map[v] : parseInt(v, 10);
          if (Number.isFinite(ticks)) {
            this.sky.time = (((ticks / 24000) % 1) + 1) % 1;
            say(`Set the time to ${Math.floor(this.sky.time * 24000)}`);
          } else say('Usage: /time set <day|noon|night|midnight|ticks>', 'error');
        } else if (sub === 'add') {
          const ticks = parseInt(parts[2] || '', 10);
          if (Number.isFinite(ticks)) {
            this.sky.time = (((this.sky.time + ticks / 24000) % 1) + 1) % 1;
            say(`Added ${ticks} ticks to the time`);
          } else say('Usage: /time add <ticks>', 'error');
        } else say('Usage: /time set|add <value>', 'error');
        break;
      }
      case 'tp': {
        if (parts.length < 4) { say('Usage: /tp <x> <y> <z>', 'error'); break; }
        const rx = this.rel(parts[1], p.x), ry = this.rel(parts[2], p.y), rz = this.rel(parts[3], p.z);
        if (![rx, ry, rz].every(Number.isFinite)) { say('Invalid coordinates', 'error'); break; }
        p.x = rx; p.y = Math.min(WORLD_HEIGHT + 60, Math.max(-20, ry)); p.z = rz;
        p.vx = p.vy = p.vz = 0;
        p.fallDist = 0;
        say(`Teleported Player to ${rx.toFixed(1)} ${p.y.toFixed(1)} ${rz.toFixed(1)}`);
        break;
      }
      case 'give': {
        if (!parts[1]) { say('Usage: /give <block> [count]', 'error'); break; }
        const id = this.findBlockId(parts[1]);
        if (id < 0) { say(`Unknown block: ${parts[1]}`, 'error'); break; }
        const n = Math.max(1, Math.min(999, parseInt(parts[2] || '1', 10) || 1));
        if (p.mode === 'survival') ui.giveInv(id, n);
        const hotbar = [...ui.hotbar];
        hotbar[ui.selectedSlot] = id;
        useUI.getState().set({ hotbar });
        say(`Gave ${n} × ${NAME_OF[id]}`);
        break;
      }
      case 'weather': {
        const w = (parts[1] || '').toLowerCase();
        if (w === 'clear' || w === 'rain' || w === 'thunder') {
          this.setWeather(w);
          say(`Set the weather to ${w}`);
        } else say('Usage: /weather <clear|rain|thunder>', 'error');
        break;
      }
      case 'seed':
        say(`Seed: [${this.seed}]`);
        break;
      case 'kill':
        p.health = 0; p.dead = true; p.deathCause = 'generic';
        p.onDeath?.('generic');
        break;
      case 'spawnpoint':
        this.spawnPoint = { x: p.x, y: p.y, z: p.z };
        say(`Set spawn point to ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`);
        break;
      case 'setblock': {
        if (parts.length < 5) { say('Usage: /setblock <x> <y> <z> <block>', 'error'); break; }
        const x = this.rel(parts[1], p.x), y = this.rel(parts[2], p.y), z = this.rel(parts[3], p.z);
        const id = this.findBlockId(parts[4]);
        if (![x, y, z].every(Number.isFinite) || id < 0) { say('Invalid arguments', 'error'); break; }
        this.setBlock(Math.floor(x), Math.floor(y), Math.floor(z), id);
        say(`Placed ${NAME_OF[id]} at ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`);
        break;
      }
      case 'clear':
        useUI.getState().set({ inv: {} });
        say('Cleared inventory');
        break;
      default:
        say(`Unknown or incomplete command: /${cmd} — try /help`, 'error');
    }
  }

  setWeather(w: 'clear' | 'rain' | 'thunder'): void {
    this.weather = w;
    this.sky.weather = w;
    this.particles.setRain(w !== 'clear');
    this.sound.setRain(w === 'clear' ? 0 : w === 'rain' ? 0.65 : 1);
    this.thunderTimer = 4 + Math.random() * 10;
  }

  private pickBlock(): void {
    const hit = this.currentHit;
    if (!hit) return;
    const id = this.getBlock(hit.x, hit.y, hit.z);
    if (id === AIR || PLACEABLE[id] !== 1) return; // water etc. can't be picked
    const ui = useUI.getState();
    const hotbar = [...ui.hotbar];
    hotbar[ui.selectedSlot] = id;
    ui.set({ hotbar });
    this.sound.pop();
  }

  // ---------------- interaction ----------------

  private currentHit: { x: number; y: number; z: number; fx: number; fy: number; fz: number } | null = null;

  private raycast(): { x: number; y: number; z: number; fx: number; fy: number; fz: number } | null {
    const eye = { x: 0, y: 0, z: 0 };
    this.player.eyePos(eye);
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));
    let x = Math.floor(eye.x), y = Math.floor(eye.y), z = Math.floor(eye.z);
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-9)), tDeltaY = Math.abs(1 / (dir.y || 1e-9)), tDeltaZ = Math.abs(1 / (dir.z || 1e-9));
    let tMaxX = tDeltaX * (dir.x > 0 ? (x + 1 - eye.x) : (eye.x - x));
    let tMaxY = tDeltaY * (dir.y > 0 ? (y + 1 - eye.y) : (eye.y - y));
    let tMaxZ = tDeltaZ * (dir.z > 0 ? (z + 1 - eye.z) : (eye.z - z));
    let fx = 0, fy = 0, fz = 0;
    const maxDist = 4.5;
    for (let i = 0; i < 128; i++) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && !isFluid(id)) {
        return { x, y, z, fx, fy, fz };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (tMaxX > maxDist) break;
        x += stepX; tMaxX += tDeltaX; fx = -stepX; fy = 0; fz = 0;
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > maxDist) break;
        y += stepY; tMaxY += tDeltaY; fx = 0; fy = -stepY; fz = 0;
      } else {
        if (tMaxZ > maxDist) break;
        z += stepZ; tMaxZ += tDeltaZ; fx = 0; fy = 0; fz = -stepZ;
      }
    }
    return null;
  }

  private updateInteraction(dt: number): void {
    const ui = useUI.getState();
    if (this.mode !== 'game' || this.paused || this.player.dead || ui.screen !== 'playing') {
      this.outline.visible = false;
      this.crackMesh.visible = false;
      return;
    }
    const hit = this.raycast();
    this.currentHit = hit;
    if (hit) {
      this.outline.visible = true;
      this.outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      this.outline.visible = false;
    }

    const s = useSettings.getState().settings;
    const creative = this.player.mode === 'creative';
    const selectedId = ui.hotbar[ui.selectedSlot] ?? 0;

    // breaking
    const breaking = this.mouseL || this.touchBreak;
    if (breaking && hit) {
      const changed = !this.breakTarget || this.breakTarget.x !== hit.x || this.breakTarget.y !== hit.y || this.breakTarget.z !== hit.z;
      if (changed) {
        this.breakTarget = { x: hit.x, y: hit.y, z: hit.z };
        this.breakProgress = 0;
      }
      const id = this.getBlock(hit.x, hit.y, hit.z);
      const hard = creative ? 0.05 : Math.max(0.05, HARDNESS[id] || 0.5);
      this.breakProgress += dt / hard;
      this.digSoundTimer -= dt;
      if (this.digSoundTimer <= 0) {
        this.digSoundTimer = 0.22;
        this.sound.dig(SOUND_OF[id] as never, 0.9 + Math.random() * 0.2);
      }
      if (this.breakProgress >= 1) {
        this.destroyBlock(hit.x, hit.y, hit.z);
        // creative: instant break with a short pause between blocks
        this.breakProgress = creative ? -0.25 : 0;
        this.breakTarget = null;
      }
    } else {
      this.breakTarget = null;
      this.breakProgress = 0;
    }

    // crack overlay
    if (this.breakTarget && this.breakProgress > 0.02 && !creative) {
      const stage = Math.min(9, Math.floor(this.breakProgress * 10));
      this.crackMesh.visible = true;
      this.crackMesh.position.set(this.breakTarget.x + 0.5, this.breakTarget.y + 0.5, this.breakTarget.z + 0.5);
      const mat = this.crackMesh.material as THREE.MeshBasicMaterial;
      if (mat.map !== this.crackTex[stage]) {
        mat.map = this.crackTex[stage];
        mat.needsUpdate = true;
      }
    } else {
      this.crackMesh.visible = false;
    }

    // placing
    this.placeCooldown -= dt;
    if ((this.mouseR || this.touchPlaceQ) && hit && this.placeCooldown <= 0) {
      this.placeCooldown = 0.12;
      const px2 = hit.x + hit.fx, py2 = hit.y + hit.fy, pz2 = hit.z + hit.fz;
      if (py2 >= 1 && py2 < WORLD_HEIGHT) {
        const existing = this.getBlock(px2, py2, pz2);
        const replaceable = existing === AIR || isFluid(existing) || CROSS[existing] === 1;
        if (replaceable && selectedId !== 0 && PLACEABLE[selectedId] === 1) {
          // survival: must actually have the item
          if (creative || (useUI.getState().inv[selectedId] || 0) > 0) {
            // player AABB overlap check for solid blocks
            const solid = IS_SOLID[selectedId] === 1;
            let blocked = false;
            if (solid) {
              const p = this.player;
              const px0 = p.x - 0.31, px1 = p.x + 0.31, pz0 = p.z - 0.31, pz1 = p.z + 0.31;
              const py0 = p.y, py1 = p.y + 1.8;
              blocked = px1 > px2 && px0 < px2 + 1 && py1 > py2 && py0 < py2 + 1 && pz1 > pz2 && pz0 < pz2 + 1;
            }
            if (!blocked) {
              this.setBlock(px2, py2, pz2, selectedId);
              this.sound.place(SOUND_OF[selectedId] as never);
              if (!creative) useUI.getState().takeInv(selectedId, 1);
              this.swingT = 0;
            }
          }
        }
      }
    }
    this.touchPlaceQ = false;
  }

  dropSelected(): void {
    const ui = useUI.getState();
    const id = ui.hotbar[ui.selectedSlot] ?? 0;
    if (!id) return;
    if (this.player.mode === 'survival') {
      const took = ui.takeInv(id, 1);
      if (took <= 0) return;
    }
    const eye = { x: 0, y: 0, z: 0 };
    this.player.eyePos(eye);
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(this.player.pitch, this.player.yaw, 0, 'YXZ'));
    this.drops.throwItem(id, eye.x + dir.x * 0.6, eye.y + dir.y * 0.6 - 0.2, eye.z + dir.z * 0.6,
      dir.x * 6.5, dir.y * 6.5 + 1.8, dir.z * 6.5);
    this.sound.pop();
    this.swingT = 0;
  }

  private rebuildHeld(id: number): void {
    this.heldId = id;
    if (this.heldMesh) {
      this.heldGroup.remove(this.heldMesh);
      this.heldMesh.geometry.dispose();
      this.heldMesh = null;
    }
    if (!id || !this.heldMat) return;
    this.heldMesh = new THREE.Mesh(dropGeometry(id), this.heldMat);
    this.heldMesh.scale.setScalar(2.05);
    this.heldMesh.renderOrder = 99;
    this.heldMesh.frustumCulled = false;
    this.heldGroup.add(this.heldMesh);
  }

  private updateHeld(dt: number): void {
    if (!this.heldGroup.visible) return;
    const ui = useUI.getState();
    const sel = ui.hotbar[ui.selectedSlot] ?? 0;
    if (sel !== this.heldId) this.rebuildHeld(sel);
    if (this.heldMesh) this.heldMesh.visible = sel !== 0;

    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dt * 3.8);
    const sw = this.swingT < 1 ? Math.sin(this.swingT * Math.PI) : 0;
    const p = this.player;
    const bob = p.bobAmp * Math.min(1, Math.hypot(p.vx, p.vz) / 4.3);
    this.heldGroup.position.set(
      0.55 + Math.cos(p.bobPhase) * 0.014 * bob - sw * 0.24,
      -0.48 + Math.abs(Math.sin(p.bobPhase)) * 0.02 * bob - sw * 0.26,
      -0.85 - sw * 0.1,
    );
    this.heldGroup.rotation.set(0.12 + sw * 0.95, -0.55 - sw * 0.35, 0.06 - sw * 0.25);

    // tint by local light
    this.heldLightTimer -= dt;
    if (this.heldLightTimer <= 0 && this.heldMat) {
      this.heldLightTimer = 0.35;
      const v = this.views.get(chunkKey(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4));
      let lum = 1;
      if (v && v.light) {
        const li = v.light[((Math.floor(p.y) << 8) | ((Math.floor(p.z) & 15) << 4) | (Math.floor(p.x) & 15))];
        lum = 0.3 + 0.7 * Math.max((li >> 4) / 15 * this.sky.sunIntensity, (li & 15) / 15);
      }
      this.heldMat.color.setRGB(lum, lum, lum);
    }
  }

  private destroyBlock(x: number, y: number, z: number): void {
    const id = this.getBlock(x, y, z);
    if (id === AIR) return;
    if (this.player.mode === 'survival' && (id === 17)) return; // bedrock unbreakable in survival
    this.setBlock(x, y, z, AIR);
    this.sound.breakBlock(SOUND_OF[id] as never);
    const tile = BLOCKS[id]?.tiles[2] ?? 3;
    const color = this.tileAvg.get(tile) || [128, 128, 128];
    const count = useSettings.getState().settings.particles === 'all' ? 18 : useSettings.getState().settings.particles === 'decreased' ? 7 : 2;
    this.particles.spawnBlockBreak(x, y, z, color, count);
    this.swingT = 0;
    // survival: spawn the dropped item
    if (this.player.mode === 'survival') {
      let dropId: number;
      if (id in DROP_TABLE) dropId = DROP_TABLE[id];
      else dropId = id;
      if (dropId) this.drops.spawn(dropId, x + 0.5, y + 0.4, z + 0.5, 0.22, 0.4);
    }
  }

  async screenshot(): Promise<void> {
    this.renderFrame();
    const url = this.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `voxelcraft-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
  }

  // ---------------- settings application ----------------

  applySettings(s: Settings): void {
    const prevSmooth = this.lastSmooth;
    this.wantedRenderDist = s.renderDistance;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.uniforms.brightness.value = s.brightness / 100;
    this.sky.setCloudMode(s.clouds);
    this.particles.setScale(s.particles === 'all' ? 1 : s.particles === 'decreased' ? 0.4 : 0.12);
    this.sound.setVolumes(s.master, s.music, s.blocks, s.ambient);
    this.player.autoJump = s.autoJump;
    this.applyMipmap(s.mipmap);
    this.applyFullscreen(s.fullscreen);
    const target = s.graphics === 'fast' ? Math.min(window.devicePixelRatio || 1, 1) : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(target);
    this.worker.postMessage({ t: 'smooth', on: s.smoothLighting });
    // if smooth lighting toggled, remesh every loaded chunk
    if (prevSmooth !== null && prevSmooth !== s.smoothLighting) {
      for (const [, v] of this.views) {
        this.worker.postMessage({ t: 'gen', cx: v.cx, cz: v.cz });
      }
    }
    this.lastSmooth = s.smoothLighting;
    this.resize();
  }
  private lastSmooth: boolean | null = null;

  applyFullscreen(on: boolean): void {
    if (on && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {});
    } else if (!on && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }

  // ---------------- loop ----------------

  private scheduleFrame(): void {
    if (!this.running || this.disposed) return;
    const s = useSettings.getState().settings;
    if (s.vsync) {
      this.rafId = requestAnimationFrame(() => this.loop());
    } else {
      this.timeoutId = window.setTimeout(() => this.loop(), 0);
    }
  }

  private loop(): void {
    if (!this.running || this.disposed) return;
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;
    this.fpsEMA = this.fpsEMA * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    // fps cap
    const s = useSettings.getState().settings;
    const interval = s.maxFps > 0 ? 1000 / s.maxFps : 0;
    if (interval > 0 && now - this.frameAcc < interval - 0.5) {
      this.scheduleFrame();
      return;
    }
    this.frameAcc = now;

    this.update(dt);
    this.renderFrame();
    this.renderCalls++;
    this.scheduleFrame();
  }

  private update(dt: number): void {
    const s = useSettings.getState().settings;
    const ui = useUI.getState();
    this.uniforms.time.value = performance.now() / 1000;

    if (this.mode === 'panorama') {
      this.panoramaAngle += dt * 0.05;
      const cx = 8, cz = 8;
      const r = 34;
      this.camera.position.set(cx + Math.cos(this.panoramaAngle) * r, 88, cz + Math.sin(this.panoramaAngle) * r);
      this.camera.lookAt(cx + Math.cos(this.panoramaAngle + 2.4) * 10, 74, cz + Math.sin(this.panoramaAngle + 2.4) * 10);
      this.camera.fov = 62;
      this.camera.updateProjectionMatrix();
      this.wantedRenderDist = Math.min(s.renderDistance, 6);
      this.updateStreaming(cx, cz);
      this.sky.update(dt, this.camera.position.x, this.camera.position.y, this.camera.position.z, false);
      this.updateUniformsCommon(dt, false);
      this.particles.update(dt);
      return;
    }
    if (this.mode !== 'game') return;

    // input state (keyboard + touch blended)
    const k = s.keys;
    const kd = this.keysDown;
    const tm = this.touchMove;
    this.input.fwd = kd.has(k.forward) || tm.y > 0.25;
    this.input.back = kd.has(k.back) || tm.y < -0.25;
    this.input.left = kd.has(k.left) || tm.x < -0.25;
    this.input.right = kd.has(k.right) || tm.x > 0.25;
    this.input.jump = kd.has(k.jump) || this.touchJump;
    this.input.sneak = kd.has(k.sneak) || this.touchSneak;
    const wantSprint = kd.has(k.sprint) || this.sprintByDouble || this.touchSprint;
    this.input.sprint = wantSprint;
    if (!this.input.fwd) this.sprintByDouble = false;

    // freeze physics whenever the game isn't the active screen
    const frozen = this.paused || this.player.dead || ui.screen !== 'playing';
    if (!frozen) {
      // fixed substeps for physics
      let remaining = dt;
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 60);
        this.player.update(step, this.input, this);
        remaining -= step;
      }
    }

    // streaming
    this.updateStreaming(this.player.x, this.player.z);

    // camera
    this.updateCamera(dt, s);

    // fluid simulation heartbeat (water 4/s, lava 1/s inside the worker)
    this.fluidTimer -= dt;
    if (this.fluidTimer <= 0) {
      this.fluidTimer = 0.25;
      if (!this.paused) this.worker.postMessage({ t: 'tick' });
    }

    // weather / thunder
    if (this.weather !== 'clear' && !this.paused) {
      if (this.weather === 'thunder') {
        this.thunderTimer -= dt;
        if (this.thunderTimer <= 0) {
          this.thunderTimer = 7 + Math.random() * 22;
          useUI.getState().set({ skyFlash: performance.now() });
          window.setTimeout(() => this.sound.thunder(), 300 + Math.random() * 1400);
        }
      }
    }

    // dropped items
    this.drops.update(
      dt,
      this.player,
      this,
      (id) => {
        const u2 = useUI.getState();
        if (u2.screen !== 'playing' && u2.screen !== 'chat') return false;
        if (this.player.dead) return false;
        this.sound.pop();
        if (this.player.mode === 'survival') u2.giveInv(id, 1);
        return true;
      },
      (x, y, z) => {
        const v = this.views.get(chunkKey(x >> 4, z >> 4));
        if (!v || !v.light) return 0xf0;
        return v.light[(y << 8) | ((z & 15) << 4) | (x & 15)];
      },
    );

    // held item view model
    this.updateHeld(dt);

    // sky + fog
    this.underwater = this.player.headInWater;
    this.sky.update(dt, this.camera.position.x, this.camera.position.y, this.camera.position.z, this.underwater);
    this.updateUniformsCommon(dt, this.underwater);

    // interaction
    this.updateInteraction(dt);
    this.particles.update(dt, this.camera.position.x, this.camera.position.y, this.camera.position.z);

    // cave ambience
    this.caveDroneTimer -= dt;
    if (this.caveDroneTimer <= 0) {
      this.caveDroneTimer = 25 + Math.random() * 40;
      const v = this.views.get(chunkKey(Math.floor(this.player.x) >> 4, Math.floor(this.player.z) >> 4));
      if (v && v.light) {
        const li = v.light[((Math.floor(this.player.y) << 8) | ((Math.floor(this.player.z) & 15) << 4) | (Math.floor(this.player.x) & 15))];
        if ((li >> 4) < 4 && this.player.y < 55) this.sound.caveDrone();
      }
    }

    // landing damage hookup
    if (this.player.onLand === null) {
      this.player.onLand = (fall) => {
        this.player.landDamage(fall);
      };
      this.player.onDamage = () => {
        this.sound.hurt();
        useUI.getState().set({ hitFlash: performance.now() });
      };
      this.player.onStep = (fam) => this.sound.step(fam as never);
      this.player.onSplash = () => this.sound.splash();
      this.player.onDeath = (cause) => {
        useUI.getState().set({ screen: 'dead', deathMessage: DEATH_MESSAGES[cause] || 'Player died' });
        document.exitPointerLock();
      };
    }

    // autosave
    this.saveTimer += dt;
    if (this.saveTimer > 20) {
      this.saveTimer = 0;
      this.saveNow();
    }

    // debug info
    const p = this.player;
    this.debug.fps = Math.round(this.fpsEMA);
    this.debug.x = p.x; this.debug.y = p.y; this.debug.z = p.z;
    this.debug.chunkX = Math.floor(p.x / 16); this.debug.chunkZ = Math.floor(p.z / 16);
    const yawDeg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = ['south', 'west', 'north', 'east'];
    this.debug.facing = dirs[Math.round(yawDeg / 90) % 4];
    this.debug.yaw = yawDeg;
    this.debug.pitch = p.pitch * 180 / Math.PI;
    const cv = this.views.get(chunkKey(Math.floor(p.x) >> 4, Math.floor(p.z) >> 4));
    if (cv && cv.biomes) {
      this.debug.biome = BIOME_NAMES[cv.biomes[(Math.floor(p.z) & 15) * 16 + (Math.floor(p.x) & 15)]] || '—';
    }
    if (cv && cv.light) {
      this.debug.lightFeet = cv.light[((Math.floor(p.y) << 8) | ((Math.floor(p.z) & 15) << 4) | (Math.floor(p.x) & 15))] >> 4;
    }
    this.debug.dayTime = Math.floor(this.sky.time * 24000);
    this.debug.chunks = this.views.size;
    this.debug.drawCalls = this.renderer.info.render.calls;
    this.debug.tris = this.renderer.info.render.triangles;
    this.debug.mode = p.mode;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.debug.mem = mem ? Math.round(mem.usedJSHeapSize / 1048576) : 0;
  }

  private updateUniformsCommon(_dt: number, underwater: boolean): void {
    const s = useSettings.getState().settings;
    this.uniforms.dayFactor.value = this.sky.sunIntensity;
    this.uniforms.brightness.value = s.brightness / 100;
    const rd = this.mode === 'panorama' ? Math.min(s.renderDistance, 6) : s.renderDistance;
    const inLava = this.mode === 'game' && this.player.headInLava;
    if (inLava) {
      (this.uniforms.fogColor.value as THREE.Color).setRGB(0.6, 0.16, 0.02);
      this.uniforms.fogNear.value = 0.1;
      this.uniforms.fogFar.value = 3.5;
      this.renderer.setClearColor(0x992600);
      return;
    }
    if (underwater) {
      (this.uniforms.fogColor.value as THREE.Color).setRGB(0.05, 0.18, 0.32);
      this.uniforms.fogNear.value = 1;
      this.uniforms.fogFar.value = 24;
    } else {
      (this.uniforms.fogColor.value as THREE.Color).copy(this.sky.fogColor);
      this.uniforms.fogNear.value = rd * 16 * 0.6;
      this.uniforms.fogFar.value = rd * 16 * 0.98;
      if (this.weather !== 'clear') {
        this.uniforms.fogNear.value *= 0.55;
        this.uniforms.fogFar.value *= 0.72;
      }
    }
    this.renderer.setClearColor(this.sky.fogColor);
  }

  private updateCamera(dt: number, s: Settings): void {
    const p = this.player;
    // fov: sprint kick
    const hSpeed = Math.hypot(p.vx, p.vz);
    const sprinting = p.sprinting || (hSpeed > 4.8);
    const targetFov = s.fov * (sprinting && hSpeed > 1 ? 1.12 : 1) * (p.flying && hSpeed > 12 ? 1.06 : 1);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8);
    this.camera.updateProjectionMatrix();

    const eyeY = p.y + p.eyeHeight;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(p.pitch, p.yaw, 0);

    let bx = 0, by = 0, roll = 0;
    if (s.viewBobbing && p.bobAmp > 0.01) {
      const amp = p.bobAmp * Math.min(1, hSpeed / 4.3);
      bx = Math.cos(p.bobPhase) * 0.02 * amp;
      by = Math.abs(Math.sin(p.bobPhase)) * 0.055 * amp;
      roll = Math.cos(p.bobPhase) * 0.0035 * amp;
    }
    // camera position relative to look direction for bob
    const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw);
    this.camera.position.set(p.x + bx * cos, eyeY + by, p.z - bx * sin);
    this.camera.rotation.z = roll;
  }

  renderFrame(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- persistence ----------------

  saveNow(): void {
    if (this.mode !== 'game' || !this.worldMeta) return;
    this.worker.postMessage({ t: 'save' });
  }

  private persistWorld(edits: Record<string, number[]>): void {
    if (!this.worldMeta) return;
    const key = `voxelcraft.world.${this.worldMeta.id}`;
    const data = {
      edits,
      player: this.player.serialize(),
      time: this.sky.time,
      hotbar: useUI.getState().hotbar,
      selected: useUI.getState().selectedSlot,
      inv: useUI.getState().inv,
      weather: this.weather,
    };
    try {
      localStorage.setItem(key, JSON.stringify(data));
      const worlds = useUI.getState().world;
      if (worlds) {
        const list = JSON.parse(localStorage.getItem('voxelcraft.worlds.v1') || '[]') as WorldMeta[];
        const w = list.find((x) => x.id === worlds.id);
        if (w) { w.lastPlayed = Date.now(); localStorage.setItem('voxelcraft.worlds.v1', JSON.stringify(list)); }
      }
    } catch { /* storage full */ }
  }

  loadWorldData(id: string): { edits: Record<string, number[]>; player?: { x: number; y: number; z: number; yaw: number; pitch: number; health: number }; time?: number; hotbar?: number[]; inv?: Record<number, number>; weather?: string } {
    try {
      const raw = localStorage.getItem(`voxelcraft.world.${id}`);
      if (!raw) return { edits: {} };
      const parsed = JSON.parse(raw);
      return { edits: parsed.edits || {}, player: parsed.player, time: parsed.time, hotbar: parsed.hotbar, inv: parsed.inv, weather: parsed.weather };
    } catch {
      return { edits: {} };
    }
  }

  // ---------------- accessors for UI ----------------

  private colinfoWaiters = new Map<number, (infos: { x: number; z: number; h: number; biome: number }[]) => void>();
  private colinfoSeq = 0;

  /** query terrain biome/height at world points without generating chunks */
  queryBiomes(pts: [number, number][]): Promise<{ x: number; z: number; h: number; biome: number }[]> {
    return new Promise((resolve) => {
      const id = ++this.colinfoSeq;
      this.colinfoWaiters.set(id, resolve);
      this.worker.postMessage({ t: 'colinfo', id, pts });
    });
  }

  private spawnPoint: { x: number; y: number; z: number } | null = null;

  respawnPlayer(): void {
    const sp = this.spawnPoint || { x: 0.5, y: 90, z: 0.5 };
    this.player.respawn(sp.x, sp.y, sp.z);
  }

  getDebug(): DebugInfo { return this.debug; }

  /** 0..1 progress of the initial ring of chunks around the player */
  loadingProgress(): number {
    if (this.mode !== 'game') return 1;
    const r = 3;
    const ccx = Math.floor(this.player.x / CHUNK), ccz = Math.floor(this.player.z / CHUNK);
    let need = 0, have = 0;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        need++;
        const v = this.views.get(chunkKey(ccx + dx, ccz + dz));
        if (v && v.blocks) have++;
      }
    return need === 0 ? 1 : have / need;
  }
  getPlayerState(): { health: number; air: number; underwater: boolean; mode: string; paused: boolean } {
    return { health: this.player.health, air: this.player.air, underwater: this.underwater, mode: this.player.mode, paused: this.paused };
  }
  setHotbarSlot(slot: number, id: number): void {
    const ui = useUI.getState();
    const hotbar = [...ui.hotbar];
    hotbar[slot] = id;
    ui.set({ hotbar });
  }

  /** draw icon for a block id into a canvas (for HUD) */
  drawIcon(cv: HTMLCanvasElement, id: number): void {
    const def = BLOCKS[id];
    if (!def) return;
    if (def.cross) {
      drawBlockIcon(cv, def.tiles[0], def.tiles[0], def.tiles[0], true);
    } else {
      drawBlockIcon(cv, def.tiles[2], def.tiles[4], def.tiles[0], false);
    }
  }

  crackTexturesInit(): void {
    this.crackTex = buildCrackCanvases().map((cv) => {
      const t = new THREE.CanvasTexture(cv);
      t.magFilter = THREE.NearestFilter;
      return t;
    });
  }
}
