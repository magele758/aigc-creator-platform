import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'studio-store-test-'));
process.env.STUDIO_DATA_DIR = dir;
const {
  createProject,
  project,
  patchProject,
  mutateProject,
  publicProject,
  getAsset,
  share,
  revoke,
  addJob,
  saveJob,
  job,
  db,
} = await import('./store.mjs');
const { recoverQueue } = await import('./pipeline.mjs');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('授权引用可撤销；副本保留项目归属且媒体 URL 按接收项目生成', () => {
  const a = createProject({ name: 'A' }),
    b = createProject({ name: 'B' }),
    other = createProject({ name: 'C' });
  mutateProject(a.id, (p) =>
    p.assets.push({ id: 'a1', kind: 'image', title: '海岸', file: 'private.png', mime: 'image/png' }),
  );
  assert.throws(() => getAsset(project(b.id), 'a1'), /权限/);
  const reference = share(a.id, { assetId: 'a1', targetProjectId: b.id, mode: 'reference' });
  assert.deepEqual(share(a.id, { assetId: 'a1', targetProjectId: b.id, mode: 'reference' }), reference);
  const shared = publicProject(project(b.id)).assets[0];
  assert.equal(shared.shared, true);
  assert.equal(shared.src, '/api/projects/' + b.id + '/media/a1');
  assert.equal('file' in shared, false);
  assert.throws(() => revoke(other.id, reference.id), /不存在/);
  const copied = share(a.id, { assetId: 'a1', targetProjectId: b.id, mode: 'copy' });
  revoke(a.id, reference.id);
  assert.throws(() => getAsset(project(b.id), 'a1'), /权限/);
  assert.equal(getAsset(project(b.id), copied.assetId).copiedFrom.assetId, 'a1');
});

test('并发编辑、图内循环、越界裁切和未授权素材均原子拒绝', () => {
  const p = createProject({ name: '编辑' });
  const first = patchProject(p.id, { expectedRevision: 1, brief: '先行修改' });
  assert.throws(
    () => patchProject(p.id, { expectedRevision: 1, brief: '覆盖' }),
    (e) => e.status === 409,
  );
  assert.equal(project(p.id).brief, '先行修改');
  const chapters = [
    {
      id: 'c',
      title: '第一章',
      text: '风起',
      shots: [
        { id: 's1', title: '树', prompt: 'slow' },
        { id: 's2', title: '楼', prompt: 'pan' },
      ],
    },
  ];
  patchProject(p.id, { chapters, expectedRevision: first.revision });
  assert.throws(
    () =>
      patchProject(p.id, {
        storyLinks: [
          { from: 's1', to: 's2' },
          { from: 's2', to: 's1' },
        ],
      }),
    /循环/,
  );
  assert.deepEqual(project(p.id).storyLinks, []);
  assert.throws(
    () =>
      patchProject(p.id, {
        chapters: [{ ...chapters[0], shots: [{ ...chapters[0].shots[0], image: 'foreign' }] }],
      }),
    /不可访问/,
  );
  mutateProject(p.id, (x) => x.assets.push({ id: 'v', kind: 'video', title: '成片', duration: 2 }));
  assert.throws(() => patchProject(p.id, { sequence: [{ assetId: 'v', duration: 2.5 }] }), /裁切/);
  assert.throws(() => patchProject(p.id, { sequence: [{ assetId: 'foreign', duration: 1 }] }), /不可访问/);
  assert.deepEqual(project(p.id).sequence, []);
});

test('同一项目的重复提交只产生一个作业，参数或操作范围不同不会串单', () => {
  const a = createProject({ name: '幂等 A' }),
    b = createProject({ name: '幂等 B' }),
    req = { kind: 'image', projectId: a.id, prompt: 'red', idempotencyKey: 'retry' };
  const { j } = addJob(req);
  assert.equal(addJob({ prompt: 'red', kind: 'image', idempotencyKey: 'retry', projectId: a.id }).j.id, j.id);
  assert.throws(
    () => addJob({ ...req, prompt: 'blue' }),
    (e) => e.status === 409,
  );
  const other = addJob({ ...req, projectId: b.id }).j;
  assert.notEqual(other.id, j.id);
  j.status = 'failed';
  saveJob(j);
  other.status = 'failed';
  saveJob(other);
});
test('重启将活动任务标明可恢复，保留导演决定，已完成任务保持成功', () => {
  const p = createProject({ name: '恢复' }),
    running = addJob({ kind: 'agent', projectId: p.id }).j,
    complete = addJob({ kind: 'export', projectId: p.id }).j;
  running.status = 'running';
  running.checkpoints = { direction: { orderedShotIds: ['s1'] } };
  saveJob(running);
  complete.status = 'succeeded';
  saveJob(complete);
  recoverQueue();
  assert.equal(job(running.id).status, 'interrupted');
  assert.deepEqual(job(running.id).checkpoints, running.checkpoints);
  assert.equal(job(complete.id).status, 'succeeded');
});
