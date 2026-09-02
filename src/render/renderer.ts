import type { Game } from '../game/game';
import { tileIndex } from '../game/grid';
import type { Vec } from '../game/types';
import { coneTiles } from '../game/vision';
import {
  Atlas,
  COVER_VARIANTS,
  FLOOR_VARIANTS,
  WALL_VARIANTS,
  variantFor,
  type TileSpriteName,
} from './atlas';
import { PALETTE } from './palette';
import {
  drawCamera,
  drawFacingTick,
  drawGuardState,
  drawNoiseRing,
  drawObjectiveMarker,
  drawOperativeGlow,
  guardAccent,
} from './sprites';

interface ConeCell {
  index: number;
  alert: boolean;
  camera: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private atlas = new Atlas();
  private tileSize = 24;
  private originX = 0;
  private originY = 0;
  private coneCache: ConeCell[] | null = null;

  /** Tile the pointer is currently over, or null. */
  hover: Vec | null = null;
  /** Route preview drawn on top of the map (set by the UI or by plan_route). */
  routePreview: { x: number; y: number; risk: number }[] | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private game: Game,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  async load(): Promise<void> {
    await this.atlas.load(`${import.meta.env.BASE_URL}assets/tiles.png`);
  }

  /** Vision cones only change when the game state changes, so they are cached. */
  invalidate(): void {
    this.coneCache = null;
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const floor = this.game.state.floor;
    this.tileSize = Math.max(
      8,
      Math.floor(Math.min(width / floor.width, height / floor.height)),
    );
    this.originX = Math.floor((width - this.tileSize * floor.width) / 2);
    this.originY = Math.floor((height - this.tileSize * floor.height) / 2);
    this.invalidate();
  }

