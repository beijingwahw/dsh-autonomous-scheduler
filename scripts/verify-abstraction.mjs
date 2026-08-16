/**
 * verify-abstraction.mjs — 9.0「抽象心智：类比结构映射」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   8.0 元认知心智：经验锁死在它被采集的具体状态键里——结构相同的
 *      新域永远从 Beta(1,1) 无知开始，深思只能凭认知价值乱试探。
 *   9.0 抽象心智：状态分解为 域#骨架（保关系、换对象）——结构
 *      同构的域互为类比证人，冷状态零样本借用别域后验与**后继
 *      结构**，整体计划跨域成功晋升抽象技能。
 *
 * 闭环断言：
 *   A 均匀层等价：挂载但零数据 → posterior 与未挂载严格相等（零漂移）
 *   B 分层收缩：域边际先验抬升冷状态；叶子证据渐近压倒类比
 *   C 结构相似度：同构域 sim=1、无关域 sim=0（类比的闸门）
 *   D 类比零样本：冷域冷状态直接拿到别域的后验（含陷阱的后继结构）
 *   E 后继继承：trapA 的 bait→#dead 映射为 trapB 的 bait→#dead
 *   F 类比规划分水岭：冷域深思搜索凭继承结构绕开诱饵
 *     （未挂载时同一搜索对称无知、选诱饵；挂载后选缓行）
 *   G 抽象技能：同骨架同序列 2 域成功 → 跨域宏技能 → 第三域冷启动种子
 *   H 元认知 KPI：抽象统计（零样本应答/迁移次数/技能数）+ 缺省零漂移
 *   I 优化器集成：metacognitiveRecommendation 在冷同构域给出类比深思
 *   J 序列化：分层证据 + 抽象技能 roundtrip
 *
 * 运行：npm run build && node scripts/verify-abstraction.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AbstractionEngine,
  DeliberationEngine,
  LongTermMemory,
  MetaCognitionEngine,
  Optimizer,
  RationalMetareasoner,
} from '../dist/index.mjs';

// ─────────────────────────── 断言工具 ───────────────────────────
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

function seed(engine, state, action, successes, failures, next) {
  for (let i = 0; i < successes; i += 1) engine.observe(state, action, true, next);
  for (let i = 0; i < failures; i += 1) engine.observe(state, action, false);
}

/** 陷阱世界播种：诱饵一步诱人、通向死路；缓行一步平庸、通向富态 */
function seedTrapWorld(engine, domain) {
  seed(engine, `${domain}#s0`, 'bait', 9, 1, `${domain}#dead`);
  seed(engine, `${domain}#s0`, 'slow', 6, 4, `${domain}#rich`);
  seed(engine, `${domain}#dead`, 'bait', 2, 8, `${domain}#dead`);
  seed(engine, `${domain}#dead`, 'slow', 2, 8, `${domain}#dead`);
  seed(engine, `${domain}#rich`, 'bait', 19, 1, `${domain}#rich`);
  seed(engine, `${domain}#rich`, 'slow', 19, 1, `${domain}#rich`);
}

// ═══════════════════ A 均匀层等价（零漂移） ═══════════════════

section('A 均匀层等价：挂载但零数据 = 未挂载（严格相等）');

{
  const bare = new DeliberationEngine();
  seed(bare, 'x#s', 'a', 9, 1, 'x#t');
  const attached = new DeliberationEngine();
  attached.attachAbstraction(new AbstractionEngine());
  seed(attached, 'x#s', 'a', 9, 1, 'x#t');

  const p1 = bare.posterior('x#s', 'a');
  const p2 = attached.posterior('x#s', 'a');
  ok(near(p1.pSuccess, p2.pSuccess, 1e-9), `已有证据边后验严格相等（${p1.pSuccess} = ${p2.pSuccess}）`);
  const c1 = bare.posterior('cold#z', 'a');
  const c2 = attached.posterior('cold#z', 'a');
  ok(near(c1.pSuccess, c2.pSuccess, 1e-9) && near(c1.pSuccess, 0.5, 1e-9), `冷边也相等（0.5 = ${c2.pSuccess}：uniform 层 strength=2 ≡ Beta(1,1)）`);
  ok(c2.abstract?.source === 'uniform', `来源标注 uniform（实测 ${c2.abstract?.source}）`);
}

