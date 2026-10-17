/** Export the drawing canvas: PNG download and hand-rolled PDF download.
 *
 * No third-party export library: PNG uses the platform canvas encoder, PDF is
 * a minimal writer embedding the drawing as JPEG (DCTDecode) — every step is
 * logged so a corrupt export is debuggable.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('share');

export function flattenOnBackground(canvas: HTMLCanvasElement, bg: string): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    log.error('flatten: getContext(2d) null on export canvas');
    throw new Error('Export canvas is unavailable in this browser.');
  }
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (url.startsWith('blob:')) {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function downloadPNG(canvas: HTMLCanvasElement, bg: string): void {
  try {
    const flat = flattenOnBackground(canvas, bg);
    const url = flat.toDataURL('image/png');
    log.info(`downloadPNG: exporting ${flat.width}x${flat.height} payload_chars=${url.length}`);
    triggerDownload(url, `calcdraw-${Date.now()}.png`);
  } catch (e) {
    log.error('downloadPNG: failed', e);
    throw e instanceof Error ? e : new Error('Image export failed. See console.');
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    log.error(`base64ToBytes: invalid base64 (len=${b64.length})`, e);
    throw new Error('JPEG encoder produced invalid output. See console.', { cause: e });
  }
}

/** Minimal one-page PDF with the JPEG as a full-page image. Exported for testing. */
export function buildPdf(jpeg: Uint8Array, w: number, h: number): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const str = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    pos += b.length;
  };
  const raw = (b: Uint8Array) => {
    chunks.push(b);
    pos += b.length;
  };
  const obj = (body: string) => {
    offsets.push(pos);
    str(body);
  };

  str('%PDF-1.4\n');
  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  obj(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
  );
  const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
  const contentBytes = enc.encode(content);
  offsets.push(pos);
  str(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
  raw(contentBytes);
  str('endstream\nendobj\n');
  offsets.push(pos);
  str(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  raw(jpeg);
  str('\nendstream\nendobj\n');

  const xrefPos = pos;
  str(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) str(`${String(o).padStart(10, '0')} 00000 n \n`);
  str(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function downloadPDF(canvas: HTMLCanvasElement, bg: string): void {
  try {
    if (canvas.width === 0 || canvas.height === 0) {
      log.error(`downloadPDF: canvas has zero size ${canvas.width}x${canvas.height}`);
      throw new Error('Canvas is empty — nothing to export.');
    }
    const flat = flattenOnBackground(canvas, bg);
    const jpegUrl = flat.toDataURL('image/jpeg', 0.92);
    const comma = jpegUrl.indexOf(',');
    if (comma === -1) {
      log.error('downloadPDF: JPEG data URL malformed');
      throw new Error('JPEG encoder produced invalid output. See console.');
    }
    const jpeg = base64ToBytes(jpegUrl.slice(comma + 1));
    log.info(`downloadPDF: jpeg_bytes=${jpeg.length} page=${flat.width}x${flat.height}pt`);
    const pdf = buildPdf(jpeg, flat.width, flat.height);
    log.info(`downloadPDF: pdf_bytes=${pdf.length}`);
    const blob = new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' });
    triggerDownload(URL.createObjectURL(blob), `calcdraw-${Date.now()}.pdf`);
  } catch (e) {
    log.error('downloadPDF: failed', e);
    throw e instanceof Error ? e : new Error('PDF export failed. See console.');
  }
}
