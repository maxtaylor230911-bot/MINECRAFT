// ============================================================
// Voxelcraft — client root: owns the Engine instance and
// switches between menu screens and the in-game HUD.
// ============================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import { Engine } from '@/game/engine';
import { useUI, useSettings, initSettingsStore } from '@/state/gameStore';
import Hud from './Hud';
import OptionsScreen from './Options';
import TouchControls from './TouchControls';
import { TitleScreen, WorldsScreen, LoadingScreen, PauseScreen, DeathScreen, InventoryScreen, AboutScreen } from './Screens';

initSettingsStore();

export default function GameRoot() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const screen = useUI((s) => s.screen);
  const settings = useSettings((s) => s.settings);

  // create engine once
  useEffect(() => {
    if (!canvasRef.current) return;
    let e: Engine | null = null;
    try {
      e = new Engine(canvasRef.current);
      e.applySettings(useSettings.getState().settings);
      e.startPanorama();
      setEngine(e);
      // dev/verification hook (harmless in production)
      (window as unknown as { __vc?: Engine }).__vc = e;
    } catch (err) {
      console.error('Failed to start Voxelcraft:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      e?.dispose();
      setEngine(null);
    };
  }, []);

  // apply settings changes to engine
  useEffect(() => {
    engine?.applySettings(settings);
  }, [engine, settings]);

  // WebGL / worker error surface
  useEffect(() => {
    const onErr = (ev: ErrorEvent) => {
      if (ev.message?.includes('WebGL')) setError(ev.message);
    };
    window.addEventListener('error', onErr);
    return () => window.removeEventListener('error', onErr);
  }, []);

  const inGame = screen === 'playing';

  return (
    <main className="fixed inset-0 bg-black" aria-label="Voxelcraft game">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {error && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 p-6">
          <div className="mc-panel max-w-[520px] p-6 text-center font-pixel text-[13px] text-white">
            <div className="mb-3 text-[16px] text-[#ff7b7b]">Could not start the game</div>
            <p className="text-white/80">{error}</p>
            <p className="mt-3 text-white/60">Voxelcraft needs WebGL2 and Web Worker support. Try a recent desktop browser (Chrome, Edge, Firefox or Safari).</p>
          </div>
        </div>
      )}

      {/* click-to-play catcher: while playing but pointer not locked.
          Skipped on touch devices — they never use pointer lock. */}
      {inGame && !error && !(engine?.isTouch) && <ClickCatcher engine={engine} />}

      {/* touch controls (joystick, look layer, action buttons) */}
      {inGame && !error && engine?.isTouch && <TouchControls engine={engine} />}

      <Hud engine={engine} />

      {screen === 'title' && <TitleScreen />}
      {screen === 'about' && <AboutScreen />}
      {screen === 'worlds' && <WorldsScreen engine={engine} />}
      {screen === 'loading' && <LoadingScreen engine={engine} />}
      {screen === 'paused' && <PauseScreen engine={engine} />}
      {screen === 'dead' && <DeathScreen engine={engine} />}
      {screen === 'inventory' && <InventoryScreen engine={engine} />}
      {screen === 'options' && <OptionsScreen />}
    </main>
  );
}

function ClickCatcher({ engine }: { engine: Engine | null }) {
  const [, force] = useState(0);
  const [lockBroken, setLockBroken] = useState(false);
  useEffect(() => {
    const iv = setInterval(() => {
      force((n) => n + 1);
      if (engine?.lockFailed) setLockBroken(true);
    }, 250);
    return () => clearInterval(iv);
  }, [engine]);
  const locked = typeof document !== 'undefined' && document.pointerLockElement !== null;
  if (locked || lockBroken) return null;
  return (
    <button
      type="button"
      aria-label="Click to play"
      onClick={() => engine?.resumeLock()}
      className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center bg-black/35"
    >
      <span className="mc-panel px-6 py-4 font-pixel text-[15px] text-white text-shadow-mc">
        Click to play
      </span>
    </button>
  );
}
