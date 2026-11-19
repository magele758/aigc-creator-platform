// Uses a disposable database. No stack credentials or running production service are required.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'studio-directory-'));
process.env.STUDIO_DATA_DIR = dir;
const { createProject, mutateProject, projectSummaries, db } = await import('./store.mjs');
try {
  for (let i = 0; i < 100; i++) {
    const p = createProject({ name: '目录压测 ' + i, brief: '一部跨章节短片。' });
    mutateProject(p.id, (pr) => {
      pr.chapters = Array.from({ length: 10 }, (_, c) => ({
        id: 'chapter-' + c,
        title: '章节',
        text: '场景、角色和声音。'.repeat(35),
        shots: Array.from({ length: 10 }, (_, s) => ({
          id: c + '-' + s,
          title: '镜头',
          prompt: 'A red lantern on a rainy wooden platform. '.repeat(2),
        })),
      }));
      pr.assets = Array.from({ length: 1000 }, (_, a) => ({
        id: 'asset-' + a,
        kind: 'image',
        title: '场景图',
        file: 'asset-' + a + '.png',
        sha256: '7'.repeat(64),
        metrics: { model: 'Z-Image Turbo', seed: 123, wall_seconds: 8.2 },
      }));
    });
  }
  const t = [];
  let bytes;
  for (let n = 0; n <= 30; n++) {
    const start = performance.now();
    bytes = Buffer.byteLength(JSON.stringify({ projects: projectSummaries() }));
    if (n) t.push(performance.now() - start);
  }
  t.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        test: 'warm directory read + JSON serialization',
        projects: 100,
        assets: 100000,
        shots: 10000,
        warmup: 1,
        samples: t.length,
        p50Ms: +t[14].toFixed(3),
        p95Ms: +t[28].toFixed(3),
        responseBytes: bytes,
        arch: process.arch,
        node: process.version,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