// ═══════════════════ B 分层收缩 ═══════════════════

section('B 分层收缩：域边际抬升冷状态，叶子渐近压倒先验');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  // 域内其他骨架对该行动经验极佳；目标骨架全新
  seed(d, 'gen#a', 'act', 18, 2, 'gen#a');
  const cold = d.posterior('gen#b', 'act');
  ok(cold.pSuccess > 0.7, `冷状态零样本抬升（p=${cold.pSuccess.toFixed(3)} > 0.7，域边际 19/22=${(19 / 22).toFixed(3)}）`);
  ok(cold.abstract?.source === 'domain-marginal', `来源 = domain-marginal（实测 ${cold.abstract?.source}）`);

  // 叶子证据渐近压倒先验：本骨架持续成功 → 朝叶子均值漂移
  const p0 = cold.pSuccess;
  seed(d, 'gen#b', 'act', 3, 0, 'gen#b');
  const p1 = d.posterior('gen#b', 'act').pSuccess;
  seed(d, 'gen#b', 'act', 27, 0, 'gen#b');
  const p2 = d.posterior('gen#b', 'act').pSuccess;
  ok(p1 > p0 && p2 > p1, `证据累积单调抬升（${p0.toFixed(3)} → ${p1.toFixed(3)} → ${p2.toFixed(3)}）`);
  ok(p2 > 0.95, `30✓ 后叶子压倒先验（${p2.toFixed(3)} ≈ 31/32=${(31 / 32).toFixed(3)}）`);
}

// ═══════════════════ C 结构相似度 ═══════════════════

section('C 域结构相似度：同构 = 1，无关 = 0');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');
  seedTrapWorld(d, 'trapB');
  seed(d, 'unrelated#u0', 'zzz', 5, 5, 'unrelated#u1');

  ok(near(abs.domainSimilarity('trapA', 'trapB'), 1, 1e-9), `同构域 sim=1（实测 ${abs.domainSimilarity('trapA', 'trapB')}）`);
  ok(near(abs.domainSimilarity('trapA', 'unrelated'), 0, 1e-9), `无关域 sim=0（结构映射有闸门）`);
  ok(abs.stats().domains === 3, `已观测 3 域（实测 ${abs.stats().domains}）`);
}

// ═══════════════════ D 类比零样本 ═══════════════════

section('D 类比零样本：冷域冷状态直接拿到别域后验');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');

  // trapC 全域零证据：凭结构同构直接借用 trapA 的后验
  const baitS0 = d.posterior('trapC#s0', 'bait');
  const slowS0 = d.posterior('trapC#s0', 'slow');
  const baitDead = d.posterior('trapC#dead', 'bait');
  ok(near(baitS0.pSuccess, 10 / 12, 0.01), `冷 (s0,bait) ≈ trapA 的 10/12（实测 ${baitS0.pSuccess.toFixed(4)}）`);
  ok(near(slowS0.pSuccess, 7 / 12, 0.01), `冷 (s0,slow) ≈ trapA 的 7/12（实测 ${slowS0.pSuccess.toFixed(4)}）`);
  ok(baitDead.pSuccess < 0.35, `冷 (dead,bait) 继承了死路知识（${baitDead.pSuccess.toFixed(3)} ≈ 3/12）`);
  ok(baitS0.abstract?.source === 'analogy(trapA)', `来源 = analogy(trapA)（实测 ${baitS0.abstract?.source}）`);
  ok(baitS0.evidence === 0 && baitS0.pSuccess !== 0.5, `零样本应答：证据 0 但估计非无知（举一反三）`);
  ok(abs.stats().zeroShotAnswers >= 3 && abs.stats().analogyTransfers >= 3, `KPI 计数（零样本 ${abs.stats().zeroShotAnswers} / 迁移 ${abs.stats().analogyTransfers}）`);
}

// ═══════════════════ E 后继继承 ═══════════════════

