/**
 * Greenvale gameplay HUD.
 *
 * Layout (artboard coords):
 *   top-left  HP/mana/Lv     0,    0,  377, 117
 *   top-right Greenvale map  1262, 0,  274, 338  (+ quest log under map)
 *   bottom-left shortcut bar 0,    970, 520, 54
 *   bottom-right skills: compact 3×3 grid, 1135, 894, 360, 130
 *
 * Each rectangle is covered by an opaque parchment layer before any text
 * or icon is drawn. Static widgets (frames, shortcut bars, slot chrome)
 * are drawn exactly once during `createHud`; `update(state)` only mutates
 * the widgets that actually changed.
 *
 * Skill costs / cooldowns, HP/MANA caps, and the interact radius are
 * imported from `world.ts` so the HUD never invents values the
 * simulation does not honour. NPC positions and HERB positions come
 * from the world module too so any future position fix flows through
 * automatically.
 */

import { Container, Graphics, Text } from 'pixi.js';
import { GAME_FONT_FAMILY } from './font.js';
import { ATTACKS, HEIGHT, WIDTH } from './types.js';
import { drawAttackIcon } from './attack-icons.js';
import {
  HERBS, HERB_RADIUS, HP_MAX, INTERACT_RADIUS, MANA_MAX, NPCS,
  SKILL_COSTS, SKILL_COOLDOWNS,
} from './world.js';
import type { Attack, GameState, Hud, Resources, Skill } from './types.js';

interface Rect { x: number; y: number; width: number; height: number }

const TOP_LEFT = Object.freeze<Rect>({ x: 0, y: 0, width: 377, height: 117 });
const TOP_RIGHT = Object.freeze<Rect>({ x: 1262, y: 0, width: 274, height: 338 });
const BOTTOM_LEFT = Object.freeze<Rect>({ x: 0, y: 970, width: 520, height: 54 });
const BOTTOM_RIGHT = Object.freeze<Rect>({ x: 1135, y: 894, width: 360, height: 130 });
const PROMPT = Object.freeze<Rect>({ x: (WIDTH - 380) / 2, y: 900, width: 380, height: 64 });

interface MapLandmark {
  x: number; y: number; r: number; color: number; label: string;
}

const LANDMARKS: readonly MapLandmark[] = [
  { x: 200, y: 280, r: 38, color: 0x3d6cb4, label: 'House' },
  { x: 714, y: 254, r: 38, color: 0x6fc6e8, label: 'Fountain' },
  { x: 1180, y: 522, r: 32, color: 0xc0723b, label: 'Market' },
  { x: 170, y: 610, r: 28, color: 0x81cb45, label: 'Farm' },
  { x: 1280, y: 880, r: 30, color: 0x6e4a26, label: 'Forge' },
  { x: 768, y: 880, r: 26, color: 0x8a6a3a, label: 'Dock' },
  { x: 1112, y: 328, r: 22, color: 0x9a9a9a, label: 'Bridge' },
];

const COLOR = {
  paper: 0x2a2018, paperDark: 0x161210,
  frameDark: 0x1a1410, frameLight: 0x3a2a18,
  gold: 0xc89238, goldHi: 0xf3c25b,
  hp: 0xc9413e, hpDark: 0x5a1c1a,
  mana: 0x4a8ee0, manaDark: 0x1f3a60,
  text: 0xf3e8c8, textSoft: 0xc4b48a, textGold: 0xffd979,
  ghosted: 0x6a5a3e,
} as const;

const SKILL_SLOTS: readonly Skill[] = ['heal', 'ice', 'fire'];
const SKILL_LABEL: Readonly<Record<Skill, string>> = {
  heal: 'Heal', ice: 'Ice', fire: 'Fire',
};

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function projectWorld(mapRect: Rect, wx: number, wy: number): { x: number; y: number } {
  const sx = mapRect.width / WIDTH;
  const sy = mapRect.height / HEIGHT;
  return { x: mapRect.x + wx * sx, y: mapRect.y + wy * sy };
}

function drawFrameAndCover(g: Graphics, rect: Rect): void {
  g.rect(rect.x, rect.y, rect.width, rect.height).fill({ color: COLOR.paper });
  g.rect(rect.x, rect.y, rect.width, rect.height).fill({ color: COLOR.paperDark, alpha: 0.55 });
  g.rect(rect.x, rect.y, rect.width, rect.height).stroke({ color: COLOR.frameLight, width: 2, alpha: 0.95 });
  g.rect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2).stroke({ color: COLOR.frameDark, width: 1, alpha: 0.85 });
  g.rect(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6).stroke({ color: COLOR.gold, width: 1, alpha: 0.85 });
  const stud = 6;
  const offset = 6;
  const corners: Array<readonly [number, number]> = [
    [rect.x + offset, rect.y + offset],
    [rect.x + rect.width - offset, rect.y + offset],
    [rect.x + offset, rect.y + rect.height - offset],
    [rect.x + rect.width - offset, rect.y + rect.height - offset],
  ];
  for (const [cx, cy] of corners) {
    g.rect(cx - stud / 2, cy - stud / 2, stud, stud).fill({ color: COLOR.gold });
    g.rect(cx - stud / 2 + 1, cy - stud / 2 + 1, stud - 2, stud - 2).fill({ color: COLOR.goldHi });
  }
}

