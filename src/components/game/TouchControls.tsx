// ============================================================
// Voxelcraft — touch controls (iPad / mobile):
// Bedrock-style joystick, drag-to-look layer, tap to place,
// hold to break, jump / sneak / sprint buttons, pause &
// inventory shortcuts. Rendered only on coarse-pointer devices.
// ============================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import type { Engine } from '@/game/engine';
import { useUI } from '@/state/gameStore';

// capture must never break the interaction (throws on inactive pointers)
function safeCapture(e: React.PointerEvent): void {
  try {
    (e.target as Element).setPointerCapture?.(e.pointerId);
  } catch { /* inactive pointer — fine */ }
}

export default function TouchControls({ engine }: { engine: Engine | null }) {
  const [sprintOn, setSprintOn] = useState(false);
  const [sneakOn, setSneakOn] = useState(false);
  const [flying, setFlying] = useState(false);

  // track fly state so Jump/Sneak become Up/Down while flying
  useEffect(() => {
    if (!engine) return;
    const iv = setInterval(() => setFlying(engine.player.flying), 300);
    return () => clearInterval(iv);
  }, [engine]);

  if (!engine) return null;

  const toggleSprint = () => {
    const next = !sprintOn;
    setSprintOn(next);
    engine.setTouchKey('sprint', next);
  };
  const toggleSneak = () => {
    const next = !sneakOn;
    setSneakOn(next);
    engine.setTouchKey('sneak', next);
  };

  const openPause = () => {
    engine.pauseGame();
    useUI.getState().set({ screen: 'paused', pauseReason: null });
  };
  const openInventory = () => {
    engine.pauseGame();
    useUI.getState().set({ screen: 'inventory' });
  };
  const openChat = () => {
    engine.pauseGame();
    useUI.getState().set({ screen: 'chat', chatDraft: '' });
  };

  return (
    <>
      {/* look / interact layer — sits above the canvas, below the HUD */}
      <LookLayer engine={engine} />

      {/* top-right buttons */}
      <div className="pointer-events-none absolute right-2 top-2 z-30 flex gap-2">
        <TouchButton label="Chat" ariaLabel="Chat and commands" onPress={openChat} className="h-11 w-14 text-[11px]" />
        <TouchButton label="II" ariaLabel="Pause" onPress={openPause} className="h-11 w-11 text-[13px]" />
        <TouchButton label="E" ariaLabel="Inventory" onPress={openInventory} className="h-11 w-11 text-[13px]" />
      </div>

      {/* joystick — bottom left */}
      <Joystick engine={engine} />

      {/* action buttons — bottom right */}
      <div className="pointer-events-none absolute bottom-24 right-4 z-30 flex flex-col items-end gap-3">
        <TouchButton
          label="Sprint"
          ariaLabel="Toggle sprint"
          active={sprintOn}
          onPress={toggleSprint}
          className="h-12 w-[86px] text-[11px]"
        />
        <div className="flex items-end gap-3">
          <TouchButton
            label={flying ? 'Down' : 'Sneak'}
            ariaLabel={flying ? 'Fly down' : 'Sneak'}
            active={sneakOn}
            onPress={toggleSneak}
            className="h-14 w-14 text-[10px]"
          />
          <TouchButton
            label={flying ? 'Up' : 'Jump'}
            ariaLabel={flying ? 'Fly up' : 'Jump'}
            onDown={(down) => engine.setTouchKey('jump', down)}
            className="h-20 w-20 text-[13px]"
          />
        </div>
      </div>

      {/* hint pill, fades after a while */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2">
        <div className="mc-panel px-3 py-1.5 font-pixel text-[10px] text-white/90 text-shadow-mc">
          Drag to look · Tap to place · Hold to break
        </div>
      </div>
    </>
  );
}

// ---------------- look / interact layer ----------------

function LookLayer({ engine }: { engine: Engine }) {
  const active = useRef<{
    id: number;
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    t: number;
    moved: boolean;
  } | null>(null);
  const holdTimer = useRef<number>(0);
  const breaking = useRef(false);

  const clearHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = 0;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (active.current) return; // ignore extra fingers on the look layer
    active.current = {
      id: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      t: performance.now(),
      moved: false,
    };
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      if (active.current && !active.current.moved) {
        breaking.current = true;
        engine.setTouchBreak(true);
      }
    }, 280);
    safeCapture(e);
  };

  const onMove = (e: React.PointerEvent) => {
    const a = active.current;
    if (!a || a.id !== e.pointerId) return;
    const dx = e.clientX - a.lastX;
    const dy = e.clientY - a.lastY;
    a.lastX = e.clientX;
    a.lastY = e.clientY;
    engine.touchLook(dx, dy);
    if (!a.moved && Math.hypot(e.clientX - a.startX, e.clientY - a.startY) > 14) {
      a.moved = true;
      if (!breaking.current) clearHold();
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const a = active.current;
    if (!a || a.id !== e.pointerId) return;
    clearHold();
    active.current = null;
    if (breaking.current) {
      breaking.current = false;
      engine.setTouchBreak(false);
    } else if (!a.moved && performance.now() - a.t < 280) {
      engine.touchPlaceOnce();
    }
  };

  return (
    <div
      aria-label="Look area"
      className="absolute inset-0 z-[5] touch-none"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}

// ---------------- joystick ----------------

function Joystick({ engine }: { engine: Engine }) {
  const padRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pid = useRef<number | null>(null);

  const RADIUS = 46;

  const update = (clientX: number, clientY: number) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx = (dx / len) * RADIUS;
      dy = (dy / len) * RADIUS;
    }
    setKnob({ x: dx, y: dy });
    engine.setTouchMove(dx / RADIUS, -dy / RADIUS); // up = forward
  };

  const reset = () => {
    pid.current = null;
    setKnob({ x: 0, y: 0 });
    engine.setTouchMove(0, 0);
  };

  return (
    <div
      ref={padRef}
      aria-label="Movement joystick"
      className="pointer-events-auto absolute bottom-8 left-6 z-30 flex h-[128px] w-[128px] touch-none items-center justify-center rounded-full border-2 border-white/25 bg-white/10 backdrop-blur-[2px]"
      onPointerDown={(e) => {
        if (pid.current !== null) return;
        pid.current = e.pointerId;
        safeCapture(e);
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (pid.current !== e.pointerId) return;
        update(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (pid.current !== e.pointerId) return;
        reset();
      }}
      onPointerCancel={() => reset()}
    >
      <div
        className="h-[52px] w-[52px] rounded-full border-2 border-white/50 bg-white/30"
        style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
      />
    </div>
  );
}

// ---------------- generic touch button ----------------

function TouchButton({
  label,
  ariaLabel,
  onPress,
  onDown,
  active,
  className = '',
}: {
  label: string;
  ariaLabel: string;
  onPress?: () => void;
  onDown?: (down: boolean) => void;
  active?: boolean;
  className?: string;
}) {
  const [held, setHeld] = useState(false);
  const pressed = held || active;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={`pointer-events-auto flex touch-none select-none items-center justify-center rounded-lg border-2 font-pixel text-white text-shadow-mc transition-colors ${
        pressed ? 'border-white/70 bg-white/40' : 'border-white/35 bg-black/30'
      } ${className}`}
      onPointerDown={(e) => {
        safeCapture(e);
        setHeld(true);
        onDown?.(true);
      }}
      onPointerUp={() => {
        setHeld(false);
        onDown?.(false);
        onPress?.();
      }}
      onPointerCancel={() => {
        if (held) {
          setHeld(false);
          onDown?.(false);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}
