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

const { runStudioOperations } = await import('./command-actions.mjs');
const { upload, localPath } = await import('./media.mjs');
const { execFileSync } = await import('node:child_process');
const { readFileSync, readdirSync } = await import('node:fs');

function call(j, p, key, actions) {
  return runStudioOperations(j, { projectId: p.id, callId: key, actions });
}

test('导演分次操作后读取真实新增 ID，重试不重复写入，按章排序和解除共享画布连线', async () => {
  const { p, j } = fixture([]);
  const a = [
    { op: 'outline_add', title: '去港口', text: '雾起' },
    { op: 'chapter_add', target: '$lastOutline', title: '第二章' },
    {
      op: 'shot_add',
      target: '$lastChapter',
      title: '镜三',
      text: '原始',
      imagePrompt: '晨雾',
      videoPrompt: '横移',
    },
  ];
  const first = await call(j, p, 'write', a);
  assert.deepEqual(
    first.created.map((r) => r.kind),
    ['outline', 'chapter', 'shot'],
  );
  const [outline, chapter, shot] = first.created.map((r) => r.id);
  const { j: newJob } = db.addJob({ kind: 'command', projectId: p.id, prompt: '继续工作' });
  const second = [
    { op: 'outline_move', target: outline, index: 1 },
    { op: 'chapter_move', target: chapter, index: 1 },
    { op: 'shot_move', target: 's2', index: 1 },
    { op: 'shot_edit', target: shot, videoPrompt: '镜头慢慢推近' },
    { op: 'link_shots', target: 's2', next: shot },
    { op: 'map_move', target: shot, x: -5, y: 10 },
  ];
  await call(newJob, p, 'edit', second);
  assert.deepEqual(await call(db.job(j.id), p, 'write', a), first);
  await assert.rejects(call(db.job(j.id), p, 'write', [{ op: 'inspect' }]), /不同操作/);
  const after = db.project(p.id);
  assert.deepEqual(
    after.chapters.map((c) => c.id),
    [chapter, 'ch'],
  );
  assert.equal(after.chapters[1].shots[0].id, 's2');
  assert.equal(after.chapters[0].shots[0].imagePrompt, '晨雾');
  assert.equal(after.chapters[0].shots[0].videoPrompt, '镜头慢慢推近');
  assert.deepEqual(after.storyLinks, [{ from: 's2', to: shot }]);
  assert.deepEqual(after.mapLayout[shot], { x: -5, y: 10 });
  await call(newJob, p, 'undo-map', [
    { op: 'map_reset' },
    { op: 'unlink_shots', target: 's2' },
    { op: 'outline_remove', target: outline },
  ]);
  assert.deepEqual(db.project(p.id).mapLayout, {});
  assert.deepEqual(db.project(p.id).storyLinks, []);
  assert.deepEqual(
    db.project(p.id).outline.map((o) => o.id),
    ['o'],
  );
  assert.equal(db.project(p.id).chapters.length, 2);
});

test('同一委托可按 Map 整串入剪并两次导出变更后的不同片段和帧率', async () => {
  const { p, j } = fixture([]);
  const path = join(data, p.id + '.mp4');
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x64:r=24:d=1',
    '-c:v',
    'libx264',
    path,
  ]);
  const movie = await upload(p.id, {
    title: '走近',
    dataUrl: 'data:video/mp4;base64,' + readFileSync(path).toString('base64'),
  });
  await call(j, p, 'series', [
    { op: 'adopt_asset', target: 's1', asset: movie.id },
    { op: 'adopt_asset', target: 's2', asset: movie.id },
    { op: 'link_shots', target: 's1', next: 's2' },
    { op: 'append_chain', target: 's1' },
  ]);
  const timeline = db.project(p.id).sequence;
  assert.deepEqual(
    timeline.map((c) => c.shotId),
    ['s1', 's2'],
  );
  const one = await call(j, p, 'export1', [{ op: 'export', width: 96, height: 64, fps: 24 }]);
  await call(j, p, 'recut', [{ op: 'remove_clip', target: timeline[1].id }]);
  const two = await call(j, p, 'export2', [{ op: 'export', width: 64, height: 64, fps: 12 }]);
  const deliveries = db.project(p.id).assets.filter((a) => a.role === 'delivery');
  assert.notEqual(one.assetId, two.assetId);
  assert.deepEqual(
    deliveries.map((a) => [a.width, a.height, a.frames]),
    [
      [96, 64, 48],
      [64, 64, 12],
    ],
  );
  assert.equal(
    (await call(db.job(j.id), p, 'export2', [{ op: 'export', width: 64, height: 64, fps: 12 }])).assetId,
    two.assetId,
  );
});