function drawBar(g: Graphics, rx: number, ry: number, rw: number, rh: number,
                fill: number, empty: number, ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filledWidth = Math.max(0, Math.round(rw * clamped));
  g.rect(rx, ry, rw, rh).fill({ color: 0x0a0806 });
  g.rect(rx + 1, ry + 1, rw - 2, rh - 2).fill({ color: empty, alpha: 0.95 });
  if (filledWidth > 0) {
    g.rect(rx + 1, ry + 1, filledWidth - 2, rh - 2).fill({ color: fill });
    g.rect(rx + 1, ry + 1, filledWidth - 2, 1).fill({ color: 0xffffff, alpha: 0.18 });
  }
}

function drawPotionIcon(g: Graphics, cx: number, cy: number, size: number, hot: boolean): void {
  const w = size * 0.78;
  const h = size * 0.92;
  const left = cx - w / 2;
  const top = cy - h / 2;
  const r = Math.max(2, Math.round(size * 0.18));
  g.rect(cx - size * 0.18, top - 1, size * 0.36, Math.max(3, size * 0.16))
    .fill({ color: hot ? COLOR.goldHi : COLOR.ghosted });
  g.roundRect(left, top + h * 0.18, w, h * 0.78, r)
    .fill({ color: hot ? COLOR.hp : 0x352620 });
  g.roundRect(left + 2, top + h * 0.34, w - 0.34, h * 0.24, Math.max(1, r - 2))
    .fill({ color: hot ? 0xff8a78 : 0x5e463a, alpha: 0.7 });
}

function drawIceIcon(g: Graphics, cx: number, cy: number, size: number, hot: boolean): void {
  const color = hot ? 0xc8e8ff : COLOR.ghosted;
  const r1 = size * 0.5;
  const r2 = size * 0.18;
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3;
    g.moveTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      .lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      .lineTo(cx + Math.cos(a + Math.PI / 3) * r2, cy + Math.sin(a + Math.PI / 3) * r2)
      .closePath()
      .fill({ color });
  }
  g.circle(cx, cy, size * 0.14).fill({ color });
}

function drawFlameIcon(g: Graphics, cx: number, cy: number, size: number, hot: boolean): void {
  const baseColor = hot ? 0xff7a2a : COLOR.ghosted;
  const innerColor = hot ? COLOR.goldHi : 0x6a5a3e;
  g.moveTo(cx, cy - size * 0.5)
    .bezierCurveTo(cx + size * 0.45, cy - size * 0.05, cx + size * 0.35, cy + size * 0.45, cx, cy + size * 0.5)
    .bezierCurveTo(cx - size * 0.35, cy + size * 0.45, cx - size * 0.45, cy - size * 0.05, cx, cy - size * 0.5)
    .fill({ color: baseColor });
  g.moveTo(cx, cy - size * 0.2)
    .bezierCurveTo(cx + size * 0.18, cy + size * 0.05, cx + size * 0.12, cy + size * 0.28, cx, cy + size * 0.3)
    .bezierCurveTo(cx - size * 0.12, cy + size * 0.28, cx - size * 0.18, cy + size * 0.05, cx, cy - size * 0.2)
    .fill({ color: innerColor });
}

function drawTalkIcon(g: Graphics, cx: number, cy: number, size: number, hot: boolean): void {
  const stroke = hot ? COLOR.text : COLOR.ghosted;
  const w = size * 1.1;
  const h = size * 0.78;
  g.roundRect(cx - w / 2, cy - h / 2, w, h, Math.max(2, size * 0.14))
    .stroke({ color: stroke, width: Math.max(2, size * 0.12) });
  g.moveTo(cx - size * 0.18, cy + h / 2 - 1)
    .lineTo(cx - size * 0.05, cy + h / 2 + size * 0.22)
    .lineTo(cx + size * 0.05, cy + h / 2 - 1)
    .stroke({ color: stroke, width: Math.max(2, size * 0.12) });
  for (let i = -1; i <= 1; i++) {
    g.circle(cx + i * size * 0.18, cy, size * 0.07).fill({ color: stroke });
  }
}

