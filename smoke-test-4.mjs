/**
 * smoke-test-4.mjs — 第 4 批（集成层）冒烟验证
 *
 * 覆盖范围：
 * 1. llm-client：宽松 JSON 解析 / 429 重试 / 并发控制串行化
 * 2. sentinel：聚合窗口交付 / 同源去重合并
 * 3. executor：DAG 解析与兜底 / 循环依赖检测 / 并行执行 / 质量反思重试 / 级联触发 / 经验沉淀
 * 4. 端到端：cordis 插件加载 → autonomous_execute Tool → 10 步链路 →
 *    plan-complete 事件 → 记忆沉淀 → dashboard HTTP / WS 事件回放 → fiber 卸载清理
 * 5. 12 Tool 注册完整性与关键 action 抽检
 *
 * 全程离线：fetchImpl 与 nodeRunner 均注入模拟实现，不依赖真实模型端点。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import plugin, {
  LLMClient,
  Sentinel,
  Executor,
  LongTermMemory,
  parseJSONLoose,
} from './dist/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout, label) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
    await sleep(50);
  }
}

// 全局超时保护
setTimeout(() => {
  console.error('❌ 测试全局超时（60s）');
  process.exit(1);
}, 60_000).unref();

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ─────────────────────────── 1. llm-client ───────────────────────────
console.log('\n[1] llm-client');

assert.deepEqual(parseJSONLoose('{"a":1}'), { a: 1 });
assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
assert.deepEqual(parseJSONLoose('前缀文本 {"a": [1,2]} 后缀'), { a: [1, 2] });
assert.equal(parseJSONLoose('完全不是 JSON'), undefined);
ok('parseJSONLoose 宽松解析（直接 / 代码块包裹 / 杂散文本 / 失败）');

{
  let calls = 0;
  const flakyFetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: { total_tokens: 10 } }), { status: 200 });
  };
  const client = new LLMClient({ fetchImpl: flakyFetch, retryBaseDelay: 10, maxRetries: 2 });
  client.registerModel({ id: 'm1', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 1 });
  const res = await client.chat('m1', [{ role: 'user', content: 'hi' }]);
  assert.equal(res.retries, 1);
  assert.equal(res.content, 'hello');
  assert.equal(res.tokensUsed, 10);
  client.dispose();
  ok('429 自动重试后成功（retries=1）');
}

{
  let active = 0;
  let maxActive = 0;
  const slowFetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(30);
    active -= 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 });
  };
  const client = new LLMClient({ fetchImpl: slowFetch, maxRetries: 0 });
  client.registerModel({ id: 'm1', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 1 });
  await Promise.all([0, 1, 2].map(() => client.chat('m1', [{ role: 'user', content: 'q' }])));
  assert.equal(maxActive, 1);
  const status = client.getModelStatuses()[0];
  assert.equal(status.totalCalls, 3);
  assert.equal(status.successRate, 1);
  client.dispose();
  ok('并发控制：maxConcurrency=1 时 3 个请求串行执行');
}

// ─────────────────────────── 2. sentinel ───────────────────────────
console.log('\n[2] sentinel');

{
  const batches = [];
  const sentinel = new Sentinel(
    { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.15 },
    (b) => batches.push(b),
  );
  sentinel.start();
  sentinel.ingest({ type: 't', description: 'd', payload: {}, source: 'test' });
  sentinel.ingest({ type: 't', description: 'd', payload: {}, source: 'test' }); // 去重合并
  sentinel.ingest({ type: 't2', description: 'd2', payload: {}, source: 'test' });
  await waitFor(() => batches.length >= 1, 3000, '聚合窗口交付');
  assert.equal(batches[0].signals.length, 2);
  assert.equal(batches[0].signals[0].occurrences, 2);
  assert.equal(batches[0].reason, 'window');
  sentinel.stop();
  ok('聚合窗口交付 + 同源去重合并（occurrences=2）');
}

// ─────────────────────────── 3. executor ───────────────────────────
console.log('\n[3] executor');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exec-'));
  const memory = new LongTermMemory(path.join(tmpDir, 'mem.json'));
  const llm = new LLMClient({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  llm.registerModel({ id: 'a', endpoint: 'http://mock', apiKey: 'k', initialCapabilities: { taskScores: { 'code-generation': 0.9 } } });
  llm.registerModel({ id: 'b', endpoint: 'http://mock', apiKey: 'k', initialCapabilities: { taskScores: { 'code-generation': 0.5 } } });

  const cascades = [];
  const executor = new Executor({
    config: { qualityThreshold: 0.7, maxRetries: 2, globalTimeout: 30_000, nodeTimeout: 5000, enableProgress: false, verbose: false },
    llm,
    memory,
    nodeRunner: async ({ node, attempt }) => {
      if (node.id === 'n1' && attempt === 1) return { output: 'bad', quality: 0.3 }; // 首次质量不达标触发反思重试
      return { output: `out-${node.id}`, quality: 0.9, tokensUsed: 10 };
    },
    cascadeHandler: (s) => cascades.push(s),
  });

  // DAG 解析
  const plan = executor.buildPlan('goal', '{"nodes":[{"id":"n1","description":"x","type":"code-generation","dependsOn":[]},{"id":"n2","description":"y","type":"code-generation","dependsOn":["n1"]}],"parallelismStrategy":"layered"}', 'code-generation');
  assert.equal(plan.source, 'strategist');
  assert.equal(plan.nodes.length, 2);
  ok('strategist DAG 输出解析');

  // 非法输出兜底
  assert.equal(executor.buildPlan('goal', 'garbage', 't').source, 'fallback');
  // 循环依赖兜底
  assert.equal(executor.buildPlan('goal', '{"nodes":[{"id":"n1","description":"x","type":"t","dependsOn":["n2"]},{"id":"n2","description":"y","type":"t","dependsOn":["n1"]}]}', 't').source, 'fallback');
  ok('非法输出与循环依赖回退兜底计划');

  // 模型分配：能力画像最优者
  assert.equal(executor.assignModel('code-generation'), 'a');

  // 并行执行 + 质量反思重试 + 级联 + 沉淀
  const planWithCascade = executor.buildPlan(
    'goal',
    JSON.stringify({
      nodes: [
        { id: 'n1', description: 'x', type: 'code-generation', dependsOn: [], cascade: [{ type: 'follow', description: 'next' }] },
        { id: 'n2', description: 'y', type: 'code-generation', dependsOn: ['n1'] },
      ],
    }),
    'code-generation',
  );
  const signal = { id: 'sig1', type: 'code-generation', description: '测试任务', payload: {}, receivedAt: Date.now(), source: 'test', occurrences: 1 };
  const result = await executor.executePlan(signal, planWithCascade);
  assert.equal(result.success, true);
  assert.equal(result.successCount, 2);
  assert.equal(result.nodeResults.find((r) => r.nodeId === 'n1').attempts, 2); // 反思重试一次
  assert.equal(cascades.length, 1);
  assert.ok(memory.getGlobalStats().totalSuccesses >= 1);
  memory.dispose();
  llm.dispose();
  ok('并行执行 + 质量反思重试（attempts=2）+ 级联触发 + 经验沉淀');
}

// ─────────────────────────── 4. 端到端（cordis 插件） ───────────────────────────
console.log('\n[4] 端到端链路（cordis 插件）');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke4-'));
const PORT = 19877;

/** 模拟模型端点：区分战略决策 / 计划生成请求 */
const mockFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const text = body.messages.map((m) => m.content).join('\n');
  let content;
  if (text.includes('战略决策器')) {
    // 决策引擎升级后 user content 为 { signals, history } 包装对象
    const parsed = JSON.parse(body.messages[1].content);
    const signals = Array.isArray(parsed) ? parsed : parsed.signals;
    content = JSON.stringify(
      signals.map((s) => ({ id: s.id, urgency: 0.9, decision: s.description.includes('延迟') ? 'defer' : 'execute' })),
    );
  } else if (text.includes('任务规划器')) {
    if (text.includes('后续任务')) {
      // 级联信号返回单节点计划（无 cascade，防止无限级联）
      content = JSON.stringify({ nodes: [{ id: 'f1', description: '后续处理', type: 'general', dependsOn: [] }], parallelismStrategy: 'sequential' });
    } else {
      content = JSON.stringify({
        nodes: [
          { id: 'n1', description: '分析', type: 'code-generation', dependsOn: [], cascade: [{ type: 'follow-up', description: '后续任务' }] },
          { id: 'n2', description: '文档', type: 'documentation', dependsOn: ['n1'] },
        ],
        parallelismStrategy: 'layered',
      });
    }
  } else {
    content = 'ok';
  }
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 100 }, model: body.model }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

