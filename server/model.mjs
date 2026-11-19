import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

const sdkRoot = resolve(
  process.env.PPENG_AGENT_CORE_DIR || fileURLToPath(new URL('../../ppeng-agent-core/', import.meta.url)),
);
const sdkDir = resolve(sdkRoot, 'packages/agent-loop/dist');
let sdkPromise;
async function sdk() {
  if (!sdkPromise)
    sdkPromise = (async () => {
      if (existsSync(resolve(sdkDir, 'index.js')))
        return Promise.all(
          ['index.js', 'mini.js'].map((name) => import(pathToFileURL(resolve(sdkDir, name)))),
        );
      for (const pkg of ['@mage-ai-lab/agent-loop', '@ppeng/agent-loop']) {
        try {
          return await Promise.all([import(pkg), import(pkg + '/mini')]);
        } catch (e) {
          if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
        }
      }
      throw new Error(
        '请安装 agent-loop 或设置 PPENG_AGENT_CORE_DIR 指向含 packages/agent-loop/dist 的工作树。',
      );
    })().catch((e) => {
      sdkPromise = null;
      throw e;
    });
  return sdkPromise;
}

function connection() {
  if (process.env.STUDIO_TEXT_BASE_URL && process.env.STUDIO_TEXT_MODEL) {
    return {
      baseUrl: process.env.STUDIO_TEXT_BASE_URL,
      apiKey: process.env.STUDIO_TEXT_API_KEY || 'local',
      model: process.env.STUDIO_TEXT_MODEL,
      httpKind: process.env.STUDIO_TEXT_HTTP_KIND || 'chat_completions',
      kind: 'openai-compatible',
    };
  }
  const catalogPath = resolve(
    process.env.STUDIO_AGENT_CATALOG || resolve(sdkRoot, '.agent-state/runtime.sqlite'),
  );
  if (existsSync(catalogPath)) {
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value_json FROM daemon_control WHERE key='model_providers'").get();
      const catalog = row && JSON.parse(row.value_json);
      const ref = catalog?.defaultRef,
        provider = catalog?.providers?.find((p) => p.id === ref?.providerId);
      if (provider?.apiKey && provider.baseUrl && ref?.modelId && provider.kind !== 'heuristic')
        return {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: ref.modelId,
          httpKind: provider.httpKind,
          kind: provider.kind,
        };
    } finally {
      db.close();
    }
  }
  const envFile = resolve(sdkRoot, '.env');
  const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  if (env.RAW_AGENT_API_KEY && env.RAW_AGENT_BASE_URL && env.RAW_AGENT_MODEL_NAME)
    return {
      baseUrl: env.RAW_AGENT_BASE_URL,
      apiKey: env.RAW_AGENT_API_KEY,
      model: env.RAW_AGENT_MODEL_NAME,
      kind: env.RAW_AGENT_MODEL_PROVIDER,
      httpKind: env.RAW_AGENT_OPENAI_HTTP_KIND,
    };
  throw new Error(
    '请在 Agent Home 选择真实文字模型，或设置 STUDIO_TEXT_BASE_URL、STUDIO_TEXT_MODEL 与 STUDIO_TEXT_API_KEY。',
  );
}

export async function modelHealth() {
  try {
    await sdk();
    const { model } = connection();
    return { sdk: 'ppeng-agent-core/agent-loop', model, configured: true };
  } catch (e) {
    return { sdk: 'ppeng-agent-core/agent-loop', configured: false, error: e.message };
  }
}

// SDK 0.1.5 selects tools automatically. If a compatible provider prints a proposal
// as prose, require a named native call on one repair turn. The SDK still validates
// and executes the ToolContract; the proposal text itself can never mutate a project.
async function forceNativeCommand(config, tool, prompt, signal) {
  const base = config.baseUrl.trim().replace(/\/+$/, '');
  const root = /\/v\d+(?:beta)?(?:\/|$)/i.test(base) ? base : base + '/v1';
  const responses = config.httpKind === 'responses';
  const named = { name: tool.name, description: tool.description, parameters: tool.schema };
  const body = responses
    ? {
        model: config.model,
        stream: false,
        input: prompt,
        tools: [{ type: 'function', ...named }],
        tool_choice: { type: 'function', name: tool.name },
      }
    : {
        model: config.model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'function', function: named }],
        tool_choice: { type: 'function', function: { name: tool.name } },
      };
  const response = await fetch(root + (responses ? '/responses' : '/chat/completions'), {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  });
  // Gateways without specific-tool choice can still handle the corrected SDK turn.
  if ([400, 404, 405, 422].includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('模型工具补交失败，HTTP ' + response.status);
  }
  const data = await response.json();
  const choice = responses
    ? data.output?.find((x) => x.type === 'function_call')
    : data.choices?.[0]?.message?.tool_calls?.[0];
  const name = responses ? choice?.name : choice?.function?.name;
  if (name !== tool.name)
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: '模型未提交要求的原生工具调用。' }] };
  const args = responses ? choice.arguments : choice.function.arguments;
  return {
    stopReason: 'tool_use',
    assistantParts: [
      {
        type: 'tool_call',
        toolCallId: (responses ? choice.call_id : choice.id) || 'studio-repair',
        name,
        input: JSON.parse(args),
      },
    ],
  };
}

