import { RNG } from './rng';
import type { Camera, FloorState, Guard, Loot, Terminal, Tile, Vec } from './types';

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  id: number;
}

export interface FloorConfig {
  index: number;
  width: number;
  height: number;
  roomTarget: number;
  guards: number;
  cameras: number;
  dataCores: number;
  lootCount: number;
}

/** Difficulty curve across the five floors of a run. */
export function floorConfig(index: number): FloorConfig {
  return {
    index,
    width: 30 + index * 3,
    height: 20 + index * 2,
    roomTarget: 6 + index,
    guards: 2 + index,
    cameras: index,
    dataCores: 1 + Math.floor(index / 2),
    lootCount: 3 + index,
  };
}

function idx(w: number, x: number, y: number): number {
  return y * w + x;
}

function roomCenter(r: Room): Vec {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

function overlaps(a: Room, b: Room): boolean {
  return (
    a.x - 1 < b.x + b.w + 1 &&
    a.x + a.w + 1 > b.x - 1 &&
    a.y - 1 < b.y + b.h + 1 &&
    a.y + a.h + 1 > b.y - 1
  );
}

export function generateFloor(seed: number, cfg: FloorConfig): FloorState {
  const rng = new RNG(seed + cfg.index * 7919);
  const { width: w, height: h } = cfg;
  const tiles: Tile[] = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    tiles[i] = { kind: 'wall', open: false, lockedTurns: 0, roomId: -1 };
  }

  // --- rooms -------------------------------------------------------------
  const rooms: Room[] = [];
  let attempts = 0;
  while (rooms.length < cfg.roomTarget && attempts < 400) {
    attempts++;
    const rw = rng.int(4, 8);
    const rh = rng.int(4, 7);
    const rx = rng.int(1, w - rw - 2);
    const ry = rng.int(1, h - rh - 2);
    const room: Room = { x: rx, y: ry, w: rw, h: rh, id: rooms.length };
    if (rooms.some((other) => overlaps(room, other))) continue;
    rooms.push(room);
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        tiles[idx(w, x, y)] = { kind: 'floor', open: false, lockedTurns: 0, roomId: room.id };
      }
    }
  }

  // --- corridors ---------------------------------------------------------
  const carve = (x: number, y: number) => {
    const t = tiles[idx(w, x, y)];
    if (t.kind === 'wall') {
      tiles[idx(w, x, y)] = { kind: 'floor', open: false, lockedTurns: 0, roomId: -1 };
    }
  };
  for (let i = 1; i < rooms.length; i++) {
    const a = roomCenter(rooms[i - 1]);
    const b = roomCenter(rooms[i]);
    const horizontalFirst = rng.next() < 0.5;
    if (horizontalFirst) {
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, a.y);
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(b.x, y);
    } else {
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(a.x, y);
      for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, b.y);
    }
  }
  // a couple of loops so the facility isn't a pure tree — gives real route choice
  for (let i = 0; i < 2 && rooms.length > 3; i++) {
    const a = roomCenter(rng.pick(rooms));
    const b = roomCenter(rng.pick(rooms));
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) carve(x, a.y);
    for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) carve(b.x, y);
  }

  // --- doors at chokepoints between corridor and room ---------------------
  const kindAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= w || y >= h ? 'wall' : tiles[idx(w, x, y)].kind;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const t = tiles[idx(w, x, y)];
      if (t.kind !== 'floor') continue;
      const nsWall = kindAt(x, y - 1) === 'wall' && kindAt(x, y + 1) === 'wall';
      const ewWall = kindAt(x - 1, y) === 'wall' && kindAt(x + 1, y) === 'wall';
      const horizontalChoke = nsWall && kindAt(x - 1, y) === 'floor' && kindAt(x + 1, y) === 'floor';
      const verticalChoke = ewWall && kindAt(x, y - 1) === 'floor' && kindAt(x, y + 1) === 'floor';
      if (!horizontalChoke && !verticalChoke) continue;
      const neighbourRooms = horizontalChoke
        ? [tiles[idx(w, x - 1, y)].roomId, tiles[idx(w, x + 1, y)].roomId]
        : [tiles[idx(w, x, y - 1)].roomId, tiles[idx(w, x, y + 1)].roomId];
      // only where a corridor meets a room, so doors read as thresholds
      if (neighbourRooms[0] === neighbourRooms[1]) continue;
      if (rng.next() < 0.75) {
        t.kind = 'door';
        t.open = rng.next() < 0.5;
      }
    }
  }

  // --- cover ------------------------------------------------------------
  for (const room of rooms) {
    const coverCount = rng.int(1, 4);
    for (let i = 0; i < coverCount; i++) {
      const x = rng.int(room.x, room.x + room.w - 1);
      const y = rng.int(room.y, room.y + room.h - 1);
      const t = tiles[idx(w, x, y)];
      if (t.kind === 'floor') t.kind = 'cover';
    }
  }

  // --- placement --------------------------------------------------------
  const freeTilesIn = (room: Room): Vec[] => {
    const out: Vec[] = [];
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (tiles[idx(w, x, y)].kind === 'floor') out.push({ x, y });
      }
    }
    return out;
  };

  const startRoom = rooms[0];
  const startCandidates = freeTilesIn(startRoom);
  const start = startCandidates.length ? startCandidates[0] : roomCenter(startRoom);

  // extraction goes in the room furthest (by walking distance) from the entry
  let extractionRoom = rooms[rooms.length - 1];
  let bestDist = -1;
  for (const room of rooms.slice(1)) {
    const c = roomCenter(room);
    const d = Math.abs(c.x - start.x) + Math.abs(c.y - start.y);
    if (d > bestDist) {
      bestDist = d;
      extractionRoom = room;
    }
  }
  const extraction = roomCenter(extractionRoom);
  if (tiles[idx(w, extraction.x, extraction.y)].kind === 'cover') {
    tiles[idx(w, extraction.x, extraction.y)].kind = 'floor';
  }

  const occupied = new Set<string>([`${start.x},${start.y}`, `${extraction.x},${extraction.y}`]);
  const takeSpot = (pool: Room[]): Vec | null => {
    for (let tries = 0; tries < 60; tries++) {
      const room = rng.pick(pool);
      const free = freeTilesIn(room).filter((v) => !occupied.has(`${v.x},${v.y}`));
      if (!free.length) continue;
      const spot = rng.pick(free);
      occupied.add(`${spot.x},${spot.y}`);
      return spot;
    }
    return null;
  };

  // data cores live away from the entry room so every run needs a real infiltration
  const coreRooms = rooms.length > 2 ? rooms.slice(1) : rooms;
  const terminals: Terminal[] = [];
  for (let i = 0; i < cfg.dataCores; i++) {
    const spot = takeSpot(coreRooms);
    if (spot) terminals.push({ id: `core-${i}`, x: spot.x, y: spot.y, kind: 'data', hacked: false });
  }
  const securityCount = Math.max(1, Math.floor(cfg.index / 2) + 1);
  for (let i = 0; i < securityCount; i++) {
    const spot = takeSpot(rooms);
    if (spot) {
      terminals.push({ id: `sec-${i}`, x: spot.x, y: spot.y, kind: 'security', hacked: false });
    }
  }

  const loot: Loot[] = [];
  for (let i = 0; i < cfg.lootCount; i++) {
    const spot = takeSpot(rooms);
    if (spot) {
      loot.push({ id: `loot-${i}`, x: spot.x, y: spot.y, value: rng.int(20, 60), taken: false });
    }
  }

  const guards: Guard[] = [];
  const patrolPool = rooms.length > 1 ? rooms.slice(1) : rooms;
  for (let i = 0; i < cfg.guards; i++) {
    const home = rng.pick(patrolPool);
    const spot = takeSpot([home]) ?? roomCenter(home);
    const waypointRooms = rng.shuffle(patrolPool).slice(0, rng.int(2, Math.min(4, patrolPool.length)));
    const route = waypointRooms.map(roomCenter);
    if (!route.length) route.push(roomCenter(home));
    guards.push({
      id: `guard-${i}`,
      x: spot.x,
      y: spot.y,
      facing: rng.pick([
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
      ]),
      route,
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 7,
      coneHalfAngleDeg: 45,
      stunTurns: 0,
    });
  }

  const cameras: Camera[] = [];
  for (let i = 0; i < cfg.cameras; i++) {
    const spot = takeSpot(rooms);
    if (!spot) continue;
    cameras.push({
      id: `cam-${i}`,
      x: spot.x,
      y: spot.y,
      facing: rng.pick([
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
      ]),
      visionRange: 6,
      coneHalfAngleDeg: 35,
      disabledTurns: 0,
    });
  }

  return {
    index: cfg.index,
    width: w,
    height: h,
    tiles,
    guards,
    cameras,
    terminals,
    loot,
    extraction,
    discovered: new Array(w * h).fill(false),
    visible: new Array(w * h).fill(false),
    scanned: new Array(w * h).fill(false),
    noises: [],
    // start position is returned via the helper below
  } satisfies FloorState;
}

/** The entry tile the operative spawns on for a generated floor. */
export function floorStart(floor: FloorState): Vec {
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      const t = floor.tiles[idx(floor.width, x, y)];
      if (t.kind === 'floor' && t.roomId === 0) return { x, y };
    }
  }
  return { x: 1, y: 1 };
}
