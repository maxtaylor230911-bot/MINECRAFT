// ============================================================
// Voxelcraft — global store: settings (Java-Edition style
// options), UI screen state, world management.
// Settings persist to localStorage.
// ============================================================

'use client';

import { create } from 'zustand';

export type GraphicsOpt = 'fancy' | 'fast';
export type CloudsOpt = 'fancy' | 'fast' | 'off';
export type ParticlesOpt = 'all' | 'decreased' | 'minimal';
export type GameMode = 'creative' | 'survival';

export interface KeyBinds {
  forward: string; back: string; left: string; right: string;
  jump: string; sneak: string; sprint: string; inventory: string;
  toggleDebug: string; screenshot: string; toggleFullscreen: string; pickBlock: string;
}

export interface Settings {
  // video
  renderDistance: number;        // 2..32 chunks
  maxFps: number;                // 0 = uncapped, else 30/60/90/120/144/165/240
  vsync: boolean;
  fov: number;                   // 30..110
  brightness: number;            // 0..100 (moody..bright)
  guiScale: number;              // 0 = auto, 1..4
  graphics: GraphicsOpt;
  smoothLighting: boolean;
  mipmap: number;                // 0..4
  clouds: CloudsOpt;
  particles: ParticlesOpt;
  viewBobbing: boolean;
  fullscreen: boolean;
  // sound (0..100)
  master: number;
  music: number;
  blocks: number;
  ambient: number;
  // controls
  sensitivity: number;           // 0..200, 100 default
  invertY: boolean;
  autoJump: boolean;
  keys: KeyBinds;
}

export const DEFAULT_KEYS: KeyBinds = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft', inventory: 'KeyE',
  toggleDebug: 'F3', screenshot: 'F2', toggleFullscreen: 'F11', pickBlock: 'MiddleClick',
};

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  maxFps: 120,
  vsync: true,
  fov: 70,
  brightness: 50,
  guiScale: 0,
  graphics: 'fancy',
  smoothLighting: true,
  mipmap: 4,
  clouds: 'fancy',
  particles: 'all',
  viewBobbing: true,
  fullscreen: false,
  master: 100,
  music: 60,
  blocks: 100,
  ambient: 100,
  sensitivity: 100,
  invertY: false,
  autoJump: false,
  keys: { ...DEFAULT_KEYS },
};

const SETTINGS_KEY = 'voxelcraft.settings.v1';

export function loadSettings(): Settings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed, keys: { ...DEFAULT_KEYS, ...(parsed.keys || {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* full */ }
}

// ---------------- worlds ----------------

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  mode: GameMode;
  created: number;
  lastPlayed: number;
}

const WORLDS_KEY = 'voxelcraft.worlds.v1';

export function loadWorlds(): WorldMeta[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(WORLDS_KEY) || '[]') as WorldMeta[];
  } catch { return []; }
}
export function saveWorlds(list: WorldMeta[]): void {
  try { localStorage.setItem(WORLDS_KEY, JSON.stringify(list)); } catch { /* full */ }
}

// ---------------- UI store ----------------

export type Screen =
  | 'title' | 'worlds' | 'loading' | 'playing' | 'paused'
  | 'options' | 'inventory' | 'dead' | 'about' | 'chat';

export interface ChatMsg { text: string; ts: number; kind: 'chat' | 'system' | 'error' }

interface UIState {
  screen: Screen;
  optionsFrom: Screen;
  loadingProgress: number;
  loadingLabel: string;
  selectedSlot: number;
  hotbar: number[];
  debugOpen: boolean;
  chatToast: string | null;
  world: WorldMeta | null;
  pauseReason: string | null;
  deathMessage: string | null;
  hitFlash: number;
  skyFlash: number;
  chatLog: ChatMsg[];
  inv: Record<number, number>;   // survival item counts by block id
  chatDraft: string;
  goTo: (s: Screen) => void;
  openOptions: (from: Screen) => void;
  set: (p: Partial<UIState>) => void;
  addChat: (text: string, kind?: ChatMsg['kind']) => void;
  giveInv: (id: number, n: number) => void;
  takeInv: (id: number, n: number) => number;
}

export const useUI = create<UIState>((set, get) => ({
  screen: 'title',
  optionsFrom: 'title',
  loadingProgress: 0,
  loadingLabel: 'Building terrain…',
  selectedSlot: 0,
  hotbar: [2, 3, 1, 5, 8, 11, 26, 27, 4],
  debugOpen: false,
  chatToast: null,
  world: null,
  pauseReason: null,
  deathMessage: null,
  hitFlash: 0,
  skyFlash: 0,
  chatLog: [],
  inv: {},
  chatDraft: '',
  goTo: (s) => set({ screen: s }),
  openOptions: (from) => set({ screen: 'options', optionsFrom: from }),
  set: (p) => set(p),
  addChat: (text, kind = 'system') => {
    const log = get().chatLog.concat({ text, ts: Date.now(), kind });
    set({ chatLog: log.slice(-120) });
  },
  giveInv: (id, n) => {
    if (id <= 0) return;
    const inv = { ...get().inv };
    inv[id] = (inv[id] || 0) + n;
    set({ inv });
    // auto-assign to first empty hotbar slot on first pickup
    const hotbar = get().hotbar;
    if (!hotbar.includes(id)) {
      const empty = hotbar.findIndex((x) => !x);
      if (empty >= 0) set({ hotbar: hotbar.map((x, i) => (i === empty ? id : x)) });
    }
  },
  takeInv: (id, n) => {
    const inv = { ...get().inv };
    const have = inv[id] || 0;
    const take = Math.min(have, n);
    if (take > 0) inv[id] = have - take;
    if (inv[id] === 0) delete inv[id];
    set({ inv });
    return take;
  },
}));

// ---------------- settings store ----------------

interface SState {
  settings: Settings;
  update: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  reset: () => void;
}

export const useSettings = create<SState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  update: (k, v) => {
    const s = { ...get().settings, [k]: v };
    set({ settings: s });
    saveSettings(s);
  },
  reset: () => {
    set({ settings: { ...DEFAULT_SETTINGS, keys: { ...DEFAULT_KEYS } } });
    saveSettings(DEFAULT_SETTINGS);
  },
}));

export function initSettingsStore(): void {
  useSettings.setState({ settings: loadSettings() });
}

// ---------------- key names ----------------

export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code === 'MiddleClick') return 'Middle Click';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5) + ' Arrow';
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const map: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt', Tab: 'Tab',
    CapsLock: 'Caps', Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', Backspace: 'Bksp', Escape: 'Esc',
  };
  return map[code] || code;
}