test('导演从授权原图生成精确矩形加笔画的黑白遮罩，素材上传和同一工具调用可以重放', async () => {
  const { p, j } = fixture([]);
  const png = execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=orange:s=64x48',
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2pipe',
    '-',
  ]);
  const input = { title: '杯子', dataUrl: 'data:image/png;base64,' + png.toString('base64') };
  const receipt = { jobId: j.id, slot: 'attached-file-1' };
  const base = await upload(p.id, input, receipt);
  assert.equal((await upload(p.id, input, receipt)).id, base.id);
  const actions = [
    {
      op: 'create_mask',
      asset: base.id,
      rect: [0.25, 0.25, 0.75, 0.75],
      strokes: [
        {
          w: 0.12,
          xy: [
            [0.05, 0.1],
            [0.18, 0.1],
          ],
        },
      ],
    },
  ];
  const res = await call(j, p, 'mask A', actions);
  const mask = db.getAsset(db.project(p.id), res.assetId);
  const gray = execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-i',
    localPath(mask),
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ]);
  assert.deepEqual([mask.width, mask.height, mask.role, mask.inputRefs.main], [64, 48, 'mask', base.id]);
  assert.equal(gray[0], 0);
  assert.equal(gray[24 * 64 + 32], 255);
  assert.equal(gray[5 * 64 + 5], 255);
  assert.equal(gray[40 * 64 + 32], 0);
  assert.equal((await call(db.job(j.id), p, 'mask A', actions)).assetId, mask.id);
  assert.equal(db.project(p.id).assets.length, 2);
});

test('媒体渲染实际接收种子、分辨率、推理步数、质量档位和源素材参数', async () => {
  const { p, j } = fixture([]);
  const old = process.env.STUDIO_PYTHON;
  process.env.STUDIO_PYTHON = join(data, 'inference-intentionally-unavailable');
  try {
    await assert.rejects(
      call(j, p, 'video options', [
        {
          op: 'video',
          text: 'pan',
          provider: 'local',
          seed: 18,
          width: 640,
          height: 352,
          steps: 20,
          frames: 49,
          fps: 12,
          videoProfile: 'standard',
          allowReferenceComposition: true,
        },
      ]),
      /ENOENT/,
    );
    const folder = join(data, 'jobs', j.id);
    const request = JSON.parse(
      readFileSync(
        join(
          folder,
          readdirSync(folder).find((n) => n.endsWith('.request.json')),
        ),
      ),
    );
    assert.deepEqual(request, {
      kind: 'video',
      prompt: 'pan',
      references: [],
      width: 640,
      height: 352,
      steps: 20,
      frames: 49,
      seed: 18,
      fps: 12,
      video_profile: 'standard',
      allow_reference_composition: true,
    });
  } finally {
    if (old === undefined) delete process.env.STUDIO_PYTHON;
    else process.env.STUDIO_PYTHON = old;
  }
});

test('跨章移动或移除镜头同步画布与剪辑的关联，保留既有素材和可播放片段', async () => {
  const { p, j } = fixture([]);
  db.mutateProject(p.id, (x) =>
    x.assets.push({ id: 'clip-video', kind: 'video', title: 'a', duration: 2, file: 'a.mp4' }),
  );
  const chapter = (await call(j, p, 'new chapter', [{ op: 'chapter_add', title: '黎明' }])).created[0];
  await call(j, p, 'build map', [
    { op: 'map_move', target: 's1', x: 1, y: 3 },
    { op: 'link_shots', target: 's1', next: 's2' },
    { op: 'append_clip', target: 's1', asset: 'clip-video' },
    { op: 'shot_move', target: 's1', next: chapter.id, index: 1 },
  ]);
  assert.equal(db.project(p.id).sequence[0].chapterId, chapter.id);
  await call(j, p, 'remove chapter', [{ op: 'chapter_remove', target: chapter.id }]);
  const after = db.project(p.id);
  assert.equal(after.chapters.length, 1);
  assert.equal(after.chapters[0].shots[0].id, 's2');
  assert.deepEqual(after.storyLinks, []);
  assert.deepEqual(after.mapLayout, {});
  assert.equal(after.sequence[0].assetId, 'clip-video');
  assert.equal(after.sequence[0].chapterId, null);
  assert.equal(after.sequence[0].shotId, null);
  const actions = [
    { op: 'outline_edit', target: 'o', text: '已提交的节拍' },
    { op: 'shot_remove', target: 'absent' },
  ];
  await assert.rejects(call(j, p, 'partial', actions), (e) => {
    assert.deepEqual(e.studioProgress.completed, ['outline_edit']);
    return true;
  });
  await assert.rejects(
    runStudioOperations(j, {
      projectId: p.id,
      callId: 'stale',
      actions: [{ op: 'shot_remove', target: 's2' }],
      expectedRevision: 0,
    }),
    /项目已有更新/,
  );
  assert.equal(db.project(p.id).chapters[0].shots.length, 1);
});