function drawSkillIcon(g: Graphics, slot: number, cx: number, cy: number, size: number, hot: boolean): void {
  if (slot === 0) drawPotionIcon(g, cx, cy, size, hot);
  else if (slot === 1) drawIceIcon(g, cx, cy, size, hot);
  else if (slot === 2) drawFlameIcon(g, cx, cy, size, hot);
  else drawTalkIcon(g, cx, cy, size, hot);
}

function buildShortcutBar(parent: Container): Container {
  const group = new Container({ label: 'hud-shortcuts' });
  parent.addChild(group);

  const cover = new Graphics();
  group.addChild(cover);
  drawFrameAndCover(cover, BOTTOM_LEFT);

  // Only actually-implemented controls (input.ts): WASD / Shift / E / 1-3.
  const keys: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'WASD', label: 'Move' },
    { key: 'Shift', label: 'Run' },
    { key: 'E', label: 'Interact' },
    { key: '1', label: 'Heal' },
    { key: '2', label: 'Ice' },
    { key: '3', label: 'Fire' },
  ];
  const slotWidth = (BOTTOM_LEFT.width - 32) / keys.length;
  for (let i = 0; i < keys.length; i++) {
    const item = keys[i]!;
    const baseX = BOTTOM_LEFT.x + 16 + slotWidth * i;
    const baseY = BOTTOM_LEFT.y + 6;
    const cap = new Graphics();
    cap.rect(baseX, baseY, 36, 22).fill({ color: 0x0a0806 });
    cap.rect(baseX + 1, baseY + 1, 34, 20).fill({ color: 0x2a2018 });
    cap.rect(baseX + 1, baseY + 1, 34, 20).stroke({ color: COLOR.gold, width: 1, alpha: 0.7 });
    cap.rect(baseX + 2, baseY + 3, 12, 1).fill({ color: 0xfff5d6, alpha: 0.25 });
    group.addChild(cap);

    const keyText = new Text({
      text: item.key,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '700', fill: hex(COLOR.textGold) },
    });
    keyText.anchor.set(0.5, 0.5);
    keyText.position.set(baseX + 18, baseY + 11);
    group.addChild(keyText);

    const capLabel = new Text({
      text: item.label,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 9, fontWeight: '600', fill: hex(COLOR.text) },
    });
    capLabel.anchor.set(0.5, 0);
    capLabel.position.set(baseX + 18, baseY + 24);
    group.addChild(capLabel);
  }
  return group;
}

function buildTopLeft(parent: Container): { group: Container; update(state: GameState): void } {
  const group = new Container({ label: 'hud-top-left' });
  parent.addChild(group);

  const cover = new Graphics();
  group.addChild(cover);
  drawFrameAndCover(cover, TOP_LEFT);

  const nameTag = new Text({
    text: 'Greenvale Hero',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 16, fontWeight: '700', fill: hex(COLOR.text) },
  });
  nameTag.position.set(TOP_LEFT.x + 8, TOP_LEFT.y + 4);
  group.addChild(nameTag);

  const hpLabel = new Text({
    text: 'HP',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 16, fontWeight: '700', fill: hex(COLOR.text) },
  });
  hpLabel.position.set(TOP_LEFT.x + 8, TOP_LEFT.y + 20);
  group.addChild(hpLabel);

  const manaLabel = new Text({
    text: 'MP',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 14, fontWeight: '600', fill: hex(COLOR.textSoft) },
  });
  manaLabel.position.set(TOP_LEFT.x + 8, TOP_LEFT.y + 62);
  group.addChild(manaLabel);

  const barX = TOP_LEFT.x + 70;
  const barW = TOP_LEFT.width - 86;
  const hpY = TOP_LEFT.y + 38;
  const manaY = TOP_LEFT.y + 70;

  const bars = new Graphics();
  bars.rect(barX - 1, hpY - 1, barW + 2, 16).stroke({ color: COLOR.gold, width: 1, alpha: 0.6 });
  bars.rect(barX - 1, manaY - 1, barW + 2, 14).stroke({ color: COLOR.gold, width: 1, alpha: 0.6 });
  group.addChild(bars);

  const hpFill = new Graphics();
  const manaFill = new Graphics();
  group.addChild(hpFill);
  group.addChild(manaFill);

  const hpText = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 13, fontWeight: '700', fill: hex(COLOR.text) },
  });
  hpText.anchor.set(0.5, 0.5);
  hpText.position.set(barX + barW / 2, hpY + 8);
  group.addChild(hpText);

  const manaText = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 12, fontWeight: '600', fill: hex(COLOR.text) },
  });
  manaText.anchor.set(0.5, 0.5);
  manaText.position.set(barX + barW / 2, manaY + 7);
  group.addChild(manaText);

  const lvBg = new Graphics();
  const lvX = TOP_LEFT.x + TOP_LEFT.width - 32;
  const lvY = TOP_LEFT.y + 30;
  lvBg.rect(lvX - 20, lvY - 11, 40, 22).fill({ color: COLOR.gold });
  lvBg.rect(lvX - 18, lvY - 9, 36, 18).fill({ color: COLOR.goldHi });
  group.addChild(lvBg);

  const lvLabel = new Text({
    text: 'Lv.1',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 13, fontWeight: '700', fill: hex(0x1a1410) },
  });
  lvLabel.anchor.set(0.5, 0.5);
  lvLabel.position.set(lvX, lvY);
  group.addChild(lvLabel);

  const xpUnderline = new Graphics();
  xpUnderline.rect(TOP_LEFT.x + 14, TOP_LEFT.y + 86, TOP_LEFT.width - 28, 1).fill({ color: COLOR.gold, alpha: 0.5 });
  group.addChild(xpUnderline);

  const questHint = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '600', fill: hex(COLOR.textGold) },
  });
  questHint.position.set(TOP_LEFT.x + 8, TOP_LEFT.y + 92);
  group.addChild(questHint);

  let lastHp = -1;
  let lastMana = -1;

  function update(state: GameState): void {
    const hpShown = Math.max(0, state.hp);
    const manaShown = Math.floor(Math.max(0, state.mana));
    if (hpShown !== lastHp) {
      hpFill.clear();
      drawBar(hpFill, barX, hpY, barW, 14, COLOR.hp, COLOR.hpDark, hpShown / HP_MAX);
      hpText.text = `${hpShown} / ${HP_MAX}`;
      lastHp = hpShown;
    }
    if (manaShown !== lastMana) {
      manaFill.clear();
      drawBar(manaFill, barX, manaY, barW, 12, COLOR.mana, COLOR.manaDark, manaShown / MANA_MAX);
      manaText.text = `${manaShown} / ${MANA_MAX}`;
      lastMana = manaShown;
    }
    questHint.text = `${Math.min(3, state.herbs)}/3 herbs • ${state.elderTalked ? 'Met Village Elder' : 'Meet Village Elder'}`;
  }

  return { group, update };
}

