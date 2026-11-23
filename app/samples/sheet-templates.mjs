// Zeichnet die Vorlagen der Figurenblätter neu: node app/samples/sheet-templates.mjs → plan_figurenblatt
// Raster wie SHEET_PANELS in app/shared, Größe 1920 × 1088; harness/figuren.mjs prüft die Größe.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sharp = createRequire(new URL('../server/package.json', import.meta.url))('sharp');
const out = (name) => fileURLToPath(new URL(name, import.meta.url));
const W = 1920, H = 1088;

// --- Figur: Grauflächen-Puppe, nur Grau, damit weder Haut- noch Haarfarbe abfärbt ---
const B = '#9c9c9c', D = '#828282', SKIN = '#dcdcdc', HAIR = '#555555', EYE = '#3a3a3a', SH = '#ececec';
const shadow = (cx) => `<ellipse cx="${cx}" cy="925" rx="110" ry="16" fill="${SH}"/>`;
const front = (cx) => shadow(cx) + `
  <rect x="${cx - 125}" y="255" width="38" height="340" rx="19" fill="${D}"/><rect x="${cx + 87}" y="255" width="38" height="340" rx="19" fill="${D}"/>
  <ellipse cx="${cx - 106}" cy="610" rx="20" ry="26" fill="${SKIN}"/><ellipse cx="${cx + 106}" cy="610" rx="20" ry="26" fill="${SKIN}"/>
  <rect x="${cx - 62}" y="510" width="56" height="395" rx="24" fill="${D}"/><rect x="${cx + 6}" y="510" width="56" height="395" rx="24" fill="${D}"/>
  <ellipse cx="${cx - 36}" cy="912" rx="34" ry="14" fill="${D}"/><ellipse cx="${cx + 36}" cy="912" rx="34" ry="14" fill="${D}"/>
  <rect x="${cx - 88}" y="245" width="176" height="300" rx="34" fill="${B}"/>
  <rect x="${cx - 16}" y="212" width="32" height="40" fill="${SKIN}"/>
  <ellipse cx="${cx}" cy="150" rx="52" ry="50" fill="${HAIR}"/>
  <ellipse cx="${cx}" cy="178" rx="41" ry="46" fill="${SKIN}"/>
  <circle cx="${cx - 15}" cy="172" r="4.5" fill="${EYE}"/><circle cx="${cx + 15}" cy="172" r="4.5" fill="${EYE}"/>
  <path d="M${cx - 5} 190 L${cx} 198 L${cx + 5} 190" stroke="#b0b0b0" stroke-width="3" fill="none"/>`;
const threeQuarter = (cx) => shadow(cx) + `
  <rect x="${cx - 88}" y="262" width="34" height="255" rx="17" fill="#767676"/>
  <ellipse cx="${cx - 71}" cy="530" rx="18" ry="25" fill="${SKIN}"/>
  <rect x="${cx - 48}" y="445" width="52" height="460" rx="24" fill="#767676"/>
  <ellipse cx="${cx - 6}" cy="913" rx="36" ry="13" fill="#767676"/>
  <rect x="${cx - 12}" y="445" width="58" height="460" rx="24" fill="${D}"/>
  <ellipse cx="${cx + 36}" cy="915" rx="42" ry="14" fill="${D}"/>
  <rect x="${cx - 70}" y="245" width="140" height="230" rx="34" fill="${B}"/>
  <rect x="${cx + 42}" y="258" width="38" height="268" rx="19" fill="${D}"/>
  <ellipse cx="${cx + 64}" cy="540" rx="19" ry="26" fill="${SKIN}"/>
  <rect x="${cx - 10}" y="212" width="32" height="40" fill="${SKIN}"/>
  <ellipse cx="${cx - 4}" cy="155" rx="50" ry="52" fill="${HAIR}"/>
  <ellipse cx="${cx + 14}" cy="180" rx="34" ry="45" fill="${SKIN}"/>
  <ellipse cx="${cx - 26}" cy="180" rx="8" ry="14" fill="${SKIN}"/>
  <path d="M${cx + 44} 170 L${cx + 56} 192 L${cx + 44} 196 Z" fill="${SKIN}"/>
  <circle cx="${cx + 22}" cy="172" r="4.5" fill="${EYE}"/>`;
