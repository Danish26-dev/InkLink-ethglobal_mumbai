import * as THREE from 'three';

function finish(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

/** A printed INKLINK job sheet (Paper White with ink text blocks). */
export function makePrintedSheet() {
  const { c, g } = canvas(512, 683);
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, 512, 683);
  g.fillStyle = '#F15A36';
  g.fillRect(44, 48, 34, 34);
  g.fillStyle = '#111111';
  g.font = '700 28px sans-serif';
  g.fillText('INKLINK', 92, 76);
  g.fillStyle = '#777777';
  g.font = '500 15px monospace';
  g.fillText('JOB REF 0001  ·  PAGE 1 / 1', 44, 124);
  g.fillStyle = '#111111';
  g.fillRect(44, 150, 424, 3);
  const rows = [0.95, 1, 0.88, 1, 0.6, 0, 1, 0.92, 1, 0.74, 0, 1, 0.97, 0.5];
  rows.forEach((w, i) => {
    if (!w) return;
    g.fillStyle = i % 5 === 0 ? '#111111' : '#9a9a96';
    g.fillRect(44, 184 + i * 30, 424 * w, i % 5 === 0 ? 12 : 8);
  });
  return finish(c);
}

/** Small instruction "chip" — structured print parameter. */
export function makeChipTexture(text: string) {
  const { c, g } = canvas(512, 128);
  g.fillStyle = '#FAFAF7';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#F15A36';
  g.fillRect(0, 0, 22, 128);
  g.strokeStyle = '#111111';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 508, 124);
  g.fillStyle = '#111111';
  g.font = '600 44px monospace';
  g.textBaseline = 'middle';
  g.fillText(text, 48, 66);
  return finish(c);
}

type PhoneKind = 'intent' | 'connect' | 'pay';

/** Screen content for the native INKLINK app. */
export function makePhoneTexture(kind: PhoneKind) {
  const { c, g } = canvas(512, 1024);
  g.fillStyle = '#111111';
  g.fillRect(0, 0, 512, 1024);
  g.fillStyle = '#F15A36';
  g.fillRect(36, 54, 26, 26);
  g.fillStyle = '#FAFAF7';
  g.font = '700 30px sans-serif';
  g.textBaseline = 'alphabetic';
  g.fillText('INKLINK', 74, 78);

  const bubble = (y: number, lines: string[], dark = false) => {
    const h = 40 + lines.length * 44;
    g.fillStyle = dark ? '#262626' : '#FAFAF7';
    g.fillRect(36, y, 440, h);
    g.fillStyle = dark ? '#FAFAF7' : '#111111';
    g.font = '500 30px sans-serif';
    lines.forEach((l, i) => g.fillText(l, 58, y + 54 + i * 44));
    return y + h;
  };

  if (kind === 'intent') {
    g.fillStyle = '#777777';
    g.font = '500 22px monospace';
    g.fillText('INSTRUCTION', 36, 160);
    const y = bubble(180, ['Print pages 1–4,', 'double-sided,', '2 copies.']);
    g.fillStyle = '#F15A36';
    g.beginPath();
    g.arc(52, y + 70, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#FAFAF7';
    g.font = '500 22px monospace';
    g.fillText('LOCAL SLM · ON-DEVICE', 74, y + 78);
    g.fillStyle = '#777777';
    g.fillText('→ structured job', 74, y + 112);
  } else if (kind === 'connect') {
    g.fillStyle = '#777777';
    g.font = '500 22px monospace';
    g.fillText('NEARBY PRINT SHOPS', 36, 160);
    const rows = ['Local gateway', 'Shop channel', 'Scan QR'];
    rows.forEach((r, i) => {
      g.fillStyle = i === 0 ? '#262626' : '#1a1a1a';
      g.fillRect(36, 190 + i * 110, 440, 92);
      g.fillStyle = i === 0 ? '#F15A36' : '#555555';
      g.beginPath();
      g.arc(76, 236 + i * 110, 11, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#FAFAF7';
      g.font = '500 30px sans-serif';
      g.fillText(r, 106, 246 + i * 110);
    });
  } else {
    g.fillStyle = '#777777';
    g.font = '500 22px monospace';
    g.fillText('QUOTATION', 36, 160);
    const y = bubble(180, ['12 pages · B/W', 'Quote ready'], true);
    g.fillStyle = '#F15A36';
    g.fillRect(36, y + 40, 440, 96);
    g.fillStyle = '#FAFAF7';
    g.font = '700 32px sans-serif';
    g.fillText('AUTHORIZE', 150, y + 100);
  }
  return finish(c);
}

let blob: THREE.CanvasTexture | null = null;
/** Soft radial contact shadow. */
export function getBlobTexture() {
  if (blob) return blob;
  const { c, g } = canvas(128, 128);
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.5)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.18)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  blob = new THREE.CanvasTexture(c);
  return blob;
}
