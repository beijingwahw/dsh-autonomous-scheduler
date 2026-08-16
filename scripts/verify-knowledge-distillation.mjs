/**
 * verify-knowledge-distillation.mjs — 第二阶段「三层记忆 + 知识蒸馏」闭环离线验证
 *
 * 数据流（第二阶段单向闭环）：
 *   情景记忆(TaskPatternMemory) --蒸馏--> 语义/程序记忆 --检索--> 优化器三层级联
 *     --执行--> 反思器(应用反馈回写) --记忆更新--> 记忆库
 *
 * 全程离线（不依赖 LLM / 定时器），验证断点：
 *
 *   A 蒸馏产出：模型亲和/复杂度规律（语义）+ prefer-model/enable-cot（调度规则）+ avoid-model（反思规则）
 *   B 稳定 id：重复蒸馏不产生重复条目，同 id 覆盖（updated）保留应用反馈统计
 *   C 水位门控：蒸馏后 pending=0 → 非 force 跳过（below-threshold）；新增样本达阈值后恢复全量蒸馏
 *   D 三层级联：procedural → semantic → episodic → none，rationale 说明决策依据
 *   E avoid 聚合：多条程序记忆的 avoid-model 动作聚合为 avoidModels
 *   F 应用反馈闭环：recordSemantic/ProceduralOutcome + reflectOnOutcome(appliedMemoryIds) 回写校准
 *   G 证据合并：同规律异 id → merged（支撑度累加、置信度加权、溯源并集）
 *   H 冲突消解：强新证据取代旧规律（superseded），弱证据保守丢弃（duplicate）
 *   I 持久化：语义/程序记忆 + 蒸馏水位重启恢复一致
 *
 * 运行：npm run build && node scripts/verify-knowledge-distillation.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongTermMemory, MemoryGraph, Optimizer, Reflector, ReflectionEngine } from '../dist/index.mjs';

const TASK_TYPE = 'code-generation';
const STRONG = 'model-strong';
const WEAK = 'model-weak';

// ── 环境准备：临时持久化路径 ──
const stamp = Date.now();
const memPath = path.join(os.tmpdir(), `dsh-verify-kd-${stamp}.json`);
const graphPath = path.join(os.tmpdir(), `dsh-verify-kd-graph-${stamp}.json`);
fs.rmSync(memPath, { force: true });
fs.rmSync(graphPath, { force: true });

const memory = new LongTermMemory(memPath);
const graph = new MemoryGraph(graphPath);
const reflectionEngine = new ReflectionEngine({ qualityThreshold: 0.7 });
const reflector = new Reflector({
  memory,
  reflection: reflectionEngine,
  graph,
  config: { enableProgress: false, autoDistillThreshold: 5 },
});
const optimizer = new Optimizer({ memory, graph });

// ── 测试数据工厂 ──
let signalSeq = 0;
function makeSignal(description) {
  return {
    id: `sig-${++signalSeq}`,
    type: TASK_TYPE,
    description,
    payload: {},
    receivedAt: Date.now(),
    source: 'verify-kd',
    occurrences: 1,
  };
}

function makePlan(objective) {
  return {
    objective,
    nodes: [{ id: 'node-1', description: objective, type: TASK_TYPE, dependsOn: [] }],
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
}

/** 直接写入一条成功情景样本（绕开执行器，精确控制情景记忆形态） */
function seedSuccess(complexity, features, modelId, seq) {
  const nodeId = `node-${seq}`;
  memory.recordSuccess({
    taskType: TASK_TYPE,
    complexity,
    features,
    taskSummary: `${TASK_TYPE}: 样本 ${seq}`,
    plan: {
      objective: `目标 ${seq}`,
      nodes: [{ id: nodeId, description: `步骤 ${seq}`, type: TASK_TYPE, dependsOn: [] }],
      parallelismStrategy: 'layered',
    },
    modelAssignments: { [nodeId]: modelId },
    totalLatency: 100 + seq,
    qualityScores: { [nodeId]: 0.9 },
    tokenCost: 120,
  });
}