const root = new Context();
const fiber = await root.plugin(plugin, {
  strategistModel: { id: 'mock-strategist', endpoint: 'http://mock', apiKey: 'k' },
  models: [
    { id: 'mock-strategist', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 2, initialCapabilities: { taskScores: { general: 0.8 } } },
    { id: 'mock-worker', endpoint: 'http://mock', apiKey: 'k', maxConcurrency: 2, initialCapabilities: { taskScores: { 'code-generation': 0.9, documentation: 0.7 } } },
  ],
  sentinel: { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.2 },
  qualityThreshold: 0.7,
  maxRetries: 1,
  globalTimeout: 30_000,
  enableProgress: true,
  progressPort: PORT,
  verbose: false,
  experienceStorePath: path.join(TMP, 'memory.json'),
  encryption: { enabled: false, algorithm: 'aes-256-gcm', fullFileEncryption: true },
  sync: { localNodeId: 'node-test', peers: [] },
  consensus: { enabled: false },
  hotReload: { enabled: false },
  tenants: [],
  dataDir: path.join(TMP, '.scheduler'),
  llm: { fetchImpl: mockFetch },
  nodeRunner: async ({ node }) => ({ output: `done-${node.id}`, quality: 0.9, tokensUsed: 20 }),
});

const svc = root.scheduler;
assert.ok(svc, 'scheduler 服务已 provide');
ok('cordis 插件加载成功，scheduler 服务已暴露');

