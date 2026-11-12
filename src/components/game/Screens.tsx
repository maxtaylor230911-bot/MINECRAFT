// ============================================================
// Voxelcraft — menu screens: title, world select/create, pause,
// loading, death, inventory, about. Original UI.
// ============================================================

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useUI, useSettings, WorldMeta, GameMode, loadWorlds, saveWorlds } from '@/state/gameStore';
import type { Engine } from '@/game/engine';
import { PALETTE, NAME_OF, T } from '@/game/blocks';
import { getTileDataURL } from '@/game/atlas';
import { BlockIcon } from './Hud';

// ---------------- shared bits ----------------

function McButton({
  children, onClick, disabled, className = '', small,
}: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; className?: string; small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`mc-btn font-pixel ${small ? 'mc-btn-sm text-[13px]' : 'text-[15px]'} ${className}`}
    >
      {children}
    </button>
  );
}

const SPLASHES = [
  'Fully procedural!',
  'Infinite worlds!',
  'Runs in your browser!',
  'Now with torches!',
  '100% original voxels!',
  'Punch a tree!',
  'Also try going outside!',
  'WebGL powered!',
  'Greedy chunks!',
  'Diamonds are down deep!',
];

function useDirtBg(dark = true): React.CSSProperties {
  return useMemo(() => {
    let url = '';
    try { url = getTileDataURL(T.dirt); } catch { /* not ready */ }
    return {
      backgroundImage: url ? `linear-gradient(rgba(0,0,0,${dark ? 0.62 : 0.35}),rgba(0,0,0,${dark ? 0.62 : 0.35})),url(${url})` : '#1a1a1a',
    };
  }, [dark]);
}

export { McButton, useDirtBg };

// ---------------- title ----------------

export function TitleScreen() {
  const ui = useUI();
  // random splash — suppressHydrationWarning tells React the server text may
  // differ (client re-picks its own splash during hydration)
  const [splash] = useState(() => SPLASHES[Math.floor(Math.random() * SPLASHES.length)]);
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-between" style={{ background: 'rgba(8,8,12,0.42)' }}>
      <div className="mt-[9vh] flex flex-col items-center">
        <h1
          className="font-pixel font-bold text-white text-shadow-mc"
          style={{ fontSize: 'clamp(34px, 7vw, 74px)', letterSpacing: '0.04em', textShadow: '4px 4px 0 rgba(0,0,0,0.75)' }}
        >
          VOXELCRAFT
        </h1>
        {splash && (
          <div suppressHydrationWarning className="vc-splash font-pixel text-[#ffff55] text-shadow-mc mt-1 ml-40" style={{ fontSize: 'clamp(11px, 1.6vw, 17px)' }}>
            {splash}
          </div>
        )}
      </div>

      <div className="mb-[7vh] flex w-full max-w-[420px] flex-col gap-2 px-4">
        <McButton onClick={() => ui.goTo('worlds')}>Singleplayer</McButton>
        <McButton onClick={() => ui.openOptions('title')}>Options...</McButton>
        <McButton onClick={() => ui.goTo('about')}>About & Help</McButton>
      </div>

      <div className="mb-3 flex w-full items-end justify-between px-3 font-pixel text-[11px] text-white/75 text-shadow-mc">
        <span>Voxelcraft 1.2</span>
        <span className="text-right">An original browser voxel sandbox.<br />Not affiliated with Mojang or Microsoft.</span>
      </div>
    </div>
  );
}

// ---------------- about ----------------