interface NearestProximity {
  inRange: boolean;
  hint: string;
  target: 'herb' | 'npc' | null;
}

function nearestProximity(state: GameState, result: NearestProximity): void {
  const r2 = INTERACT_RADIUS * INTERACT_RADIUS;
  let bestDist = r2;
  let bestKind: 'herb' | 'npc' | null = null;
  let bestHint = '';
  for (let i = 0; i < HERBS.length; i++) {
    if (state.collected[i]) continue;
    const h = HERBS[i]!;
    const dx = state.x - h.x;
    const dy = state.y - h.y;
    const d = dx * dx + dy * dy;
    if (d <= HERB_RADIUS * HERB_RADIUS && d <= bestDist) {
      bestDist = d;
      bestKind = 'herb';
      bestHint = 'Press E to gather herb';
    }
  }
  for (const npc of NPCS) {
    const dx = state.x - npc.x;
    const dy = state.y - npc.y;
    const d = dx * dx + dy * dy;
    if (d <= bestDist) {
      bestDist = d;
      bestKind = 'npc';
      bestHint = `Press E to talk to ${npc.name}`;
    }
  }
  result.inRange = bestKind !== null;
  result.hint = bestHint;
  result.target = bestKind;
}

function buildTopRight(parent: Container): { group: Container; update(state: GameState): void } {
  const group = new Container({ label: 'hud-top-right' });
  parent.addChild(group);

  const cover = new Graphics();
  group.addChild(cover);
  drawFrameAndCover(cover, TOP_RIGHT);

  const title = new Text({
    text: 'Greenvale Map',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 15, fontWeight: '700', fill: hex(COLOR.textGold) },
  });
  title.position.set(TOP_RIGHT.x + 16, TOP_RIGHT.y + 10);
  group.addChild(title);

  const subtitle = new Text({
    text: 'Riverside Village',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '500', fill: hex(COLOR.textSoft) },
  });
  subtitle.position.set(TOP_RIGHT.x + 16, TOP_RIGHT.y + 30);
  group.addChild(subtitle);

  const mapRect: Rect = {
    x: TOP_RIGHT.x + 12, y: TOP_RIGHT.y + 52,
    width: TOP_RIGHT.width - 24, height: 178,
  };
  const mapTerrain = new Graphics();
  group.addChild(mapTerrain);
  mapTerrain.rect(mapRect.x, mapRect.y, mapRect.width, mapRect.height).fill({ color: 0x0c1814 });
  mapTerrain.rect(mapRect.x, mapRect.y, mapRect.width, mapRect.height).stroke({ color: COLOR.gold, width: 1, alpha: 0.55 });
  mapTerrain.rect(mapRect.x, mapRect.y, mapRect.width, mapRect.height).fill({ color: 0x1d2a18 });

  const riverPts = [
    projectWorld(mapRect, 1180, 120), projectWorld(mapRect, 1280, 260),
    projectWorld(mapRect, 1340, 380), projectWorld(mapRect, 1300, 440),
    projectWorld(mapRect, 1240, 560), projectWorld(mapRect, 1320, 720),
    projectWorld(mapRect, 1240, 900),
  ];
  const riverRev = [
    projectWorld(mapRect, 1320, 940), projectWorld(mapRect, 1380, 540),
    projectWorld(mapRect, 1280, 160),
  ];
  mapTerrain.moveTo(riverPts[0]!.x, riverPts[0]!.y);
  for (let i = 1; i < riverPts.length - 1; i++) {
    const cur = riverPts[i]!;
    mapTerrain.bezierCurveTo(cur.x, cur.y, cur.x, cur.y, riverPts[i + 1]!.x, riverPts[i + 1]!.y);
  }
  for (let i = 0; i < riverRev.length - 1; i++) {
    const cur = riverRev[i]!;
    mapTerrain.bezierCurveTo(cur.x, cur.y, cur.x, cur.y, riverRev[i + 1]!.x, riverRev[i + 1]!.y);
  }
  mapTerrain.closePath().fill({ color: 0x2c5d8a, alpha: 0.85 });

  const pond = projectWorld(mapRect, 714, 254);
  mapTerrain.circle(pond.x, pond.y, 36 * Math.max(mapRect.width / WIDTH, mapRect.height / HEIGHT))
    .fill({ color: 0x2c5d8a, alpha: 0.85 });

  const cliff = [projectWorld(mapRect, 0, 820), projectWorld(mapRect, 220, 820),
                 projectWorld(mapRect, 220, 900), projectWorld(mapRect, 60, 940),
                 projectWorld(mapRect, 0, 990)];
  mapTerrain.moveTo(cliff[0]!.x, cliff[0]!.y);
  for (let i = 1; i < cliff.length; i++) mapTerrain.lineTo(cliff[i]!.x, cliff[i]!.y);
  mapTerrain.closePath().fill({ color: 0x4a4332, alpha: 0.9 });

  const drawPath = (points: Array<{ x: number; y: number }>): void => {
    if (points.length < 2) return;
    mapTerrain.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length - 1; i++) {
      const cur = points[i]!;
      mapTerrain.bezierCurveTo(cur.x, cur.y, cur.x, cur.y, points[i + 1]!.x, points[i + 1]!.y);
    }
    mapTerrain.stroke({ color: 0xc8a877, width: 3, alpha: 0.85 });
  };
  drawPath([
    projectWorld(mapRect, 200, 280), projectWorld(mapRect, 380, 280),
    projectWorld(mapRect, 440, 320), projectWorld(mapRect, 588, 312),
    projectWorld(mapRect, 740, 320), projectWorld(mapRect, 900, 360),
    projectWorld(mapRect, 1100, 440), projectWorld(mapRect, 1140, 490),
    projectWorld(mapRect, 1170, 510), projectWorld(mapRect, 1180, 522),
  ]);
  drawPath([
    projectWorld(mapRect, 588, 312), projectWorld(mapRect, 580, 500),
    projectWorld(mapRect, 640, 720), projectWorld(mapRect, 760, 940),
  ]);
  drawPath([
    projectWorld(mapRect, 1100, 440), projectWorld(mapRect, 1180, 600),
    projectWorld(mapRect, 1240, 740), projectWorld(mapRect, 1280, 880),
  ]);

  for (const lk of LANDMARKS) {
    const m = projectWorld(mapRect, lk.x, lk.y);
    const mr = Math.max(3, lk.r * Math.max(mapRect.width / WIDTH, mapRect.height / HEIGHT));
    mapTerrain.circle(m.x, m.y, mr).fill({ color: lk.color });
    mapTerrain.circle(m.x, m.y, mr).stroke({ color: 0x0a0806, width: 1 });
    const lbl = new Text({
      text: lk.label,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 9, fontWeight: '600', fill: hex(0xf3e8c8) },
    });
    lbl.anchor.set(0.5, 0.5);
    lbl.position.set(m.x, m.y + mr + 7);
    group.addChild(lbl);
  }

  for (const npc of NPCS) {
    const m = projectWorld(mapRect, npc.x, npc.y);
    mapTerrain.circle(m.x, m.y, 3).fill({ color: 0xffd979 });
    mapTerrain.circle(m.x, m.y, 3).stroke({ color: 0x0a0806, width: 1 });
  }
  for (const h of HERBS) {
    const m = projectWorld(mapRect, h.x, h.y);
    mapTerrain.star(m.x, m.y, 5, 4, 1.6).fill({ color: 0xb2df63 });
  }

  // Hero marker geometry is built once and transformed per frame.
  const markerBase = new Graphics();
  markerBase.moveTo(0, -5).lineTo(-5, 4).lineTo(5, 4).closePath().fill({ color: 0xff5050 });
  markerBase.moveTo(0, -5).lineTo(-5, 4).lineTo(5, 4).closePath().stroke({ color: 0xfff5d6, width: 1, alpha: 0.85 });
  markerBase.ellipse(0, 6, 5, 2).fill({ color: 0x000000, alpha: 0.5 });
  group.addChild(markerBase);

  const questTitle = new Text({
    text: 'Quests',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 14, fontWeight: '700', fill: hex(COLOR.textGold) },
  });
  questTitle.position.set(TOP_RIGHT.x + 16, TOP_RIGHT.y + 238);
  group.addChild(questTitle);

  const mainQuestTag = new Text({
    text: 'Main',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '700', fill: hex(COLOR.textSoft) },
  });
  mainQuestTag.position.set(TOP_RIGHT.x + 16, TOP_RIGHT.y + 259);
  group.addChild(mainQuestTag);

  const mainQuest = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '600', fill: hex(COLOR.text),
             wordWrap: true, wordWrapWidth: TOP_RIGHT.width - 36 },
  });
  mainQuest.position.set(TOP_RIGHT.x + 28, TOP_RIGHT.y + 273);
  group.addChild(mainQuest);

  const sideQuestTag = new Text({
    text: 'Side',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '700', fill: hex(COLOR.textSoft) },
  });
  sideQuestTag.position.set(TOP_RIGHT.x + 16, TOP_RIGHT.y + 298);
  group.addChild(sideQuestTag);

  const sideQuest = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '600', fill: hex(COLOR.text),
             wordWrap: true, wordWrapWidth: TOP_RIGHT.width - 36 },
  });
  sideQuest.position.set(TOP_RIGHT.x + 28, TOP_RIGHT.y + 314);
  group.addChild(sideQuest);

  function update(state: GameState): void {
    markerBase.position.set(mapRect.x + state.x * mapRect.width / WIDTH,
      mapRect.y + state.y * mapRect.height / HEIGHT);
    markerBase.scale.x = state.facing >= 0 ? 1 : -1;

    mainQuest.text = state.elderTalked
      ? '✓ The Village Elder agreed.'
      : '• Find the Village Elder for a quest.';
    sideQuest.text = state.herbs >= 3
      ? '✓ Gather 3 healing herbs.'
      : `• Gather ${Math.min(3, state.herbs)}/3 healing herbs.`;
  }

  return { group, update };
}