const back = (cx) => shadow(cx) + `
  <rect x="${cx - 125}" y="255" width="38" height="340" rx="19" fill="${D}"/><rect x="${cx + 87}" y="255" width="38" height="340" rx="19" fill="${D}"/>
  <ellipse cx="${cx - 106}" cy="610" rx="20" ry="26" fill="${SKIN}"/><ellipse cx="${cx + 106}" cy="610" rx="20" ry="26" fill="${SKIN}"/>
  <rect x="${cx - 62}" y="510" width="56" height="395" rx="24" fill="${D}"/><rect x="${cx + 6}" y="510" width="56" height="395" rx="24" fill="${D}"/>
  <ellipse cx="${cx - 36}" cy="908" rx="30" ry="14" fill="${D}"/><ellipse cx="${cx + 36}" cy="908" rx="30" ry="14" fill="${D}"/>
  <rect x="${cx - 88}" y="245" width="176" height="300" rx="34" fill="${B}"/>
  <rect x="${cx - 16}" y="212" width="32" height="40" fill="${SKIN}"/>
  <ellipse cx="${cx - 46}" cy="182" rx="7" ry="13" fill="${SKIN}"/><ellipse cx="${cx + 46}" cy="182" rx="7" ry="13" fill="${SKIN}"/>
  <ellipse cx="${cx}" cy="168" rx="47" ry="58" fill="${HAIR}"/>`;
// Nahaufnahme leicht nach rechts gedreht statt Profil: im Profil malte FLUX eine fremde Person (gemessen 23.11.2026)
const closeUp = (cx) => `
  <path d="M${cx - 285} 1080 C${cx - 280} 830 ${cx - 200} 745 ${cx - 90} 730 L${cx + 90} 730 C${cx + 200} 745 ${cx + 280} 830 ${cx + 285} 1080 Z" fill="${B}"/>
  <rect x="${cx - 55}" y="600" width="120" height="140" fill="${SKIN}"/>
  <ellipse cx="${cx - 15}" cy="420" rx="178" ry="195" fill="${HAIR}"/>
  <ellipse cx="${cx + 15}" cy="475" rx="140" ry="180" fill="${SKIN}"/>
  <ellipse cx="${cx - 130}" cy="485" rx="22" ry="40" fill="${SKIN}"/>
  <ellipse cx="${cx - 5}" cy="335" rx="165" ry="80" fill="${HAIR}"/>
  <circle cx="${cx - 22}" cy="470" r="9" fill="${EYE}"/><circle cx="${cx + 78}" cy="470" r="9" fill="${EYE}"/>
  <path d="M${cx + 48} 485 L${cx + 66} 548 L${cx + 44} 553" stroke="#b0b0b0" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M${cx + 2} 605 Q${cx + 35} 615 ${cx + 68} 603" stroke="#a8a8a8" stroke-width="6" fill="none" stroke-linecap="round"/>`;