/** 经反思引擎沉淀一条 timeout 教训（rootCause='timeout'，失败模型 = WEAK） */
async function seedTimeoutLesson(seq) {
  const signal = makeSignal(`${TASK_TYPE} 超时场景 ${seq}`);
  const plan = makePlan(`超时目标 ${seq}`);
  const result = {
    planId: `plan-${seq}`,
    success: false,
    nodeResults: [
      {
        nodeId: 'node-1',
        modelId: WEAK,
        success: false,
        quality: 0,
        latency: 5000,
        attempts: 2,
        error: '执行超时：节点在 5000ms 内未完成',
        tokensUsed: 50,
      },
    ],
    totalTime: 5000,
    successCount: 0,
    totalTokens: 50,
    avgQuality: 0,
  };
  await reflectionEngine.extractLesson({ signal, taskType: TASK_TYPE, result, plan });
}

// ══════════════════════════ 阶段一：构造情景记忆 ══════════════════════════
// 两个高复杂度 code 模式（bucket 0.8 / 0.7，各 3 次成功 → confidence 0.65 ≥ 0.6，成功方案 3 条达 minSuccesses）
for (let i = 1; i <= 3; i += 1) seedSuccess(0.8, ['code'], STRONG, i);
for (let i = 4; i <= 6; i += 1) seedSuccess(0.7, ['code', 'review'], STRONG, i);
// 2 条同类 timeout 教训 → 反思规则蒸馏素材
await seedTimeoutLesson(1);
await seedTimeoutLesson(2);

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

// ══════════════════════════ 断点 A：首次强制蒸馏产出 ══════════════════════════
const first = await reflector.distillKnowledge({ force: true });
const semanticByDomain = new Map(first.semanticMemories.map((m) => [m.domain, m]));
const schedRules = first.proceduralMemories.filter((p) => p.kind === 'scheduling');
const reflRules = first.proceduralMemories.filter((p) => p.kind === 'reflection');

check(
  '断点A 语义记忆蒸馏（模型亲和 + 复杂度规律）',
  Boolean(semanticByDomain.get('model-affinity')) && Boolean(semanticByDomain.get('complexity-pattern')) && first.sourceEpisodicCount === 2,
  `来源情景 ${first.sourceEpisodicCount} 个模式 → 语义 ${first.semanticMemories.length} 条：${[...semanticByDomain.keys()].join(' / ')}；亲和结论=${semanticByDomain.get('model-affinity')?.conclusion.value}`,
);
check(
  '断点A 程序记忆蒸馏（调度规则 prefer-model + enable-cot）',
  schedRules.length >= 2 && schedRules.some((p) => p.action.type === 'prefer-model') && schedRules.some((p) => p.action.type === 'enable-cot'),
  `调度规则 ${schedRules.length} 条：${schedRules.map((p) => `${p.name}→${p.action.type}`).join('；')}`,
);
check(
  '断点A 程序记忆蒸馏（反思规则 avoid-model）',
  reflRules.length >= 1 && reflRules.every((p) => p.action.type === 'avoid-model') && reflRules.some((p) => p.action.params.model === WEAK),
  `反思规则 ${reflRules.length} 条：${reflRules.map((p) => `${p.name}（支撑 ${p.supportCount}）`).join('；')}`,
);

const semMa = semanticByDomain.get('model-affinity');
const firstSemanticIds = new Set(memory.getAllSemanticMemories().map((m) => m.id));
const firstProceduralIds = new Set(memory.getAllProceduralMemories().map((p) => p.id));

// ══════════════════════════ 断点 B：稳定 id（重复蒸馏幂等） ══════════════════════════
const second = await reflector.distillKnowledge({ force: true });
const semanticIdsAfter = new Set(memory.getAllSemanticMemories().map((m) => m.id));
const proceduralIdsAfter = new Set(memory.getAllProceduralMemories().map((p) => p.id));
const idSetsEqual =
  semanticIdsAfter.size === firstSemanticIds.size && [...semanticIdsAfter].every((id) => firstSemanticIds.has(id)) &&
  proceduralIdsAfter.size === firstProceduralIds.size && [...proceduralIdsAfter].every((id) => firstProceduralIds.has(id));
