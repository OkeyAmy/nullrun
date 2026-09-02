/** Single source of truth for colour. Mirrors the ramps in tools/build-atlas.sh. */
export const PALETTE = {
  void: '#070b10',
  floorShadow: '#0d141c',
  fogOverlay: 'rgba(6, 10, 15, 0.72)',
  /* not fully opaque, so the grid still reads underneath and unexplored space
     looks like unlit facility rather than a hole in the page */
  unexplored: 'rgba(7, 11, 16, 0.88)',
  gridLine: 'rgba(125, 249, 255, 0.05)',

  operative: '#7df9ff',
  operativeDark: '#0b2b33',
  operativeGlow: 'rgba(125, 249, 255, 0.55)',

  guardPatrol: '#ffa63d',
  guardSuspicious: '#ffd24d',
  guardHunting: '#ff5470',
  guardStunned: '#6b8299',

  camera: '#c58bff',
  cameraDisabled: '#4a5568',

  coneSafe: 'rgba(255, 166, 61, 0.13)',
  coneAlert: 'rgba(255, 84, 112, 0.18)',
  coneEdge: 'rgba(255, 166, 61, 0.35)',
  coneEdgeAlert: 'rgba(255, 84, 112, 0.5)',
  cameraCone: 'rgba(197, 139, 255, 0.14)',

  noise: 'rgba(255, 210, 77, 0.5)',
  scan: 'rgba(125, 249, 255, 0.18)',
  routeSafe: 'rgba(109, 255, 168, 0.75)',
  routeRisky: 'rgba(255, 84, 112, 0.8)',

  extraction: '#6dffa8',
  core: '#7df9ff',
  terminal: '#ffc24d',
  intel: '#ffd24d',
} as const;