// Each turn can only commit the commands offered by this job and project.
// The durable job owns model and GPU lifetimes separately.
export async function requestCommand({ name, description, schema, task, onEvent, validate, signal }) {
  const [
    { createAssembledLoop, OpenAICompatibleAdapter, AnthropicMessagesAdapter },
    { createDefaultMemoryStore, DEFAULT_EMBED_AGENT },
  ] = await sdk();
  const config = connection();
  const model =
    config.kind === 'anthropic-compatible'
      ? new AnthropicMessagesAdapter(config)
      : new OpenAICompatibleAdapter({ ...config, useJsonMode: false });
  let forcedPrompt;
  if (config.kind !== 'anthropic-compatible') {
    for (const method of ['runTurn', 'runTurnStream']) {
      if (typeof model[method] !== 'function') continue;
      const normal = model[method].bind(model);
      model[method] = async (input, ...rest) => {
        if (forcedPrompt) {
          const prompt = forcedPrompt;
          forcedPrompt = null;
          const turn = await forceNativeCommand(config, { name, description, schema }, prompt, input.signal);
          if (turn) return turn;
        }
        return normal(input, ...rest);
      };
    }
  }
  const agent = {
    ...DEFAULT_EMBED_AGENT,
    name: '叠映导演',
    instructions:
      '你是影视工作室导演。使用当前唯一提供的工具完成用户要求的工序。请严格按 schema 给出完整参数。不要用聊天叙述代替工具调用；成功后只回答完成。',
  };
  const { store, surface } = createDefaultMemoryStore({ agent });
  const session = surface.createSession({ title: name, mode: 'chat', agentId: agent.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: task }]);
  let command, lastError;
  const started = performance.now();
  const tool = {
    name,
    description,
    inputSchema: schema,
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async (_ctx, args) => {
      if (command) return { ok: true, content: '已接单。' };
      try {
        command = validate ? validate(args) : args;
        onEvent?.({ type: 'tool', tool: name, sessionId: session.id });
        return { ok: true, content: '已接单，请结束本工序。' };
      } catch (e) {
        lastError = e.message;
        return { ok: false, content: e.message };
      }
    },
  };
  const controllers = new Map();
  const loop = await createAssembledLoop({
    preset: 'normal',
    io: {
      model,
      store,
      agent,
      tools: [tool],
      maxTurns: 4,
      maxParallelToolCalls: 1,
      sessionAbortControllers: controllers,
      loopConfig: { maxTurns: 4, forceAnswerOnLastTurn: false },
      env: { RAW_AGENT_MODEL_MAX_RETRIES: '1' },
      emitTrace: (_id, ev) => {
        if (ev.kind === 'model_request' || ev.kind === 'model_response')
          onEvent?.({ type: ev.kind, tool: name });
      },
    },
  });
  const abort = () => controllers.get(session.id)?.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await loop.run(session.id);
    // Some compatible providers print the intended arguments instead of issuing
    // a tool call. Let the same SDK session resubmit once; text never commits.
    if (!command) {
      signal?.throwIfAborted();
      onEvent?.({ type: 'tool_resubmission', tool: name, sessionId: session.id });
      const previous =
        store
          .foldMessages(session.id)
          .at(-1)
          ?.parts?.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ')
          .slice(0, 40000) || '';
      forcedPrompt =
        '使用指定的原生工具通道提交完整参数。' +
        (lastError ? '校验反馈：' + lastError : '') +
        '\n任务：' +
        task +
        '\n上次尚未提交的候选：' +
        previous;
      surface.appendMessage(session.id, 'user', [
        {
          type: 'text',
          text:
            '上一次没有成功提交，项目未更改。请将上一次起草的完整参数作为原生函数调用 `' +
            name +
            '` 的入参发出，必须使用工具通道。不要输出 JSON 文本或解释。' +
            (lastError ? '校验反馈：' + lastError : ''),
        },
      ]);
      await loop.run(session.id);
    }
    if (!command) {
      const messages = store.foldMessages(session.id);
      const last = messages.at(-1);
      const summary = last?.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(' ')
        .slice(0, 220);
      throw new Error('导演模型未成功调用 ' + name + '。' + (lastError || summary || '模型连接中断'));
    }
    return {
      command,
      model: config.model,
      sdk: 'ppeng-agent-core/agent-loop',
      sessionId: session.id,
      tool: name,
      seconds: +((performance.now() - started) / 1000).toFixed(3),
    };
  } finally {
    signal?.removeEventListener('abort', abort);
    loop.close?.();
  }
}