check(
  '断点B 稳定 id：重复蒸馏条目数不增、id 不变',
  idSetsEqual && !first.skipped && !second.skipped,
  `语义 ${firstSemanticIds.size}→${semanticIdsAfter.size} 条、程序 ${firstProceduralIds.size}→${proceduralIdsAfter.size} 条（内容寻址 id 跨次蒸馏稳定）`,
);

// ══════════════════════════ 断点 C：蒸馏水位门控 ══════════════════════════
const progressAfterDistill = memory.getDistillationProgress();
const skippedReport = await reflector.distillKnowledge(); // 非 force：水位归零且已有知识 → 应跳过
check(
  '断点C 水位门控：无新增样本时跳过全量蒸馏',
  progressAfterDistill.pendingSinceLastDistillation === 0 && skippedReport.skipped === true && skippedReport.skipReason === 'below-threshold',
  `蒸馏后 pending=${progressAfterDistill.pendingSinceLastDistillation} → 非 force 蒸馏返回 skipped（${skippedReport.skipReason}）`,
);

const supportBefore = memory.getAllSemanticMemories().find((m) => m.id === semMa.id)?.supportCount ?? 0;
for (let i = 7; i <= 12; i += 1) seedSuccess(0.8, ['code'], STRONG, i); // 新增 6 个情景事件 ≥ 阈值 5
const progressAfterFeed = memory.getDistillationProgress();
const third = await reflector.distillKnowledge(); // 非 force：水位达阈值 → 应执行全量蒸馏
const supportAfter = memory.getAllSemanticMemories().find((m) => m.id === semMa.id)?.supportCount ?? 0;
check(
  '断点C 水位恢复：新增样本达阈值后重新全量蒸馏（支撑度全量重算增强）',
  progressAfterFeed.pendingSinceLastDistillation >= 5 && !third.skipped && supportAfter > supportBefore,
  `新增 ${progressAfterFeed.pendingSinceLastDistillation} 个事件 → 蒸馏执行（非跳过），模型亲和支撑度 ${supportBefore} → ${supportAfter}`,
);

// ══════════════════════════ 断点 D：优化器三层级联检索 ══════════════════════════
const lookupProc = optimizer.lookupExperience(TASK_TYPE, 0.8, ['code'], { length: 12000 });
check(
  '断点D 程序层命中：memoryLayer=procedural + matchedProceduralIds + rationale',
  lookupProc.memoryLayer === 'procedural' && (lookupProc.matchedProceduralIds?.length ?? 0) >= 1 && lookupProc.rationale.includes('程序记忆') && Boolean(lookupProc.matchedSemanticId),
  `层级=${lookupProc.memoryLayer}，命中规则 ${lookupProc.matchedProceduralIds?.length ?? 0} 条 + 语义 ${lookupProc.matchedSemanticId ? 1 : 0} 条；依据：${lookupProc.rationale}`,
);

const lookupSem = optimizer.lookupExperience('data-analysis', 0.9, ['analysis']); // 无该任务程序规则/情景模式 → 复杂度语义规律兜底
check(
  '断点D 语义层兜底：无程序规则时回退跨任务复杂度规律',
  lookupSem.memoryLayer === 'semantic' && Boolean(lookupSem.matchedSemanticId) && lookupSem.rationale.includes('语义记忆'),
  `data-analysis(0.9) → 层级=${lookupSem.memoryLayer}；依据：${lookupSem.rationale}`,
);

const lookupNone = optimizer.lookupExperience('unknown-task', 0.2, []);
check(
  '断点D 冷启动：三层均未命中 → none（首次任务走常规规划）',
  lookupNone.memoryLayer === 'none' && lookupNone.rationale.includes('无记忆命中') && lookupNone.recommendedModels[TASK_TYPE] === undefined,
  `unknown-task → 层级=${lookupNone.memoryLayer}；依据：${lookupNone.rationale}`,
);

