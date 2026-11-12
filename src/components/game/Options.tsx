// ============================================================
// Voxelcraft — Options screen: Video / Music & Sounds /
// Controls (with key rebinding), Java-Edition style layout.
// ============================================================

'use client';

import { useEffect, useState } from 'react';
import { useUI, useSettings, keyLabel, DEFAULT_KEYS, Settings } from '@/state/gameStore';
import { McButton, useDirtBg } from './Screens';

type Cycle<T extends string> = { label: string; get: (s: Settings) => T; next: (v: T) => T; fmt?: (v: T) => string };

function CycleButton({
  label, value, onClick, width = 300,
}: { label: string; value: string; onClick: () => void; width?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mc-btn mc-btn-sm mc-cycle font-pixel text-[13px]"
      style={{ width }}
    >
      <span>{label}: {value}</span>
    </button>
  );
}

function SliderRow({
  label, value, min, max, step = 1, onChange, fmt,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; fmt?: (v: number) => string;
}) {
  return (
    <label className="relative block" style={{ width: 300 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mc-slider"
        aria-label={label}
      />
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-pixel text-[12px] text-white text-shadow-mc">
        {label}: {fmt ? fmt(value) : value}
      </span>
    </label>
  );
}

const FPS_OPTS = [0, 30, 60, 90, 120, 144, 165, 240];
const KEY_ORDER: { k: keyof typeof DEFAULT_KEYS; label: string }[] = [
  { k: 'forward', label: 'Walk Forwards' },
  { k: 'back', label: 'Walk Backwards' },
  { k: 'left', label: 'Strafe Left' },
  { k: 'right', label: 'Strafe Right' },
  { k: 'jump', label: 'Jump' },
  { k: 'sneak', label: 'Sneak' },
  { k: 'sprint', label: 'Sprint' },
  { k: 'inventory', label: 'Open Palette' },
  { k: 'pickBlock', label: 'Pick Block' },
  { k: 'toggleDebug', label: 'Toggle Debug Screen' },
  { k: 'screenshot', label: 'Take Screenshot' },
  { k: 'toggleFullscreen', label: 'Toggle Fullscreen' },
];

export default function OptionsScreen() {
  const ui = useUI();
  const { settings, update, reset } = useSettings();
  const tab = ui.optionsFrom === 'paused' ? 'video' : 'video';
  const [tabState, setTabState] = useState<'video' | 'sound' | 'controls'>(tab as 'video');
  const [listening, setListening] = useState<keyof typeof DEFAULT_KEYS | null>(null);
  const bg = useDirtBg();

  // key rebinding capture
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        update('keys', { ...settings.keys, [listening]: e.code });
      }
      setListening(null);
    };
    const onMouse = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 1) {
        update('keys', { ...settings.keys, [listening]: 'MiddleClick' });
      }
      setListening(null);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [listening, settings.keys, update]);

  const cycles: Record<string, Cycle<string>> = {
    graphics: {
      label: 'Graphics', get: (s) => s.graphics, next: (v) => (v === 'fancy' ? 'fast' : 'fancy'),
      fmt: (v) => (v === 'fancy' ? 'Fancy' : 'Fast'),
    },
    smoothLighting: {
      label: 'Smooth Lighting', get: (s) => String(s.smoothLighting), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
    vsync: {
      label: 'VSync', get: (s) => String(s.vsync), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
    maxFps: {
      label: 'Max Framerate', get: (s) => String(s.maxFps),
      next: (v) => String(FPS_OPTS[(FPS_OPTS.indexOf(Number(v)) + 1) % FPS_OPTS.length]),
      fmt: (v) => (v === '0' ? 'Unlimited' : v),
    },
    guiScale: {
      label: 'GUI Scale', get: (s) => String(s.guiScale),
      next: (v) => String(Number(v) >= 4 ? 0 : Number(v) + 1),
      fmt: (v) => (v === '0' ? 'Auto' : v),
    },
    clouds: {
      label: 'Clouds', get: (s) => s.clouds,
      next: (v) => (v === 'fancy' ? 'fast' : v === 'fast' ? 'off' : 'fancy'),
      fmt: (v) => (v === 'fancy' ? 'Fancy' : v === 'fast' ? 'Fast' : 'OFF'),
    },
    particles: {
      label: 'Particles', get: (s) => s.particles,
      next: (v) => (v === 'all' ? 'decreased' : v === 'decreased' ? 'minimal' : 'all'),
      fmt: (v) => (v === 'all' ? 'All' : v === 'decreased' ? 'Decreased' : 'Minimal'),
    },
    viewBobbing: {
      label: 'View Bobbing', get: (s) => String(s.viewBobbing), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
    fullscreen: {
      label: 'Fullscreen', get: (s) => String(s.fullscreen), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
    invertY: {
      label: 'Invert Mouse', get: (s) => String(s.invertY), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
    autoJump: {
      label: 'Auto-Jump', get: (s) => String(s.autoJump), next: (v) => (v === 'true' ? 'false' : 'true'),
      fmt: (v) => (v === 'true' ? 'ON' : 'OFF'),
    },
  };

  const cycleOf = (key: keyof Settings | string, labelOverride?: string) => {
    const c = cycles[key as string];
    const val = c.get(settings);
    const label = labelOverride || c.label;
    return (
      <CycleButton
        key={key as string}
        label={label}
        value={c.fmt ? c.fmt(val) : String(val)}
        onClick={() => {
          const nv = c.next(val);
          if (key === 'graphics') update('graphics', nv as Settings['graphics']);
          else if (key === 'clouds') update('clouds', nv as Settings['clouds']);
          else if (key === 'particles') update('particles', nv as Settings['particles']);
          else if (key === 'smoothLighting') update('smoothLighting', nv === 'true');
          else if (key === 'vsync') update('vsync', nv === 'true');
          else if (key === 'viewBobbing') update('viewBobbing', nv === 'true');
          else if (key === 'fullscreen') update('fullscreen', nv === 'true');
          else if (key === 'invertY') update('invertY', nv === 'true');
          else if (key === 'autoJump') update('autoJump', nv === 'true');
          else if (key === 'maxFps') update('maxFps', Number(nv));
          else if (key === 'guiScale') update('guiScale', Number(nv));
        }}
      />
    );
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center pt-6" style={bg}>
      <h2 className="font-pixel text-[18px] text-white text-shadow-mc mb-3">Options</h2>

      <div className="mb-4 flex gap-2">
        <McButton small className={tabState === 'video' ? 'brightness-125' : ''} onClick={() => setTabState('video')}>Video Settings...</McButton>
        <McButton small className={tabState === 'sound' ? 'brightness-125' : ''} onClick={() => setTabState('sound')}>Music & Sounds...</McButton>
        <McButton small className={tabState === 'controls' ? 'brightness-125' : ''} onClick={() => setTabState('controls')}>Controls...</McButton>
      </div>

      <div className="mc-scroll w-full max-w-[640px] flex-1 overflow-y-auto px-4" style={{ maxHeight: '58vh' }}>
        {tabState === 'video' && (
          <div className="flex flex-wrap justify-center gap-2 pb-4">
            {cycleOf('graphics')}
            <SliderRow label="Render Distance" value={settings.renderDistance} min={2} max={32}
              onChange={(v) => update('renderDistance', Math.round(v))}
              fmt={(v) => `${Math.round(v)} chunks`} />
            {cycleOf('smoothLighting')}
            {cycleOf('maxFps')}
            {cycleOf('vsync')}
            <SliderRow label="FOV" value={settings.fov} min={30} max={110}
              onChange={(v) => update('fov', Math.round(v))}
              fmt={(v) => (v >= 110 ? 'Quake Pro' : String(v))} />
            <SliderRow label="Brightness" value={settings.brightness} min={0} max={100}
              onChange={(v) => update('brightness', Math.round(v))}
              fmt={(v) => (v <= 0 ? 'Moody' : v >= 100 ? 'Bright' : `${v}%`)} />
            {cycleOf('guiScale')}
            <SliderRow label="Mipmap Levels" value={settings.mipmap} min={0} max={4}
              onChange={(v) => update('mipmap', Math.round(v))} />
            {cycleOf('clouds')}
            {cycleOf('particles')}
            {cycleOf('viewBobbing')}
            {cycleOf('fullscreen')}
          </div>
        )}

        {tabState === 'sound' && (
          <div className="flex flex-wrap justify-center gap-2 pb-4">
            <SliderRow label="Master Volume" value={settings.master} min={0} max={100}
              onChange={(v) => update('master', Math.round(v))} fmt={(v) => `${v}%`} />
            <SliderRow label="Music" value={settings.music} min={0} max={100}
              onChange={(v) => update('music', Math.round(v))} fmt={(v) => `${v}%`} />
            <SliderRow label="Blocks" value={settings.blocks} min={0} max={100}
              onChange={(v) => update('blocks', Math.round(v))} fmt={(v) => `${v}%`} />
            <SliderRow label="Ambient/Environment" value={settings.ambient} min={0} max={100}
              onChange={(v) => update('ambient', Math.round(v))} fmt={(v) => `${v}%`} />
            <div className="w-full text-center font-pixel text-[11px] text-white/55 pt-2">
              All audio is synthesized live — no sound files.
            </div>
          </div>
        )}

        {tabState === 'controls' && (
          <div className="flex flex-col items-center gap-2 pb-4">
            <SliderRow label="Mouse Sensitivity" value={settings.sensitivity} min={0} max={200}
              onChange={(v) => update('sensitivity', Math.round(v))}
              fmt={(v) => (v <= 0 ? '*yawn*' : v >= 200 ? 'HYPERSPEED!!!' : `${v}%`)} />
            {cycleOf('invertY')}
            {cycleOf('autoJump')}
            <div className="mt-2 w-full text-center font-pixel text-[13px] text-white/80 text-shadow-mc">Key Binds</div>
            <div className="grid w-full max-w-[560px] grid-cols-1 gap-1 sm:grid-cols-2">
              {KEY_ORDER.map(({ k, label }) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setListening(k)}
                  className="mc-btn mc-btn-sm mc-cycle font-pixel text-[12px]"
                  style={{ width: '100%' }}
                >
                  {listening === k ? '> press a key <' : `${label}: ${keyLabel(settings.keys[k])}`}
                </button>
              ))}
            </div>
            <div className="font-pixel text-[10px] text-white/45 mt-1">
              Click a binding, then press a key (Esc cancels). Middle mouse supported for Pick Block.
            </div>
            <McButton small onClick={() => update('keys', { ...DEFAULT_KEYS })}>Reset Keys to Default</McButton>
          </div>
        )}
      </div>

      <div className="mb-6 mt-4 flex items-center gap-3">
        <McButton onClick={() => ui.goTo(ui.optionsFrom)}>Done</McButton>
        <McButton small onClick={reset}>Reset All to Default</McButton>
      </div>
    </div>
  );
}
