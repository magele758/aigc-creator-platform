import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'cine-control-'));
process.env.STUDIO_DATA_DIR = dir;
const { addJob, job, project, patchProject, createProject, mutateProject } = await import('./store.mjs');
const { directWorkspace } = await import('./director.mjs');
const { prepareDirectorRequest } = await import('./director-files.mjs');
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const ctl = { emit() {} };
const call = (tools, name, args) => tools.find((t) => t.name === name).execute({}, args);
const ok = async (r) => {
  const v = await r;
  assert.equal(v.ok, true, v.content);
  return JSON.parse(v.content);
};
test.after(() => rm(dir, { recursive: true, force: true }));

test('从首页委托，回执驱动切换项目、导入、看图、共享和打开浏览器页面', async () => {
  const request = await prepareDirectorRequest({
    kind: 'command',
    prompt: '导入并共享印样，打开接收方',
    commandFiles: [{ dataUrl: png, title: '印样' }],
  });
  assert.ok(!JSON.stringify(request).includes('base64'));
  const { j } = addJob(request);
  let owner, dest, imageId;
  await assert.rejects(
    directWorkspace(j, ctl, async ({ tools, task, resolveImageDataUrl }) => {
      assert.ok(task.includes('印样') && !task.includes('base64'));
      const unsupported = await call(tools, 'finish_direction', { status: 'complete', summary: '完成' });
      assert.equal(unsupported.ok, false);
      owner = await ok(call(tools, 'workspace', { op: 'project_create', name: '库' }));
      imageId = (await ok(call(tools, 'import_attachment', { index: 1 }))).assetId;
      const index = await ok(call(tools, 'import_attachment', { index: 1 }));
      assert.equal(index.assetId, imageId);
      const preview = await call(tools, 'inspect_media', { assetId: imageId });
      assert.equal(preview.images.length, 1);
      assert.match(await resolveImageDataUrl(preview.images[0].assetId), /^data:image\/jpeg;base64,/);
      dest = await ok(call(tools, 'workspace', { op: 'project_create', name: '接收方' }));
      assert.equal((await call(tools, 'inspect_media', { assetId: imageId })).ok, false);
      await ok(
        call(tools, 'workspace', {
          op: 'asset_share',
          projectId: owner.projectId,
          targetProjectId: dest.projectId,
          assetId: imageId,
          mode: 'reference',
        }),
      );
      throw new Error('模拟断线');
    }),
    /模拟断线/,
  );
  const result = await directWorkspace(job(j.id), ctl, async ({ tools, task }) => {
    assert.match(task, /asset_share/);
    const visible = await ok(call(tools, 'workspace', { op: 'assets_list' }));
    assert.equal(visible.items[0].id, imageId);
    await ok(call(tools, 'set_view', { theme: 'cinema', page: 'image', result: imageId }));
    const invented = await call(tools, 'finish_direction', {
      status: 'complete',
      summary: '结果为 00000000-0000-0000-0000-000000000000',
    });
    assert.equal(invented.ok, false);
    await ok(
      call(tools, 'finish_direction', { status: 'complete', summary: '已共享印样', assetId: imageId }),
    );
  });
  assert.deepEqual(result.view, {
    theme: 'cinema',
    page: 'image',
    projectId: dest.projectId,
    result: imageId,
  });
  assert.equal(result.assetUrl, '/api/projects/' + dest.projectId + '/media/' + imageId);
  assert.equal(project(owner.projectId).assets.length, 1);
  assert.equal(project(dest.projectId).chapters.length, 0);
  assert.equal(result.operations.filter((o) => o === 'project_create').length, 2);
});

test('跨模型轮次有人修改项目时，导演收到冲突回执并可重新读取', async () => {
  const p = createProject({ name: '冲突回归' }),
    { j } = addJob({ kind: 'command', projectId: p.id, prompt: '修改简报' });
  const result = await directWorkspace(j, ctl, async ({ tools }) => {
    await ok(call(tools, 'workspace', { op: 'project_read' }));
    patchProject(p.id, { brief: '人工修改' });
    const action = { actions: [{ op: 'project_edit', text: '已参考人工修改' }] };
    assert.equal((await call(tools, 'edit_project', action)).ok, false);
    assert.equal(project(p.id).brief, '人工修改');
    assert.equal((await ok(call(tools, 'workspace', { op: 'project_read' }))).text, '人工修改');
    await ok(call(tools, 'edit_project', action));
    await ok(call(tools, 'finish_direction', { status: 'complete', summary: '已更新剧本简报' }));
  });
  assert.equal(result.projectId, p.id);
  assert.equal(project(p.id).brief, '已参考人工修改');
});

test('仅凭聊天文本不能宣告成功，文件路径与伪造的服务器附件不能导入', async () => {
  for (const extra of [
    { directorFiles: [] },
    { parentJobId: 'a' },
    { commandFiles: [{ title: 'a', dataUrl: 'file:///tmp/no' }] },
  ])
    await assert.rejects(prepareDirectorRequest({ kind: 'command', ...extra }));
  const { j } = addJob({ kind: 'command', prompt: '假成功' });
  await assert.rejects(
    directWorkspace(j, ctl, async () => '已完成'),
    /未提交最终回执/,
  );
});

test('成片时长取自文件，模型写错时得到实测反馈并修正', async () => {
  const p = createProject({ name: '港口' });
  mutateProject(p.id, (v) =>
    v.assets.push({
      id: 'ferry',
      title: '渡轮',
      role: 'delivery',
      kind: 'video',
      width: 960,
      height: 540,
      frames: 50,
      duration: 50 / 24,
    }),
  );
  const { j } = addJob({ kind: 'command', projectId: p.id, prompt: '交付成片并报告时长' });
  const result = await directWorkspace(j, ctl, async ({ tools }) => {
    await ok(call(tools, 'workspace', { op: 'asset_read', assetId: 'ferry' }));
    const failed = await call(tools, 'finish_direction', {
      status: 'complete',
      assetId: 'ferry',
      summary: '约3.6秒视频镜头',
    });
    assert.equal(failed.ok, false);
    assert.match(failed.content, /2.083/);
    await ok(
      call(tools, 'finish_direction', { status: 'complete', assetId: 'ferry', summary: '片长 2.08 秒。' }),
    );
  });
  assert.equal(result.media.frames, 50);
  assert.equal(result.media.duration, 50 / 24);
});