export function AboutScreen() {
  const ui = useUI();
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center" style={useDirtBg()}>
      <div className="mc-panel mc-scroll max-h-[80vh] w-full max-w-[560px] overflow-y-auto p-6 font-pixel text-[13px] leading-relaxed text-white/90">
        <h2 className="mb-4 text-center text-[18px] text-white text-shadow-mc">About Voxelcraft</h2>
        <p className="mb-3">
          Voxelcraft is an original, from-scratch voxel sandbox that runs entirely in your browser.
          Explore infinite procedurally generated worlds with mountains, oceans, deserts, forests,
          snowy plains and cave systems. Mine blocks, build structures, place torches to light up
          the dark, and watch the day/night cycle roll by.
        </p>
        <p className="mb-3">Everything — terrain, textures, lighting, sounds — is generated on your machine.</p>
        <h3 className="mt-4 mb-2 text-[15px] text-[#ffff55]">Quick controls</h3>
        <ul className="list-disc pl-5">
          <li>WASD to move, Space to jump, Ctrl or double-tap W to sprint</li>
          <li>Left click: mine — Right click: place — Middle click: pick block</li>
          <li>E: block palette — 1-9 / scroll: hotbar — Q: drop item</li>
          <li>T: chat — /: commands (/help for the list)</li>
          <li>Double-tap Space: toggle flying (creative)</li>
          <li>F3: debug screen — F2: screenshot — F11: fullscreen</li>
          <li>Esc: pause / back</li>
        </ul>
        <p className="mt-4 text-white/60">
          This is an original fan-made genre piece. It is not Minecraft and is not affiliated with,
          or endorsed by, Mojang or Microsoft.
        </p>
        <div className="mt-6 text-center">
          <McButton onClick={() => ui.goTo('title')}>Back</McButton>
        </div>
      </div>
    </div>
  );
}

// ---------------- worlds ----------------

function fmtDate(t: number): string {
  try { return new Date(t).toLocaleString(); } catch { return ''; }
}