// ══════════════════════════ 断点 E：avoid-model 负向约束聚合（独立实例） ══════════════════════════
const avoidMemPath = path.join(os.tmpdir(), `dsh-verify-kd-avoid-${stamp}.json`);
const avoidMemory = new LongTermMemory(avoidMemPath);
const baseConds = [
  { dimension: 'task-type', operator: 'eq', value: TASK_TYPE },
  { dimension: 'feature', operator: 'contains', value: 'code' },
  { dimension: 'complexity', operator: 'gte', value: 0.7 },
];
avoidMemory.upsertProceduralMemory({
  id: 'proc-prefer-a', kind: 'scheduling', name: '偏好模型A', taskTypes: [TASK_TYPE], conditions: baseConds,
  action: { type: 'prefer-model', params: { model: 'model-a' }, rationale: 'test' },
  confidence: 0.9, supportCount: 5, sourceFingerprints: [], distilledAt: Date.now(), appliedTotal: 0, appliedSuccesses: 0,
});
avoidMemory.upsertProceduralMemory({
  id: 'proc-avoid-b', kind: 'scheduling', name: '规避模型B', taskTypes: [TASK_TYPE], conditions: baseConds,
  action: { type: 'avoid-model', params: { model: 'model-b' }, rationale: 'test' },
  confidence: 0.85, supportCount: 4, sourceFingerprints: [], distilledAt: Date.now(), appliedTotal: 0, appliedSuccesses: 0,
});
const avoidOptimizer = new Optimizer({ memory: avoidMemory });
const avoidLookup = avoidOptimizer.lookupExperience(TASK_TYPE, 0.8, ['code']);
check(
  '断点E avoid 聚合：多条程序记忆动作合并（prefer + avoid 同时生效）',
  avoidLookup.memoryLayer === 'procedural' &&
    avoidLookup.recommendedModels[TASK_TYPE] === 'model-a' &&
    avoidLookup.avoidModels.includes('model-b') &&
    (avoidLookup.suggestedActions?.length ?? 0) === 2,
  `prefer=${avoidLookup.recommendedModels[TASK_TYPE]}，avoid=[${avoidLookup.avoidModels.join(',')}]，动作 ${avoidLookup.suggestedActions?.length ?? 0} 条`,
);
avoidMemory.dispose();
fs.rmSync(avoidMemPath, { force: true });
fs.rmSync(avoidMemPath.replace(/\.json$/, '.db'), { force: true });

// ══════════════════════════ 断点 F：应用反馈闭环回写 ══════════════════════════
const semanticTarget = memory.getAllSemanticMemories().find((m) => m.id === semMa.id);
const procTargets = memory.getAllProceduralMemories().filter((p) => p.kind === 'scheduling');
const confBefore = semanticTarget?.confidence ?? 0;
// 注意：getAllSemanticMemories 返回浅拷贝数组（元素为引用），断言取值需在读点快照
const snapSemantic = () => {
  const m = memory.getAllSemanticMemories().find((x) => x.id === semMa.id);
  return { appliedTotal: m?.appliedTotal ?? -1, appliedSuccesses: m?.appliedSuccesses ?? -1, confidence: m?.confidence ?? 0, lastAppliedAt: m?.lastAppliedAt ?? 0 };
};
memory.recordSemanticOutcome(semMa.id, true);
memory.recordSemanticOutcome(semMa.id, true);
const semanticAfterFb = snapSemantic();
for (const proc of procTargets) memory.recordProceduralOutcome(proc.id, true);
const procAfterFbAppliedTotal = memory.getAllProceduralMemories().find((p) => p.id === procTargets[0]?.id)?.appliedTotal ?? -1;

