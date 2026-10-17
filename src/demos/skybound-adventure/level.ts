import manifest from "../../../public/skybound-adventure/reference-map/manifest.json" with { type: "json" };
import type { Enemy, LevelDefinition, Platform, Rect } from "./contracts";
import type { ReferenceMapManifest } from "./reference-types";

const art = manifest as ReferenceMapManifest;
// Authored bodies must not change when an RGBA matte is trimmed or cleaned.
const enemies: Enemy[] = [
  { id: "slime-left", x: 597, y: 487, w: 28, h: 27, minX: 565, maxX: 630, speed: 23, facing: -1, alive: true },
  { id: "slime-mid", x: 973, y: 369, w: 29, h: 24, minX: 965, maxX: 1024, speed: 24, facing: -1, alive: true },
  { id: "slime-watch-a", x: 1074, y: 274, w: 24, h: 25, minX: 1052, maxX: 1088, speed: 18, facing: -1, alive: true },
  { id: "slime-watch-b", x: 1103, y: 275, w: 27, h: 24, minX: 1095, maxX: 1110, speed: 16, facing: -1, alive: true },
  { id: "slime-crate", x: 1158, y: 406, w: 30, h: 26, minX: 1151, maxX: 1164, speed: 12, facing: -1, alive: true },
  { id: "boar-low", x: 1305, y: 470, w: 40, h: 43, minX: 1254, maxX: 1380, speed: 32, facing: -1, alive: true },
  { id: "boar-bridge", x: 1382, y: 371, w: 46, h: 55, minX: 1365, maxX: 1405, speed: 28, facing: -1, alive: true },
];
// Deck collision planes are independent of source trims and hanging fittings.
const movingPlatforms: Platform[] = [
  { id: "drifter", kind: "moving", x: 668, y: 431, w: 110, h: 18, travelX: 40, travelY: -18, period: 4 },
  { id: "chain-lift", kind: "moving", x: 823, y: 507, w: 105, h: 18, travelX: 0, travelY: -70, period: 5 },
];

type Point = readonly [number, number];

/** Author collision outlines separately from image alpha. Compile their interiors
 * once into merged native-pixel bands, so concave rock/arch bounds never fill air.
 */