export function WorldsScreen({ engine }: { engine: Engine | null }) {
  const ui = useUI();
  const [worlds, setWorlds] = useState<WorldMeta[]>(() =>
    typeof window === 'undefined' ? [] : loadWorlds().sort((a, b) => b.lastPlayed - a.lastPlayed)
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('New World');
  const [seedText, setSeedText] = useState('');
  const [mode, setMode] = useState<GameMode>('creative');

  const startWorld = (w: WorldMeta) => {
    ui.set({ world: w, screen: 'loading', loadingProgress: 0, deathMessage: null });
    const data = engine ? engine.loadWorldData(w.id) : { edits: {} };
    engine?.startWorld(w, data);
  };

  const createWorld = () => {
    let seed = 0;
    if (seedText.trim() === '') {
      seed = (Math.random() * 2 ** 31) | 0;
    } else if (/^-?\d+$/.test(seedText.trim())) {
      seed = parseInt(seedText.trim(), 10) | 0;
    } else {
      // hash the text
      let h = 1125899906842597;
      for (let i = 0; i < seedText.length; i++) h = (Math.imul(31, h) + seedText.charCodeAt(i)) | 0;
      seed = h;
    }
    const w: WorldMeta = {
      id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: name.trim() || 'New World',
      seed, mode,
      created: Date.now(), lastPlayed: Date.now(),
    };
    const list = [w, ...loadWorlds()];
    saveWorlds(list);
    setWorlds(list);
    startWorld(w);
  };

  const deleteWorld = () => {
    if (!selected) return;
    const list = loadWorlds().filter((w) => w.id !== selected);
    saveWorlds(list);
    try { localStorage.removeItem(`voxelcraft.world.${selected}`); } catch { /* */ }
    setWorlds(list);
    setSelected(null);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center pt-10" style={useDirtBg()}>
      <h2 className="font-pixel text-[20px] text-white text-shadow-mc mb-6">{creating ? 'Create New World' : 'Select World'}</h2>

      {!creating ? (
        <>
          <div className="mc-scroll w-full max-w-[560px] flex-1 overflow-y-auto px-4 flex flex-col gap-2" style={{ maxHeight: '48vh' }}>
            {worlds.length === 0 && (
              <div className="font-pixel text-[13px] text-white/60 text-center py-10">No worlds yet. Create one!</div>
            )}
            {worlds.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setSelected(w.id)}
                onDoubleClick={() => startWorld(w)}
                className={`mc-row text-left px-4 py-3 ${selected === w.id ? 'selected' : ''}`}
              >
                <div className="font-pixel text-[14px] text-white text-shadow-mc">{w.name}</div>
                <div className="font-pixel text-[11px] text-white/55 mt-1">
                  {w.mode === 'creative' ? 'Creative' : 'Survival'} · seed {w.seed} · {fmtDate(w.lastPlayed)}
                </div>
              </button>
            ))}
          </div>
          <div className="mb-8 mt-6 grid w-full max-w-[560px] grid-cols-2 gap-2 px-4">
            <McButton disabled={!selected} onClick={() => {
              const w = worlds.find((x) => x.id === selected);
              if (w) startWorld(w);
            }}>Play Selected World</McButton>
            <McButton onClick={() => setCreating(true)}>Create New World</McButton>
            <McButton disabled={!selected} onClick={deleteWorld}>Delete</McButton>
            <McButton onClick={() => ui.goTo('title')}>Cancel</McButton>
          </div>
        </>
      ) : (
        <div className="w-full max-w-[560px] px-4 flex flex-col gap-4">
          <label className="font-pixel text-[13px] text-white/85 text-shadow-mc flex flex-col gap-1">
            World Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              className="bg-black/60 border-2 border-white/40 px-3 py-2 font-pixel text-[14px] text-white outline-none focus:border-white"
            />
          </label>
          <label className="font-pixel text-[13px] text-white/85 text-shadow-mc flex flex-col gap-1">
            Seed for the World Generator (leave blank for random)
            <input
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              maxLength={32}
              placeholder="e.g. 12345 or my-seed"
              className="bg-black/60 border-2 border-white/40 px-3 py-2 font-pixel text-[14px] text-white outline-none focus:border-white placeholder:text-white/30"
            />
          </label>
          <div className="font-pixel text-[13px] text-white/85 text-shadow-mc flex flex-col gap-1">
            Game Mode
            <McButton onClick={() => setMode(mode === 'creative' ? 'survival' : 'creative')}>
              {mode === 'creative' ? 'Game Mode: Creative' : 'Game Mode: Survival'}
            </McButton>
            <div className="text-[11px] text-white/55 mt-1">
              {mode === 'creative'
                ? 'Unlimited blocks, instant mining, flying (double-tap Space).'
                : 'Timed mining, fall damage, drowning. Bedrock is unbreakable.'}
            </div>
          </div>
          <div className="mb-8 mt-2 grid grid-cols-2 gap-2">
            <McButton onClick={createWorld}>Create New World</McButton>
            <McButton onClick={() => setCreating(false)}>Cancel</McButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- loading ----------------

export function LoadingScreen({ engine }: { engine: Engine | null }) {
  const ui = useUI();
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => {
      if (!engine) return;
      const p = engine.loadingProgress();
      setProgress(p);
      if (p >= 0.995) {
        clearInterval(iv);
        ui.goTo('playing');
      }
    }, 100);
    return () => clearInterval(iv);
  }, [engine, ui]);
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4" style={useDirtBg()}>
      <div className="font-pixel text-[16px] text-white text-shadow-mc">Building terrain…</div>
      <div className="w-[320px] border-2 border-black bg-black/60 p-0.5">
        <div className="h-3 bg-[#5bbd4e]" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="font-pixel text-[12px] text-white/70">{Math.round(progress * 100)}%</div>
    </div>
  );
}

// ---------------- pause ----------------

export function PauseScreen({ engine }: { engine: Engine | null }) {
  const ui = useUI();
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2" style={{ background: 'rgba(8,8,10,0.55)' }}>
      <h2 className="font-pixel text-[20px] text-white text-shadow-mc mb-4">Game Menu</h2>
      <div className="flex w-full max-w-[400px] flex-col gap-2 px-4">
        <McButton onClick={() => { ui.set({ screen: 'playing' }); engine?.resumeLock(); }}>Back to Game</McButton>
        <McButton onClick={() => ui.openOptions('paused')}>Options...</McButton>
        <McButton onClick={() => {
          engine?.saveNow();
          engine?.quitAndPanorama();
          ui.set({ world: null, screen: 'title', debugOpen: false });
        }}>Save and Quit to Title</McButton>
      </div>
    </div>
  );
}