// reflectOnOutcome 传递 appliedMemoryIds → 反思器统一回写（+1 应用）
const fbSignal = makeSignal('应用反馈闭环场景');
const fbPlan = makePlan('反馈目标');
const fbResult = {
  planId: 'plan-fb', success: true,
  nodeResults: [{ nodeId: 'node-1', modelId: STRONG, success: true, output: 'ok', quality: 0.95, latency: 120, attempts: 1, tokensUsed: 80 }],
  totalTime: 120, successCount: 1, totalTokens: 80, avgQuality: 0.95,
};
reflector.reflectOnOutcome({
  signal: fbSignal, plan: fbPlan, result: fbResult,
  appliedMemoryIds: { semantic: [semMa.id], procedural: procTargets.map((p) => p.id) },
});
const semanticAfterReflect = snapSemantic();
const expectedConfAfter3 = ((confBefore * 0.7 + 0.3) * 0.7 + 0.3) * 0.7 + 0.3; // 连续 3 次成功应用：conf ← 0.7×conf + 0.3×1
check(
  '断点F 应用反馈闭环：记忆库直写 + 反思器 appliedMemoryIds 回写',
  semanticAfterFb.appliedTotal === 2 &&
    semanticAfterFb.appliedSuccesses === 2 &&
    semanticAfterFb.lastAppliedAt > 0 &&
    procAfterFbAppliedTotal === 1 &&
    semanticAfterReflect.appliedTotal === 3 &&
    Math.abs(semanticAfterReflect.confidence - expectedConfAfter3) < 1e-9,
  `语义 applied ${semanticAfterFb.appliedSuccesses}/${semanticAfterFb.appliedTotal} → 反思器回写后 ${semanticAfterReflect.appliedSuccesses}/${semanticAfterReflect.appliedTotal}，程序 applied ${procAfterFbAppliedTotal}，置信度 ${confBefore.toFixed(3)} → ${semanticAfterReflect.confidence.toFixed(3)}（每次 0.7×旧 + 0.3×应用成功率）`,
);

// ══════════════════════════ 断点 B 补充：重蒸馏保留应用反馈统计 ══════════════════════════
await reflector.distillKnowledge({ force: true });
const semanticAfterRedistill = memory.getAllSemanticMemories().find((m) => m.id === semMa.id);
check(
  '断点B 补充 重蒸馏不清零应用反馈统计',
  (semanticAfterRedistill?.appliedTotal ?? 0) === 3 && (semanticAfterRedistill?.appliedSuccesses ?? 0) === 3,
  `同 id 覆盖（updated）后 applied ${semanticAfterRedistill?.appliedSuccesses}/${semanticAfterRedistill?.appliedTotal} 保持不变（闭环数据不丢）`,
);

// ══════════════════════════ 断点 G/H：证据合并 + 冲突消解（独立实例） ══════════════════════════
const upsertMemPath = path.join(os.tmpdir(), `dsh-verify-kd-upsert-${stamp}.json`);
const upsertMemory = new LongTermMemory(upsertMemPath);
const now = Date.now();
const mkSem = (id, value, support, confidence) => ({
  id, domain: 'model-affinity', statement: `${TASK_TYPE} 类任务适合模型 ${value}`,
  taskTypes: [TASK_TYPE],
  conditions: [{ dimension: 'task-type', operator: 'eq', value: TASK_TYPE }],
  conclusion: { type: 'model-preference', value, rationale: 'test' },
  confidence, supportCount: support, sourceFingerprints: [`fp-${id}`], distilledAt: now, appliedTotal: 0, appliedSuccesses: 0,
});