section('E 后继继承：trapA 的 bait→#dead 映射为 trapC 的 bait→#dead');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');

  ok(d.posterior('trapC#s0', 'bait').successor === 'trapC#dead', `冷边后继继承（bait → trapC#dead，非停留原态）`);
  ok(d.posterior('trapC#s0', 'slow').successor === 'trapC#rich', `slow → trapC#rich（缓行通向富态的结构也迁移）`);
  ok(abs.stats().successorInheritances >= 2, `继承计数 ≥ 2（实测 ${abs.stats().successorInheritances}）`);
  // 有自身证据后不再继承（自身结构优先）
  seed(d, 'trapC#s0', 'bait', 5, 0, 'trapC#own');
  ok(d.posterior('trapC#s0', 'bait').successor === 'trapC#own', `自身证据优先（继承让位：→ trapC#own）`);
}

// ═══════════════════ F 类比规划分水岭 ═══════════════════

section('F 类比规划分水岭：冷域深思凭继承结构绕开诱饵');

{
  // 对照组：未挂载抽象——冷域一切 0.5、对称无知 → 深思选诱饵
  const bare = new DeliberationEngine();
  seedTrapWorld(bare, 'trapA');
  const bareSearch = bare.search('trapC#s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  ok(bareSearch.best.actions[0] === 'bait', `未挂载：冷域对称无知 → 选 bait（${bareSearch.best.actions.join(' → ')}，重新发明轮子）`);

  // 实验组：挂载抽象——后继结构继承让陷阱在冷域显形
  const absd = new DeliberationEngine();
  absd.attachAbstraction(new AbstractionEngine());
  seedTrapWorld(absd, 'trapA');
  const absSearch = absd.search('trapC#s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  ok(absSearch.best.actions[0] === 'slow', `挂载：类比规划绕开诱饵（${absSearch.best.actions.join(' → ')}——trapA 的教训 trapC 零样本继承）`);
  const byFirst = Object.fromEntries(absSearch.ranked.map((r) => [r.actions[0], r]));
  ok(byFirst.slow.totalEfe < byFirst.bait.totalEfe, `轨迹 G：slow 路 ${byFirst.slow.totalEfe.toFixed(3)} < bait 路 ${byFirst.bait.totalEfe.toFixed(3)} nat`);
  ok(absSearch.best.states.includes('trapC#rich'), `状态轨迹走富态（${absSearch.best.states.join(' → ')}）`);
}

// ═══════════════════ G 抽象技能 ═══════════════════

section('G 抽象技能：2 域成功晋升跨域宏技能，第三域冷启动种子');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');
  seedTrapWorld(d, 'trapB');

  // 同骨架同序列在两个域整体成功（先在 trapA，后在 trapB）
  d.settle(
    [
      { state: 'trapA#s0', action: 'slow' },
      { state: 'trapA#rich', action: 'bait' },
    ],
    [true, true],
  );
  ok(abs.allAbstractSkills().length === 0, '单域成功不晋升（不轻信）');
  d.settle(
    [
      { state: 'trapB#s0', action: 'slow' },
      { state: 'trapB#rich', action: 'bait' },
    ],
    [true, true],
  );
  const skills = abs.allAbstractSkills();
  ok(skills.length === 1 && skills[0].skeleton === 's0', `第二域成功 → 抽象技能晋升（${skills[0].id}，触发骨架 s0，跨 ${skills[0].domains} 域）`);

  // 第三个同构域冷启动：技能直接可检索、参与搜索种子
  ok(d.skillsFor('trapD#s0').some((s) => s.id === skills[0].id), '第三域同骨架状态检索到跨域技能');
  const seeded = d.search('trapD#s0', ['bait', 'slow'], { depth: 2, useSkills: true });
  ok(seeded.skillSeeded === true, '搜索种子注入抽象技能（时间×状态双重抽象复合）');
  ok(seeded.best.actions[0] === 'slow', `冷域最优仍绕开诱饵（${seeded.best.actions.join(' → ')}）`);
}

// ═══════════════════ H 元认知 KPI ═══════════════════

section('H 元认知：抽象统计 KPI + 缺省零漂移');

{
  const meta = new MetaCognitionEngine({ applier: () => {} });
  meta.observe({
    timestamp: Date.now(), successRate: 0.85, avgQuality: 0.8, avgLatency: 900,
    cacheHitRate: 0.3, modelSuccessRates: {}, activeExecutions: 0,
  });
  ok(meta.getHealthReport().abstraction === undefined, '未挂载 → 无抽象统计项（零漂移）');

  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  meta.attachAbstractionEngine(abs);
  seedTrapWorld(d, 'trapA');
  d.search('trapC#s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  const kpi = meta.getHealthReport().abstraction;
  ok(kpi.domains === 1 && kpi.analogyTransfers > 0, `KPI：1 域观测 / 类比迁移 ${kpi.analogyTransfers} 次`);
  ok(kpi.zeroShotAnswers > 0 && kpi.successorInheritances > 0, `零样本应答 ${kpi.zeroShotAnswers} / 后继继承 ${kpi.successorInheritances}`);
  ok(kpi.interpretation.length > 0, `解读：${kpi.interpretation.slice(0, 36)}…`);
}

// ═══════════════════ I 优化器集成 ═══════════════════

section('I 优化器：冷同构域的元认知推荐走类比深思');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-abs-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const optimizer = new Optimizer({ memory });

  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');
  const m = new RationalMetareasoner(d, { maxDepth: 3 });
  optimizer.attachDeliberation(d);
  optimizer.attachMetareasoner(m);

  const rec = optimizer.metacognitiveRecommendation('trapC', ['bait', 'slow'], 2);
  ok(rec !== undefined && rec.mode === 'deliberative', `冷域一步暧昧 → 深思接管（mode=${rec.mode}）`);
  ok(rec.actions[0] === 'slow', `类比深思绕开诱饵（${rec.actions.join(' → ')}）`);
  ok(rec.report.states.some((s) => s.startsWith('trapC#')), `轨迹留在目标域（${rec.report.states.join(' → ')}）`);
  m.settleDecision(rec.decisionId, true);
  fs.rmSync(memPath, { force: true });
}

// ═══════════════════ J 序列化 ═══════════════════

section('J 序列化：分层证据 + 抽象技能 roundtrip');

{
  const d = new DeliberationEngine();
  const abs = new AbstractionEngine();
  d.attachAbstraction(abs);
  seedTrapWorld(d, 'trapA');
  seedTrapWorld(d, 'trapB');
  d.settle(
    [
      { state: 'trapA#s0', action: 'slow' },
      { state: 'trapA#rich', action: 'bait' },
    ],
    [true, true],
  );
  d.settle(
    [
      { state: 'trapB#s0', action: 'slow' },
      { state: 'trapB#rich', action: 'bait' },
    ],
    [true, true],
  );
  const before = d.posterior('trapC#s0', 'bait');
  const dump = JSON.parse(JSON.stringify(d.serialize()));

  const d2 = new DeliberationEngine();
  d2.attachAbstraction(new AbstractionEngine());
  d2.deserialize(dump);
  const after = d2.posterior('trapC#s0', 'bait');
  ok(near(before.pSuccess, after.pSuccess, 1e-6), `类比后验可重放（${before.pSuccess.toFixed(4)} = ${after.pSuccess.toFixed(4)}）`);
  ok(d2.posterior('trapC#s0', 'bait').successor === 'trapC#dead', '后继继承恢复');
  ok(d2.skillsFor('trapD#s0').length > 0, '抽象技能恢复（跨域检索可用）');
  const s1 = d.search('trapC#s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  const s2 = d2.search('trapC#s0', ['bait', 'slow'], { depth: 2, useSkills: false });
  ok(s1.best.actions.join('|') === s2.best.actions.join('|'), `类比搜索结论一致（${s2.best.actions.join(' → ')}）`);
}

// ═══════════════════ 总结 ═══════════════════
console.log('\n══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 「抽象心智：类比结构映射」质变闭环成立`);
  process.exit(0);
} else {
  console.log(`❌ ${failed} 项失败（通过 ${passed} 项）`);
  process.exit(1);
}