// ---------------- death ----------------

export function DeathScreen({ engine }: { engine: Engine | null }) {
  const ui = useUI();
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3" style={{ background: 'rgba(120,10,10,0.45)' }}>
      <h2 className="font-pixel text-[30px] text-white text-shadow-mc mb-2">You Died!</h2>
      <div className="font-pixel text-[13px] text-white/85 text-shadow-mc mb-4">{ui.deathMessage || 'Better luck next time'}</div>
      <div className="flex w-full max-w-[400px] flex-col gap-2 px-4">
        <McButton onClick={() => {
          engine?.respawnPlayer();
          ui.set({ screen: 'playing' });
          engine?.resumeLock();
        }}>Respawn</McButton>
        <McButton onClick={() => {
          engine?.saveNow();
          engine?.quitAndPanorama();
          ui.set({ world: null, screen: 'title' });
        }}>Title Screen</McButton>
      </div>
    </div>
  );
}

// ---------------- inventory (creative palette) ----------------

export function InventoryScreen({ engine }: { engine: Engine | null }) {
  const ui = useUI();
  const [hover, setHover] = useState<number | null>(null);
  const hotbar = useUI((s) => s.hotbar);
  const selected = useUI((s) => s.selectedSlot);
  const inv = useUI((s) => s.inv);
  const playerMode = engine?.player.mode ?? 'creative';
  const survival = playerMode === 'survival';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyE' || e.code === 'Escape') {
        e.preventDefault();
        ui.set({ screen: 'playing' });
        engine?.resumeLock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, engine]);

  const assign = (id: number) => {
    engine?.setHotbarSlot(selected, id);
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center" style={{ background: 'rgba(8,8,10,0.55)' }}>
      <div className="mc-panel p-5 max-w-[640px] w-full mx-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-pixel text-[15px] text-white text-shadow-mc">Block Palette</h3>
          <span className="font-pixel text-[11px] text-white/60">{hover !== null ? NAME_OF[hover] : 'Click a block to put it in your selected slot'}</span>
        </div>
        <div className="mc-scroll grid max-h-[52vh] grid-cols-8 gap-1 overflow-y-auto sm:grid-cols-10" style={{ minHeight: '200px' }}>
          {PALETTE.map((id) => (
            <button
              key={id}
              type="button"
              title={NAME_OF[id]}
              onClick={() => assign(id)}
              onMouseEnter={() => setHover(id)}
              onMouseLeave={() => setHover(null)}
              className="flex h-11 w-11 items-center justify-center border-2 border-white/25 bg-black/45 hover:border-white"
            >
              <BlockIcon engine={engine} id={id} size={36} />
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-col items-center gap-2">
          <div className="flex gap-0.5">
            {hotbar.map((id, i) => {
              const count = survival && id ? (inv[id] || 0) : -1;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => ui.set({ selectedSlot: i })}
                  className={`vc-hotbar-slot ${i === selected ? 'selected' : ''}`}
                  style={{ opacity: survival && id && count === 0 ? 0.35 : 1 }}
                >
                  {id ? <BlockIcon engine={engine} id={id} /> : null}
                  {survival && id && count > 0 && (
                    <span className="pointer-events-none absolute bottom-0 right-0.5 font-pixel text-[11px] text-white text-shadow-mc">{count}</span>
                  )}
                </button>
              );
            })}
          </div>
          <McButton small onClick={() => { ui.set({ screen: 'playing' }); engine?.resumeLock(); }}>
            Done (E)
          </McButton>
        </div>
      </div>
    </div>
  );
}
