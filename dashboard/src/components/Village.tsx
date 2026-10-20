/**
 * v19.1 The village — the same bot, the same data, drawn as a small medieval pixel world.
 *
 * The guild hall in the middle is the bot. Eight villagers work for you: the Scout in the watchtower, the Analyst in
 * the observatory, the Trader at the trading post, the Risk keeper in the vault, the Clerk at the town board, the
 * Historian in the library, the Crier in the tavern and the Miner in the crypto mine. One apprentice per strategy ×
 * chart the bot has put to work wanders around the library. You walk the operator (arrows / WASD, tap to walk, the
 * d-pad on a phone), stand next to anyone and press E (or tap them) to open their screen: the same panels the
 * control room shows, with the full trade, its chart and every explanation.
 *
 * Everything is drawn in code (no image assets): tiles, buildings, people, smoke, the fountain. Day while forex is
 * open, night when it is closed. New bot decisions float up over the guild hall as they happen. Display only.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useWidth } from '../hooks/useWidth';
import { Icon } from './Icon';
import { Badge, Button } from './ui';
import { HubView, ROOMS, roomView, useControlRoomData, type CRData, type RoomKey } from './ControlRoom';

// ───────────────────────────── the world ─────────────────────────────
const T = 16; // one tile in logical pixels
const W = 30; // tiles
const H = 18;
type Tile = 'grass' | 'path' | 'water' | 'tree' | 'flower' | 'plaza' | 'bridge';
type Kind = 'hall' | 'tower' | 'dome' | 'stall' | 'vault' | 'board' | 'library' | 'tavern' | 'mine';
type Spot = RoomKey | 'hub';
interface Building { k: Spot; kind: Kind; x: number; y: number; w: number; h: number; door: number; name: string; roof: string; wall: string }

const BUILDINGS: Building[] = [
  { k: 'hub', kind: 'hall', x: 12, y: 2, w: 6, h: 4, door: 15, name: 'Guild hall · the bot', roof: '#5b4b8a', wall: '#c9b79c' },
  { k: 'scout', kind: 'tower', x: 4, y: 1, w: 3, h: 5, door: 5, name: 'Watchtower · Scout', roof: '#6b7280', wall: '#9ca3af' },
  { k: 'analyst', kind: 'dome', x: 23, y: 2, w: 4, h: 4, door: 24, name: 'Observatory · Analyst', roof: '#2f6f9f', wall: '#d6cbb5' },
  { k: 'trader', kind: 'stall', x: 2, y: 8, w: 4, h: 3, door: 3, name: 'Trading post · Trader', roof: '#b23a3a', wall: '#c8a165' },
  { k: 'risk', kind: 'vault', x: 24, y: 8, w: 4, h: 3, door: 25, name: 'Vault · Risk keeper', roof: '#4b5563', wall: '#8a8f99' },
  { k: 'decisions', kind: 'board', x: 3, y: 14, w: 2, h: 2, door: 3, name: 'Town board · Clerk', roof: '#7c5a3a', wall: '#a97c50' },
  { k: 'historian', kind: 'library', x: 9, y: 13, w: 5, h: 3, door: 11, name: 'Library · Historian', roof: '#7a4b2a', wall: '#d9c8a9' },
  { k: 'news', kind: 'tavern', x: 17, y: 13, w: 5, h: 3, door: 19, name: 'Tavern · Crier', roof: '#8a3b2a', wall: '#caa676' },
  { k: 'crypto', kind: 'mine', x: 25, y: 13, w: 4, h: 3, door: 26, name: 'Mine · Miner (crypto)', roof: '#6b5a3e', wall: '#857253' },
];
const doorTile = (b: Building) => ({ x: b.door, y: b.y + b.h });

/** a seeded random so the trees stand where they stood last time */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function buildMap(): Tile[][] {
  const m: Tile[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => 'grass' as Tile));
  // a river down the left edge with a bridge
  for (let y = 0; y < H; y++) {
    m[y]![0] = 'water';
    m[y]![1] = y === 9 ? 'bridge' : 'water';
  }
  // the plaza round the fountain
  for (let y = 6; y <= 11; y++) for (let x = 11; x <= 18; x++) m[y]![x] = 'plaza';
  // paths from every door to the plaza (L-shaped)
  const path = (x1: number, y1: number, x2: number, y2: number) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) if (m[y1]![x] === 'grass') m[y1]![x] = 'path';
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) if (m[y]![x2] === 'grass') m[y]![x2] = 'path';
  };
  for (const b of BUILDINGS) {
    const d = doorTile(b);
    if (b.k === 'hub') continue;
    const tx = Math.max(11, Math.min(18, d.x));
    const ty = Math.max(6, Math.min(11, d.y));
    if (d.y <= 6) path(d.x, d.y, tx, ty);
    else path(d.x, d.y, tx, ty);
  }
  path(2, 9, 11, 9); // the bridge road
  // trees + flowers on free grass, never on a door or right in front of one
  const r = rng(7);
  const blocked = new Set<string>();
  for (const b of BUILDINGS) {
    for (let y = b.y - 1; y <= b.y + b.h + 1; y++) for (let x = b.x - 1; x <= b.x + b.w; x++) blocked.add(`${x},${y}`);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 2; x < W; x++) {
      if (m[y]![x] !== 'grass' || blocked.has(`${x},${y}`)) continue;
      const v = r();
      if (v < 0.12) m[y]![x] = 'tree';
      else if (v < 0.2) m[y]![x] = 'flower';
    }
  }
  return m;
}
const MAP = buildMap();
const solid = new Set<string>();
for (const b of BUILDINGS) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) solid.add(`${x},${y}`);
const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !solid.has(`${x},${y}`) && MAP[y]![x] !== 'water' && MAP[y]![x] !== 'tree';

/** breadth-first path on the tile grid (540 tiles: cheap) */
function findPath(sx: number, sy: number, tx: number, ty: number): Array<[number, number]> {
  if (!walkable(tx, ty)) {
    // walk to the nearest walkable tile instead
    let best: [number, number] | null = null;
    let bd = 1e9;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walkable(x, y)) {
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (d < bd) { bd = d; best = [x, y]; }
    }
    if (!best) return [];
    [tx, ty] = best;
  }
  const prev = new Map<string, string>();
  const q: Array<[number, number]> = [[sx, sy]];
  const seen = new Set([`${sx},${sy}`]);
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || !walkable(nx, ny)) continue;
      seen.add(k);
      prev.set(k, `${x},${y}`);
      q.push([nx, ny]);
    }
  }
  if (!seen.has(`${tx},${ty}`)) return [];
  const out: Array<[number, number]> = [];
  let cur = `${tx},${ty}`;
  while (cur !== `${sx},${sy}`) {
    const [x, y] = cur.split(',').map(Number) as [number, number];
    out.unshift([x, y]);
    cur = prev.get(cur)!;
  }
  return out;
}

