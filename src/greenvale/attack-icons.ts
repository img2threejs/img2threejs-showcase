import type { Graphics } from 'pixi.js';
import type { Attack } from './types.js';

// Authored pixel silhouettes: crescent, three cuts, lance, orbit, dash and pillars.
const ICONS: Record<Attack, readonly string[]> = {
  slash: ['       cc   ', '        wc  ', '         wc ', '         wc ', '         ww ', '        cww ', '       cww  ', '     ccww   ', '   ccww     ', ' ccww       ', 'cc          ', '            '],
  combo: [' cccc       ', '  wwwccc    ', '       www  ', '    c       ', '    wc      ', '    wc      ', '    wc   c  ', '    wc  cw  ', '    c  cw   ', '      cw    ', '     cw     ', '    c       '],
  thrust: ['            ', '            ', '         c  ', '      cccw  ', '   cccwwwwc ', 'cccwwwwwwwwc', '   cccwwwwc ', '      cccw  ', '         c  ', '            ', '            ', '            '],
  spin: ['            ', '    cccc    ', '  ccwwwwcc  ', ' cw      wc ', 'cw        wc', 'wc    w   cw', 'wc   ww   cw', ' cw  w   wc ', '  ccwwwwcc  ', '    cccc    ', '            ', '            '],
  dash: ['            ', '        ww  ', '        ww  ', 'cc    cww   ', '   ccwwwww  ', 'cc  ww  ww  ', '    ww      ', 'cccww ww    ', '   ww  ww   ', ' cc     ww  ', '            ', '            '],
  ground: ['     w      ', '    cwc     ', '    cwc  w  ', ' w  cwc cwc ', 'cwc cwc cwc ', 'cwc cwc cwc ', 'cwc cwc cwc ', 'cwc cwc cwc ', ' ww www ww  ', 'cccccccccccc', '  cc    cc  ', 'cc        cc'],
};
const COLORS = { c: '#438bd1', w: '#dcfaff' };

export function drawAttackIcon(g: Graphics, attack: Attack, x: number, y: number): void {
  ICONS[attack].forEach((row, ry) => [...row].forEach((cell, rx) => {
    if (cell === 'c' || cell === 'w') g.rect(x + rx * 2, y + ry * 2, 2, 2).fill(COLORS[cell]);
  }));
}

export function attackIconMarkup(attack: Attack): string {
  const pixels = ICONS[attack].flatMap((row, y) => [...row].map((cell, x) =>
    cell === 'c' || cell === 'w' ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${COLORS[cell]}"/>` : '')).join('');
  return `<svg class="greenvale-skill-icon" viewBox="0 0 12 12" width="24" height="24" aria-hidden="true" shape-rendering="crispEdges">${pixels}</svg>`;
}