const r1 = upsertMemory.upsertSemanticMemory(mkSem('sem-old', 'model-x', 4, 0.8));
const mergedInput = mkSem('sem-new-id', 'model-x', 6, 0.9); // 同 statement 异 id → merged
const r2 = upsertMemory.upsertSemanticMemory(mergedInput);
const merged = upsertMemory.getAllSemanticMemories().find((m) => m.statement.includes('model-x'));
check(
  '断点G 证据合并：同规律异 id → merged（支撑累加 + 置信度加权 + 溯源并集）',
  r1 === 'created' && r2 === 'merged' && (merged?.supportCount ?? 0) === 10 && [...new Set([...(merged?.sourceFingerprints ?? [])])].length === 2,
  `created→merged：supportCount 4+6=${merged?.supportCount}，加权置信度=${merged?.confidence.toFixed(3)}（≤0.98 上限），溯源指纹并集 ${merged?.sourceFingerprints.length} 个`,
);

const weakConflict = upsertMemory.upsertSemanticMemory(mkSem('sem-weak', 'model-y', 5, 0.7)); // 5 < 10×1.5 → duplicate
const strongConflict = upsertMemory.upsertSemanticMemory(mkSem('sem-strong', 'model-y', 16, 0.75)); // 16 ≥ 15 且 ≥3 → superseded
const afterSupersede = upsertMemory.getAllSemanticMemories();
const winner = afterSupersede.find((m) => m.conclusion.value === 'model-y');
check(
  '断点H 冲突消解：弱证据丢弃（duplicate）/ 强证据同槽取代（superseded）',
  weakConflict === 'duplicate' && strongConflict === 'superseded' && afterSupersede.length === 1 && winner?.supportCount === 26 && winner?.id === 'sem-strong',
  `model-y 支撑 5（< 10×1.5）被丢弃；支撑 16 同槽取代 model-x 旧规律并继承证据（supportCount=16+10=${winner?.supportCount}），同一结构签名仅存 1 条胜出结论`,
);
upsertMemory.dispose();
fs.rmSync(upsertMemPath, { force: true });
fs.rmSync(upsertMemPath.replace(/\.json$/, '.db'), { force: true });

// ══════════════════════════ 断点 I：持久化重启恢复 ══════════════════════════
memory.flushSync();
const progressBefore = memory.getDistillationProgress();
const semanticCount = memory.getAllSemanticMemories().length;
const proceduralCount = memory.getAllProceduralMemories().length;
const reloaded = new LongTermMemory(memPath);
const progressReloaded = reloaded.getDistillationProgress();
check(
  '断点I 持久化恢复：语义/程序记忆 + 蒸馏水位重启一致',
  reloaded.getAllSemanticMemories().length === semanticCount &&
    reloaded.getAllProceduralMemories().length === proceduralCount &&
    progressReloaded.lastDistillationEventCount === progressBefore.lastDistillationEventCount &&
    progressReloaded.pendingSinceLastDistillation === progressBefore.pendingSinceLastDistillation,
  `重启后语义 ${reloaded.getAllSemanticMemories().length}/${semanticCount} 条、程序 ${reloaded.getAllProceduralMemories().length}/${proceduralCount} 条，水位 checkpoint=${progressReloaded.lastDistillationEventCount}（不重置、不丢增量）`,
);
reloaded.dispose();

// ══════════════════════════ 结果输出 ══════════════════════════
console.log('\n=== 第二阶段「三层记忆 + 知识蒸馏」闭环验证 ===\n');
console.log(`首次蒸馏摘要：${first.summary.replace(/\n/g, '\n                  ')}`);
console.log('\n=== 断言结果 ===\n');
let allPass = true;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.detail}`);
  if (!c.pass) allPass = false;
}

// 清理
memory.dispose();
fs.rmSync(memPath, { force: true });
fs.rmSync(memPath.replace(/\.json$/, '.db'), { force: true });
fs.rmSync(`${memPath.replace(/\.json$/, '.db')}-wal`, { force: true });
fs.rmSync(`${memPath.replace(/\.json$/, '.db')}-shm`, { force: true });
fs.rmSync(graphPath, { force: true });

console.log(allPass ? '\n✓ 三层记忆蒸馏闭环全部通过：情景 → 蒸馏（语义/程序）→ 级联检索 → 反馈回写 → 记忆更新。' : '\n✗ 存在未通过的断言，请检查。');
process.exit(allPass ? 0 : 1);
