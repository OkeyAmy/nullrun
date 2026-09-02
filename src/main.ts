import './style.css';
import { AudioKit } from './audio/audio';
import { BALANCE } from './game/config';
import { Game } from './game/game';
import type { GameEvent } from './game/game';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { ToolSurface } from './webmcp/tools';

const canvas = document.getElementById('board') as HTMLCanvasElement;

const game = new Game();
const renderer = new Renderer(canvas, game);
const tools = new ToolSurface(game);
const audio = new AudioKit();

const hud = new Hud(game, tools, {
  onHack: () => report(game.hack()),
  onGrab: () => report(game.grab()),
  onExtract: () => report(game.extract()),
  onEndTurn: () => report(game.endTurn()),
  onToggleSprint: () => {
    hud.sprintMode = !hud.sprintMode;
    hud.render();
  },
  onBegin: () => game.beginInfiltration(),
  onSetMode: (mode) => report(game.setMode(mode)),
  onChooseImplant: (id) => report(game.chooseImplant(id)),
  onPurchaseUpgrade: (id) => report(game.purchaseUpgrade(id)),
  onNewRun: () => game.newRun(),
});

function report(result: { ok: boolean; message: string }): void {
  if (!result.ok) game.log('system', result.message);
  hud.render();
}

/**
 * In agent mode the handler owns the operative as well as the network, so
 * human input must not reach the game — otherwise both players drive the same
 * body and the mode means nothing. Reading the board stays available: hovering
 * for route risk is spectating, not acting.
 */
function humanCanAct(): boolean {
  return game.state.phase === 'playing' && game.state.mode !== 'agent';
}

// --- reactive wiring -----------------------------------------------------

game.onChange(() => {
  renderer.invalidate();
  renderer.routePreview = null;
  renderer.centreOn(game.state.player.x, game.state.player.y);
  audio.setTension(game.state.escalation / BALANCE.alert.max);
  hud.render();
  void tools.syncPhaseTools();
});

// Sound and screen feedback. The engine already knew all of these moments; it
// just never said them out loud, so getting caught felt like a number moving.
const SCREEN_FEEDBACK: Partial<Record<GameEvent, { strength: number; colour: string }>> = {
  spotted: { strength: 1, colour: '#ff5470' },
  lockdown: { strength: 0.9, colour: '#ff5470' },
  run_failed: { strength: 1, colour: '#ff5470' },
  escalate: { strength: 0.45, colour: '#ffc24d' },
  body_found: { strength: 0.5, colour: '#ffc24d' },
  takedown: { strength: 0.4, colour: '#7df9ff' },
  near_miss: { strength: 0.18, colour: '#7df9ff' },
  floor_clear: { strength: 0.3, colour: '#6dffa8' },
  blackout: { strength: 0.25, colour: '#3a4a66' },
};

game.onEvent((event) => {
  audio.play(event);
  const feedback = SCREEN_FEEDBACK[event];
  if (feedback) renderer.punch(feedback.strength, feedback.colour);
});

// --- sound toggle --------------------------------------------------------
const muteButton = document.getElementById('mute') as HTMLButtonElement | null;

function paintMuteButton(): void {
  if (!muteButton) return;
  muteButton.classList.toggle('muted', !audio.enabled);
  muteButton.setAttribute('aria-pressed', String(!audio.enabled));
  const glyph = muteButton.firstElementChild;
  if (glyph) glyph.textContent = audio.enabled ? '♪' : '✕';
}

muteButton?.addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  paintMuteButton();
  // play something back so the toggle confirms itself
  if (audio.enabled) audio.play('grab');
});
paintMuteButton();

// --- input ---------------------------------------------------------------

const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
};

window.addEventListener('keydown', (event) => {
  if (game.state.phase !== 'playing') {
    if (event.key === 'Enter' && game.state.phase === 'briefing') game.beginInfiltration();
    return;
  }
  if (!humanCanAct()) {
    // the agent is playing; let the human take the operative back with `C`
    if (event.key === 'c' || event.key === 'C') report(game.setMode('coop'));
    return;
  }

  const move = MOVE_KEYS[event.key];
  if (move) {
    event.preventDefault();
    report(game.move(move[0], move[1]));
    return;
  }

  switch (event.key) {
    case ' ':
      event.preventDefault();
      report(game.endTurn());
      break;
    case 'e':
    case 'E':
      report(game.hack());
      break;
    case 'f':
    case 'F':
      report(game.grab());
      break;
    case 'x':
    case 'X':
      report(game.extract());
      break;
    case 'Shift':
      hud.sprintMode = !hud.sprintMode;
      hud.render();
      break;
    default:
      break;
  }
});

// --- dragging the facility around ----------------------------------------
// Big floors no longer shrink to fit, so the map can be larger than the canvas.
// A press-and-move pans it; a press without movement is still a click.
const drag = { active: false, moved: 0, lastX: 0, lastY: 0 };
const DRAG_THRESHOLD = 4;

canvas.addEventListener('pointerdown', (event) => {
  drag.active = true;
  drag.moved = 0;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

function endDrag(event: PointerEvent): void {
  if (!drag.active) return;
  drag.active = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  canvas.style.cursor = 'crosshair';
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('mousemove', (event) => {
  if (drag.active) {
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > DRAG_THRESHOLD && renderer.pannable) {
      canvas.style.cursor = 'grabbing';
      renderer.panBy(dx, dy);
      renderer.hover = null;
      renderer.routePreview = null;
      return;
    }
  }

  const tile = renderer.tileFromPointer(event.clientX, event.clientY);
  renderer.hover = tile;
  if (!tile || game.state.phase !== 'playing') {
    renderer.routePreview = null;
    return;
  }
  const plan = game.planRoute(tile.x, tile.y);
  renderer.routePreview = plan ? plan.steps : null;
});

canvas.addEventListener('mouseleave', () => {
  renderer.hover = null;
  renderer.routePreview = null;
});

canvas.addEventListener('click', (event) => {
  // a drag that happened to end over a tile must not also order a move
  if (drag.moved > DRAG_THRESHOLD) return;
  if (!humanCanAct()) return;
  const tile = renderer.tileFromPointer(event.clientX, event.clientY);
  if (!tile) return;

  // clicking an adjacent door toggles it; clicking anything else paths there
  const target = game.state.floor.tiles[tile.y * game.state.floor.width + tile.x];
  const adjacent =
    Math.max(
      Math.abs(tile.x - game.state.player.x),
      Math.abs(tile.y - game.state.player.y),
    ) <= 1;
  if (target?.kind === 'door' && adjacent) {
    report(game.toggleDoor(tile.x, tile.y));
    return;
  }
  report(game.moveTo(tile.x, tile.y, hud.sprintMode));
});

window.addEventListener('resize', () => renderer.resize());

// the HUD changes the action bar's height as buttons appear and disappear,
// which resizes the canvas container — keep the backing store in step with it
const canvasWrap = canvas.parentElement;
if (canvasWrap && 'ResizeObserver' in window) {
  new ResizeObserver(() => renderer.resize()).observe(canvasWrap);
}

// --- boot ----------------------------------------------------------------

async function boot(): Promise<void> {
  try {
    await renderer.load();
  } catch (error) {
    console.error('[nullrun] atlas failed to load', error);
  }
  renderer.resize();

  try {
    await tools.install();
  } catch (error) {
    console.error('[nullrun] WebMCP tool registration failed', error);
  }

  hud.render();

  const frame = (time: number) => {
    renderer.draw(time);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // expose for debugging and for headless agent harnesses
  Object.assign(window, { nullrun: { game, tools, renderer, audio } });
}

void boot();
