/**
 * verify-self-evolution.mjs — 「越用越聪明」端到端离线验证（新架构）
 *
 * 按新架构单向数据流组装组件：
 *   记忆库(Memory) → 优化器(Optimizer) → 模型调度(ModelScheduler)/任务执行(TaskExecutor) → 反思器(Reflector) → 记忆更新(Memory)
 *
 * 全程离线（nodeRunner 注入模拟模型行为），验证三大断点：
 *
 * 断点 A：优化器产出的推荐模型（按节点类型）真正参与节点分配
 * 断点 B：反思器将蒸馏策略应用结果回写记忆库，校准策略置信度
 * 断点 C：优化器在高置信度模式命中经验快路径，复用历史成功计划（source='memory'）
 *
 * 运行：node scripts/verify-self-evolution.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliasMap, LLMClient, LongTermMemory, MemoryGraph, ModelScheduler, Optimizer, Reflector, ReflectionEngine, TaskExecutor, segment } from '../dist/index.mjs';

const TASK_TYPE = 'code-generation';
const TOTAL_ROUNDS = 10;

// ── 环境准备 ──
const memPath = path.join(os.tmpdir(), `dsh-verify-memory-${Date.now()}.json`);
const graphPath = path.join(os.tmpdir(), `dsh-verify-graph-${Date.now()}.json`);
fs.rmSync(memPath, { force: true });
fs.rmSync(graphPath, { force: true });

const memory = new LongTermMemory(memPath);
const memoryGraph = new MemoryGraph(graphPath);
const reflectionEngine = new ReflectionEngine({ qualityThreshold: 0.7 });

const llm = new LLMClient();
llm.registerModel({
  id: 'model-strong',
  endpoint: 'http://mock-strong.local',
  initialCapabilities: { taskScores: { [TASK_TYPE]: 0.9, general: 0.7 } },
});
llm.registerModel({
  id: 'model-weak',
  endpoint: 'http://mock-weak.local',
  initialCapabilities: { taskScores: { [TASK_TYPE]: 0.4, general: 0.4 } },
});

// 模拟模型行为：strong 高质量，weak 低质量（低于阈值 0.7）
const usedModels = [];
const nodeRunner = async ({ node, modelId }) => {
  usedModels.push(modelId);
  if (modelId === 'model-strong') return { output: `ok:${node.id}`, quality: 0.92, tokensUsed: 100 };
  return { output: `poor:${node.id}`, quality: 0.35, tokensUsed: 80 };
};

// ── 新架构组件组装：Memory → Optimizer → ModelScheduler/TaskExecutor → Reflector → Memory ──
const optimizer = new Optimizer({ memory, graph: memoryGraph, config: { memoryFastPathThreshold: 0.9 } });
const modelScheduler = new ModelScheduler({ llm, memory, config: { costWeight: 0.2 } });

const taskExecutor = new TaskExecutor({
  config: {
    qualityThreshold: 0.7,
    maxRetries: 1,
    globalTimeout: 30_000,
    nodeTimeout: 5_000,
    enableProgress: false,
    verbose: false,
  },
  llm,
  modelScheduler,
  nodeRunner,
  reflection: reflectionEngine,
});

const reflector = new Reflector({ memory, reflection: reflectionEngine, graph: memoryGraph, config: { enableProgress: false } });

// ── 闭环多轮运行 ──
const rounds = [];
let fastPathRounds = 0;
let recommendedExpected = 0;
let recommendedHonored = 0;

for (let round = 1; round <= TOTAL_ROUNDS; round++) {
  const signal = {
    id: `sig-${round}`,
    type: TASK_TYPE,
    description: `${TASK_TYPE}: 实现排序函数 v${round}`,
    payload: {},
    receivedAt: Date.now(),
    source: 'verify',
    occurrences: 1,
  };
  usedModels.length = 0;

  // 优化器：经验检索 + 快路径计划召回
  const lookup = optimizer.lookupExperience(TASK_TYPE, 0.5);
  const strategies = memory.getStrategies(TASK_TYPE, 3);
  let plan = optimizer.recallPlan(lookup, signal.description);
  const viaFastPath = Boolean(plan);
  if (!plan) plan = taskExecutor.buildPlan(signal.description, undefined, TASK_TYPE);

  // 任务执行器（内部经模型调度器分配模型，推荐模型参与分配）
  const result = await taskExecutor.executePlan(signal, plan, lookup.recommendedModels);

  // 反思器：复盘 + 记忆更新 + 策略反馈 + 蒸馏
  reflector.reflectOnOutcome({ signal, plan, result, appliedStrategies: strategies.map((s) => s.id) });

  // 断点 A 统计：有推荐时，节点实际使用的模型应等于推荐值
  const recommended = lookup.recommendedModels[TASK_TYPE];
  if (recommended) {
    recommendedExpected += usedModels.length;
    recommendedHonored += usedModels.filter((m) => m === recommended).length;
  }
  if (viaFastPath) fastPathRounds += 1;

  rounds.push({
    round,
    source: plan.source,
    fastPath: viaFastPath ? 'Y' : '-',
    success: result.success ? 'Y' : 'N',
    models: [...new Set(usedModels)].join(','),
    recommended: recommended ?? '-',
    confidence: lookup.pattern ? lookup.pattern.confidence.toFixed(2) : '-',
    strategiesUsed: strategies.length,
  });
}

// ── 结果输出 ──
console.log('\n=== 「越用越聪明」端到端验证（新架构：Memory → Optimizer → ModelScheduler/TaskExecutor → Reflector） ===\n');
console.log('轮次 | 计划来源    | 快路径 | 成功 | 实际模型     | 记忆推荐     | 模式置信度 | 用策略');
console.log('-----|-------------|--------|------|--------------|--------------|------------|-------');
for (const r of rounds) {
  console.log(
    ` ${String(r.round).padStart(2)}  | ${r.source.padEnd(11)} | ${r.fastPath.padEnd(6)} | ${r.success.padEnd(4)} | ${r.models.padEnd(12)} | ${r.recommended.padEnd(12)} | ${r.confidence.padEnd(10)} | ${r.strategiesUsed}`,
  );
}

// ── 断言 ──
const checks = [];

// 断点 A：优化器推荐模型被节点分配真正消费
checks.push({
  name: '断点A 优化器推荐模型参与节点分配',
  pass: recommendedExpected > 0 && recommendedHonored === recommendedExpected,
  detail: `有推荐的 ${recommendedExpected} 次节点分配中 ${recommendedHonored} 次采用推荐模型`,
});

// 断点 B：反思器策略应用反馈回写并校准置信度
const allStrategies = memory.getAllStrategies();
const applied = allStrategies.filter((s) => s.appliedTotal > 0);
checks.push({
  name: '断点B 反思器策略应用反馈闭环',
  pass: allStrategies.length > 0 && applied.length > 0,
  detail: `蒸馏策略 ${allStrategies.length} 条，其中 ${applied.length} 条被应用回写（${applied
    .map((s) => `applied ${s.appliedSuccesses}/${s.appliedTotal}, conf ${s.confidence.toFixed(2)}`)
    .join('；')}）`,
});

// 断点 C：高置信度模式触发经验快路径
const memoryPlans = rounds.filter((r) => r.source === 'memory');
checks.push({
  name: '断点C 优化器经验快路径复用历史计划',
  pass: fastPathRounds > 0 && memoryPlans.length === fastPathRounds,
  detail: `${fastPathRounds}/${TOTAL_ROUNDS} 轮命中快路径（跳过 LLM 规划，直接复用历史成功计划）`,
});

// 附加：闭环整体健康度（成功沉淀 → 置信度上升）
const lastConfidence = rounds[rounds.length - 1].confidence;
checks.push({
  name: '附加 记忆置信度随成功演化',
  pass: Number(lastConfidence) > 0.5,
  detail: `模式置信度 0.50 → ${lastConfidence}`,
});

// ── 自主学习建议 1：混合检索增强（FTS5 双分词 + jieba 式管道 + 稀疏向量 + 图联想） ──
memory.flushSync();
const ftsHits = memory.fullTextSearch('实现排序函数');
const vecHits = memory.vectorSearch('实现排序函数');
memoryGraph.save();
const graph = new MemoryGraph(graphPath);
const hybrid = new Optimizer({ memory, graph }).hybridSearch('实现排序函数', TASK_TYPE, 0.6, 5);
checks.push({
  name: '建议1 混合检索增强（FTS5 trigram+分词 / 稀疏向量 / 图联想）',
  pass: ftsHits.length > 0 && vecHits.length > 0 && hybrid.length > 0,
  detail: `FTS5 命中 ${ftsHits.length}、向量命中 ${vecHits.length}、混合(含图联想) ${hybrid.length}；jieba 式分词示例 [${segment('自主调度优化').slice(0, 4).join(', ')}]`,
});
graph.save();

// ── 自主学习建议 2：记忆网络 + 主题树（内存管理 + JSON 序列化） ──
const graphStats = graph.stats();
const tree = graph.topicTree();
const reloadedGraph = new MemoryGraph(graphPath);
checks.push({
  name: '建议2 记忆网络/主题树序列化与启动恢复',
  pass: graphStats.nodes > 0 && graphStats.edges > 0 && tree.length >= 1 && fs.existsSync(graphPath) && reloadedGraph.stats().nodes === graphStats.nodes,
  detail: `节点 ${graphStats.nodes}、共现边 ${graphStats.edges}、主题树根 ${tree.map((t) => t.name).join('/')}；重启加载一致`,
});

// ── 自主学习建议 3：防幻觉短索引映射（encode → 注入 → decode 往返） ──
const alias = new AliasMap();
const longId = 'strategy-0000000000000001';
const a1 = alias.encode(longId);
const injected = alias.encodeText(`参考 ${longId} 执行`);
const decoded = alias.decodeText(`模型输出引用 ${a1}`);
checks.push({
  name: '建议3 防幻觉短索引（长 ID↔#N 往返一致）',
  pass: a1 === '#1' && injected.includes('#1') && !injected.includes(longId) && decoded.includes(longId),
  detail: `${longId} → ${a1} 注入模型；输出反解回完整 ID，未登记索引原样保留`,
});

// ── 验收 3：SQLite 持久化（node:sqlite 内置）+ 重启恢复 ──
const dbPath = memPath.replace(/\.json$/, '.db');
checks.push({
  name: '验收3 SQLite 持久化（node:sqlite 内置，零依赖）',
  pass: memory.backendKind === 'sqlite' && fs.existsSync(dbPath),
  detail: `backend=${memory.backendKind}，${path.basename(memPath)} → ${path.basename(dbPath)}（三类数据 + 蒸馏策略分表存储）`,
});

// 关系化 schema：SQL 可直接查询/聚合（类型化列 + 索引 + schema 版本）
memory.flushSync();
const { DatabaseSync } = await import('node:sqlite');
const rawDb = new DatabaseSync(dbPath);
const sqlRow = rawDb.prepare('SELECT task_type, confidence, frequency FROM task_patterns WHERE task_type = ?').get(TASK_TYPE);
const schemaVersion = rawDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
const indexCount = rawDb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get().c;
const journalMode = rawDb.prepare('PRAGMA journal_mode').get().journal_mode;
rawDb.close();
checks.push({
  name: '验收3 关系化 schema 可 SQL 直查（WAL + 索引）',
  pass: sqlRow && sqlRow.confidence > 0.9 && schemaVersion === '2' && indexCount >= 3 && journalMode === 'wal',
  detail: `SQL 直查 task_type='${TASK_TYPE}' confidence=${Number(sqlRow?.confidence).toFixed(2)}；schema_version=${schemaVersion}，索引 ${indexCount} 个，journal_mode=${journalMode}`,
});

// 数据库支持完善：维护 API（完整性检查 / 统计 / checkpoint / vacuum / 热备份 / 只读查询）
const integrity = memory.integrityCheck();
const dbStats = memory.dbStats();
memory.checkpoint();
memory.vacuum();
const backupPath = memory.backup(dbPath.replace(/\.db$/, '.bak.db'));
const backupMemory = new LongTermMemory(memPath.replace(/\.json$/, '.bak.json'));
const rawRows = memory.rawQuery('SELECT task_type, confidence FROM task_patterns WHERE task_type = ?', [TASK_TYPE]);
checks.push({
  name: '数据库维护 API（完整性/统计/checkpoint/vacuum/热备份/只读查询）',
  pass:
    integrity === 'ok' &&
    dbStats.patterns >= 1 &&
    dbStats.schemaVersion === 2 &&
    dbStats.fts === true &&
    fs.existsSync(backupPath) &&
    backupMemory.getTopPatterns(1)[0]?.confidence === Number(lastConfidence) &&
    rawRows.length === 1,
  detail: `integrity=${integrity}，stats(patterns=${dbStats.patterns}, schema=v${dbStats.schemaVersion}, fts=${dbStats.fts}, wal=${dbStats.walSize}B)，热备份重载置信度一致，rawQuery 命中 ${rawRows.length} 行`,
});
backupMemory.dispose();
fs.rmSync(backupPath, { force: true });
fs.rmSync(`${backupPath}-wal`, { force: true });
fs.rmSync(`${backupPath}-shm`, { force: true });

// 重启恢复：新实例重载同一持久化文件，记忆完整恢复
const reloaded = new LongTermMemory(memPath);
const reloadedPatterns = reloaded.getTopPatterns(1);
checks.push({
  name: '验收3 重启后记忆正确恢复',
  pass:
    reloaded.backendKind === 'sqlite' &&
    reloadedPatterns.length === 1 &&
    Math.abs(reloadedPatterns[0].confidence - Number(lastConfidence)) < 1e-9 &&
    reloaded.getAllStrategies().length === allStrategies.length,
  detail: `重启后模式置信度 ${reloadedPatterns[0]?.confidence?.toFixed(2)}（与重启前一致），策略 ${reloaded.getAllStrategies().length} 条、画像 ${reloaded.getAllModelProfiles().length} 个完整恢复`,
});
reloaded.dispose();

// ── 对冲机制验证（防止「越学越错」的三个安全阀） ──
const DAY = 86_400_000;
const now = Date.now();

// 构造陈旧记忆：40 天未用的模式 + 100 天未应用的策略
const stalePath = path.join(os.tmpdir(), `dsh-verify-forget-${Date.now()}.json`);
fs.writeFileSync(
  stalePath,
  JSON.stringify({
    version: 1,
    createdAt: now,
    lastUpdatedAt: now,
    taskPatterns: [
      {
        fingerprint: 'old-pattern',
        taskSummary: 'stale pattern',
        frequency: 0,
        firstSeenAt: now - 40 * DAY,
        lastSeenAt: now - 40 * DAY,
        successfulPlans: [],
        failureRecords: [],
        confidence: 0.9,
        avgExecutionTime: 0,
        avgQualityScore: 0,
      },
    ],
    modelProfiles: [],
    decisionFeedback: [],
    distilledStrategies: [
      {
        id: 'stale-strategy',
        taskType: 'stale',
        description: 'stale strategy',
        sourceFingerprint: 'old-pattern',
        supportCount: 0,
        confidence: 0.8,
        distilledAt: now - 100 * DAY,
        appliedSuccesses: 0,
        appliedTotal: 0,
      },
    ],
    globalStats: { totalExecutions: 0, totalSuccesses: 0, totalFailures: 0, totalTokensUsed: 0, totalCostEstimate: 0, averageQualityScore: 0, averageExecutionTime: 0 },
  }),
);
const staleMemory = new LongTermMemory(stalePath);

// 验收 3 补充：旧版 JSON 记忆自动迁移至 SQLite（原文件归档为 .migrated）
checks.push({
  name: '验收3 旧版 JSON 记忆自动迁移至 SQLite',
  pass: staleMemory.backendKind === 'sqlite' && fs.existsSync(`${stalePath}.migrated`) && !fs.existsSync(stalePath),
  detail: `旧 JSON 记忆经一次性迁移载入 SQLite，原文件归档为 ${path.basename(stalePath)}.migrated`,
});

// 对冲 1：遗忘曲线幂等衰减（连续两次维护调用不复合叠加）
const firstRun = staleMemory.applyForgettingCurve();
const confAfterFirst = staleMemory.getTopPatterns(1)[0]?.confidence ?? 0;
staleMemory.applyForgettingCurve();
const confAfterSecond = staleMemory.getTopPatterns(1)[0]?.confidence ?? 0;
checks.push({
  name: '对冲1 遗忘曲线幂等衰减',
  pass: firstRun.decayed >= 1 && confAfterFirst < 0.9 && Math.abs(confAfterFirst - confAfterSecond) < 1e-9,
  detail: `40 天未用模式 0.90 → ${confAfterFirst.toFixed(3)}；连续两次维护调用后仍为 ${confAfterSecond.toFixed(3)}（无复合衰减）`,
});

// 对冲 2：置信度衰减覆盖蒸馏策略（长期未应用的策略被遗忘清除）
checks.push({
  name: '对冲2 置信度衰减覆盖蒸馏策略',
  pass: firstRun.forgotten >= 1 && staleMemory.getAllStrategies().length === 0,
  detail: `100 天未应用策略（置信度 0.80）被彻底遗忘清除，剩余策略 ${staleMemory.getAllStrategies().length} 条`,
});

// 对冲 3：阈值自校准（质量普遍偏高 → 收紧阈值追求卓越）
const calibEngine = new ReflectionEngine({ qualityThreshold: 0.7 });
for (let i = 0; i < 12; i += 1) calibEngine.recordExecution('calib', 0.95, true);
checks.push({
  name: '对冲3 阈值自校准',
  pass: calibEngine.getCurrentThreshold() > 0.7,
  detail: `质量持续 0.95 时阈值 0.70 → ${calibEngine.getCurrentThreshold().toFixed(2)}（收紧追求卓越；偏低时对称放宽）`,
});

fs.rmSync(stalePath, { force: true });
fs.rmSync(`${stalePath}.migrated`, { force: true });
fs.rmSync(stalePath.replace(/\.json$/, '.db'), { force: true });
fs.rmSync(`${stalePath.replace(/\.json$/, '.db')}-wal`, { force: true });
fs.rmSync(`${stalePath.replace(/\.json$/, '.db')}-shm`, { force: true });

console.log('\n=== 断言结果 ===\n');
let allPass = true;
for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);
  console.log(`      ${check.detail}`);
  if (!check.pass) allPass = false;
}

fs.rmSync(memPath, { force: true });
fs.rmSync(dbPath, { force: true });
fs.rmSync(`${dbPath}-wal`, { force: true });
fs.rmSync(`${dbPath}-shm`, { force: true });
fs.rmSync(`${memPath}.migrated`, { force: true });
fs.rmSync(graphPath, { force: true });
console.log(allPass ? '\n✓ 新架构闭环验证全部通过：记忆 → 优化 → 执行 → 反思 → 记忆更新，越用越聪明。' : '\n✗ 存在未通过的断言，请检查。');
process.exit(allPass ? 0 : 1);
