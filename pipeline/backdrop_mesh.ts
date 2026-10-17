// The mesh steps of pipeline/backdrop.py, with meshoptimizer: the simplifier three.js ships
// (three/examples/jsm/libs/meshopt_simplifier.module.js) and, when node_modules has it, the encoder of the meshoptimizer
// package three's types already pull in. Nothing new is installed.
//
//   bun pipeline/backdrop_mesh.ts simplify <dir>
//     <dir>/job.json { ratio, error, weights: [u, v], chunks: [{ nv, ni }] }; per chunk i: i.pos (float32 x3, metres),
//     i.uv (float32 x2), i.idx (uint32), welded on (position, uv). Writes i.out (uint32 indices) and i.remap (uint32 per
//     input vertex: its new index, or 0xffffffff when no triangle uses it). With the encoder the vertices are also put in
//     cache and fetch order (smaller once compressed). Prints { reordered, chunks: [{ triangles, vertices, error }] }.
//   bun pipeline/backdrop_mesh.ts encode <dir>
//     <dir>/job.json { buffers: [{ file, count, stride, mode: ATTRIBUTES | TRIANGLES }] }: writes <file>.enc in the
//     EXT_meshopt_compression format (codec version 0). Exits with 3 when the encoder is not installed.
//
// Simplification keeps UV seams (no Permissive mode): the atlas charts are small, and a collapse across one maps a
// triangle onto unrelated texels. The error is absolute, in metres.

import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

interface Encoder {
  ready: Promise<void>;
  reorderMesh(indices: Uint32Array, triangles: boolean, optsize: boolean): [Uint32Array, number];
  encodeGltfBuffer(source: Uint8Array, count: number, size: number, mode: string, version?: number): Uint8Array;
}

async function encoder(): Promise<Encoder | null> {
  try {
    const mod = (await import('meshoptimizer')) as unknown as { MeshoptEncoder?: Encoder };
    if (!mod.MeshoptEncoder) return null;
    await mod.MeshoptEncoder.ready;
    return mod.MeshoptEncoder;
  } catch {
    return null;
  }
}

async function simplify(dir: string): Promise<void> {
  await MeshoptSimplifier.ready;
  const enc = await encoder();
  const job = (await Bun.file(`${dir}/job.json`).json()) as {
    ratio: number;
    error: number;
    weights: [number, number];
    chunks: { nv: number; ni: number }[];
  };
  const out: { triangles: number; vertices: number; error: number }[] = [];
  for (let i = 0; i < job.chunks.length; i++) {
    const c = job.chunks[i]!;
    const pos = new Float32Array(await Bun.file(`${dir}/${i}.pos`).arrayBuffer());
    const uv = new Float32Array(await Bun.file(`${dir}/${i}.uv`).arrayBuffer());
    const idx = new Uint32Array(await Bun.file(`${dir}/${i}.idx`).arrayBuffer());
    if (pos.length !== c.nv * 3 || uv.length !== c.nv * 2 || idx.length !== c.ni) throw new Error(`chunk ${i}: sizes do not match job.json`);
    let res = idx;
    let err = 0;
    if (job.ratio < 1) {
      const target = Math.max(3, Math.floor((idx.length * job.ratio) / 3) * 3);
      [res, err] = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, uv, 2, job.weights, null, target, job.error, ['ErrorAbsolute', 'Prune']);
    }
    let remap: Uint32Array;
    let unique: number;
    if (enc) {
      // rewrites `res` in place to the new numbering
      [remap, unique] = enc.reorderMesh(res, true, true);
    } else {
      remap = new Uint32Array(c.nv).fill(0xffffffff);
      unique = 0;
      for (let k = 0; k < res.length; k++) {
        const v = res[k]!;
        if (remap[v] === 0xffffffff) remap[v] = unique++;
        res[k] = remap[v]!;
      }
    }
    await Bun.write(`${dir}/${i}.out`, res);
    await Bun.write(`${dir}/${i}.remap`, remap);
    out.push({ triangles: res.length / 3, vertices: unique, error: Math.round(err * 1e5) / 1e5 });
  }
  console.log(JSON.stringify({ reordered: !!enc, chunks: out }));
}

async function encode(dir: string): Promise<void> {
  const enc = await encoder();
  if (!enc) {
    console.error('meshoptimizer encoder not installed (node_modules/meshoptimizer)');
    process.exit(3);
  }
  const job = (await Bun.file(`${dir}/job.json`).json()) as { buffers: { file: string; count: number; stride: number; mode: string }[] };
  for (const b of job.buffers) {
    const src = new Uint8Array(await Bun.file(`${dir}/${b.file}`).arrayBuffer());
    if (src.length !== b.count * b.stride) throw new Error(`${b.file}: ${src.length} bytes, expected ${b.count} x ${b.stride}`);
    await Bun.write(`${dir}/${b.file}.enc`, enc.encodeGltfBuffer(src, b.count, b.stride, b.mode, 0));
  }
  console.log(JSON.stringify({ encoded: job.buffers.length }));
}

const [cmd, dir] = process.argv.slice(2);
if (!dir || (cmd !== 'simplify' && cmd !== 'encode')) {
  console.error('usage: bun pipeline/backdrop_mesh.ts simplify|encode <dir>');
  process.exit(2);
}
await (cmd === 'simplify' ? simplify(dir) : encode(dir));