// 13 Tool 注册完整性
const toolNames = svc.tools.list().map((t) => t.name).sort();
assert.deepEqual(toolNames, [
  'autonomous_execute', 'maintain_memory', 'manage_autonomy', 'manage_consensus', 'manage_encryption',
  'manage_hot_reload', 'manage_sync', 'manage_tenants', 'memory_migration',
  'model_dashboard', 'query_experience', 'query_memory', 'run_benchmark',
]);
ok('13 个 Tool 全部注册');

// 参数校验
let threw = false;
try { await svc.tools.invoke('autonomous_execute', {}); } catch { threw = true; }
assert.ok(threw);
ok('autonomous_execute 缺少 task 时抛 ToolError');

// 端到端：提交任务 → 10 步链路 → 级联闭环
const planCompletes = [];
root.on('scheduler/plan-complete', (result, signal) => planCompletes.push({ result, signal }));

await svc.tools.invoke('autonomous_execute', { task: '生成问候模块', urgency: 0.9 });
await waitFor(() => planCompletes.length >= 2, 20_000, '主任务 + 级联任务完成');
assert.ok(planCompletes[0].result.success);
assert.ok(planCompletes.some((p) => p.signal.type === 'follow-up'));
ok('10 步链路贯通：主任务成功 + 级联信号闭环执行');

// defer 决策路径
await svc.tools.invoke('autonomous_execute', { task: '延迟处理的任务', urgency: 0.3 });
await sleep(1200);
const fb = await svc.tools.invoke('query_memory', { query_type: 'feedback', limit: 50 });
assert.ok(fb.feedback.some((f) => f.decision === 'defer'));
ok('defer 决策进入延迟队列并沉淀反馈');

// 经验沉淀验证
const stats = svc.memory.getGlobalStats();
assert.ok(stats.totalSuccesses >= 2);
assert.ok(stats.totalTokensUsed > 0);
ok(`经验沉淀：成功 ${stats.totalSuccesses} 次，token ${stats.totalTokensUsed}`);

// Tool 抽检
const dash = await svc.tools.invoke('model_dashboard');
assert.equal(dash.models.length, 2);
const overview = await svc.tools.invoke('query_memory', { query_type: 'overview' });
assert.ok(overview.globalStats.totalExecutions >= 2);
const exp = await svc.tools.invoke('query_experience', { task_type: 'code-generation' });
assert.ok(exp.recommendedModels);
const consensusStatus = await svc.tools.invoke('manage_consensus', { action: 'status' });
assert.equal(consensusStatus.enabled, false);
const hotReloadStatus = await svc.tools.invoke('manage_hot_reload', { action: 'status' });
assert.equal(hotReloadStatus.enabled, false);
ok('Tool 抽检：model_dashboard / query_memory / query_experience / manage_consensus / manage_hot_reload');

// dashboard HTTP 端点
const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
assert.ok(html.includes('dsh-autonomous-scheduler'));
const modelStatus = await (await fetch(`http://127.0.0.1:${PORT}/api/model-status`)).json();
assert.equal(modelStatus.length, 2);
ok('dashboard 页面与 /api/model-status 端点可访问');

// WebSocket 事件回放 + 实时推送
const wsEvents = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (m) => wsEvents.push(JSON.parse(m.data));
await waitFor(() => wsEvents.some((e) => e.type === 'connected'), 3000, 'WS connected');
assert.ok(wsEvents.some((e) => e.type === 'plan-complete'), '连接回放包含历史 plan-complete');
ok('WS 连接成功且回放历史事件');

const before = wsEvents.length;
await svc.tools.invoke('autonomous_execute', { task: '第二个任务' });
await waitFor(() => wsEvents.slice(before).some((e) => e.type === 'plan-complete'), 20_000, '新任务实时推送');
const types = new Set(wsEvents.map((e) => e.type));
for (const expected of ['batch-start', 'strategist-thinking', 'signal-received', 'plan-start', 'node-start', 'node-complete', 'node-reflect', 'plan-complete']) {
  assert.ok(types.has(expected), `缺少事件类型 ${expected}`);
}
ws.close();
ok('WS 实时推送全链路事件（batch-start → plan-complete）');

// ─────────────────────────── 5. cleanup ───────────────────────────
console.log('\n[5] cleanup');

await fiber.dispose();
let closed = false;
try {
  await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
} catch {
  closed = true;
}
assert.ok(closed, 'fiber 卸载后进度端口已关闭');
ok('fiber.dispose() 完成资源清理（进度服务已关闭）');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ 第 4 批冒烟测试全部通过（${passed} 项断言组）`);
process.exit(0);