interface SkillSlotWidgets {
  cell: Graphics;
  icon: Graphics;
  cooldownFill: Graphics;
  cooldownLabel: Text;
  label: Text;
  badge: Text;
  manaText: Text;
  skill: Skill;
  slotRect: Rect;
}

function paintSlot(cell: Graphics, slotRect: Rect, disabled: boolean, insufficient: boolean): void {
  cell.clear();
  if (disabled) {
    cell.rect(slotRect.x, slotRect.y, slotRect.width, slotRect.height).fill({ color: 0x0a0806 });
    cell.rect(slotRect.x + 1, slotRect.y + 1, slotRect.width - 2, slotRect.height - 2)
      .fill({ color: insufficient ? 0x20121a : 0x1a1812 });
    cell.rect(slotRect.x, slotRect.y, slotRect.width, slotRect.height)
      .stroke({ color: insufficient ? 0xb04848 : COLOR.gold, width: 1, alpha: 0.6 });
  } else {
    cell.rect(slotRect.x, slotRect.y, slotRect.width, slotRect.height).fill({ color: 0x0a0806 });
    cell.rect(slotRect.x + 1, slotRect.y + 1, slotRect.width - 2, slotRect.height - 2).fill({ color: 0x231a14 });
    cell.rect(slotRect.x, slotRect.y, slotRect.width, slotRect.height).stroke({ color: COLOR.gold, width: 1, alpha: 0.85 });
    cell.rect(slotRect.x + 3, slotRect.y + 3, slotRect.width - 6, slotRect.height - 6)
      .stroke({ color: 0xfff5d6, width: 1, alpha: 0.22 });
  }
}

