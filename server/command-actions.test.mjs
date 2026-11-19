import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = mkdtempSync(join(tmpdir(), 'director-test-'));
process.env.STUDIO_DATA_DIR = data;
const db = await import('./store.mjs');
const { applyDirectorCommand } = await import('./command-actions.mjs');
process.on('exit', () => rmSync(data, { recursive: true, force: true }));

function fixture(plan) {
  const p = db.createProject({ name: 'test', brief: 'brief' });
  db.patchProject(p.id, {
    outline: [{ id: 'o', title: '起', beat: '镜头一' }],
    chapters: [
      {
        id: 'ch',
        title: 'chap',
        text: 'scene',
        outlineId: 'o',
        shots: [
          { id: 's1', title: 'one', prompt: 'wide' },
          { id: 's2', title: 'two', prompt: 'near' },
        ],
      },
    ],
  });
  const { j } = db.addJob({ kind: 'command', projectId: p.id, prompt: '编排当前项目' });
  const ctl = {
    emit() {},
    async command(k, spec) {
      return spec.validate({ actions: plan });
    },
  };
  return { p, j, ctl };
}

test('导演委托修改同一份剧本与画布，重复恢复不重复操作', async () => {
  const { p, j, ctl } = fixture([
    { op: 'chapter_edit', target: 'ch', text: 'new scene' },
    { op: 'shot_edit', target: 's1', title: '推镜', text: 'slow push' },
    { op: 'link_shots', target: 's1', next: 's2' },
  ]);
  const result = await applyDirectorCommand(j, ctl);
  const updated = db.project(p.id);
  assert.equal(updated.chapters[0].text, 'new scene');
  assert.equal(updated.chapters[0].shots[0].videoPrompt, 'slow push');
  assert.deepEqual(updated.storyLinks, [{ from: 's1', to: 's2' }]);
  assert.equal(result.operations.length, 3);
  await applyDirectorCommand(db.job(j.id), ctl);
  assert.equal(db.project(p.id).revision, updated.revision);
});
test('导演不能改另一项目的镜头，人工编辑冲突保留', async () => {
  const { p, j, ctl } = fixture([{ op: 'shot_edit', target: 'foreign', text: 'no' }]);
  await assert.rejects(applyDirectorCommand(j, ctl), /不属于当前项目/);
  const { j: newJob, ctl: next } = fixture([{ op: 'inspect', text: 'done' }]);
  newJob.checkpoints.commandRevision = -10;
  await assert.rejects(applyDirectorCommand(newJob, next), /已更改/);
  assert.equal(db.project(p.id).chapters[0].shots[0].title, 'one');
});
test('媒体动作数量与导出顺序在花费算力前检查', async () => {
  for (const plan of [
    [{ op: 'export' }, { op: 'image' }],
    Array.from({ length: 4 }, () => ({ op: 'image' })),
  ]) {
    const { j, ctl } = fixture(plan);
    await assert.rejects(applyDirectorCommand(j, ctl));
  }
});

test('按导演委托串行添加大纲、章与镜，采用共享图片/自有视频，移动布局不影响剪辑顺序', async () => {
  const { p, j, ctl } = fixture([
    { op: 'outline_add', title: '收束', text: '桥下红船远去' },
    { op: 'chapter_add', target: '$lastOutline', title: '桥下', text: '外景，傍晚。纸船漂过。' },
    { op: 'shot_add', target: '$lastChapter', title: '水面', text: '俯拍纸船。' },
    { op: 'adopt_asset', target: '$lastShot', asset: 'art' },
    { op: 'adopt_asset', target: '$lastShot', asset: 'movie' },
    { op: 'map_move', target: '$lastShot', x: 234, y: -50 },
  ]);
  const owner = db.createProject({ name: '外部美术室' });
  db.mutateProject(owner.id, (x) =>
    x.assets.push({ id: 'art', kind: 'image', title: '红船', file: 'art.png' }),
  );
  db.share(owner.id, { assetId: 'art', mode: 'reference', targetProjectId: p.id });
  db.mutateProject(p.id, (x) =>
    x.assets.push({ id: 'movie', kind: 'video', title: '水流', file: 'movie.mp4', duration: 2 }),
  );
  const before = db.project(p.id);
  await applyDirectorCommand(j, ctl);
  const after = db.project(p.id),
    c = after.chapters.at(-1),
    s = c.shots[0];
  assert.equal(c.outlineId, after.outline.at(-1).id);
  assert.equal(c.title, '桥下');
  assert.equal(s.title, '水面');
  assert.deepEqual([s.image, s.video], ['art', 'movie']);
  assert.deepEqual(after.mapLayout[s.id], { x: 234, y: -50 });
  assert.deepEqual(after.sequence, before.sequence);
  assert.deepEqual(after.storyLinks, before.storyLinks);
  assert.deepEqual(after.assets, before.assets);
  await applyDirectorCommand(db.job(j.id), ctl);
  assert.equal(db.project(p.id).revision, after.revision);
});
test('禁止将未共享素材绑定到镜头，外部节点移动无效', async () => {
  const { p, j, ctl } = fixture([{ op: 'adopt_asset', target: 's1', asset: 'locked' }]);
  const owner = db.createProject({ name: 'owner' });
  db.mutateProject(owner.id, (x) =>
    x.assets.push({ id: 'locked', kind: 'image', title: '私有', file: 'private.png' }),
  );
  await assert.rejects(applyDirectorCommand(j, ctl), /没有读取权限/);
  assert.equal(db.project(p.id).chapters[0].shots[0].image, undefined);
  const blocked = fixture([{ op: 'map_move', target: owner.id, x: 8, y: 9 }]);
  await assert.rejects(applyDirectorCommand(blocked.j, blocked.ctl), /不属于当前项目/);
  assert.deepEqual(db.project(blocked.p.id).mapLayout, {});
});
