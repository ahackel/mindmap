// ---- minimal ZIP writer + reader (store + deflate; no library) ----
// Used to move maps between devices: exportZip → zipBlob, importFiles → unzip.
// Zero-dependency: store entries are raw; deflate-raw via the platform
// DecompressionStream. crc32/inflateRaw are internal helpers.

// An entry to write: either raw `bytes` (e.g. an image) or UTF-8 `data` text.
export interface ZipInput { name: string; bytes?: Uint8Array; data?: string; }
// An entry read back out: text (decoded) plus the raw bytes (kept for binary entries).
export interface ZipEntry { name: string; text: string; bytes: Uint8Array; }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n=0;n<256;n++){ let c=n; for (let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[n]=c>>>0; }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i=0;i<bytes.length;i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// The archive as raw bytes — synchronous (store, no compression), so callers that need the
// data inside a single event handler (e.g. a dragstart's DownloadURL) can build it inline.
export function zipBytes(files: ZipInput[]): Uint8Array {
  const enc = new TextEncoder();
  const u16 = (v: number) => [v & 0xFF, (v>>>8) & 0xFF];
  const u32 = (v: number) => [v & 0xFF, (v>>>8) & 0xFF, (v>>>16) & 0xFF, (v>>>24) & 0xFF];
  const body: (Uint8Array)[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files){
    // f.bytes (a Uint8Array, e.g. an image) is stored verbatim; otherwise f.data is UTF-8 text.
    const name = enc.encode(f.name), data = f.bytes || enc.encode(f.data ?? ''), crc = crc32(data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ];
    body.push(new Uint8Array(local), name, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  }
  let centralSize = 0; for (const c of central) centralSize += c.length;
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  const parts = [...body, ...central, eocd];
  let size = 0; for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0; for (const p of parts){ out.set(p, at); at += p.length; }
  return out;
}
export function zipBlob(files: ZipInput[]): Blob {
  return new Blob([zipBytes(files) as BlobPart], { type:'application/zip' });
}
export async function unzip(buf: ArrayBuffer): Promise<ZipEntry[]> {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), dec = new TextDecoder();
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--){ if (dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; } }
  if (eocd < 0) throw new Error('Not a .zip file');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && off + 46 <= u8.length && dv.getUint32(off, true) === 0x02014b50; n++){
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    const lName = dv.getUint16(localOff + 26, true), lExtra = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lName + lExtra;
    const comp = u8.subarray(start, start + compSize);
    let data: Uint8Array | null = null;
    if (method === 0) data = comp;
    else if (method === 8) data = await inflateRaw(comp);
    if (data) out.push({ name, text: dec.decode(data), bytes: data });   // bytes kept for binary entries (images)
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