  tileFromPointer(clientX: number, clientY: number): Vec | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - this.originX) / this.tileSize);
    const y = Math.floor((clientY - rect.top - this.originY) / this.tileSize);
    const floor = this.game.state.floor;
    if (x < 0 || y < 0 || x >= floor.width || y >= floor.height) return null;
    return { x, y };
  }

  private px(x: number): number {
    return this.originX + x * this.tileSize;
  }

  private py(y: number): number {
    return this.originY + y * this.tileSize;
  }

  private buildConeCache(): ConeCell[] {
    const s = this.game.state;
    const ctxVision = { powerOutTurns: s.powerOutTurns };
    const cells: ConeCell[] = [];
    for (const guard of s.floor.guards) {
      if (guard.stunTurns > 0) continue;
      const alert = guard.state !== 'patrol';
      for (const tile of coneTiles(s.floor, guard, ctxVision)) {
        cells.push({ index: tileIndex(s.floor, tile.x, tile.y), alert, camera: false });
      }
    }
    for (const camera of s.floor.cameras) {
      if (camera.disabledTurns > 0) continue;
      for (const tile of coneTiles(s.floor, camera, ctxVision)) {
        cells.push({ index: tileIndex(s.floor, tile.x, tile.y), alert: false, camera: true });
      }
    }
    return cells;
  }

  draw(time: number): void {
    const { ctx } = this;
    const s = this.game.state;
    const floor = s.floor;
    const size = this.tileSize;

    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // --- terrain --------------------------------------------------------
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const i = tileIndex(floor, x, y);
        if (!floor.discovered[i]) continue;
        const tile = floor.tiles[i];
        const dx = this.px(x);
        const dy = this.py(y);

        let sprite: TileSpriteName | null = null;
        switch (tile.kind) {
          case 'floor':
            sprite = variantFor(FLOOR_VARIANTS, x, y);
            break;
          case 'wall':
            sprite = variantFor(WALL_VARIANTS, x, y);
            break;
          case 'cover':
            ctx.fillStyle = PALETTE.floorShadow;
            ctx.fillRect(dx, dy, size, size);
            sprite = variantFor(COVER_VARIANTS, x, y);
            break;
          case 'door':
            ctx.fillStyle = PALETTE.floorShadow;
            ctx.fillRect(dx, dy, size, size);
            sprite = tile.open ? 'door_open' : 'door_closed';
            break;
          case 'vent':
            sprite = 'vent';
            break;
          default:
            sprite = null;
        }
        if (sprite) this.atlas.draw(ctx, sprite, dx, dy, size);

        // sealed doors read as hard-locked
        if (tile.kind === 'door' && tile.lockedTurns > 0) {
          ctx.strokeStyle = PALETTE.guardHunting;
          ctx.lineWidth = 2;
          ctx.strokeRect(dx + 1, dy + 1, size - 2, size - 2);
        }
      }
    }

    // --- grid -----------------------------------------------------------
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= floor.width; x++) {
      ctx.moveTo(this.px(x) + 0.5, this.py(0));
      ctx.lineTo(this.px(x) + 0.5, this.py(floor.height));
    }
    for (let y = 0; y <= floor.height; y++) {
      ctx.moveTo(this.px(0), this.py(y) + 0.5);
      ctx.lineTo(this.px(floor.width), this.py(y) + 0.5);
    }
    ctx.stroke();

    // --- vision cones ---------------------------------------------------
    if (!this.coneCache) this.coneCache = this.buildConeCache();
    for (const cell of this.coneCache) {
      if (!floor.discovered[cell.index]) continue;
      const x = cell.index % floor.width;
      const y = Math.floor(cell.index / floor.width);
      ctx.fillStyle = cell.camera
        ? PALETTE.cameraCone
        : cell.alert
          ? PALETTE.coneAlert
          : PALETTE.coneSafe;
      ctx.fillRect(this.px(x), this.py(y), size, size);
    }

    // --- agent scan pulse ------------------------------------------------
    for (let i = 0; i < floor.scanned.length; i++) {
      if (!floor.scanned[i]) continue;
      const x = i % floor.width;
      const y = Math.floor(i / floor.width);
      ctx.fillStyle = PALETTE.scan;
      ctx.fillRect(this.px(x), this.py(y), size, size);
    }

    // --- objectives ------------------------------------------------------
    const extraction = floor.extraction;
    if (floor.discovered[tileIndex(floor, extraction.x, extraction.y)]) {
      this.atlas.draw(ctx, 'extraction', this.px(extraction.x), this.py(extraction.y), size);
      if (this.game.objectiveComplete()) {
        drawObjectiveMarker(
          ctx,
          this.px(extraction.x) + size / 2,
          this.py(extraction.y) + size / 2,
          size,
          PALETTE.extraction,
          time,
        );
      }
    }

    for (const terminal of floor.terminals) {
      const i = tileIndex(floor, terminal.x, terminal.y);
      if (!floor.discovered[i]) continue;
      this.atlas.draw(
        ctx,
        terminal.kind === 'data' ? 'core' : 'terminal',
        this.px(terminal.x),
        this.py(terminal.y),
        size,
      );
      if (terminal.hacked) {
        ctx.strokeStyle = PALETTE.cameraDisabled;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.px(terminal.x) + size * 0.2, this.py(terminal.y) + size * 0.2);
        ctx.lineTo(this.px(terminal.x) + size * 0.8, this.py(terminal.y) + size * 0.8);
        ctx.stroke();
      } else if (terminal.kind === 'data') {
        drawObjectiveMarker(
          ctx,
          this.px(terminal.x) + size / 2,
          this.py(terminal.y) + size / 2,
          size,
          PALETTE.core,
          time,
        );
      }
    }

    for (const item of floor.loot) {
      if (item.taken) continue;
      const i = tileIndex(floor, item.x, item.y);
      if (!floor.discovered[i]) continue;
      const cx = this.px(item.x) + size / 2;
      const cy = this.py(item.y) + size / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = PALETTE.intel;
      ctx.shadowColor = PALETTE.intel;
      ctx.shadowBlur = size * 0.3;
      ctx.fillRect(-size * 0.12, -size * 0.12, size * 0.24, size * 0.24);
      ctx.restore();
    }

    // --- noise -----------------------------------------------------------
    for (const noise of floor.noises) {
      drawNoiseRing(
        ctx,
        this.px(noise.x) + size / 2,
        this.py(noise.y) + size / 2,
        noise.radius * size,
        time,
      );
    }

    // --- entities ---------------------------------------------------------
    for (const camera of floor.cameras) {
      const i = tileIndex(floor, camera.x, camera.y);
      if (!floor.discovered[i]) continue;
      drawCamera(
        ctx,
        this.px(camera.x) + size / 2,
        this.py(camera.y) + size / 2,
        size,
        camera.facing,
        camera.disabledTurns > 0,
        time,
      );
    }

    for (const guard of floor.guards) {
      const i = tileIndex(floor, guard.x, guard.y);
      if (!floor.discovered[i]) continue;
      const stunned = guard.stunTurns > 0;
      const centreX = this.px(guard.x) + size / 2;
      const centreY = this.py(guard.y) + size / 2;
      const accent = guardAccent(guard.state, stunned);

      drawFacingTick(ctx, centreX, centreY, size, guard.facing, accent);
      this.atlas.draw(
        ctx,
        stunned
          ? 'guard_stunned'
          : guard.state === 'hunting'
            ? 'guard_hunting'
            : guard.state === 'suspicious'
              ? 'guard_suspicious'
              : 'guard_patrol',
        this.px(guard.x),
        this.py(guard.y),
        size,
      );
      drawGuardState(ctx, centreX, centreY, size, guard.state, stunned, time);
    }

    const playerX = this.px(s.player.x);
    const playerY = this.py(s.player.y);
    drawOperativeGlow(ctx, playerX + size / 2, playerY + size / 2, size, time);
    drawFacingTick(
      ctx,
      playerX + size / 2,
      playerY + size / 2,
      size,
      s.playerFacing,
      PALETTE.operative,
    );
    this.atlas.draw(ctx, 'operative', playerX, playerY, size);

    // --- fog of war -------------------------------------------------------
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const i = tileIndex(floor, x, y);
        if (floor.visible[i]) continue;
        ctx.fillStyle = floor.discovered[i] ? PALETTE.fogOverlay : PALETTE.unexplored;
        ctx.fillRect(this.px(x), this.py(y), size, size);
      }
    }

    // --- route preview ----------------------------------------------------
    if (this.routePreview?.length) {
      for (const step of this.routePreview) {
        ctx.fillStyle = step.risk > 0 ? PALETTE.routeRisky : PALETTE.routeSafe;
        ctx.globalAlpha = 0.5;
        const inset = size * 0.34;
        ctx.fillRect(
          this.px(step.x) + inset,
          this.py(step.y) + inset,
          size - inset * 2,
          size - inset * 2,
        );
        ctx.globalAlpha = 1;
      }
    }

    // --- hover ------------------------------------------------------------
    if (this.hover) {
      ctx.strokeStyle = PALETTE.operative;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this.px(this.hover.x) + 1, this.py(this.hover.y) + 1, size - 2, size - 2);
    }

    this.drawScanlines();
  }

  private drawScanlines(): void {
    const { ctx } = this;
    const height = this.canvas.height;
    const width = this.canvas.width;
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#000';
    for (let y = 0; y < height; y += 3) {
      ctx.fillRect(0, y, width, 1);
    }
    ctx.restore();
  }
}