export interface SkillRow {
  group: Container;
  update(state: GameState): void;
  /** True when at least one skill is mid-cooldown (drives prompt tinting). */
  activeCooldownSkill(state: GameState): Skill | null;
}

function buildBottomRight(): SkillRow {
  const group = new Container({ label: 'hud-bottom-right' });
  const cover = new Graphics();
  group.addChild(cover);
  drawFrameAndCover(cover, BOTTOM_RIGHT);

  const slotWidth = (BOTTOM_RIGHT.width - 20) / 3;
  const rowHeight = 38;
  const slots: SkillSlotWidgets[] = [];
  for (let i = 0; i < SKILL_SLOTS.length; i++) {
    const skill = SKILL_SLOTS[i]!;
    const slotRect: Rect = {
      x: BOTTOM_RIGHT.x + 10 + slotWidth * i,
      y: BOTTOM_RIGHT.y + 9,
      width: slotWidth - 4,
      height: rowHeight - 3,
    };
    const cell = new Graphics();
    group.addChild(cell);
    paintSlot(cell, slotRect, false, false);

    const icon = new Graphics();
    icon.position.set(slotRect.x + 18, slotRect.y + 18);
    group.addChild(icon);

    const cooldownFill = new Graphics();
    cooldownFill.visible = false;
    group.addChild(cooldownFill);

    const cooldownLabel = new Text({
      text: '',
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 13, fontWeight: '700', fill: hex(COLOR.textGold) },
    });
    cooldownLabel.anchor.set(0.5, 0.5);
    cooldownLabel.position.set(slotRect.x + 18, slotRect.y + 18);
    group.addChild(cooldownLabel);

    const badge = new Text({
      text: (i + 1).toString(),
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 10, fontWeight: '700', fill: hex(COLOR.textGold) },
    });
    badge.anchor.set(0.5, 0.5);
    badge.position.set(slotRect.x + slotRect.width - 8, slotRect.y + 10);
    group.addChild(badge);

    const label = new Text({
      text: SKILL_LABEL[skill],
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 11, fontWeight: '700', fill: hex(COLOR.text) },
    });
    label.anchor.set(0, 0.5);
    label.position.set(slotRect.x + 35, slotRect.y + 11);
    group.addChild(label);

    const manaText = new Text({
      text: `${SKILL_COSTS[skill]} MP`,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 9, fontWeight: '600', fill: hex(COLOR.textSoft) },
    });
    manaText.anchor.set(0, 0);
    manaText.position.set(slotRect.x + 35, slotRect.y + 21);
    group.addChild(manaText);

    slots.push({
      cell, icon, cooldownFill, cooldownLabel, label, badge, manaText,
      skill, slotRect,
    });
  }

  (Object.entries(ATTACKS) as [Attack, typeof ATTACKS[Attack]][]).forEach(([attack, action], i) => {
    const rect: Rect = {
      x: BOTTOM_RIGHT.x + 10 + slotWidth * (i % 3),
      y: BOTTOM_RIGHT.y + 9 + rowHeight * (1 + Math.floor(i / 3)),
      width: slotWidth - 4, height: rowHeight - 3,
    };
    const cell = new Graphics({ label: `hud-attack-${attack}` });
    paintSlot(cell, rect, false, false);
    drawAttackIcon(cell, attack, rect.x + 5, rect.y + 6);
    group.addChild(cell);
    const label = new Text({
      text: attack === 'ground' ? 'Ground\nStrike' : action.label,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 10, lineHeight: 12, fontWeight: '700', fill: hex(COLOR.text) },
    });
    label.position.set(rect.x + 35, rect.y + (attack === 'ground' ? 5 : 11));
    group.addChild(label);
    const badge = new Text({
      text: action.key,
      style: { fontFamily: GAME_FONT_FAMILY, fontSize: 10, fontWeight: '700', fill: hex(COLOR.textGold) },
    });
    badge.anchor.set(1, 0);
    badge.position.set(rect.x + rect.width - 4, rect.y + 3);
    group.addChild(badge);
  });

  let lastSnapshot = '';
  function update(state: GameState): void {
    let snapshot = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const skill = slot.skill;
      const cd = Math.max(0, state.cooldowns[skill] ?? 0);
      const manaCost = SKILL_COSTS[skill];
      const maxCd = SKILL_COOLDOWNS[skill];
      const insufficient = state.mana < manaCost && cd <= 0.001;
      const disabled = cd > 0 || insufficient;

      // Round snapshot strings so per-frame flicker doesn't redraw on
      // identical states — only when the rendered number actually changes.
      snapshot += `${i}:${cd.toFixed(3)}|${insufficient ? 1 : 0}|${state.mana.toFixed(1)};`;
      if (snapshot === lastSnapshot) continue;
      lastSnapshot = snapshot;

      paintSlot(slot.cell, slot.slotRect, disabled, insufficient);

      const r = slot.slotRect;
      slot.cooldownFill.clear();
      if (cd > 0) {
        const fillRatio = Math.max(0, Math.min(1, cd / maxCd));
        const sweep = Math.round(r.height * (1 - fillRatio));
        slot.cooldownFill.rect(r.x, r.y, r.width, r.height).fill({ color: 0x000000, alpha: 0.55 });
        slot.cooldownFill.rect(r.x, r.y + sweep, r.width, r.height - sweep)
          .fill({ color: 0x000000, alpha: 0 });
        slot.cooldownFill.visible = true;
        slot.cooldownLabel.text = cd.toFixed(1);
      } else {
        slot.cooldownFill.visible = false;
        slot.cooldownLabel.text = '';
      }

      slot.icon.alpha = disabled ? 0.6 : 1;
      slot.icon.clear();
      drawSkillIcon(slot.icon, i, 0, 0, 22, !disabled);

      const text = insufficient ? 'Low MP' : `${manaCost} MP`;
      if (slot.manaText.text !== text) slot.manaText.text = text;
      slot.manaText.style.fill = insufficient ? hex(0xff8a78) : hex(COLOR.textSoft);
    }
  }

  function activeCooldownSkill(state: GameState): Skill | null {
    for (const slot of slots) {
      if ((state.cooldowns[slot.skill] ?? 0) > 0) return slot.skill;
    }
    return null;
  }

  return { group, update, activeCooldownSkill };
}