// Ganzkörper: Kopf oben bei 100, Schatten unten bei 941 → auf 25..1055 strecken; halbnah: kürzerer Rumpf, Kopf bei 240, Beine unter dem Bildrand
const big = (cx, f) => `<g transform="translate(${cx} 25) scale(1.225) translate(${-cx} -100)">${f(cx)}</g>`;
const american = (cx, f) => `<g transform="translate(${cx} 240) scale(2.3) translate(${-cx} -103)">${f(cx)}</g>`;
// Gezeichnet auf 1080 Höhe, auf 1088 gestreckt (0,7 %, unsichtbar)
const person = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 1920 1080" preserveAspectRatio="none">
<rect width="1920" height="1080" fill="#ffffff"/>${big(192, front)}${big(576, back)}${american(1056, threeQuarter)}${closeUp(1632)}</svg>`;
const flat = await sharp(Buffer.from(person)).flatten({ background: '#ffffff' }).raw().toBuffer();
const raw = { raw: { width: W, height: H, channels: 3 } };
// Nahaufnahme: Maske bis zum unteren Rand, sonst endet der Hals im Leeren und es entsteht eine Büste
const heads = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/>
  <ellipse cx="192" cy="102" rx="72" ry="84" fill="#fff"/><ellipse cx="576" cy="102" rx="72" ry="84" fill="#fff"/>
  <ellipse cx="1068" cy="383" rx="145" ry="155" fill="#fff"/><ellipse cx="1632" cy="470" rx="230" ry="250" fill="#fff"/>
  <rect x="1360" y="485" width="560" height="${H - 485}" fill="#fff"/></svg>`;
const mask = await sharp(Buffer.from(heads)).blur(14).extractChannel(0).raw().toBuffer();
/** Körper mit `body` verwischt, Köpfe mit `head`. */
async function blurred(body, head) {
  const soft = await sharp(flat, raw).blur(body).png().toBuffer();
  const full = await sharp(flat, raw).blur(head).raw().toBuffer();
  // joinChannel hängt hier kein Alpha an, darum RGBA von Hand
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = full[i * 3]; rgba[i * 4 + 1] = full[i * 3 + 1]; rgba[i * 4 + 2] = full[i * 3 + 2]; rgba[i * 4 + 3] = mask[i];
  }
  return sharp(soft).composite([{ input: rgba, raw: { width: W, height: H, channels: 4 } }]).png().toBuffer();
}
// FLUX: weich (40) zeichnet es hart und glänzend, scharf übernimmt es Flächen als Struktur; Versuch mit leicht verwischt
await sharp(await blurred(12, 4)).png().toFile(out('sheet-person.flux3-edit.png'));
// Qwen: Körper stark verwischt, sonst übernimmt es die kastige Puppe als Körperbau; Köpfe leicht, damit die Blickrichtung
// bleibt; blass auf 45 % des Abstands zu Weiß, damit die Puppe nur Lage und Pose vorgibt
await sharp(await blurred(40, 8)).linear(0.45, 255 * 0.55).png().toFile(out('sheet-person.png'));

// --- Kreatur und Objekt: nur Boden und weiche Flecken, die Platz und Größe zeigen, keine Form ---
const BLOB = '#d2d2d2', FLOOR = '#efefef';
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${body}</svg>`);
const floor = (cx, cy, rx) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${Math.round(rx / 7)}" fill="${FLOOR}"/>`;
const blob = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${BLOB}"/>`;
async function patches(file, floors, blobs) {
  const soft = await sharp(svg(blobs)).blur(38).png().toBuffer();
  await sharp(svg(floors)).composite([{ input: soft, blend: 'multiply' }]).png().toFile(out(file));
}
// 2 × 2 je 960 × 544: vorn | Seite / Rücken | Kopf nah
await patches('sheet-creature.png',
  floor(480, 500, 260) + floor(1440, 500, 380) + floor(480, 1044, 260),
  blob(480, 290, 190, 200) + blob(1440, 300, 330, 180) + blob(480, 834, 190, 200) + blob(1440, 816, 220, 230));
// vorn 448 | 45° 448 | Rücken 448 | Detail 576
await patches('sheet-product.png',
  floor(224, 960, 190) + floor(672, 960, 190) + floor(1120, 960, 190),
  blob(224, 640, 185, 290) + blob(672, 640, 185, 290) + blob(1120, 640, 185, 290) + blob(1632, 544, 260, 300));
console.log('Vorlagen geschrieben: sheet-person.png, sheet-person.flux3-edit.png, sheet-creature.png, sheet-product.png');