// ───────────────────────────── people ─────────────────────────────
type HatKind = 'none' | 'flat' | 'point' | 'crown' | 'helmet' | 'hood' | 'band';
interface Pal { skin: string; hair: string; cloak: string; belt: string; hat: string; hatKind: HatKind; beard?: string }
const PAL: Record<Spot | 'player' | 'apprentice', Pal> = {
  player: { skin: '#f1c9a5', hair: '#3b2a1a', cloak: '#f3f4f6', belt: '#d4a017', hat: '#f5c542', hatKind: 'crown' },
  hub: { skin: '#cbd5e1', hair: '#1f2937', cloak: '#5b4b8a', belt: '#f5c542', hat: '#5b4b8a', hatKind: 'hood' },
  scout: { skin: '#e8b88a', hair: '#2b1b0e', cloak: '#2f7d4f', belt: '#8b5a2b', hat: '#2f7d4f', hatKind: 'hood' },
  analyst: { skin: '#f1c9a5', hair: '#5b3a1a', cloak: '#2f6f9f', belt: '#d1d5db', hat: '#1e3a5f', hatKind: 'point' },
  trader: { skin: '#e8b88a', hair: '#1a1a1a', cloak: '#b23a3a', belt: '#f5c542', hat: '#7a1f1f', hatKind: 'flat' },
  risk: { skin: '#d9b48f', hair: '#6b7280', cloak: '#6b7280', belt: '#374151', hat: '#9ca3af', hatKind: 'helmet' },
  decisions: { skin: '#f1c9a5', hair: '#8b5a2b', cloak: '#7c3aed', belt: '#c4b5fd', hat: '#4c1d95', hatKind: 'flat' },
  historian: { skin: '#e9c9a8', hair: '#e5e7eb', cloak: '#7a4b2a', belt: '#d9c8a9', hat: '#7a4b2a', hatKind: 'none', beard: '#e5e7eb' },
  news: { skin: '#f1c9a5', hair: '#b45309', cloak: '#d97706', belt: '#7c2d12', hat: '#fbbf24', hatKind: 'band' },
  crypto: { skin: '#d9a984', hair: '#1a1a1a', cloak: '#ea580c', belt: '#1f2937', hat: '#fde68a', hatKind: 'helmet' },
  pnl: { skin: '#f1c9a5', hair: '#1f2937', cloak: '#0e7c86', belt: '#f5c542', hat: '#0e7c86', hatKind: 'flat' },
  apprentice: { skin: '#f1c9a5', hair: '#374151', cloak: '#64748b', belt: '#94a3b8', hat: '#64748b', hatKind: 'none' },
};
const NAMES: Record<RoomKey, string> = { scout: 'Scout', analyst: 'Analyst', trader: 'Trader', risk: 'Risk keeper', decisions: 'Clerk', historian: 'Historian', news: 'Crier', crypto: 'Miner', pnl: 'Treasurer' };

interface Mover {
  id: string;
  kind: Spot | 'player' | 'apprentice';
  label: string;
  tx: number; ty: number; // the tile it stands on (or walks from)
  px: number; py: number; // pixel position (top-left of its 16×16 cell)
  path: Array<[number, number]>;
  facing: 1 | -1;
  speed: number; // px per second
  idleUntil: number;
  home: { x: number; y: number };
  wander: number; // tiles it may stray from home
  small?: boolean;
  bubble?: string | null;
  busy?: boolean;
}
function mover(id: string, kind: Mover['kind'], label: string, x: number, y: number, speed: number, wander: number, small = false): Mover {
  return { id, kind, label, tx: x, ty: y, px: x * T, py: y * T, path: [], facing: 1, speed, idleUntil: 0, home: { x, y }, wander, small };
}
function stepMover(m: Mover, dt: number) {
  if (!m.path.length) return;
  const [nx, ny] = m.path[0]!;
  const gx = nx * T, gy = ny * T;
  const dx = gx - m.px, dy = gy - m.py;
  const dist = Math.hypot(dx, dy);
  const step = m.speed * dt;
  if (dx !== 0) m.facing = dx > 0 ? 1 : -1;
  if (dist <= step) {
    m.px = gx; m.py = gy; m.tx = nx; m.ty = ny;
    m.path.shift();
  } else {
    m.px += (dx / dist) * step;
    m.py += (dy / dist) * step;
  }
}

// ───────────────────────────── drawing ─────────────────────────────
type Ctx = CanvasRenderingContext2D;
const rect = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => { c.fillStyle = col; c.fillRect(x, y, w, h); };

function drawTile(c: Ctx, t: Tile, x: number, y: number, r: () => number) {
  const X = x * T, Y = y * T;
  if (t === 'water' || t === 'bridge') {
    rect(c, X, Y, T, T, '#2b6cb0');
    for (let i = 0; i < 3; i++) rect(c, X + Math.floor(r() * 14), Y + Math.floor(r() * 14), 2, 1, '#63b3ed');
    if (t === 'bridge') { rect(c, X, Y + 3, T, 10, '#8b5a2b'); for (let i = 0; i < 4; i++) rect(c, X + i * 4, Y + 3, 1, 10, '#6b4423'); rect(c, X, Y + 2, T, 1, '#4a2f14'); rect(c, X, Y + 13, T, 1, '#4a2f14'); }
    return;
  }
  // grass base with noise
  rect(c, X, Y, T, T, '#4f9a3f');
  for (let i = 0; i < 6; i++) rect(c, X + Math.floor(r() * T), Y + Math.floor(r() * T), 1, 1, r() < 0.5 ? '#5fae4b' : '#447f36');
  if (t === 'path') { rect(c, X, Y, T, T, '#c9a66b'); for (let i = 0; i < 5; i++) rect(c, X + Math.floor(r() * T), Y + Math.floor(r() * T), 1, 1, '#b08f55'); }
  if (t === 'plaza') { rect(c, X, Y, T, T, '#b7b2a6'); rect(c, X, Y, T, 1, '#d2cdc1'); rect(c, X, Y, 1, T, '#d2cdc1'); rect(c, X + 8, Y + 8, 7, 7, '#aaa497'); rect(c, X, Y + 8, 7, 7, '#aea99c'); }
  if (t === 'flower') { const col = ['#f87171', '#fbbf24', '#f472b6', '#f3f4f6'][Math.floor(r() * 4)]!; rect(c, X + 5, Y + 6, 2, 2, col); rect(c, X + 10, Y + 10, 2, 2, col); rect(c, X + 6, Y + 8, 1, 3, '#2f6b2a'); }
  if (t === 'tree') {
    rect(c, X + 6, Y + 10, 4, 5, '#6b4423');
    rect(c, X + 2, Y + 3, 12, 8, '#2f7d3a'); rect(c, X + 4, Y + 1, 8, 3, '#2f7d3a'); rect(c, X + 1, Y + 6, 14, 3, '#2f7d3a');
    rect(c, X + 4, Y + 3, 4, 3, '#4caf50'); rect(c, X + 3, Y + 7, 3, 2, '#4caf50');
    rect(c, X + 3, Y + 11, 10, 1, '#25602c');
  }
}