function terrain(id: string, outline: readonly Point[]): Platform {
  let x = outline[0]![0], y = outline[0]![1], right = x, bottom = y;
  for (const point of outline) {
    x = Math.min(x, point[0]);
    y = Math.min(y, point[1]);
    right = Math.max(right, point[0]);
    bottom = Math.max(bottom, point[1]);
  }
  const collisionRects: Rect[] = [];
  let previous: Rect[] = [];
  for (let row = y; row < bottom; row++) {
    const crossings: number[] = [];
    const scanY = row;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      if ((a[1] > scanY) === (b[1] > scanY)) continue;
      crossings.push(a[0] + (scanY - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    crossings.sort((a, b) => a - b);
    const current: Rect[] = [];
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      // Keep a half-pixel inside traced edges, including open-arch boundaries.
      const left = Math.ceil(crossings[i]! + 0.5);
      const width = Math.floor(crossings[i + 1]! - 0.5) - left;
      if (width <= 0) continue;
      const adjacent = previous.find((part) => part.x === left && part.w === width);
      if (adjacent) {
        adjacent.h++;
        current.push(adjacent);
      } else {
        const part = { x: left, y: row, w: width, h: 1 };
        collisionRects.push(part);
        current.push(part);
      }
    }
    previous = current;
  }
  return { id, kind: "solid", x, y, w: right - x, h: bottom - y, collisionRects };
}

/** Native-map physical outlines with stable standing planes, tapered undersides,
 * and open arches. Sky, vines, banners and other soft decoration are not walls.
 */
export const LEVEL: LevelDefinition = {
  name: "The Floating Kingdom",
  width: art.width,
  height: art.height,
  spawn: { x: 101, y: 388 },
  platforms: [
    // Start crossing: solid bridge above the waterfall, open shaft below.
    terrain("start", [[82,430],[125,431],[168,430],[212,431],[214,430],[241,430],[241,431],[270,430],[294,430],[324,430],[350,432],[351,452],[343,472],[342,492],[333,518],[321,541],[315,566],[300,594],[285,579],[278,561],[261,557],[252,535],[245,511],[238,485],[235,457],[241,449],[214,449],[211,490],[199,520],[191,532],[188,550],[182,548],[181,541],[171,541],[169,546],[161,547],[158,543],[154,539],[147,538],[141,540],[136,540],[132,545],[126,549],[123,554],[119,558],[117,563],[113,567],[111,573],[111,580],[114,586],[118,589],[119,593],[111,593],[107,592],[103,596],[100,598],[98,592],[98,587],[95,589],[92,595],[87,596],[83,586],[82,586]]),
    terrain("house-ledge", [[0,389],[57,389],[82,427],[82,586],[78,582],[76,566],[71,558],[67,541],[53,529],[36,532],[20,514],[0,505]]),
    terrain("start-crates", [[189,390],[211,390],[213,391],[239,390],[244,390],[272,391],[273,419],[250,421],[220,420],[190,421]]),
    terrain("upper-isle", [[372,285],[464,285],[462,305],[453,324],[447,345],[434,364],[425,384],[413,401],[401,390],[392,369],[380,360],[373,339],[368,313],[365,285]]),
    terrain("upper-rope", [[473,319],[501,319],[503,308],[530,312],[552,309],[588,312],[591,323],[588,330],[580,330],[578,327],[567,326],[562,324],[555,325],[550,327],[540,327],[533,325],[529,326],[525,327],[521,325],[511,327],[507,326],[505,330],[501,332],[473,327]]),
    terrain("left-garden", [[364,465],[507,465],[509,483],[500,504],[499,537],[489,557],[481,581],[467,598],[461,620],[446,642],[435,628],[426,609],[414,605],[402,590],[389,575],[386,552],[374,540],[373,511],[365,489]]),
    terrain("garden-crates", [[463,418],[495,418],[497,420],[535,420],[536,467],[509,474],[504,464],[463,462]]),
    terrain("stone-chip", [[561,400],[578,400],[595,400],[614,401],[615,413],[607,428],[594,431],[583,427],[565,428],[560,421]]),
    terrain("slime-isle", [[555,514],[668,514],[668,529],[659,544],[654,568],[641,590],[627,612],[613,625],[601,612],[591,598],[576,594],[571,576],[558,554],[555,533]]),
    terrain("lower-garden", [[249,626],[359,626],[360,644],[347,662],[343,687],[330,711],[315,739],[299,731],[291,717],[277,714],[265,690],[260,665],[250,649]]),
    terrain("lower-spikes-west", [[414,679],[697,679],[696,705],[680,724],[672,751],[656,767],[414,767]]),
    terrain("lower-spikes-east", [[732,679],[806,679],[816,683],[811,705],[795,725],[789,753],[777,767],[732,767]]),
    terrain("upper-west", [[579,208],[652,208],[651,231],[642,246],[638,266],[628,281],[614,272],[608,255],[597,250],[590,230],[581,224]]),
    terrain("upper-west-crate", [[614,173],[643,173],[646,178],[645,206],[614,206]]),
    terrain("upper-bank", [[709,208],[754,208],[761,230],[760,248],[730,254],[722,237],[710,231]]),
    terrain("upper-east-crate", [[737,173],[765,173],[769,179],[766,206],[737,205]]),
    // Trace bedrock, not the art-owner hull: the old underside filled the lift exit with sky.
    terrain("crown", [[770,250],[918,250],[925,255],[923,266],[917,269],[915,278],[910,281],[904,281],[903,275],[900,274],[899,286],[896,292],[892,296],[891,305],[886,310],[879,312],[873,309],[870,305],[869,330],[867,335],[863,340],[858,344],[857,354],[854,363],[850,371],[845,373],[840,371],[838,381],[836,391],[833,401],[829,408],[824,412],[819,409],[813,385],[798,378],[790,356],[779,340],[768,310],[750,296],[746,267],[761,248]]),
    // Bedrock ends before the decorative watch post; its sky gap stays open.
    terrain("mid-west", [[904,392],[1050,392],[1055,452],[1040,467],[1020,480],[1003,493],[987,509],[970,513],[954,501],[950,480],[937,469],[932,450],[917,440],[912,416]]),
    terrain("watch-beam", [[1045,299],[1137,299],[1139,312],[1128,325],[1102,321],[1072,323],[1047,315]]),
    terrain("banner-shelf", [[1008,464],[1098,464],[1097,487],[1087,508],[1079,535],[1064,559],[1051,576],[1037,562],[1025,541],[1019,516],[1010,497]]),
    terrain("crate-deck", [[1147,432],[1180,432],[1180,464],[1216,464],[1216,514],[1180,514],[1175,481],[1146,479]]),
    terrain("heartland", [[1116,432],[1146,432],[1151,463],[1176,466],[1177,514],[1456,514],[1459,544],[1453,560],[1435,566],[1427,588],[1410,602],[1404,626],[1385,646],[1373,672],[1353,692],[1328,705],[1304,697],[1284,685],[1274,665],[1260,652],[1245,642],[1233,625],[1211,626],[1194,648],[1179,672],[1165,696],[1138,701],[1118,687],[1114,662]]),
    terrain("ruin-west-column", [[1219,315],[1234,312],[1252,315],[1255,330],[1251,333],[1252,386],[1253,391],[1220,391]]),
    // The grass-bearing deck is solid; hanging ruin masonry is background
    // so the crate-to-heartland passage below cannot become a narrow-gap trap.
    terrain("ruin-ledge", [[1245,388],[1352,388],[1352,404],[1245,404]]),
    // Arch-cap: only the central top coping slab is a standable roof; lower ring is background.
    terrain("arch-cap", [[1300,266],[1310,258],[1329,258],[1338,259],[1352,260],[1356,273],[1352,275],[1294,275]]),
    // The walking deck and gate abutment are solid. Decorative western arch
    // supports must not seal the lower collectible route against heartland.
    terrain("bridge", [[1352,425],[1400,425],[1450,425],[1502,425],[1552,425],[1600,425],[1651,426],[1717,426],[1717,464],[1838,464],[1838,625],[1763,620],[1747,624],[1730,616],[1732,487],[1713,478],[1700,462],[1681,449],[1660,438],[1635,433],[1352,433]]),
    terrain("torch-shelf", [[1499,564],[1544,564],[1544,579],[1499,579]]),
    terrain("lower-bridge-step", [[1537,535],[1607,535],[1608,552],[1594,567],[1566,572],[1548,559]]),
    terrain("lower-crates", [[1562,571],[1595,571],[1601,601],[1637,604],[1638,630],[1598,632],[1590,605],[1562,604]]),
    terrain("lower-bridge-isle", [[1544,607],[1570,607],[1600,607],[1624,607],[1655,608],[1659,633],[1645,654],[1637,680],[1623,706],[1605,735],[1589,757],[1573,746],[1563,727],[1550,703],[1546,676],[1537,650]]),
    terrain("gate-isle", [[1764,393],[2051,393],[2051,580],[2034,600],[2018,612],[2003,588],[1992,568],[1979,557],[1966,534],[1944,521],[1926,540],[1918,566],[1901,590],[1884,598],[1871,576],[1856,563],[1850,540],[1832,532],[1825,510],[1809,502],[1793,478],[1780,459],[1767,438]]),
    ...movingPlatforms,
  ],
  enemies,
  crystals: art.layers.filter((layer) => layer.motion === "crystal").map((layer) => ({
    id: layer.binding!, x: layer.x + 2, y: layer.y + 2,
    w: layer.w - 4, h: layer.h - 4, collected: false,
  })),
  spikes: art.layers.filter((layer) => layer.motion === "spikes").map((layer) => ({
    x: layer.x + 2, y: layer.y + 3, w: layer.w - 4, h: layer.h - 3,
  })),
  checkpoints: [
    { id: "checkpoint-crown", x: 795, y: 196, w: 68, h: 54, spawnX: 810, spawnY: 208, active: false },
    { id: "checkpoint-arch", x: 1290, y: 204, w: 65, h: 54, spawnX: 1310, spawnY: 216, active: false },
  ],
  portal: { x: 1917, y: 293, w: 59, h: 100 },
};