export interface InteractionPromptRow {
  group: Container;
  update(state: GameState, proximity: NearestProximity): void;
}

function buildInteractionPrompt(skillRow: SkillRow): InteractionPromptRow {
  const group = new Container({ label: 'hud-prompt' });
  const cover = new Graphics();
  group.addChild(cover);
  drawFrameAndCover(cover, PROMPT);
  const tipX = PROMPT.x + PROMPT.width / 2;
  const tipY = PROMPT.y + PROMPT.height;
  cover.moveTo(tipX - 8, tipY).lineTo(tipX + 8, tipY).lineTo(tipX, tipY + 10).closePath()
    .fill({ color: COLOR.paper });
  cover.moveTo(tipX - 8, tipY).lineTo(tipX + 8, tipY).lineTo(tipX, tipY + 10).closePath()
    .stroke({ color: COLOR.gold, width: 1, alpha: 0.8 });

  const messageLabel = new Text({
    text: '',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 12, fontWeight: '700', fill: hex(COLOR.textGold),
             align: 'center', wordWrap: true, wordWrapWidth: PROMPT.width - 32 },
  });
  messageLabel.anchor.set(0.5, 0.5);
  messageLabel.position.set(PROMPT.x + PROMPT.width / 2, PROMPT.y + PROMPT.height / 2 - 6);
  group.addChild(messageLabel);

  const promptHint = new Text({
    text: 'Press E',
    style: { fontFamily: GAME_FONT_FAMILY, fontSize: 10, fontWeight: '500', fill: hex(COLOR.textSoft),
             align: 'center' },
  });
  promptHint.anchor.set(0.5, 0);
  promptHint.position.set(PROMPT.x + PROMPT.width / 2, PROMPT.y + PROMPT.height - 18);
  group.addChild(promptHint);

  // Hard cap so a long state.message can't overflow a 64px box.
  const MAX_MESSAGE_CHARS = 96;
  let previousMessage = '';
  let previousTime = -1;
  let messageUntil = 0;

  function update(state: GameState, proximity: NearestProximity): void {
    const skillOnCd = skillRow.activeCooldownSkill(state);
    const message = state.message ?? '';
    const hasMessage = message.trim().length > 0;
    if (message !== previousMessage || state.time < previousTime) {
      previousMessage = message;
      messageUntil = state.time + 5;
    }
    previousTime = state.time;
    const showMessage = hasMessage && state.time < messageUntil;
    group.visible = proximity.inRange || showMessage;

    if (showMessage) {
      const bounded = message.length > MAX_MESSAGE_CHARS
        ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`
        : message;
      messageLabel.text = bounded;
      promptHint.visible = false;
    } else if (proximity.inRange) {
      messageLabel.text = proximity.hint;
      promptHint.visible = true;
    } else {
      messageLabel.text = '';
      promptHint.visible = false;
    }
    messageLabel.style.fill = skillOnCd && proximity.inRange ? hex(0xff8a78) : hex(COLOR.textGold);
  }

  return { group, update };
}

export function createHud(resources: Resources): Hud {
  void resources;

  const root = new Container({ label: 'greenvale-hud', sortableChildren: true });

  const topLeft = buildTopLeft(root);
  const topRight = buildTopRight(root);
  const shortcuts = buildShortcutBar(root);
  const skillRow = buildBottomRight();
  root.addChild(skillRow.group);
  const prompt = buildInteractionPrompt(skillRow);
  root.addChild(prompt.group);

  let disposed = false;
  const proximity: NearestProximity = { inRange: false, hint: '', target: null };

  function update(state: GameState): void {
    if (disposed) return;
    nearestProximity(state, proximity);
    topLeft.update(state);
    topRight.update(state);
    skillRow.update(state);
    prompt.update(state, proximity);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.destroy({ children: true, texture: false, textureSource: false });
    // Drop closures so GC can clean.
    void shortcuts;
  }

  return { root, update, dispose };
}