function drawBuilding(c: Ctx, b: Building, night: boolean) {
  const X = b.x * T, Y = b.y * T, Wd = b.w * T, Ht = b.h * T;
  const win = night ? '#fde68a' : '#9ad0ec';
  const roofH = b.kind === 'tower' ? 14 : b.kind === 'dome' ? 26 : b.kind === 'board' ? 6 : 22;
  const dark = (hex: string) => hex + 'cc';
  if (b.kind === 'board') {
    rect(c, X + 6, Y + 10, 3, 22, '#6b4423'); rect(c, X + 23, Y + 10, 3, 22, '#6b4423');
    rect(c, X + 3, Y + 6, 26, 16, '#a97c50'); rect(c, X + 3, Y + 6, 26, 2, '#7c5a3a'); rect(c, X + 3, Y + 20, 26, 2, '#7c5a3a');
    rect(c, X + 6, Y + 9, 8, 9, '#f5f0e1'); rect(c, X + 16, Y + 9, 10, 5, '#f5f0e1'); rect(c, X + 16, Y + 15, 7, 3, '#f5f0e1');
    rect(c, X + 7, Y + 11, 6, 1, '#777'); rect(c, X + 7, Y + 13, 5, 1, '#777'); rect(c, X + 17, Y + 11, 8, 1, '#777');
    return;
  }
  if (b.kind === 'mine') {
    // a hill with a dark arch, rails and a cart
    rect(c, X, Y + 8, Wd, Ht - 8, '#6f8a4a'); rect(c, X + 4, Y + 3, Wd - 8, 6, '#6f8a4a'); rect(c, X + 10, Y, Wd - 20, 4, '#6f8a4a');
    rect(c, X + 2, Y + 10, Wd - 4, 2, '#5f7a3f');
    rect(c, X + 18, Y + 16, 28, 32, '#3b2f21'); rect(c, X + 22, Y + 12, 20, 6, '#3b2f21'); rect(c, X + 18, Y + 16, 28, 2, '#8a7a5a'); rect(c, X + 18, Y + 16, 2, 32, '#8a7a5a'); rect(c, X + 44, Y + 16, 2, 32, '#8a7a5a');
    rect(c, X + 26, Y + 24, 12, 24, '#120e08');
    rect(c, X + 2, Y + 42, Wd - 4, 1, '#555'); rect(c, X + 2, Y + 45, Wd - 4, 1, '#555');
    for (let i = 0; i < 8; i++) rect(c, X + 4 + i * 8, Y + 41, 3, 6, '#6b4423');
    rect(c, X + 4, Y + 34, 12, 8, '#4b5563'); rect(c, X + 5, Y + 31, 10, 4, '#f59e0b'); rect(c, X + 5, Y + 42, 3, 3, '#1f2937'); rect(c, X + 12, Y + 42, 3, 3, '#1f2937');
    rect(c, X + 48, Y + 20, 10, 14, '#6b7280'); rect(c, X + 50, Y + 18, 6, 3, '#9ca3af');
    return;
  }
  // walls
  rect(c, X + 2, Y + roofH, Wd - 4, Ht - roofH, b.wall);
  rect(c, X + 2, Y + Ht - 2, Wd - 4, 2, dark(b.wall));
  rect(c, X + 2, Y + roofH, 2, Ht - roofH, dark(b.wall));
  if (b.kind === 'vault') for (let y = Y + roofH; y < Y + Ht; y += 6) for (let x = X + 2; x < X + Wd - 2; x += 10) rect(c, x + ((y / 6) % 2 ? 5 : 0), y, 9, 5, '#7b818c');
  if (b.kind === 'library') { rect(c, X + 6, Y + roofH + 4, Wd - 12, 2, '#7a4b2a'); for (let i = 0; i < 7; i++) rect(c, X + 7 + i * 9, Y + roofH + 7, 2, 10, ['#b91c1c', '#1d4ed8', '#047857', '#b45309', '#6d28d9', '#0e7490', '#9f1239'][i]!); }
  // roof
  if (b.kind === 'dome') {
    for (let i = 0; i < roofH; i++) {
      const t = i / roofH;
      const half = Math.round((Wd / 2 - 2) * Math.sqrt(1 - (1 - t) ** 2));
      rect(c, X + Wd / 2 - half, Y + i, half * 2, 1, i % 4 === 0 ? dark(b.roof) : b.roof);
    }
    rect(c, X + Wd / 2 - 3, Y + 4, 6, roofH - 4, '#1e3a5f'); rect(c, X + Wd / 2 - 1, Y + 1, 2, 4, '#e5e7eb');
  } else if (b.kind === 'tower') {
    rect(c, X, Y + 6, Wd, roofH - 6, b.roof);
    for (let i = 0; i < b.w * 2; i++) rect(c, X + i * 8, Y, 5, 7, i % 2 ? b.roof : 'transparent');
    rect(c, X + Wd / 2 - 1, Y - 10, 1, 12, '#6b4423'); rect(c, X + Wd / 2, Y - 10, 7, 4, '#2f7d4f');
  } else {
    for (let i = 0; i < roofH; i++) {
      const inset = Math.max(0, Math.round((roofH - 2 - i) * (Wd / 2 - 2) / (roofH - 2)));
      rect(c, X + inset, Y + i, Wd - inset * 2, 1, i % 3 === 0 ? dark(b.roof) : b.roof);
    }
    rect(c, X, Y + roofH - 2, Wd, 2, dark(b.roof));
  }
  if (b.kind === 'hall') { rect(c, X + Wd / 2 - 1, Y - 12, 1, 14, '#6b4423'); rect(c, X + Wd / 2, Y - 12, 9, 6, '#f5c542'); rect(c, X + Wd / 2 + 2, Y - 10, 5, 2, '#5b4b8a'); rect(c, X + Wd / 2 - 7, Y + roofH + 2, 14, 16, '#5b4b8a'); rect(c, X + Wd / 2 - 5, Y + roofH + 5, 10, 10, '#f5c542'); rect(c, X + Wd / 2 - 3, Y + roofH + 7, 6, 6, '#5b4b8a'); }
  if (b.kind === 'tavern') { rect(c, X + Wd - 14, Y + 2, 6, roofH - 2, '#6b7280'); rect(c, X + Wd - 15, Y + 1, 8, 2, '#4b5563'); rect(c, X + 4, Y + Ht - 12, 8, 10, '#8b5a2b'); rect(c, X + 4, Y + Ht - 9, 8, 1, '#4a2f14'); rect(c, X + 4, Y + Ht - 5, 8, 1, '#4a2f14'); }
  if (b.kind === 'stall') { for (let i = 0; i < Wd / 6; i++) rect(c, X + i * 6, Y + roofH - 6, 6, 6, i % 2 ? '#f3f4f6' : '#b23a3a'); rect(c, X + 4, Y + Ht - 14, Wd - 8, 4, '#8b5a2b'); rect(c, X + 6, Y + Ht - 18, 6, 4, '#f5c542'); rect(c, X + 14, Y + Ht - 18, 6, 4, '#34d399'); rect(c, X + 22, Y + Ht - 18, 6, 4, '#f87171'); }
  // windows
  const wy = Y + roofH + 6;
  if (b.kind !== 'stall') for (let x = X + 8; x < X + Wd - 10; x += 14) {
    if (Math.abs(x + 2 - (b.door * T + 8)) < 8) continue;
    rect(c, x, wy, 5, 6, win); rect(c, x + 2, wy, 1, 6, '#4b5563'); rect(c, x, wy + 3, 5, 1, '#4b5563');
    if (b.kind === 'vault') rect(c, x + 1, wy, 1, 6, '#1f2937');
  }
  // door
  const dx = b.door * T + 4;
  rect(c, dx, Y + Ht - 12, 8, 12, '#3b2a1a'); rect(c, dx + 1, Y + Ht - 11, 6, 10, '#5b3a1a'); rect(c, dx + 5, Y + Ht - 6, 1, 1, '#f5c542');
  if (b.kind === 'vault') { rect(c, dx - 1, Y + Ht - 13, 10, 13, '#374151'); rect(c, dx + 3, Y + Ht - 8, 3, 3, '#f5c542'); }
}

