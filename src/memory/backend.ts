/**
 * backend.ts — 记忆持久化后端抽象（验收标准 3：SQLite 持久化）
 *
 * 两种后端，统一 MemoryBackend 接口：
 * - SqliteMemoryBackend：基于 Node 内置 node:sqlite（DatabaseSync），零依赖，
 *   完全关系化 schema（v2）：热查询字段提升为类型化列 + 索引（SQL 可直接查询/聚合），
 *   data 列存完整记录 JSON 保留演进弹性；WAL 模式读写并发、预编译语句缓存、
 *   增量 UPSERT 同步（不再全表重建）；旧版 v1 blob 表首次打开自动无损升级
 * - JsonMemoryBackend：JSON 原子写回退（加密启用时沿用，保持 CryptoEngine 兼容；
 *   宿主 Node 不支持 node:sqlite 时自动降级）
 *
 * 选型策略（createMemoryBackend）：
 * 1. 加密启用 → JsonMemoryBackend（加密与 SQLite 互斥，沿用既有加密落盘）
 * 2. node:sqlite 可用 → SqliteMemoryBackend（旧版 JSON 记忆文件由 LongTermMemory 自动迁移）
 * 3. node:sqlite 不可用 → JsonMemoryBackend（兼容旧 Node）
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { MemoryError } from '../errors.js';
import type { CryptoEngine } from '../security/crypto-engine.js';
import type { MemoryStore } from './long-term-memory.js';

/** 持久化后端统一契约 */
export interface MemoryBackend {
  readonly kind: 'sqlite' | 'json';
  /** FTS5 检索是否可用（仅 SQLite 后端） */
  readonly ftsAvailable?: boolean;
  /** sqlite-vec 扩展是否加载（仅 SQLite 后端） */
  readonly vecAvailable?: boolean;
  /** 加载记忆库（不存在时返回空库） */
  load(): MemoryStore;
  /** 全量保存记忆库 */
  save(store: MemoryStore): void;
  /** 释放连接/资源 */
  close(): void;
  /** FTS5 全文检索（混合检索增强，仅 SQLite 后端提供） */
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  /** 向量检索（sqlite-vec 不可用时的稀疏向量回退，仅 SQLite 后端提供） */
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  // ── 数据库维护 API（仅 SQLite 后端提供） ──
  integrityCheck?(): string;
  stats?(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    /** 第二阶段：语义记忆条数 */
    semantic: number;
    /** 第二阶段：程序记忆条数 */
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  checkpoint?(): void;
  vacuum?(): void;
  backup?(destPath: string): string;
  rawQuery?(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
}

/** 空记忆库工厂 */
export function emptyMemoryStore(): MemoryStore {
  return {
    version: 1,
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
    taskPatterns: [],
    modelProfiles: [],
    decisionFeedback: [],
    distilledStrategies: [],
    semanticMemories: [],
    proceduralMemories: [],
    globalStats: {
      totalExecutions: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalTokensUsed: 0,
      totalCostEstimate: 0,
      averageQualityScore: 0,
      averageExecutionTime: 0,
    },
  };
}

/** 结构校验与缺省补全（JSON 加载与旧文件迁移共用） */
export function sanitizeMemoryStore(raw: unknown): MemoryStore {
  const data = raw as Partial<MemoryStore> | null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.taskPatterns)) {
    throw new MemoryError('记忆库结构非法：缺少 taskPatterns 数组');
  }
  return {
    version: data.version ?? 1,
    createdAt: data.createdAt ?? Date.now(),
    lastUpdatedAt: data.lastUpdatedAt ?? Date.now(),
    taskPatterns: data.taskPatterns,
    modelProfiles: data.modelProfiles ?? [],
    decisionFeedback: data.decisionFeedback ?? [],
    distilledStrategies: data.distilledStrategies ?? [],
    // 第二阶段三层记忆扩展：旧文件缺省为空数组，保持向后兼容
    semanticMemories: data.semanticMemories ?? [],
    proceduralMemories: data.proceduralMemories ?? [],
    globalStats: {
      totalExecutions: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalTokensUsed: 0,
      totalCostEstimate: 0,
      averageQualityScore: 0,
      averageExecutionTime: 0,
      ...data.globalStats,
    },
  };
}

