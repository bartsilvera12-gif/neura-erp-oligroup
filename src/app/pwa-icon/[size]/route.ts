import zlib from "node:zlib";

export const runtime = "nodejs";
export const dynamic = "force-static";

const SIZES = [192, 512];

const GLYPHS: Record<string, string[]> = {
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** Ícono PNG simple de OLI GROUP: fondo azul oscuro con las letras "OG" en blanco. */
function makeIcon(size: number): Buffer {
  const bg = [0x0f, 0x17, 0x2a];
  const fg = [0xff, 0xff, 0xff];
  const cell = Math.floor((size * 0.56) / 11);
  const textW = cell * 11;
  const textH = cell * 7;
  const x0 = Math.floor((size - textW) / 2);
  const y0 = Math.floor((size - textH) / 2);
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      let on = false;
      const gx = x - x0;
      const gy = y - y0;
      if (gx >= 0 && gx < textW && gy >= 0 && gy < textH) {
        const col = Math.floor(gx / cell);
        const row = Math.floor(gy / cell);
        if (col < 5) on = GLYPHS.O[row][col] === "1";
        else if (col >= 6) on = GLYPHS.G[row][col - 6] === "1";
      }
      const px = on ? fg : bg;
      const o = y * rowLen + 1 + x * 3;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function generateStaticParams() {
  return SIZES.map((s) => ({ size: String(s) }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  const n = Number(size);
  if (!SIZES.includes(n)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(makeIcon(n)), {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}