function drawPerson(c: Ctx, m: Mover, time: number, highlight: boolean) {
  const p = PAL[m.kind];
  const s = m.small ? 0.75 : 1;
  const x = Math.round(m.px), y = Math.round(m.py + (m.small ? 4 : 0));
  const walking = m.path.length > 0;
  const frame = walking ? Math.floor(time / 140) % 2 : 0;
  const bob = m.busy && !walking ? (Math.floor(time / 400) % 2) : 0;
  c.save();
  c.translate(x, y - bob);
  c.scale(s, s);
  // shadow
  rect(c, 4, 14, 8, 2, 'rgba(0,0,0,0.25)');
  // legs
  rect(c, 5, 11 + (frame ? 1 : 0), 2, 3 - (frame ? 1 : 0), '#2b2b2b'); rect(c, 9, 11 + (frame ? 0 : 1), 2, 3 - (frame ? 0 : 1), '#2b2b2b');
  // body
  rect(c, 5, 6, 6, 5, p.cloak); rect(c, 5, 9, 6, 1, p.belt);
  rect(c, m.facing === 1 ? 11 : 4, 6, 1, 4, p.cloak); rect(c, m.facing === 1 ? 4 : 11, 7, 1, 3, p.cloak);
  // head
  rect(c, 5, 1, 6, 5, p.skin);
  rect(c, m.facing === 1 ? 8 : 6, 3, 1, 1, '#1f2937'); rect(c, m.facing === 1 ? 10 : 5, 3, 1, 1, '#1f2937');
  if (p.beard) rect(c, 5, 5, 6, 2, p.beard);
  // hair / hat
  rect(c, 5, 0, 6, 2, p.hair);
  if (p.hatKind === 'hood') { rect(c, 4, 0, 8, 3, p.hat); rect(c, 4, 3, 1, 3, p.hat); rect(c, 11, 3, 1, 3, p.hat); }
  if (p.hatKind === 'flat') { rect(c, 4, 0, 8, 2, p.hat); rect(c, 5, -1, 6, 1, p.hat); }
  if (p.hatKind === 'point') { rect(c, 4, 1, 8, 1, p.hat); rect(c, 5, -1, 6, 2, p.hat); rect(c, 6, -3, 4, 2, p.hat); rect(c, 7, -5, 2, 2, p.hat); }
  if (p.hatKind === 'crown') { rect(c, 5, -1, 6, 2, p.hat); rect(c, 5, -3, 1, 2, p.hat); rect(c, 7, -3, 2, 2, p.hat); rect(c, 10, -3, 1, 2, p.hat); rect(c, 8, -1, 1, 1, '#ef4444'); }
  if (p.hatKind === 'helmet') { rect(c, 4, -1, 8, 3, p.hat); rect(c, 7, -2, 2, 1, p.hat); if (m.kind === 'crypto') rect(c, 7, -1, 2, 1, '#fff7ae'); }
  if (p.hatKind === 'band') { rect(c, 5, 0, 6, 1, p.hat); }
  if (highlight) { rect(c, 2, 13, 12, 1, '#fde68a'); rect(c, 1, 14, 14, 2, '#fde68a'); rect(c, 2, 16, 12, 1, '#fde68a'); rect(c, 4, 14, 8, 2, 'rgba(0,0,0,0.25)'); }
  c.restore();
}

/** every worker's one-liner + whether it is busy, from the shared data (the map and the roster read the same) */
function saysFor(X: CRData): Record<RoomKey, { bubble: string; busy: boolean }> {
  return {
    scout: { bubble: X.closest.length ? `${X.closest.length} setup${X.closest.length === 1 ? '' : 's'} close` : `${X.markets.length} markets`, busy: X.closest.length > 0 },
    analyst: { bubble: X.fm ? `${X.fm.id.length === 6 ? `${X.fm.id.slice(0, 3)}/${X.fm.id.slice(3)}` : X.fm.id} ${X.fm.trend === 'up' ? '▲' : X.fm.trend === 'down' ? '▼' : '→'}` : 'no chart yet', busy: !!X.fpos.length },
    trader: { bubble: X.positions.length ? `${X.positions.length} open ${usd(X.livePnlAll)}` : X.orders.length ? `${X.orders.length} order${X.orders.length === 1 ? '' : 's'} waiting` : 'no trade yet', busy: X.positions.length > 0 },
    risk: { bubble: `${X.d?.riskMode ?? 'normal'} mode`, busy: false },
    decisions: { bubble: X.d?.log?.[0]?.e.slice(0, 28) ?? 'nothing yet', busy: false },
    historian: { bubble: `${X.d?.chosen.length ?? 0} at work`, busy: false },
    news: { bubble: X.cal.data?.clock?.noNewTrades ? 'no new trades!' : (X.cal.data?.events ?? []).some((e) => e.t > X.now && e.t - X.now < 30 * 60_000 && e.impact === 'High') ? 'news in 30 min!' : 'quiet', busy: !!X.cal.data?.clock?.noNewTrades },
    crypto: { bubble: `${X.sys.data?.trading?.lastHour?.evaluated ?? 0} coins / h`, busy: (X.sys.data?.trading?.lastHour?.evaluated ?? 0) > 0 },
    pnl: { bubble: X.pnl.data?.periods?.today && X.pnl.data.periods.week ? `today ${usd(X.pnl.data.periods.today.pnlUsd)} · week ${usd(X.pnl.data.periods.week.pnlUsd)}` : 'counting…', busy: false },
  };
}

