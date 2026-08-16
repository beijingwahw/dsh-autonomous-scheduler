/**
 * verify-resilience-governance.mjs — 项目 4.0「可靠执行 + 治理闭环」离线验证
 *
 * 升级主线（全部离线，不依赖 LLM）：
 *   core/resilience.ts 弹性内核（熔断器 / 指数退避全抖动 / 错误分型）
 *     → task-executor 熔断感知调度 + 分型差异化重试
 *   safety-governor.ts 治理闭环（半开探测互斥 / 按动作限流 / 预算 / 审计持久化）
 *
 * 验证断点：
 *   A 熔断器状态机：closed → open（阈值）→ half-open（冷却后单试探）
 *     → closed（试探成功）/ re-open（试探失败），全部注入确定性时钟
 *   B 半开互斥与名额治理：探测在途拒绝并发 / peek 纯读不占名额 /
 *     releaseProbe 释放「无法判定下游」的探测资格（名额泄漏修复）
 *   C 熔断器注册表：按 key 故障隔离 + 容量上限 LRU 淘汰 + snapshot/hasOpen
 *   D 指数退避：确定性上界序列（200→400→800→…→8000 封顶）+ 全抖动分布
 *   E 可中止睡眠：睡满 true / 中止 false / 预中止 false / 零毫秒直通
 *   F 错误分型：超时/网络→退避重试，429→rate-limit，5xx/408→server，
 *     4xx（非 408/429）→fatal，未知错→fatal（保守终止）
 *   G 治理闭环：kill switch > 熔断（半开互斥）> 限流（按动作独立窗口 +
 *     共享全局窗）> 预算（token/成本）> 置信度门控（探索豁免）；checkGate 纯读
 *   H 治理持久化：预算累计 + kill switch + 审计尾部落盘重启恢复
 *
 * 运行：npm run build && node scripts/verify-resilience-governance.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  backoffDelayMs,
  abortableSleep,
  classifyError,
  SafetyGovernor,
  TimeoutError,
  NetworkError,
  LLMError,
} from '../dist/index.mjs';

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// abortableSleep 内部定时器为 unref（不拖住宿主事件循环），独立脚本运行时事件循环
// 会被清空导致 Node 以 13 退出（未决 top-level await）——用 ref'd 保持器撑住循环。
const keepAlive = setInterval(() => {}, 1_000_000);

// ══════════════════ 断点 A：熔断器状态机（确定性时钟） ══════════════════
{
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000 });
  const t0 = 1_000_000;

  const initial = breaker.canExecute(t0);
  breaker.recordFailure(t0);
  breaker.recordFailure(t0);
  const belowThreshold = breaker.getState();
  breaker.recordFailure(t0); // 第 3 次失败 → 熔断
  const tripped = breaker.getState();
  check(
    '断点A 连续失败达阈值熔断：closed → open（未达阈值保持 closed）',
    initial.allowed && initial.state === 'closed' &&
      belowThreshold.state === 'closed' && belowThreshold.consecutiveFailures === 2 &&
      tripped.state === 'open' && tripped.consecutiveFailures === 3,
    `初始 ${initial.state}；2 次失败后 ${belowThreshold.state}(${belowThreshold.consecutiveFailures})；3 次失败后 ${tripped.state}`,
  );

  const midCooldown = breaker.canExecute(t0 + 400);
  const atCooldown = breaker.canExecute(t0 + 1_000); // 冷却期满 → 半开试探
  check(
    '断点A 冷却期内拒绝并报告剩余时间；期满转入 half-open 放行试探',
    !midCooldown.allowed && midCooldown.state === 'open' && midCooldown.msUntilRetry === 600 &&
      atCooldown.allowed && atCooldown.state === 'half-open',
    `t+400ms → ${midCooldown.state}（剩 ${midCooldown.msUntilRetry}ms）；t+1000ms → ${atCooldown.state} 放行`,
  );

  breaker.recordSuccess(); // 试探成功 → 恢复闭合
  const recovered = breaker.getState();
  const afterRecover = breaker.canExecute(t0 + 1_100);
  check(
    '断点A 半开试探成功 → closed 且失败计数清零',
    recovered.state === 'closed' && recovered.consecutiveFailures === 0 && afterRecover.allowed && afterRecover.state === 'closed',
    `试探成功后 state=${recovered.state}，failures=${recovered.consecutiveFailures}`,
  );

  // 试探失败 → 重新熔断（新冷却期起点）
  breaker.recordFailure(t0 + 2_000);
  breaker.recordFailure(t0 + 2_000);
  breaker.recordFailure(t0 + 2_000);
  const reopen = breaker.canExecute(t0 + 2_000);
  const probe = breaker.canExecute(t0 + 3_100); // 冷却期满，占住探测名额
  breaker.recordFailure(t0 + 3_100); // 试探失败 → 重新 open
  const afterProbeFail = breaker.getState();
  const nextDenied = breaker.canExecute(t0 + 3_200);
  check(
    '断点A 半开试探失败 → 重新 open（冷却期重新计时）',
    reopen.state === 'open' && probe.allowed && probe.state === 'half-open' &&
      afterProbeFail.state === 'open' && !nextDenied.allowed && nextDenied.state === 'open',
    `试探失败后 state=${afterProbeFail.state}，t+100ms 再探 → ${nextDenied.state} 拒绝`,
  );
}

// ════════════ 断点 B：半开互斥 + peek 纯读 + releaseProbe 名额治理 ════════════
{
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500 });
  const t0 = 2_000_000;
  breaker.recordFailure(t0);
  breaker.recordFailure(t0); // open

  const firstProbe = breaker.canExecute(t0 + 500); // 名额被占
  const concurrent = breaker.canExecute(t0 + 501); // 互斥拒绝
  const peekResult = breaker.peek(t0 + 502); // 纯读：仍显示被占，且不偷名额
  const peekAgain = breaker.peek(t0 + 503);
  check(
    '断点B 半开并发互斥：探测在途时其余请求拒绝；peek 纯读不占用名额',
    firstProbe.allowed && firstProbe.state === 'half-open' &&
      !concurrent.allowed && concurrent.state === 'half-open' &&
      !peekResult.allowed && peekResult.state === 'half-open' &&
      !peekAgain.allowed,
    `首探放行；并发 → ${concurrent.state} 拒绝；peek 两次均如实反映在途探测`,
  );

  breaker.releaseProbe(); // 客户端 4xx 等场景：释放名额不影响统计
  const reprobe = breaker.canExecute(t0 + 600);
  const statsAfterRelease = breaker.getState();
  check(
    '断点B releaseProbe：释放无法判定下游的探测资格（名额泄漏修复）',
    reprobe.allowed && reprobe.state === 'half-open' && statsAfterRelease.consecutiveFailures === 2,
    `释放后再探 → ${reprobe.state} 放行；失败计数保持 ${statsAfterRelease.consecutiveFailures}（未被误清）`,
  );

  breaker.recordSuccess();
  const closed = breaker.getState();
  check('断点B 探测成功闭环：half-open → closed', closed.state === 'closed', `state=${closed.state}`);
}

// ════════════════ 断点 C：注册表隔离 + 容量 LRU 淘汰 ════════════════
{
  const registry = new CircuitBreakerRegistry({ failureThreshold: 2, capacity: 2 });
  registry.recordFailure('model-a');
  registry.recordFailure('model-a'); // model-a 熔断
  const bProbe = registry.peek('model-b');
  const aProbe = registry.peek('model-a');
  check(
    '断点C 按 key 故障隔离：model-a 熔断不影响 model-b',
    aProbe.state === 'open' && !aProbe.allowed && bProbe.allowed && bProbe.state === 'closed' && registry.hasOpen(),
    `model-a → ${aProbe.state}；model-b → ${bProbe.state}；hasOpen=${registry.hasOpen()}`,
  );

  registry.peek('model-c'); // 容量 2：插入 c 淘汰最旧的 a
  const snapshot = registry.snapshot();
  const keys = Object.keys(snapshot);
  check(
    '断点C 容量上限 LRU 淘汰：超出容量淘汰最旧条目（防长尾 key 泄漏）',
    keys.length === 2 && keys.includes('model-b') && keys.includes('model-c') && !keys.includes('model-a'),
    `容量 2 注入 3 个 key 后存活：${keys.join(', ')}`,
  );

  registry.reset();
  check('断点C reset 清空注册表', Object.keys(registry.snapshot()).length === 0 && !registry.hasOpen(), 'reset 后 snapshot 为空');
}

// ════════════════ 断点 D：指数退避 + 全抖动分布 ════════════════
{
  const ceil = backoffDelayMs;
  const seq = [1, 2, 3, 4, 5, 6, 7, 10].map((n) => ceil(n, {}, () => 1.0));
  const expected = [200, 400, 800, 1600, 3200, 6400, 8000, 8000];
  const seqOk = seq.every((v, i) => v === expected[i]);
  const zero = backoffDelayMs(3, {}, () => 0);
  const half = backoffDelayMs(1, {}, () => 0.5);
  check(
    '断点D 指数退避上界：200→400→800→…→6400→8000 封顶；抖动采样 [0, ceiling]',
    seqOk && zero === 0 && half === 100,
    `确定性采样上界序列 ${seq.join('/')}；rng=0 → ${zero}；rng=0.5 → ${half}`,
  );

  const custom2 = backoffDelayMs(2, { baseMs: 100, factor: 3, maxMs: 900 }, () => 1.0);
  const custom3 = backoffDelayMs(3, { baseMs: 100, factor: 3, maxMs: 900 }, () => 1.0);
  check('断点D 退避配置可覆盖：base 100 × factor 3 → attempt2=300，attempt3=900（封顶）', custom2 === 300 && custom3 === 900, `attempt=2 上界 ${custom2}，attempt=3 上界 ${custom3}`);

  const samples = [];
  for (let i = 0; i < 5_000; i += 1) samples.push(backoffDelayMs(2)); // ceiling = 400
  const max = Math.max(...samples);
  const min = Math.min(...samples);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const inLowerHalf = samples.filter((v) => v < 200).length / samples.length;
  check(
    '断点D 全抖动分布：均匀 [0, 400]，均值≈200，下半区占比≈50%（防惊群）',
    min === 0 && max <= 400 && mean > 170 && mean < 230 && inLowerHalf > 0.44 && inLowerHalf < 0.56,
    `n=5000：min=${min} max=${max} mean=${mean.toFixed(1)} 下半区占比=${(inLowerHalf * 100).toFixed(1)}%`,
  );
}

// ════════════════ 断点 E：可中止睡眠 ════════════════
{
  const startedAt = Date.now();
  const full = await abortableSleep(25);
  const elapsed = Date.now() - startedAt;
  check('断点E 睡满返回 true', full === true && elapsed >= 20, `睡 25ms 实际 ${elapsed}ms → ${full}`);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const aborted = await abortableSleep(5_000, ac.signal);
  check('断点E 中止信号到达立即放弃（返回 false）', aborted === false, `长眠 5s 被 10ms 中止 → ${aborted}`);

  const pre = new AbortController();
  pre.abort();
  const preAborted = await abortableSleep(5_000, pre.signal);
  const zeroMs = await abortableSleep(0);
  check('断点E 预中止直通 false；零毫秒无信号直通 true', preAborted === false && zeroMs === true, `预中止 → ${preAborted}；0ms → ${zeroMs}`);
}

// ════════════════ 断点 F：错误分型 ════════════════
{
  const cases = [
    [new TimeoutError('exec timeout'), 'retryable-backoff', 'timeout'],
    [new NetworkError('conn reset'), 'retryable-backoff', 'network'],
    [new LLMError('rate limited', 429), 'retryable-backoff', 'rate-limit'],
    [new LLMError('gateway down', 503), 'retryable-backoff', 'server'],
    [new LLMError('request timeout', 408), 'retryable-backoff', 'server'],
    [new LLMError('bad request', 400), 'fatal', 'client'],
    [new LLMError('unauthorized', 401), 'fatal', 'client'],
    [new Error('boom'), 'fatal', 'unknown'],
    ['plain string error', 'fatal', 'unknown'],
  ];
  const results = cases.map(([err, wantClass, wantKind]) => {
    const got = classifyError(err);
    return { ok: got.class === wantClass && got.kind === wantKind, got, wantClass, wantKind };
  });
  const allOk = results.every((r) => r.ok);
  check(
    '断点F 错误分型：瞬时错退避重试 / 客户端错与未知错保守终止',
    allOk,
    results.map((r) => `${r.got.kind}→${r.got.class}${r.ok ? '' : `（期望 ${r.wantKind}→${r.wantClass}）`}`).join('；'),
  );

  const timeoutCls = classifyError(new TimeoutError('t'));
  check('断点F 分型携带人类可读原因', typeof timeoutCls.reason === 'string' && timeoutCls.reason.length > 0, `reason="${timeoutCls.reason}"`);
}

// ════════════════ 断点 G：治理闭环（裁决优先级链） ════════════════
{
  // G1 置信度门控：低置信拦截 + 探索豁免
  const g1 = new SafetyGovernor({ confidenceThreshold: 0.3, maxActionsPerMinute: 100 });
  const lowConf = g1.govern('autonomous-execute', 0.1);
  const highConf = g1.govern('autonomous-execute', 0.9);
  const exploration = g1.govern('exploration', 0.05);
  check(
    '断点G1 置信度门控：低于阈值拦截（confidence-gate），探索动作豁免',
    !lowConf.allowed && lowConf.blockedBy === 'confidence-gate' && highConf.allowed && exploration.allowed,
    `conf=0.1 → ${lowConf.blockedBy}；conf=0.9 放行；exploration conf=0.05 豁免放行`,
  );

  // G2 按动作独立限流：exploration 2/min，未配置动作走共享全局窗
  const g2 = new SafetyGovernor({
    maxActionsPerMinute: 10,
    perActionRateLimits: { exploration: 2 },
  });
  const e1 = g2.govern('exploration');
  const e2 = g2.govern('exploration');
  const e3 = g2.govern('exploration'); // 独立窗口打满
  const other = g2.govern('autonomous-execute'); // 全局窗未叠加 exploration 计数
  check(
    '断点G2 按动作限流：exploration 独立窗 2/min 打满即拦；其余动作不受其拖累',
    e1.allowed && e2.allowed && !e3.allowed && e3.blockedBy === 'rate-limit' && other.allowed,
    `exploration 前两次放行，第 3 次 → ${e3.blockedBy}；autonomous-execute 仍放行（窗口隔离）`,
  );

  // G3 共享全局窗：未配置动作共用 maxActionsPerMinute
  const g3 = new SafetyGovernor({ maxActionsPerMinute: 3 });
  const v1 = g3.govern('goal-dispatch');
  const v2 = g3.govern('strategy-evolution');
  const v3 = g3.govern('autonomous-execute');
  const v4 = g3.govern('goal-dispatch');
  check(
    '断点G3 全局限流：未配置动作共享窗口，3/min 打满即拦',
    v1.allowed && v2.allowed && v3.allowed && !v4.allowed && v4.blockedBy === 'rate-limit',
    `前 3 次放行（不同动作共享计数），第 4 次 → ${v4.blockedBy}`,
  );

  // G4 预算：token / 成本双闸
  const g4 = new SafetyGovernor({ tokenBudget: 100, costBudget: 1, maxActionsPerMinute: 100 });
  g4.recordOutcome(true, 60, 0.5);
  const within = g4.govern('autonomous-execute');
  g4.recordOutcome(true, 50, 0.6); // token 110 ≥ 100，成本 1.1 ≥ 1 双超
  const beyond = g4.govern('autonomous-execute');
  check(
    '断点G4 预算闸：token/成本累计达上限后拒绝新动作',
    within.allowed && !beyond.allowed && beyond.blockedBy === 'budget',
    `60token/$0.5 时放行；累计 110token/$1.1 后 → ${beyond.blockedBy}（reason：${beyond.reason}）`,
  );

  // G5 熔断 + 半开探测互斥（治理器侧，真实时钟短冷却）
  const g5 = new SafetyGovernor({ circuitFailureThreshold: 3, circuitCooldownMs: 60, maxActionsPerMinute: 100 });
  g5.recordOutcome(false);
  g5.recordOutcome(false);
  const notYet = g5.govern('autonomous-execute');
  g5.recordOutcome(false); // 第 3 次失败 → open
  const tripped = g5.govern('autonomous-execute');
  await sleep(80); // 冷却期满
  const probe1 = g5.govern('autonomous-execute'); // 本调用即试探，占住名额
  const probe2 = g5.govern('autonomous-execute'); // 互斥拒绝
  g5.recordOutcome(true); // 试探成功 → closed
  const after = g5.govern('autonomous-execute');
  check(
    '断点G5 治理熔断：连续失败熔断 → 冷却后单试探互斥 → 成功恢复闭合',
    notYet.allowed && !tripped.allowed && tripped.blockedBy === 'circuit-breaker' &&
      probe1.allowed && !probe2.allowed && probe2.blockedBy === 'circuit-breaker' &&
      after.allowed && g5.getCircuitState() === 'closed',
    `3 败后 → ${tripped.blockedBy}；冷却后首探放行、次探被互斥拦截；成功后 state=${g5.getCircuitState()}`,
  );

  // G6 半开试探失败 → 重新熔断
  const g6 = new SafetyGovernor({ circuitFailureThreshold: 2, circuitCooldownMs: 40, maxActionsPerMinute: 100 });
  g6.recordOutcome(false);
  g6.recordOutcome(false);
  await sleep(50);
  const p1 = g6.govern('autonomous-execute'); // half-open 试探
  g6.recordOutcome(false); // 试探失败 → 重新 open
  const p2 = g6.govern('autonomous-execute');
  check(
    '断点G6 半开试探失败 → 重新熔断（恢复期下游仍病着则继续冷却）',
    p1.allowed && !p2.allowed && p2.blockedBy === 'circuit-breaker' && g6.getCircuitState() === 'open',
    `试探失败后 state=${g6.getCircuitState()}，后续动作 → ${p2.blockedBy}`,
  );

  // G7 Kill Switch 最高优先级 + checkGate 纯读
  const g7 = new SafetyGovernor({ maxActionsPerMinute: 2 });
  g7.engageKillSwitch();
  const killed = g7.govern('autonomous-execute');
  const gateBefore = g7.checkGate();
  const auditCount = g7.getAudit().length;
  g7.disengageKillSwitch();
  const gateAfter = g7.checkGate();
  check(
    '断点G7 Kill Switch 最高优先级；checkGate 纯读不推进限流窗、不记审计',
    !killed.allowed && killed.blockedBy === 'kill-switch' && !gateBefore.allowed &&
      gateAfter.allowed && g7.getAudit().length === auditCount,
    `启用后 govern → ${killed.blockedBy}，checkGate 同步拦截；解除后 checkGate 放行；审计条数不变（${auditCount}）`,
  );

  // G8 审计日志上限收敛
  const g8 = new SafetyGovernor({ maxActionsPerMinute: 1_000, auditLimit: 50 });
  for (let i = 0; i < 120; i += 1) g8.govern('autonomous-execute');
  check('断点G8 审计上限：超限收敛保留尾部', g8.getAudit(1_000).length === 50, `120 次裁决后审计保留 ${g8.getAudit(1_000).length} 条`);
}

// ════════════════ 断点 H：治理状态持久化重启恢复 ════════════════
{
  const stamp = Date.now();
  const persistPath = path.join(os.tmpdir(), `dsh-verify-gov-${stamp}.json`);
  fs.rmSync(persistPath, { force: true });

  const g1 = new SafetyGovernor({ persistPath, tokenBudget: 1_000, maxActionsPerMinute: 100 });
  g1.recordOutcome(true, 42, 0.37);
  g1.govern('autonomous-execute'); // 放行审计
  g1.engageKillSwitch();
  g1.govern('autonomous-execute'); // kill-switch 拦截审计
  g1.flushPersist();

  const g2 = new SafetyGovernor({ persistPath, maxActionsPerMinute: 100 }); // 模拟重启恢复
  const status = g2.getStatus();
  const audit = g2.getAudit(1_000);
  const stillBlocked = g2.govern('autonomous-execute');
  check(
    '断点H 持久化恢复：预算累计 + kill switch + 审计尾部的跨实例重建',
    g2.isKillSwitchEngaged() && status.budget.tokensUsed === 42 && Math.abs(status.budget.costUsed - 0.37) < 1e-9 &&
      audit.length === 2 && stillBlocked.blockedBy === 'kill-switch',
    `重启后 killSwitch=${g2.isKillSwitchEngaged()}，tokens=${status.budget.tokensUsed}，cost=${status.budget.costUsed}，审计 ${audit.length} 条，动作仍被 ${stillBlocked.blockedBy} 拦截`,
  );

  g2.disengageKillSwitch();
  g2.flushPersist();
  const g3 = new SafetyGovernor({ persistPath, tokenBudget: 1_000, maxActionsPerMinute: 100 });
  const resumed = g3.govern('autonomous-execute');
  check('断点H 解除 kill switch 持久化后重启可恢复执行', resumed.allowed, `恢复后 govern → ${resumed.allowed ? '放行' : resumed.blockedBy}`);

  fs.rmSync(persistPath, { force: true });
}

// ═════════════════════════════ 汇总 ═════════════════════════════
const failed = checks.filter((c) => !c.pass);
console.log(`\n${'═'.repeat(72)}`);
console.log(`弹性内核 + 治理闭环验证：${checks.length - failed.length}/${checks.length} 通过`);
console.log('═'.repeat(72));
for (const c of checks) {
  console.log(`${c.pass ? '✓' : '✗'} ${c.name}`);
  if (!c.pass) console.log(`   详情：${c.detail}`);
}
if (failed.length > 0) {
  clearInterval(keepAlive);
  console.error(`\n${failed.length} 项断点失败`);
  process.exit(1);
}
clearInterval(keepAlive);
console.log('\n全部断点通过：熔断器状态机 / 半开互斥与名额治理 / 注册表隔离 / 指数退避全抖动 / 可中止睡眠 / 错误分型 / 治理裁决链 / 持久化恢复 ✓');
