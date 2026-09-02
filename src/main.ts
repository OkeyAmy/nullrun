import './style.css';
import { Game } from './game/game';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { ToolSurface } from './webmcp/tools';

const canvas = document.getElementById('board') as HTMLCanvasElement;

const game = new Game();
const renderer = new Renderer(canvas, game);
const tools = new ToolSurface(game);

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
  onNewRun: () => game.newRun(),
});

function report(result: { ok: boolean; message: string }): void {
  if (!result.ok) game.log('system', result.message);
  hud.render();
}

// --- reactive wiring -----------------------------------------------------

game.onChange(() => {
  renderer.invalidate();
  renderer.routePreview = null;
  hud.render();
  void tools.syncPhaseTools();
});

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

canvas.addEventListener('mousemove', (event) => {
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
  if (game.state.phase !== 'playing') return;
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
  Object.assign(window, { nullrun: { game, tools, renderer } });
}

void boot();