/** a worker's sprite as a small image for the roster (drawn once per kind) */
const spriteCache = new Map<string, string>();
function spriteUrl(kind: Mover['kind']): string {
  const hit = spriteCache.get(kind);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  const cv = document.createElement('canvas');
  cv.width = 48; cv.height = 66;
  const c = cv.getContext('2d');
  if (!c) return '';
  c.imageSmoothingEnabled = false;
  c.scale(3, 3);
  drawPerson(c, { id: kind, kind, label: '', tx: 0, ty: 0, px: 0, py: 6, path: [], facing: 1, speed: 0, idleUntil: 0, home: { x: 0, y: 0 }, wander: 0 }, 0, false);
  const url = cv.toDataURL();
  spriteCache.set(kind, url);
  return url;
}

// ───────────────────────────── the page ─────────────────────────────
interface Panel { k: Spot; apprentice?: string }
const usd = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(2)}`;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

export function Village() {
  const x = useControlRoomData();
  const dataRef = useRef(x);
  dataRef.current = x;
  const [wrapRef, wrapW] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelRef = useRef<Panel | null>(null);
  panelRef.current = panel;
  const [prompt, setPrompt] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [help, setHelp] = useState<boolean>(() => {
    try { return localStorage.getItem('village.help') !== 'seen'; } catch { return true; }
  });
  const closeHelp = () => { setHelp(false); try { localStorage.setItem('village.help', 'seen'); } catch { /* private mode */ } };
  const held = useRef<Set<string>>(new Set());
  const phone = wrapW > 0 && wrapW < 640;
  const scale = wrapW >= 1000 ? 2 : wrapW >= 720 ? 1.5 : 2;
  const viewW = Math.min(W * T, Math.floor(wrapW / scale));
  const viewH = phone ? 13 * T : H * T;

  // the world's people live in refs; React only sees the panel, the prompt and the hover label
  const world = useMemo(() => {
    const people: Mover[] = [];
    for (const b of BUILDINGS) {
      if (b.k === 'hub') continue;
      const d = doorTile(b);
      people.push(mover(b.k, b.k, NAMES[b.k], d.x, d.y, 28, b.k === 'scout' ? 5 : 3));
    }
    // the Treasurer counts the gold outside the vault
    people.push(mover('pnl', 'pnl', NAMES.pnl, 27, 12, 24, 2));
    const plaza = { x: 14, y: 9 };
    const player = mover('player', 'player', 'You', plaza.x, plaza.y, 56, 99);
    return { people, player, apprentices: [] as Mover[], toasts: [] as Array<{ t: number; text: string }>, seenLog: 0, hoverId: null as string | null, time: 0 };
  }, []);

  // keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') { setPanel(null); return; }
      if (panelRef.current) return;
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) { held.current.add(k); e.preventDefault(); }
      if (k === 'e' || k === 'enter' || k === ' ') { const near = nearest(); if (near) { setPanel(near); e.preventDefault(); } }
    };
    const up = (e: KeyboardEvent) => held.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** who is within reach of the operator: a villager / apprentice within 1.5 tiles, else a door the operator stands at */
  const nearest = (): Panel | null => {
    const p = world.player;
    let best: { d: number; panel: Panel } | null = null;
    for (const m of [...world.people, ...world.apprentices]) {
      const d = Math.hypot(m.px - p.px, m.py - p.py) / T;
      if (d <= 1.6 && (!best || d < best.d)) best = { d, panel: m.kind === 'apprentice' ? { k: 'historian', apprentice: m.label } : { k: m.kind as Spot } };
    }
    if (best) return best.panel;
    for (const b of BUILDINGS) {
      const d = doorTile(b);
      if (Math.abs(p.tx - d.x) <= 1 && Math.abs(p.ty - d.y) <= 1) return { k: b.k };
    }
    return null;
  };

  // the game loop
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || wrapW === 0) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(viewW * scale * dpr);
    cv.height = Math.round(viewH * scale * dpr);
    cv.style.width = `${viewW * scale}px`;
    cv.style.height = `${viewH * scale}px`;

    // the static map, drawn once per daylight state
    const stat = document.createElement('canvas');
    stat.width = W * T; stat.height = H * T;
    const sc = stat.getContext('2d')!;
    let statNight: boolean | null = null;
    const paintStatic = (night: boolean) => {
      const r = rng(11);
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) drawTile(sc, MAP[y]![xx]!, xx, y, r);
      // fountain
      const fx = 14 * T + 8, fy = 8 * T + 8;
      rect(sc, fx - 12, fy - 6, 24, 14, '#8f8a7e'); rect(sc, fx - 10, fy - 4, 20, 10, '#2b6cb0'); rect(sc, fx - 2, fy - 10, 4, 10, '#8f8a7e');
      for (const b of BUILDINGS) drawBuilding(sc, b, night);
      statNight = night;
    };

    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    const r2 = rng(3);
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      world.time = now;
      const X = dataRef.current;
      const night = !X.open;
      if (statNight !== night) paintStatic(night);

      // ── people's minds ──
      const p = world.player;
      if (!panelRef.current && !p.path.length) {
        const k = held.current;
        const dx = k.has('arrowright') || k.has('d') ? 1 : k.has('arrowleft') || k.has('a') ? -1 : 0;
        const dy = dx === 0 ? (k.has('arrowdown') || k.has('s') ? 1 : k.has('arrowup') || k.has('w') ? -1 : 0) : 0;
        if (dx || dy) { if (walkable(p.tx + dx, p.ty + dy)) p.path = [[p.tx + dx, p.ty + dy]]; else p.facing = dx === -1 ? -1 : dx === 1 ? 1 : p.facing; }
      }
      stepMover(p, dt);

      const says = saysFor(X);
      for (const m of world.people) {
        const s = says[m.kind as RoomKey];
        m.bubble = s.bubble;
        m.busy = s.busy;
        if (!still && !m.path.length && now > m.idleUntil) {
          if (m.busy && Math.random() < 0.7) { m.path = findPath(m.tx, m.ty, m.home.x, m.home.y); m.idleUntil = now + 4000 + Math.random() * 6000; }
          else {
            const goPlaza = Math.random() < 0.15;
            const cx = goPlaza ? 14 : m.home.x, cy = goPlaza ? 9 : m.home.y;
            const tx = cx + Math.round((r2() - 0.5) * 2 * m.wander), ty = cy + Math.round((r2() - 0.5) * 2 * m.wander);
            if (walkable(tx, ty)) m.path = findPath(m.tx, m.ty, tx, ty);
            m.idleUntil = now + 2500 + Math.random() * 7000;
          }
        }
        stepMover(m, dt);
      }
      // apprentices: one per strategy × chart the bot put to work, around the library
      const chosen = (X.d?.chosen ?? []).slice(0, 12);
      if (world.apprentices.length !== chosen.length || world.apprentices.some((a, i) => a.id !== chosen[i])) {
        world.apprentices = chosen.map((id, i) => {
          const name = `${X.names[id.split(':')[0]!] ?? id.split(':')[0]} · ${id.split(':')[1] ?? ''}`;
          const prev = world.apprentices.find((a) => a.id === id);
          return prev ? { ...prev, label: name } : mover(id, 'apprentice', name, 9 + (i % 6), 16 - Math.floor(i / 6), 20, 2, true);
        });
      }
      for (const a of world.apprentices) {
        if (!still && !a.path.length && now > a.idleUntil) {
          const tx = a.home.x + Math.round((r2() - 0.5) * 6), ty = a.home.y + Math.round((r2() - 0.5) * 2);
          if (walkable(tx, ty)) a.path = findPath(a.tx, a.ty, tx, ty);
          a.idleUntil = now + 3000 + Math.random() * 8000;
        }
        stepMover(a, dt);
      }
      // new decisions float up over the guild hall
      const newest = X.d?.log?.[0];
      if (newest && newest.t > world.seenLog) {
        if (world.seenLog > 0) world.toasts.push({ t: now, text: newest.e });
        world.seenLog = newest.t;
      }
      world.toasts = world.toasts.filter((t) => now - t.t < 7000).slice(-3);

      // ── camera ──
      const camX = Math.max(0, Math.min(W * T - viewW, p.px + 8 - viewW / 2));
      const camY = Math.max(0, Math.min(H * T - viewH, p.py + 8 - viewH / 2));
      const S = scale * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = night ? '#0b1020' : '#1f3a1a';
      ctx.fillRect(0, 0, cv.width, cv.height);
      const ox = viewW >= W * T ? Math.floor((viewW - W * T) / 2) : -Math.round(camX);
      const oy = viewH >= H * T ? Math.floor((viewH - H * T) / 2) : -Math.round(camY);
      ctx.setTransform(S, 0, 0, S, ox * S, oy * S);
      ctx.drawImage(stat, 0, 0);
      // water shimmer + fountain + smoke
      const ph = Math.floor(now / 500) % 2;
      for (let y = 0; y < H; y++) for (let xx = 0; xx < 2; xx++) if (MAP[y]![xx] === 'water') rect(ctx, xx * T + (ph ? 3 : 9), y * T + ((y * 5) % 12), 3, 1, '#9fd3ff');
      const fx = 14 * T + 8, fy = 8 * T + 8;
      for (let i = 0; i < 4; i++) { const t = ((now / 600) + i / 4) % 1; rect(ctx, fx - 1 + Math.round(Math.sin(i * 1.7) * 5 * t), fy - 10 - Math.round(Math.sin(t * Math.PI) * 8), 2, 2, '#bfe3ff'); }
      for (let i = 0; i < 3; i++) { const t = ((now / 2200) + i / 3) % 1; rect(ctx, 17 * T + 5 * T - 11 + Math.round(Math.sin(t * 6) * 2), 13 * T - 2 - Math.round(t * 22), 3 - Math.floor(t * 2), 3 - Math.floor(t * 2), `rgba(220,220,220,${0.6 - t * 0.5})`); }
      // people, back to front
      const all = [...world.people, ...world.apprentices, p].sort((a, b) => a.py - b.py);
      const near = nearest();
      for (const m of all) drawPerson(ctx, m, now, m.id !== 'player' && (world.hoverId === m.id || (near !== null && (m.kind === near.k || (near.apprentice !== undefined && m.label === near.apprentice)))));
      // night
      if (night) {
        ctx.fillStyle = 'rgba(8,12,40,0.5)';
        ctx.fillRect(0, 0, W * T, H * T);
        for (const b of BUILDINGS) {
          const d = doorTile(b);
          const g = ctx.createRadialGradient(d.x * T + 8, d.y * T - 4, 2, d.x * T + 8, d.y * T - 4, 26);
          g.addColorStop(0, 'rgba(255,220,120,0.45)'); g.addColorStop(1, 'rgba(255,220,120,0)');
          ctx.fillStyle = g; ctx.fillRect(d.x * T - 24, d.y * T - 30, 64, 56);
        }
        const rs = rng(5);
        for (let i = 0; i < 40; i++) { const sx = Math.floor(rs() * W * T), sy = Math.floor(rs() * 40); if (MAP[Math.floor(sy / T)]![Math.floor(sx / T)] === 'grass' || sy < 8) rect(ctx, sx, sy, 1, 1, (Math.floor(now / 700) + i) % 5 ? '#e5e7eb' : '#9ca3af'); }
      }
      // ── labels in screen space ──
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const toScreen = (lx: number, ly: number) => [(lx + ox) * scale, (ly + oy) * scale] as const;
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const label = (text: string, lx: number, ly: number, col = '#f8fafc', bg = 'rgba(15,23,42,0.75)') => {
        const [sx, sy] = toScreen(lx, ly);
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = bg; ctx.fillRect(sx - w / 2, sy - 14, w, 16);
        ctx.fillStyle = col; ctx.fillText(text, sx, sy - 2);
      };
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      for (const b of BUILDINGS) label(b.name, b.x * T + b.w * T / 2, b.y * T - (b.kind === 'hall' ? 14 : b.kind === 'tower' ? 12 : 2), '#f8fafc', 'rgba(15,23,42,0.7)');
      // every worker wears a name tag in its own colour; what it is doing floats above when it is busy, near you or hovered
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      for (const m of [...world.people, ...world.apprentices]) {
        const d = Math.hypot(m.px - p.px, m.py - p.py) / T;
        const near3 = d <= 2.5 || world.hoverId === m.id;
        if (m.small && !near3) continue;
        const col = PAL[m.kind].cloak;
        label(m.label, m.px + 8, m.py - 6, '#ffffff', col + 'e6');
        if (m.bubble && (near3 || m.busy)) {
          ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
          label(m.bubble, m.px + 8, m.py - 22, '#0f172a', 'rgba(255,255,255,0.94)');
          ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
        }
      }
      label('You', p.px + 8, p.py - 6, '#0f172a', 'rgba(253,230,138,0.95)');
      for (const [i, t] of world.toasts.entries()) {
        const age = (now - t.t) / 7000;
        label(t.text.length > 60 ? `${t.text.slice(0, 58)}…` : t.text, 15 * T, 1 * T - 20 - i * 18 - age * 10, '#fef3c7', `rgba(91,75,138,${0.9 - age * 0.7})`);
      }
      // the prompt / hover for React (only when it changed)
      const near2 = near ? (near.apprentice ? `E · talk to the apprentice on ${near.apprentice}` : `E · ${near.k === 'hub' ? 'enter the guild hall' : `talk to the ${NAMES[near.k]}`}`) : null;
      setPrompt((prev) => (prev === near2 ? prev : near2));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapW, viewW, viewH, scale]);

  /** screen → world tile / pixel */
  const toWorld = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const R = cv.getBoundingClientRect();
    const p = world.player;
    const camX = Math.max(0, Math.min(W * T - viewW, p.px + 8 - viewW / 2));
    const camY = Math.max(0, Math.min(H * T - viewH, p.py + 8 - viewH / 2));
    const ox = viewW >= W * T ? Math.floor((viewW - W * T) / 2) : -Math.round(camX);
    const oy = viewH >= H * T ? Math.floor((viewH - H * T) / 2) : -Math.round(camY);
    const lx = (e.clientX - R.left) / scale - ox;
    const ly = (e.clientY - R.top) / scale - oy;
    return { lx, ly, tx: Math.floor(lx / T), ty: Math.floor(ly / T) };
  };
  const hit = (lx: number, ly: number): Panel | null => {
    for (const m of [...world.apprentices, ...world.people]) if (lx >= m.px - 2 && lx <= m.px + 18 && ly >= m.py - 8 && ly <= m.py + 18) return m.kind === 'apprentice' ? { k: 'historian', apprentice: m.label } : { k: m.kind as Spot };
    for (const b of BUILDINGS) if (lx >= b.x * T && lx < (b.x + b.w) * T && ly >= b.y * T - 16 && ly < (b.y + b.h) * T) return { k: b.k };
    return null;
  };
  const onTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { lx, ly, tx, ty } = toWorld(e);
    const h = hit(lx, ly);
    if (h) { setPanel(h); return; }
    world.player.path = findPath(world.player.tx, world.player.ty, tx, ty);
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { lx, ly } = toWorld(e);
    let id: string | null = null;
    for (const m of [...world.apprentices, ...world.people]) if (lx >= m.px - 2 && lx <= m.px + 18 && ly >= m.py - 8 && ly <= m.py + 18) { id = m.id; break; }
    world.hoverId = id;
    const b = id ? null : BUILDINGS.find((bb) => lx >= bb.x * T && lx < (bb.x + bb.w) * T && ly >= bb.y * T - 16 && ly < (bb.y + bb.h) * T);
    const h = id ? [...world.apprentices, ...world.people].find((m) => m.id === id)!.label : b ? b.name : null;
    setHover((prev) => (prev === h ? prev : h));
  };
  const pad = (dir: string, on: boolean) => { if (on) held.current.add(dir); else held.current.delete(dir); };

  const equity = x.a?.equityUsd ?? null;
  const dayPnl = x.a ? x.a.closed.filter((c) => x.now - c.closedAt < 86_400_000).reduce((s, c) => s + c.pnlUsd, 0) : 0;

  return (
    <div ref={wrapRef} className="relative select-none">
      <div className="relative overflow-hidden rounded-xl border border-line bg-[#1f3a1a]" style={{ height: viewH * scale }}>
        <canvas
          ref={canvasRef}
          className="mx-auto block touch-none"
          style={{ imageRendering: 'pixelated', cursor: hover ? 'pointer' : 'crosshair' }}
          onPointerDown={onTap}
          onPointerMove={onMove}
          onPointerLeave={() => { world.hoverId = null; setHover(null); }}
          aria-label="The village: the bot's workers as villagers. Arrow keys or WASD walk, E talks, tap to walk or talk."
        />
        {/* HUD */}
        <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1 text-xs">
          <div className="rounded-lg bg-black/60 px-2 py-1 text-amber-200 backdrop-blur-sm">
            <span className="font-semibold">Gold</span> {equity !== null ? `$${equity.toFixed(0)}` : '—'} <span className={dayPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{usd(dayPnl)} today</span>
          </div>
          <div className="rounded-lg bg-black/60 px-2 py-1 text-slate-100 backdrop-blur-sm">
            <span className="font-semibold">{x.state.word}</span> · next look {mmss(x.next.at - x.now)} ({x.next.tf}) · {x.open ? 'day — forex open' : 'night — forex closed'}
          </div>
          {x.d?.why?.quiet && <div className="max-w-[min(92vw,560px)] rounded-lg bg-amber-300/95 px-2 py-1 text-slate-900"><span className="font-semibold">Why no trades? </span>{x.d.why.verdict}</div>}
          <div className="rounded-lg bg-black/60 px-2 py-1 text-slate-100 backdrop-blur-sm sm:hidden">{x.d?.chosen.length ?? 0} apprentices at work · {x.positions.length} trade{x.positions.length === 1 ? '' : 's'} open</div>
        </div>
        <button type="button" onClick={() => setHelp(true)} aria-label="How the village works" className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-sm font-bold text-slate-100 backdrop-blur-sm sm:top-10">?</button>
        <div className="pointer-events-none absolute right-2 top-2 hidden rounded-lg bg-black/60 px-2 py-1 text-xs text-slate-100 backdrop-blur-sm sm:block">
          {world.people.length} villagers · {(x.d?.chosen.length ?? 0)} apprentices at work · {x.positions.length} trade{x.positions.length === 1 ? '' : 's'} open
        </div>
        {prompt && !panel && (
          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-300 px-3 py-1 text-xs font-semibold text-slate-900 shadow">{prompt}</div>
        )}
        {hover && !prompt && !panel && <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-slate-100">{hover} · tap to open</div>}
        {/* phone d-pad + talk */}
        {phone && !panel && (
          <div className="absolute bottom-2 left-2 grid grid-cols-3 gap-1 text-slate-100">
            {[['', 'arrowup', ''], ['arrowleft', '', 'arrowright'], ['', 'arrowdown', '']].map((row, i) => row.map((d, j) => (
              d ? (
                <button key={`${i}${j}`} type="button" aria-label={d.replace('arrow', '')} className="h-10 w-10 rounded-lg bg-black/55 text-lg active:bg-black/80" onPointerDown={() => pad(d, true)} onPointerUp={() => pad(d, false)} onPointerCancel={() => pad(d, false)} onPointerLeave={() => pad(d, false)}>
                  {d === 'arrowup' ? '▲' : d === 'arrowdown' ? '▼' : d === 'arrowleft' ? '◀' : '▶'}
                </button>
              ) : <span key={`${i}${j}`} />
            )))}
          </div>
        )}
        {phone && !panel && prompt && (
          <button type="button" className="absolute bottom-2 right-2 h-12 w-12 rounded-full bg-amber-300 text-sm font-bold text-slate-900 shadow" onClick={() => { const n = nearest(); if (n) setPanel(n); }}>E</button>
        )}
        {/* the screen of whoever you talked to (desktop: a drawer inside the world) */}
        {panel && !phone && (
          <div className="absolute inset-y-0 right-0 z-20 w-[460px] max-w-full overflow-y-auto border-l border-line bg-surface p-3 shadow-2xl fade-in">
            <PanelBody panel={panel} x={x} onClose={() => setPanel(null)} />
          </div>
        )}
      </div>
      {panel && phone && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-surface p-3 pb-20 fade-in">
          <PanelBody panel={panel} x={x} onClose={() => setPanel(null)} />
        </div>
      )}
      {help && (
        <div className="card mt-3 p-3 sm:p-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name="sparkles" size={18} /></div>
            <div className="min-w-0 flex-1 text-sm text-ink-2">
              <div className="text-sm font-semibold text-ink">How the village works</div>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                <li><span className="font-semibold text-ink">The guild hall in the middle is the bot.</span> Each villager is one part of it: the Scout watches markets, the Analyst reads the chart, the Trader runs the open trades, the Risk keeper sizes them, the Treasurer counts the money, the Clerk logs decisions, the Historian grades strategies, the Crier watches the news, the Miner runs the crypto side.</li>
                <li><span className="font-semibold text-ink">The white bubble over a villager is what they are doing right now.</span> Their name tag is in their colour. The small grey ones by the library are apprentices: one per strategy the bot has put to work.</li>
                <li><span className="font-semibold text-ink">To open someone's screen</span>, tap them, or walk up with the arrows / WASD / the d-pad and press E. The list under the map does the same without walking.</li>
                <li>Daylight means forex is open; night means it is closed. New decisions float up over the guild hall.</li>
              </ul>
            </div>
            <Button size="sm" variant="ghost" onClick={closeHelp} aria-label="Close help"><Icon name="x" size={16} /></Button>
          </div>
        </div>
      )}
      <Roster x={x} onOpen={(pnl) => setPanel(pnl)} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>Walk: arrows / WASD or tap. Talk: stand next to someone and press E, or tap them. Esc closes a screen.</span>
        <button type="button" className="text-accent-text hover:underline" onClick={() => setHelp(true)}>How it works</button>
        <Link to="/forex" className="text-accent-text hover:underline">Control room view</Link>
        <Link to="/forex/bot" className="text-accent-text hover:underline">Auto-bot page</Link>
      </div>
    </div>
  );
}

/** who works for you, what they are doing now, one tap to open — the readable twin of the map */
function Roster({ x, onOpen }: { x: CRData; onOpen: (p: Panel) => void }) {
  const says = saysFor(x);
  const rows: Array<{ panel: Panel; kind: Mover['kind']; name: string; place: string; line: string; busy: boolean }> = [
    { panel: { k: 'hub' }, kind: 'hub', name: 'The bot', place: 'Guild hall', line: `${x.state.word} · next look ${mmss(x.next.at - x.now)}`, busy: x.positions.length > 0 },
    ...BUILDINGS.filter((b) => b.k !== 'hub').map((b) => {
      const k = b.k as RoomKey;
      return { panel: { k }, kind: k as Mover['kind'], name: NAMES[k], place: b.name.split(' · ')[0] ?? b.name, line: says[k].bubble, busy: says[k].busy };
    }),
    { panel: { k: 'pnl' }, kind: 'pnl', name: NAMES.pnl, place: 'Outside the vault', line: says.pnl.bubble, busy: false },
  ];
  const chosen = (x.d?.chosen ?? []).slice(0, 12);
  return (
    <div className="mt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink">Who is working right now</h2>
        <span className="text-xs text-muted">tap anyone to open their screen</span>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => (
          <li key={r.name}>
            <button type="button" onClick={() => onOpen(r.panel)} className="card cr-room flex w-full items-center gap-3 p-2.5 text-left">
              <img src={spriteUrl(r.kind)} alt="" width={32} height={44} className="shrink-0" style={{ imageRendering: 'pixelated' }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-ink">{r.name}</span>
                  <span className="truncate text-xs text-muted">{r.place}</span>
                  {r.busy && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-good" aria-label="busy" />}
                </div>
                <p className="truncate text-xs text-ink-2">{r.line}</p>
              </div>
              <Icon name="chevron" size={16} className="shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
      {chosen.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Apprentices (strategies at work):</span>
          {chosen.map((id) => {
            const name = `${x.names[id.split(':')[0]!] ?? id.split(':')[0]} · ${id.split(':')[1] ?? ''}`;
            return <button key={id} type="button" onClick={() => onOpen({ k: 'historian', apprentice: name })} className="min-h-7 rounded-full bg-surface-2 px-2.5 text-xs text-ink-2 hover:bg-surface-3">{name}</button>;
          })}
        </div>
      )}
    </div>
  );
}

function PanelBody({ panel, x, onClose }: { panel: Panel; x: CRData; onClose: () => void }) {
  const rk: RoomKey | null = panel.k === 'hub' ? null : panel.k;
  const isHub = rk === null;
  const r = rk ? ROOMS[rk] : null;
  const v = rk ? roomView(rk, x) : null;
  const row = panel.apprentice ? (x.lab.data?.last?.rows ?? []).find((rr) => `${rr.name} · ${rr.tf}` === panel.apprentice) ?? null : null;
  let body: ReactNode;
  if (isHub) body = <HubView x={x} />;
  else if (panel.k === 'trader') body = <><HubView x={x} /><div className="mt-3">{v!.body}</div></>;
  else body = v!.body;
  return (
    <div>
      <div className="mb-2 flex items-start gap-2">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-text"><Icon name={isHub ? 'cpu' : r!.icon} size={18} /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{isHub ? 'The guild hall · the bot' : panel.apprentice ? `Apprentice on ${panel.apprentice}` : `${NAMES[rk!]} · ${BUILDINGS.find((b) => b.k === rk)?.name.split(' · ')[0] ?? r!.name}`}</div>
          <p className="text-xs text-ink-2">{isHub ? x.state.word : panel.apprentice && row ? `Works the ${row.name} rule on the ${row.tf} chart · verdict ${row.verdict}` : v!.says}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></Button>
      </div>
      {panel.apprentice && row && <div className="mb-2"><Badge tone={row.verdict === 'edge' ? 'up' : row.verdict === 'maybe' ? 'warn' : 'neutral'}>{row.verdict === 'edge' ? 'Edge' : row.verdict === 'maybe' ? 'Maybe' : 'no edge yet'}</Badge></div>}
      {body}
    </div>
  );
}