/** JSON 持久化路径 → SQLite 文件路径（memory.json → memory.db） */
export function sqlitePathFor(persistPath: string): string {
  return persistPath.endsWith('.json') ? `${persistPath.slice(0, -5)}.db` : `${persistPath}.db`;
}

/** 惰性加载 node:sqlite 模块（不可用时返回 null，避免静态 import 拖垮旧 Node） */
let sqliteModuleCache: typeof import('node:sqlite') | null | undefined;
function getSqliteModule(): typeof import('node:sqlite') | null {
  if (sqliteModuleCache !== undefined) return sqliteModuleCache;
  try {
    const require = createRequire(import.meta.url);
    sqliteModuleCache = require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    sqliteModuleCache = null;
  }
  return sqliteModuleCache;
}

/** 宿主是否支持内置 SQLite */
export function sqliteAvailable(): boolean {
  return getSqliteModule() !== null;
}

interface DataRow {
  data: string;
}
interface MetaRow {
  key: string;
  value: string;
}

// ─────────────────────────── 中文分词管道（混合检索增强） ───────────────────────────

/**
 * 轻量中文分词（jieba 式管道的零依赖实现）：
 * - ASCII/数字串按词切分
 * - 连续 CJK 串切分为二元组（bigram），覆盖无词典场景下的中文词级匹配
 *
 * 若宿主提供真实 jieba 管道（如 jieba-wasm），可通过 setChineseTokenizer 注入替换。
 */
export function tokenizeChinese(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []) tokens.push(word);
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length <= 2) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}

let customTokenizer: ((text: string) => string[]) | null = null;
/** 注入真实 jieba 分词管道（可选；缺省使用内置轻量分词） */
export function setChineseTokenizer(fn: ((text: string) => string[]) | null): void {
  customTokenizer = fn;
}
/** 分词入口：优先外部注入的 jieba 管道，缺省轻量分词 */
export function segment(text: string): string[] {
  return customTokenizer ? customTokenizer(text) : tokenizeChinese(text);
}

/** 稀疏词频向量（sqlite-vec 不可用时的零依赖向量检索） */
export function toSparseVector(text: string): Record<string, number> {
  const vec: Record<string, number> = {};
  for (const token of segment(text)) vec[token] = (vec[token] ?? 0) + 1;
  return vec;
}

export function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, weight] of Object.entries(a)) {
    normA += weight * weight;
    if (b[token]) dot += weight * b[token];
  }
  for (const weight of Object.values(b)) normB += weight * weight;
  return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

export interface MemorySearchHit {
  /** 联合类型宽化（第二阶段）：新增 semantic / procedural；既有 pattern / strategy 仍合法 */
  kind: 'pattern' | 'strategy' | 'semantic' | 'procedural';
  refId: string;
  score: number;
}

/** 当前 SQLite schema 版本（v2 = 关系化列 + 索引；v1 = 纯 blob 表） */
const SCHEMA_VERSION = 2;

/**
 * 版本化迁移注册表：新增迁移在数组末尾追加 { to, up }，
 * migrateIfNeeded 按顺序执行未应用步骤（每步独立事务）。
 */
const MIGRATIONS: Array<{ to: number; up: (backend: SqliteMemoryBackend) => void }> = [
  { to: 2, up: (backend) => (backend as unknown as { migrateV1toV2(): void }).migrateV1toV2() },
];

