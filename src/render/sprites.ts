import { PALETTE } from './palette';
import type { GuardState } from '../game/types';

/**
 * Effects layer. Characters themselves are pixel-art sprites blitted from the
 * atlas; everything here is the live state a static sprite cannot carry —
 * glow, alert rings, facing ticks, noise pulses and objective markers.
 */

function withShadow(
  ctx: CanvasRenderingContext2D,
  colour: string,
  blur: number,
  draw: () => void,
): void {
  ctx.save();
  ctx.shadowColor = colour;
  ctx.shadowBlur = blur;
  draw();
  ctx.restore();
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawOperativeGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  time: number,
): void {
  const pulse = 0.5 + 0.5 * Math.sin(time / 420);
  const gradient = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.72);
  gradient.addColorStop(0, `rgba(125, 249, 255, ${0.26 + pulse * 0.12})`);
  gradient.addColorStop(1, 'rgba(125, 249, 255, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(cx - size * 0.72, cy - size * 0.72, size * 1.44, size * 1.44);
}

/** Small chevron on the tile edge showing which way an observer is looking. */
export function drawFacingTick(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  facing: { dx: number; dy: number },
  colour: string,
): void {
  const angle = Math.atan2(facing.dy, facing.dx);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size * 0.32, -size * 0.13);
  ctx.lineTo(size * 0.32, size * 0.13);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function guardColour(state: GuardState, stunned: boolean): string {
  if (stunned) return PALETTE.guardStunned;
  if (state === 'hunting') return PALETTE.guardHunting;
  if (state === 'suspicious') return PALETTE.guardSuspicious;
  return PALETTE.guardPatrol;
}

export function guardAccent(state: GuardState, stunned: boolean): string {
  return guardColour(state, stunned);
}

export function drawGuardState(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  state: GuardState,
  stunned: boolean,
  time: number,
): void {
  const s = size;

  if (state === 'hunting' && !stunned) {
    const pulse = 0.5 + 0.5 * Math.sin(time / 180);
    ctx.strokeStyle = `rgba(255, 84, 112, ${0.25 + pulse * 0.45})`;
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.46, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (stunned) {
    ctx.fillStyle = PALETTE.guardStunned;
    ctx.font = `${Math.round(s * 0.4)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('z', cx, cy - s * 0.42);
  }
}

export function drawCamera(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  facing: { dx: number; dy: number },
  disabled: boolean,
  time: number,
): void {
  const s = size;
  const colour = disabled ? PALETTE.cameraDisabled : PALETTE.camera;
  const angle = Math.atan2(facing.dy, facing.dx);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  withShadow(ctx, colour, disabled ? 0 : s * 0.3, () => {
    ctx.fillStyle = 'rgba(12, 18, 25, 0.95)';
    roundedRect(ctx, -s * 0.2, -s * 0.18, s * 0.32, s * 0.36, s * 0.1);
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.stroke();

    // lens
    ctx.beginPath();
    ctx.arc(s * 0.16, 0, s * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  });
  ctx.restore();

  if (disabled) {
    // looped feed marker
    ctx.strokeStyle = PALETTE.cameraDisabled;
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.24, cy - s * 0.24);
    ctx.lineTo(cx + s * 0.24, cy + s * 0.24);
    ctx.stroke();
  } else {
    const sweep = Math.sin(time / 700) * 0.1;
    ctx.strokeStyle = `rgba(197, 139, 255, ${0.3 + Math.abs(sweep) * 2})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.36, angle - 0.4, angle + 0.4);
    ctx.stroke();
  }
}

export function drawNoiseRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusPx: number,
  time: number,
): void {
  const pulse = (time % 900) / 900;
  ctx.strokeStyle = `rgba(255, 210, 77, ${0.5 * (1 - pulse)})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radiusPx * (0.5 + pulse * 0.5), 0, Math.PI * 2);
  ctx.stroke();
}

export function drawObjectiveMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  colour: string,
  time: number,
): void {
  const pulse = 0.5 + 0.5 * Math.sin(time / 500);
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.35 + pulse * 0.5;
  ctx.lineWidth = Math.max(1, size * 0.05);
  const r = size * (0.34 + pulse * 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