/**
 * SQLite 后端（node:sqlite 内置，零依赖，完全关系化）
 *
 * schema v2：热查询/聚合字段提升为类型化列并建索引，SQL 可直接查询，
 * data 列存完整记录 JSON 保留 schema 演进弹性：
 * - meta(key PK, value)：schema_version / createdAt / lastUpdatedAt / globalStats(JSON)
 * - task_patterns(fingerprint PK, task_type, confidence REAL, frequency, last_seen_at, last_decay_at, data)
 *   + idx(task_type, confidence)：支撑"按类型取最优模式"类 SQL 聚合
 * - model_profiles(id PK, best_task_type, data)
 * - decision_feedback(id PK, ts, signal_type, decision, outcome, data)
 *   + idx(signal_type, ts)：支撑"按信号类型的决策成功率"类 SQL 统计
 * - distilled_strategies(id PK, task_type, confidence REAL, support_count, last_applied_at, data)
 *   + idx(task_type, confidence)
 *
 * 工程特性：
 * - WAL 模式（journal_mode=WAL）：读写不互斥、崩溃恢复更快
 * - 预编译语句缓存（stmt）：热路径零重复编译开销
 * - 增量 UPSERT 同步：save 按主键 upsert + 删除已消失行，不再全表重建
 * - 旧版 v1 blob 表首次打开自动无损升级为 v2
 */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private dbPath: string;
  private stmts = new Map<string, StatementSync>();
  /** sqlite-vec 扩展是否加载成功（在线/预装环境启用；缺省走零依赖稀疏向量） */
  readonly vecAvailable: boolean;
  /** FTS5 是否可用（node:sqlite 内置；极端裁剪构建可能缺失） */
  readonly ftsAvailable: boolean;

  constructor(dbPath: string) {
    const mod = getSqliteModule();
    if (!mod) throw new MemoryError('当前 Node 运行时不支持 node:sqlite');
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // allowExtension：为 sqlite-vec 等原生扩展预留加载接缝
    try {
      this.db = new mod.DatabaseSync(dbPath, { allowExtension: true } as never);
    } catch {
      this.db = new mod.DatabaseSync(dbPath);
    }
    this.vecAvailable = this.tryLoadVec();
    // PRAGMA 加固：WAL 读写并发 + 5s 忙等待（多连接安全）+ NORMAL 同步（WAL 下安全且更快）
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_patterns (
        fingerprint TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        frequency INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_patterns_type_conf ON task_patterns (task_type, confidence);
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        best_task_type TEXT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_feedback (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        outcome TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decision_feedback_signal_ts ON decision_feedback (signal_type, ts);
      CREATE TABLE IF NOT EXISTS distilled_strategies (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_distilled_strategies_type_conf ON distilled_strategies (task_type, confidence);
      -- 第二阶段三层记忆扩展：语义记忆 + 程序记忆（CREATE IF NOT EXISTS 幂等加表，旧库自动建表）
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_memories_domain_conf ON semantic_memories (domain, confidence);
      CREATE TABLE IF NOT EXISTS procedural_memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_procedural_memories_kind_conf ON procedural_memories (kind, confidence);
      CREATE TABLE IF NOT EXISTS memory_vectors (ref_id TEXT PRIMARY KEY, kind TEXT NOT NULL, vector TEXT NOT NULL);
    `);
    // FTS5 混合检索增强：trigram 表（子串级中文匹配）+ 分词表（jieba 式 token 级匹配）
    this.ftsAvailable = this.createFtsTables();
    this.migrateIfNeeded();
  }

  /** sqlite-vec 接缝：宿主预装扩展时启用，失败静默回退稀疏向量 */
  private tryLoadVec(): boolean {
    try {
      this.db.enableLoadExtension(true);
      for (const name of ['vec0', 'sqlite-vec']) {
        try {
          this.db.loadExtension(name);
          return true;
        } catch {
          /* 尝试下一个候选 */
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private createFtsTables(): boolean {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(ref_id UNINDEXED, kind UNINDEXED, content, tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tok USING fts5(ref_id UNINDEXED, kind UNINDEXED, content);
      `);
      return true;
    } catch {
      return false;
    }
  }

  /** 预编译语句缓存：同一条 SQL 只编译一次 */
  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  /**
   * 版本化迁移框架：按 schema_version 顺序执行 MIGRATIONS 中未应用的步骤，
   * 每步独立事务，失败即停（保留现场便于诊断）。新增迁移只需在数组末尾追加。
   */
  private migrateIfNeeded(): void {
    let version = Number(this.getMeta('schema_version') ?? 0);
    for (const migration of MIGRATIONS) {
      if (version >= migration.to) continue;
      this.db.exec('BEGIN');
      try {
        migration.up(this);
        this.setMeta('schema_version', String(migration.to));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new MemoryError(`SQLite schema 迁移 v${version}→v${migration.to} 失败`, {
          cause: err instanceof Error ? err.message : String(err),
        });
      }
      version = migration.to;
    }
  }

  /** 迁移步骤可访问的内部工具 */
  private hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some((c) => c.name === column);
  }

  /** v1（纯 blob 表）→ v2（关系化列）：从 data blob 回填类型化列 */
  private migrateV1toV2(): void {
    const hasLegacyColumns = (table: string, column: string): boolean => this.hasColumn(table, column);

    if (!hasLegacyColumns('task_patterns', 'task_type')) {
      this.db.exec('ALTER TABLE task_patterns ADD COLUMN task_type TEXT;');
      this.db.exec('ALTER TABLE task_patterns ADD COLUMN confidence REAL;');
      this.db.exec('ALTER TABLE task_patterns ADD COLUMN frequency INTEGER;');
      this.db.exec('ALTER TABLE task_patterns ADD COLUMN last_seen_at INTEGER;');
      this.db.exec('ALTER TABLE task_patterns ADD COLUMN last_decay_at INTEGER;');
      // taskType 取自指纹首段（与 similarity() 的还原约定一致）
      this.db.exec(`
        UPDATE task_patterns SET
          task_type = CASE WHEN instr(fingerprint, '::') > 0
            THEN substr(fingerprint, 1, instr(fingerprint, '::') - 1) ELSE fingerprint END,
          confidence = json_extract(data, '$.confidence'),
          frequency = json_extract(data, '$.frequency'),
          last_seen_at = json_extract(data, '$.lastSeenAt'),
          last_decay_at = json_extract(data, '$.lastDecayAt');
      `);
    }
    if (!hasLegacyColumns('decision_feedback', 'signal_type')) {
      this.db.exec('ALTER TABLE decision_feedback ADD COLUMN signal_type TEXT;');
      this.db.exec('ALTER TABLE decision_feedback ADD COLUMN decision TEXT;');
      this.db.exec('ALTER TABLE decision_feedback ADD COLUMN outcome TEXT;');
      this.db.exec(`
        UPDATE decision_feedback SET
          signal_type = json_extract(data, '$.signalType'),
          decision = json_extract(data, '$.decision'),
          outcome = json_extract(data, '$.outcome');
      `);
    }
    if (!hasLegacyColumns('distilled_strategies', 'task_type')) {
      this.db.exec('ALTER TABLE distilled_strategies ADD COLUMN task_type TEXT;');
      this.db.exec('ALTER TABLE distilled_strategies ADD COLUMN confidence REAL;');
      this.db.exec('ALTER TABLE distilled_strategies ADD COLUMN support_count INTEGER;');
      this.db.exec('ALTER TABLE distilled_strategies ADD COLUMN last_applied_at INTEGER;');
      this.db.exec(`
        UPDATE distilled_strategies SET
          task_type = json_extract(data, '$.taskType'),
          confidence = json_extract(data, '$.confidence'),
          support_count = json_extract(data, '$.supportCount'),
          last_applied_at = json_extract(data, '$.lastAppliedAt');
      `);
    }
    if (!hasLegacyColumns('model_profiles', 'best_task_type')) {
      this.db.exec('ALTER TABLE model_profiles ADD COLUMN best_task_type TEXT;');
      this.db.exec(`UPDATE model_profiles SET best_task_type = json_extract(data, '$.bestTaskType');`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_patterns_type_conf ON task_patterns (task_type, confidence);
      CREATE INDEX IF NOT EXISTS idx_decision_feedback_signal_ts ON decision_feedback (signal_type, ts);
      CREATE INDEX IF NOT EXISTS idx_distilled_strategies_type_conf ON distilled_strategies (task_type, confidence);
    `);
  }

  private getMeta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as unknown as MetaRow | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  load(): MemoryStore {
    const store = emptyMemoryStore();
    const createdAt = this.getMeta('createdAt');
    if (createdAt) store.createdAt = Number(createdAt);
    const lastUpdatedAt = this.getMeta('lastUpdatedAt');
    if (lastUpdatedAt) store.lastUpdatedAt = Number(lastUpdatedAt);
    const stats = this.getMeta('globalStats');
    if (stats) store.globalStats = { ...store.globalStats, ...JSON.parse(stats) };
    store.taskPatterns = (this.stmt('SELECT data FROM task_patterns').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    store.modelProfiles = (this.stmt('SELECT data FROM model_profiles').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    store.decisionFeedback = (this.stmt('SELECT data FROM decision_feedback ORDER BY ts').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    store.distilledStrategies = (this.stmt('SELECT data FROM distilled_strategies').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    // 第二阶段三层记忆扩展：语义记忆 + 程序记忆
    store.semanticMemories = (this.stmt('SELECT data FROM semantic_memories').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    store.proceduralMemories = (this.stmt('SELECT data FROM procedural_memories').all() as unknown as DataRow[]).map((r) => JSON.parse(r.data));
    return store;
  }

  /** 增量同步：按主键 UPSERT + 删除已消失行，单事务保证一致性 */
  save(store: MemoryStore): void {
    this.db.exec('BEGIN');
    try {
      const upPattern = this.stmt(`
        INSERT INTO task_patterns (fingerprint, task_type, confidence, frequency, last_seen_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          task_type = excluded.task_type, confidence = excluded.confidence, frequency = excluded.frequency,
          last_seen_at = excluded.last_seen_at, last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
      const seenPatterns = new Set<string>();
      for (const p of store.taskPatterns) {
        seenPatterns.add(p.fingerprint);
        // taskType 取自指纹首段（与 similarity() 的还原约定一致）
        const taskType = p.fingerprint.split('::')[0] ?? '';
        upPattern.run(p.fingerprint, taskType, p.confidence, p.frequency, p.lastSeenAt, p.lastDecayAt ?? null, JSON.stringify(p));
      }
      this.stmt('DELETE FROM task_patterns WHERE fingerprint NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenPatterns]));

      const upProfile = this.stmt(`
        INSERT INTO model_profiles (id, best_task_type, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET best_task_type = excluded.best_task_type, data = excluded.data
      `);
      const seenProfiles = new Set<string>();
      for (const m of store.modelProfiles) {
        seenProfiles.add(m.id);
        upProfile.run(m.id, m.bestTaskType ?? null, JSON.stringify(m));
      }
      this.stmt('DELETE FROM model_profiles WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenProfiles]));

      const upFeedback = this.stmt(`
        INSERT INTO decision_feedback (id, ts, signal_type, decision, outcome, data) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, signal_type = excluded.signal_type,
          decision = excluded.decision, outcome = excluded.outcome, data = excluded.data
      `);
      const seenFeedback = new Set<string>();
      for (const f of store.decisionFeedback) {
        seenFeedback.add(f.id);
        upFeedback.run(f.id, f.timestamp, f.signalType, f.decision, f.outcome, JSON.stringify(f));
      }
      this.stmt('DELETE FROM decision_feedback WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenFeedback]));

      const upStrategy = this.stmt(`
        INSERT INTO distilled_strategies (id, task_type, confidence, support_count, last_applied_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET task_type = excluded.task_type, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at, data = excluded.data
      `);
      const seenStrategies = new Set<string>();
      for (const s of store.distilledStrategies) {
        seenStrategies.add(s.id);
        upStrategy.run(s.id, s.taskType, s.confidence, s.supportCount, s.lastAppliedAt ?? null, JSON.stringify(s));
      }
      this.stmt('DELETE FROM distilled_strategies WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenStrategies]));

      // 第二阶段三层记忆扩展：语义记忆 + 程序记忆 UPSERT
      const upSemantic = this.stmt(`
        INSERT INTO semantic_memories (id, domain, confidence, support_count, last_applied_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at,
          last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
      const seenSemantic = new Set<string>();
      for (const m of store.semanticMemories) {
        seenSemantic.add(m.id);
        upSemantic.run(m.id, m.domain, m.confidence, m.supportCount, m.lastAppliedAt ?? null, m.lastDecayAt ?? null, JSON.stringify(m));
      }
      this.stmt('DELETE FROM semantic_memories WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenSemantic]));

      const upProcedural = this.stmt(`
        INSERT INTO procedural_memories (id, kind, task_type, confidence, support_count, last_applied_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, task_type = excluded.task_type, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at,
          last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
      const seenProcedural = new Set<string>();
      for (const p of store.proceduralMemories) {
        seenProcedural.add(p.id);
        // task_type 取首个适用类型（无则空串），仅用于索引；完整 taskTypes 在 data 列
        const primaryTaskType = p.taskTypes[0] ?? '';
        upProcedural.run(p.id, p.kind, primaryTaskType, p.confidence, p.supportCount, p.lastAppliedAt ?? null, p.lastDecayAt ?? null, JSON.stringify(p));
      }
      this.stmt('DELETE FROM procedural_memories WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...seenProcedural]));

      // 混合检索索引同步：FTS5 双分词表 + 稀疏向量表（同一事务）
      if (this.ftsAvailable) {
        this.db.exec('DELETE FROM memory_fts; DELETE FROM memory_fts_tok; DELETE FROM memory_vectors;');
        const insFts = this.stmt('INSERT INTO memory_fts (ref_id, kind, content) VALUES (?, ?, ?)');
        const insFtsTok = this.stmt('INSERT INTO memory_fts_tok (ref_id, kind, content) VALUES (?, ?, ?)');
        const insVec = this.stmt('INSERT INTO memory_vectors (ref_id, kind, vector) VALUES (?, ?, ?)');
        for (const p of store.taskPatterns) {
          const content = `${p.taskSummary} ${p.fingerprint}`;
          insFts.run(p.fingerprint, 'pattern', content);
          insFtsTok.run(p.fingerprint, 'pattern', segment(content).join(' '));
          insVec.run(p.fingerprint, 'pattern', JSON.stringify(toSparseVector(content)));
        }
        for (const s of store.distilledStrategies) {
          insFts.run(s.id, 'strategy', s.description);
          insFtsTok.run(s.id, 'strategy', segment(s.description).join(' '));
          insVec.run(s.id, 'strategy', JSON.stringify(toSparseVector(s.description)));
        }
        // 语义记忆与程序记忆纳入混合检索（statement / name 作为可搜索内容）
        for (const m of store.semanticMemories) {
          insFts.run(m.id, 'semantic', m.statement);
          insFtsTok.run(m.id, 'semantic', segment(m.statement).join(' '));
          insVec.run(m.id, 'semantic', JSON.stringify(toSparseVector(m.statement)));
        }
        for (const p of store.proceduralMemories) {
          const content = `${p.name} ${p.action.rationale}`;
          insFts.run(p.id, 'procedural', content);
          insFtsTok.run(p.id, 'procedural', segment(content).join(' '));
          insVec.run(p.id, 'procedural', JSON.stringify(toSparseVector(content)));
        }
      }

      this.setMeta('createdAt', String(store.createdAt));
      this.setMeta('lastUpdatedAt', String(store.lastUpdatedAt));
      this.setMeta('globalStats', JSON.stringify(store.globalStats));
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * FTS5 全文检索（混合检索增强）：
   * - trigram 表：原始内容子串级匹配（中文无需分词即可命中）
   * - 分词表：jieba 式 token 级 OR 匹配（词级语义召回）
   * 两路结果按 rank 合并去重。
   */
  fullTextSearch(query: string, limit = 5): MemorySearchHit[] {
    if (!this.ftsAvailable) return [];
    const hits = new Map<string, MemorySearchHit>();
    try {
      const trigramQ = `"${query.replace(/"/g, '')}"`;
      for (const row of this.stmt('SELECT ref_id, kind, rank FROM memory_fts WHERE content MATCH ? ORDER BY rank LIMIT ?').all(trigramQ, limit) as unknown as Array<{ ref_id: string; kind: 'pattern' | 'strategy'; rank: number }>) {
        const score = Math.max(0, -row.rank);
        const prev = hits.get(row.ref_id);
        if (!prev || prev.score < score) hits.set(row.ref_id, { kind: row.kind, refId: row.ref_id, score });
      }
      const tokQ = segment(query)
        .map((t) => `"${t.replace(/"/g, '')}"`)
        .join(' OR ');
      if (tokQ) {
        for (const row of this.stmt('SELECT ref_id, kind, rank FROM memory_fts_tok WHERE content MATCH ? ORDER BY rank LIMIT ?').all(tokQ, limit) as unknown as Array<{ ref_id: string; kind: 'pattern' | 'strategy'; rank: number }>) {
          const score = Math.max(0, -row.rank);
          const prev = hits.get(row.ref_id);
          if (!prev || prev.score < score) hits.set(row.ref_id, { kind: row.kind, refId: row.ref_id, score });
        }
      }
    } catch {
      /* 查询语法异常等：静默降级为空结果 */
    }
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 稀疏向量检索（sqlite-vec 不可用时的零依赖语义召回） */
  vectorSearch(query: string, limit = 5): MemorySearchHit[] {
    const qVec = toSparseVector(query);
    const scored: MemorySearchHit[] = [];
    for (const row of this.stmt('SELECT ref_id, kind, vector FROM memory_vectors').all() as unknown as Array<{ ref_id: string; kind: 'pattern' | 'strategy'; vector: string }>) {
      const score = cosineSimilarity(qVec, JSON.parse(row.vector));
      if (score > 0) scored.push({ kind: row.kind, refId: row.ref_id, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ─────────────────────────── 数据库维护 API ───────────────────────────

  /** 完整性检查（PRAGMA integrity_check），返回 ok 或错误描述 */
  integrityCheck(): string {
    const row = this.stmt('PRAGMA integrity_check').get() as unknown as { integrity_check: string };
    return row.integrity_check;
  }

  /** 数据库统计（运维可观测：行数、页大小、WAL 状态、schema 版本、扩展能力） */
  stats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    semantic: number;
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  } {
    const count = (table: string): number => (this.stmt(`SELECT COUNT(*) AS c FROM ${table}`).get() as unknown as { c: number }).c;
    let walSize = 0;
    try {
      walSize = fs.statSync(`${this.dbPath}-wal`).size;
    } catch {
      /* WAL 文件不存在（已 checkpoint） */
    }
    return {
      patterns: count('task_patterns'),
      profiles: count('model_profiles'),
      feedback: count('decision_feedback'),
      strategies: count('distilled_strategies'),
      semantic: count('semantic_memories'),
      procedural: count('procedural_memories'),
      pageSize: (this.stmt('PRAGMA page_size').get() as unknown as { page_size: number }).page_size,
      pageCount: (this.stmt('PRAGMA page_count').get() as unknown as { page_count: number }).page_count,
      walSize,
      schemaVersion: Number(this.getMeta('schema_version') ?? 0),
      fts: this.ftsAvailable,
      vec: this.vecAvailable,
    };
  }

  /** WAL checkpoint（TRUNCATE）：把 WAL 合并回主库，缩小文件、便于备份 */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  /** VACUUM：回收碎片空间（阻塞式，建议低峰期调用） */
  vacuum(): void {
    this.db.exec('VACUUM;');
  }

  /**
   * 热备份：checkpoint 后复制主库文件（node:sqlite 无 backup API，
   * 采用「checkpoint + 文件复制」保证备份一致性），返回备份路径
   */
  backup(destPath: string): string {
    this.checkpoint();
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(this.dbPath, destPath);
    return destPath;
  }

  /** 只读查询通道（运维/诊断用；调用方自行保证 SQL 只读） */
  rawQuery(sql: string, params: Array<string | number | null> = []): Array<Record<string, unknown>> {
    return this.stmt(sql).all(...params) as unknown as Array<Record<string, unknown>>;
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}

/** JSON 后端（原子写 + 可选加密，回退/兼容路径） */
export class JsonMemoryBackend implements MemoryBackend {
  readonly kind = 'json' as const;

  constructor(
    private persistPath: string,
    private cryptoEngine?: CryptoEngine,
  ) {}

  load(): MemoryStore {
    if (!fs.existsSync(this.persistPath)) return emptyMemoryStore();
    try {
      if (this.cryptoEngine) {
        const { data } = this.cryptoEngine.readEncrypted(this.persistPath);
        return sanitizeMemoryStore(data);
      }
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
      return sanitizeMemoryStore(raw);
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      // 损坏文件备份后抛出，避免静默丢记忆
      const backup = `${this.persistPath}.corrupt.${Date.now()}`;
      try {
        fs.copyFileSync(this.persistPath, backup);
      } catch {
        /* 备份失败不阻塞 */
      }
      throw new MemoryError(`记忆库加载失败，已备份至 ${backup}`, { persistPath: this.persistPath });
    }
  }

  save(store: MemoryStore): void {
    try {
      if (this.cryptoEngine) {
        const result = this.cryptoEngine.writeEncrypted(this.persistPath, store);
        if (!result.success) {
          throw new MemoryError(`记忆库写入失败: ${result.error}`);
        }
        return;
      }
      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      if (err instanceof MemoryError) throw err;
      throw new MemoryError('记忆库持久化失败', {
        persistPath: this.persistPath,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  close(): void {
    /* JSON 后端无连接资源 */
  }
}

/**
 * 后端选型：加密启用 → JSON；否则 node:sqlite 可用 → SQLite；不可用 → JSON 回退
 */
export function createMemoryBackend(persistPath: string, cryptoEngine?: CryptoEngine): MemoryBackend {
  if (cryptoEngine) return new JsonMemoryBackend(persistPath, cryptoEngine);
  try {
    return new SqliteMemoryBackend(sqlitePathFor(persistPath));
  } catch {
    return new JsonMemoryBackend(persistPath);
  }
}
