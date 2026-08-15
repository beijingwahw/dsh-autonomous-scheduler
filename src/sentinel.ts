/**
 * sentinel.ts — 信号感知哨兵（集成层，执行链路第 1~2 步）
 *
 * 职责：主动感知环境变化，统一封装为 Signal 对象并在聚合窗口内合并相关信号
 * - 三种信号源：webhook（HTTP 接入）/ filesystem（文件监听）/ polling（轮询比对）
 * - 手动注入入口（autonomous_execute Tool 与级联触发共用）
 * - 聚合窗口：aggregationWindow 内相关信号合并去重，窗口结束批量交付
 * - 交付回调 onBatch 由 index.ts 编排层消费，进入优先级排序与战略决策
 *
 * 升级点（相对单一 webhook 的质的提升）：
 * 1. 窗口内同源去重：type + dedupeKey 相同的信号合并计数，避免重复决策
 * 2. 批次双触发：窗口到期或达到 maxBatchSize 立即交付，兼顾时延与吞吐
 * 3. 文件监听防抖 + 忽略规则（node_modules / dist / .git），杜绝噪声风暴
 * 4. 轮询源内容哈希比对：仅在内容真实变化时产生信号
 * 5. 全部资源（server / watcher / timer）由 stop() 统一回收，支持 cordis fiber 清理
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NetworkError } from './errors.js';

/** 统一信号对象（执行链路第 1 步产物） */
export interface Signal {
  id: string;
  /** 信号类型：code-change / error-detected / performance-degraded / webhook / manual / cascade 等 */
  type: string;
  /** 人类可读描述 */
  description: string;
  /** 原始载荷 */
  payload: Record<string, any>;
  /** 紧急度 0~1（第 3 步由决策模型填充） */
  urgency?: number;
  receivedAt: number;
  /** 来源标识：webhook:9878 / fs:/path / poll:url / manual / cascade */
  source: string;
  /** 聚合去重键（缺省取 type + description） */
  dedupeKey?: string;
  /** 窗口内被合并的原始信号次数 */
  occurrences: number;
  /** 所属租户（多租户路由后填充） */
  tenantId?: string;
  /** 截止时间（毫秒时间戳）：截止时间感知调度依据 */
  deadlineMs?: number;
  /** 富化上下文（哨兵自动附加：到达速率 / 关联信号 / 历史频率） */
  enrichment?: SignalEnrichment;
}

/** 信号富化上下文（感知环节深度优化产物） */
export interface SignalEnrichment {
  /** 该类型信号最近 1 分钟到达次数（突发检测依据） */
  recentRatePerMin: number;
  /** 该类型信号历史总次数 */
  historicalCount: number;
  /** 是否突发（recentRatePerMin 超过基线 3 倍） */
  isBurst: boolean;
  /** 关联信号 id 列表（时间邻近 + 类型关联） */
  correlatedSignalIds: string[];
  /** 当前生效的聚合窗口（毫秒，自适应） */
  effectiveWindowMs: number;
}

/** 信号源配置 */
export interface SignalSourceConfig {
  type: 'webhook' | 'polling' | 'filesystem';
  /** webhook 监听端口 */
  port?: number;
  /** polling 间隔（毫秒） */
  interval?: number;
  /** polling 目标 URL */
  url?: string;
  /** filesystem 监听路径 */
  path?: string;
  /** 该源产生的信号类型 */
  signalType: string;
}

/** 哨兵配置（对应 cordis.yml sentinel 节） */
export interface SentinelConfig {
  watchCodeChanges: boolean;
  watchErrors: boolean;
  watchPerformance: boolean;
  /** 聚合窗口（秒） */
  aggregationWindow: number;
  signalSources?: SignalSourceConfig[];
  /** 文件监听根目录（watchCodeChanges 启用时） */
  watchDir?: string;
  /** 批次大小上限（达到即提前交付） */
  maxBatchSize?: number;
  /** fetch 实现注入（测试用） */
  fetchImpl?: typeof fetch;
}

/** 聚合批次（执行链路第 2 步产物） */
export interface SignalBatch {
  signals: Signal[];
  aggregatedAt: number;
  /** 交付原因：窗口到期 / 批量上限 / 手动 flush */
  reason: 'window' | 'max-size' | 'flush';
}

/** 哨兵运行时状态 */
export interface SentinelStatus {
  running: boolean;
  pendingSignals: number;
  totalIngested: number;
  totalBatches: number;
  sources: Array<{ type: string; detail: string; active: boolean }>;
  aggregationWindow: number;
  /** 当前自适应窗口（毫秒） */
  effectiveWindowMs: number;
  /** 累计突发次数 */
  burstCount: number;
  /** 各类型信号历史计数 */
  historicalCounts: Record<string, number>;
}

/** 文件监听忽略目录 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.scheduler', '.cache', 'coverage']);
/** 文件监听防抖（毫秒） */
const FS_DEBOUNCE_MS = 300;
/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL = 30_000;

/**
 * 信号感知哨兵
 *
 * 被 index.ts 持有：start() 后持续产生 SignalBatch，
 * 编排层对每个批次执行第 3~10 步链路。
 */
export class Sentinel {
  private config: SentinelConfig;
  private onBatch: (batch: SignalBatch) => void;
  private fetchImpl: typeof fetch;

  private pending: Signal[] = [];
  private dedupeIndex = new Map<string, Signal>();
  private windowTimer: ReturnType<typeof setTimeout> | null = null;

  private webhookServers: http.Server[] = [];
  private fsWatchers: fs.FSWatcher[] = [];
  private pollTimers: Array<ReturnType<typeof setInterval>> = [];
  private pollHashes = new Map<string, string>();
  private fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsPendingPaths = new Set<string>();

  private running = false;
  private totalIngested = 0;
  private totalBatches = 0;

  // ── 感知深度优化：自适应窗口 + 富化状态 ──
  /** 各类型信号到达时间戳环形缓冲（突发检测 / 速率统计） */
  private arrivalHistory = new Map<string, number[]>();
  /** 各类型信号历史总次数 */
  private historicalCounts = new Map<string, number>();
  /** 各类型信号到达速率基线（指数移动平均，次/分钟） */
  private rateBaseline = new Map<string, number>();
  /** 最近注入的信号（关联分析用，保留 50 条；ingest 时即记录，无需等待交付） */
  private recentSignals: Array<{ id: string; type: string; receivedAt: number }> = [];
  /** 当前自适应窗口（毫秒） */
  private currentWindowMs: number;
  /** 突发计数（最近窗口内被判定为突发的次数） */
  private burstCount = 0;

  /**
   * @param config 哨兵配置
   * @param onBatch 批次交付回调（编排层入口）
   */
  constructor(config: SentinelConfig, onBatch: (batch: SignalBatch) => void) {
    this.config = config;
    this.onBatch = onBatch;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.currentWindowMs = Math.max(0.1, config.aggregationWindow) * 1000;
  }

  /**
   * 启动所有信号源
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const source of this.config.signalSources ?? []) {
      try {
        if (source.type === 'webhook') this.startWebhook(source);
        else if (source.type === 'filesystem') this.startFileWatch(source);
        else if (source.type === 'polling') this.startPolling(source);
      } catch (err) {
        // 单个信号源失败不拖垮整体，仅记录
        this.ingest({
          type: 'sentinel-error',
          description: `信号源启动失败(${source.type}): ${(err as Error).message}`,
          payload: { source },
          source: 'sentinel',
        });
      }
    }

    // watchCodeChanges 且未显式配置 filesystem 源时，自动监听 watchDir
    if (this.config.watchCodeChanges && this.config.watchDir) {
      const hasFsSource = (this.config.signalSources ?? []).some((s) => s.type === 'filesystem');
      if (!hasFsSource) {
        this.startFileWatch({ type: 'filesystem', path: this.config.watchDir, signalType: 'code-change' });
      }
    }
  }

  /**
   * 停止所有信号源并清空待处理缓冲（不交付残余信号）
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const server of this.webhookServers) server.close();
    this.webhookServers = [];
    for (const watcher of this.fsWatchers) watcher.close();
    this.fsWatchers = [];
    for (const timer of this.pollTimers) clearInterval(timer);
    this.pollTimers = [];
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.fsDebounceTimer) {
      clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = null;
    }
    this.pending = [];
    this.dedupeIndex.clear();
    this.fsPendingPaths.clear();
  }

  /**
   * 注入一个信号（手动 / webhook / 文件监听 / 轮询 / 级联统一入口）
   * @param partial 信号字段（id / receivedAt / occurrences 自动补齐）
   * @returns 归一化后的 Signal（若被窗口内去重则返回已存在的信号）
   */
  ingest(partial: Omit<Signal, 'id' | 'receivedAt' | 'occurrences'> & Partial<Signal>): Signal {
    const signal: Signal = {
      id: partial.id ?? `sig-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      type: partial.type,
      description: partial.description,
      payload: partial.payload ?? {},
      urgency: partial.urgency,
      receivedAt: partial.receivedAt ?? Date.now(),
      source: partial.source ?? 'manual',
      dedupeKey: partial.dedupeKey,
      occurrences: 1,
      tenantId: partial.tenantId,
      deadlineMs: partial.deadlineMs,
    };
    this.totalIngested += 1;

    // ── 感知深度优化：富化上下文（速率 / 突发 / 关联） ──
    const enrichment = this.enrich(signal);
    signal.enrichment = enrichment;

    // 记录近期信号（关联分析用，保留 50 条）
    this.recentSignals.push({ id: signal.id, type: signal.type, receivedAt: signal.receivedAt });
    if (this.recentSignals.length > 50) {
      this.recentSignals.splice(0, this.recentSignals.length - 50);
    }

    // 窗口内去重合并
    const key = signal.dedupeKey ?? `${signal.type}:${signal.description}`;
    const existing = this.dedupeIndex.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.payload = { ...existing.payload, lastMergedAt: Date.now(), mergedCount: existing.occurrences };
      existing.enrichment = enrichment;
      return existing;
    }

    this.pending.push(signal);
    this.dedupeIndex.set(key, signal);
    this.ensureWindowTimer();

    const maxBatchSize = this.config.maxBatchSize ?? 10;
    if (this.pending.length >= maxBatchSize) {
      this.flush('max-size');
    }
    return signal;
  }

  /**
   * 信号富化：到达速率统计 + 突发检测 + 关联分析 + 自适应窗口调整
   * @param signal 待富化信号
   */
  private enrich(signal: Signal): SignalEnrichment {
    const now = Date.now();

    // 到达历史维护（保留最近 5 分钟）
    const history = this.arrivalHistory.get(signal.type) ?? [];
    history.push(now);
    const cutoff = now - 5 * 60_000;
    while (history.length > 0 && history[0] < cutoff) history.shift();
    this.arrivalHistory.set(signal.type, history);

    // 最近 1 分钟速率
    const recentWindow = now - 60_000;
    const recentRatePerMin = history.filter((t) => t >= recentWindow).length;

    // 历史总次数
    const historicalCount = (this.historicalCounts.get(signal.type) ?? 0) + 1;
    this.historicalCounts.set(signal.type, historicalCount);

    // 速率基线（指数移动平均，α=0.1 慢速跟踪，避免基线追平速率导致突发永不触发）
    // 关键：突发检测必须对比"纳入本信号前的基线"，否则基线先被当前速率污染
    const hasBaseline = this.rateBaseline.has(signal.type);
    const prevBaseline = this.rateBaseline.get(signal.type) ?? 0;

    // 突发检测：速率超过前一基线 3 倍且绝对值 ≥ 3
    const isBurst = hasBaseline && recentRatePerMin >= 3 && recentRatePerMin > prevBaseline * 3;
    if (isBurst) this.burstCount += 1;

    // 基线更新：首次观测建立基线；突发期间冻结基线（保持其代表平稳期水平）
    if (!hasBaseline) {
      this.rateBaseline.set(signal.type, recentRatePerMin);
    } else if (!isBurst) {
      this.rateBaseline.set(signal.type, prevBaseline * 0.9 + recentRatePerMin * 0.1);
    }

    // 自适应窗口：突发时缩短窗口（快速响应），平稳时恢复配置值
    this.adaptWindow(isBurst);

    // 关联分析：最近 30s 内注入的异类型信号（无需等待批次交付）
    const correlatedSignalIds = this.recentSignals
      .filter((s) => s.id !== signal.id && now - s.receivedAt < 30_000 && s.type !== signal.type)
      .slice(-5)
      .map((s) => s.id);

    return {
      recentRatePerMin,
      historicalCount,
      isBurst,
      correlatedSignalIds,
      effectiveWindowMs: this.currentWindowMs,
    };
  }

  /** 自适应窗口调整：突发 → 缩短至 1/4（下限 50ms）；平稳 → 逐步恢复配置值 */
  private adaptWindow(isBurst: boolean): void {
    const configuredMs = Math.max(0.1, this.config.aggregationWindow) * 1000;
    if (isBurst) {
      this.currentWindowMs = Math.max(50, Math.floor(this.currentWindowMs / 4));
    } else if (this.currentWindowMs < configuredMs) {
      // 平稳期每次向配置值靠拢 25%
      this.currentWindowMs = Math.min(configuredMs, Math.ceil(this.currentWindowMs * 1.25));
    }
  }

  /**
   * 立即交付当前待处理批次（无待处理信号时为空操作）
   * @param reason 交付原因标记
   */
  flush(reason: SignalBatch['reason'] = 'flush'): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.pending.length === 0) return;

    const batch: SignalBatch = {
      signals: this.pending,
      aggregatedAt: Date.now(),
      reason,
    };
    this.pending = [];
    this.dedupeIndex.clear();
    this.totalBatches += 1;

    try {
      this.onBatch(batch);
    } catch {
      // 编排层异常不影响哨兵存活
    }
  }

  /** 当前待处理信号（只读快照） */
  getPendingSignals(): Signal[] {
    return [...this.pending];
  }

  /**
   * 哨兵运行状态（manage_consensus / model_dashboard 等 Tool 可引用）
   */
  getStatus(): SentinelStatus {
    const sources: SentinelStatus['sources'] = [];
    for (const server of this.webhookServers) {
      const addr = server.address();
      sources.push({ type: 'webhook', detail: `port:${typeof addr === 'object' && addr ? addr.port : '?'}`, active: true });
    }
    for (const source of this.config.signalSources ?? []) {
      if (source.type === 'filesystem') sources.push({ type: 'filesystem', detail: source.path ?? '', active: true });
      if (source.type === 'polling') sources.push({ type: 'polling', detail: source.url ?? '', active: true });
    }
    return {
      running: this.running,
      pendingSignals: this.pending.length,
      totalIngested: this.totalIngested,
      totalBatches: this.totalBatches,
      sources,
      aggregationWindow: this.config.aggregationWindow,
      effectiveWindowMs: this.currentWindowMs,
      burstCount: this.burstCount,
      historicalCounts: Object.fromEntries(this.historicalCounts),
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 确保聚合窗口定时器存在（首个信号触发开窗，使用自适应窗口） */
  private ensureWindowTimer(): void {
    if (this.windowTimer) return;
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      this.flush('window');
    }, this.currentWindowMs);
    this.windowTimer.unref?.();
  }

  /** 启动 webhook 信号源 */
  private startWebhook(source: SignalSourceConfig): void {
    const port = source.port ?? 9878;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(); // 1MB 上限
      });
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const signal = this.ingest({
            type: source.signalType || 'webhook',
            description: payload.description ?? payload.title ?? 'webhook 信号',
            payload,
            source: `webhook:${port}`,
            dedupeKey: payload.dedupeKey,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, signalId: signal.id, occurrences: signal.occurrences }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      });
    });
    server.on('error', (err) => {
      throw new NetworkError(`webhook 信号源异常: ${err.message}`, { port });
    });
    server.listen(port);
    this.webhookServers.push(server);
  }

  /** 启动文件监听信号源（递归监听 + 防抖 + 忽略规则） */
  private startFileWatch(source: SignalSourceConfig): void {
    const target = source.path ?? this.config.watchDir ?? process.cwd();
    if (!fs.existsSync(target)) return;

    const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const normalized = filename.replace(/\\/g, '/');
      if (normalized.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;
      this.fsPendingPaths.add(path.join(target, normalized));

      if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = setTimeout(() => {
        const paths = [...this.fsPendingPaths];
        this.fsPendingPaths.clear();
        this.fsDebounceTimer = null;
        if (paths.length === 0) return;
        this.ingest({
          type: source.signalType || 'code-change',
          description: `检测到 ${paths.length} 个文件变更`,
          payload: { files: paths.slice(0, 50), totalFiles: paths.length },
          source: `fs:${target}`,
          dedupeKey: `${source.signalType || 'code-change'}:${target}`,
        });
      }, FS_DEBOUNCE_MS);
      this.fsDebounceTimer.unref?.();
    });
    this.fsWatchers.push(watcher);
  }

  /** 启动轮询信号源（内容哈希比对） */
  private startPolling(source: SignalSourceConfig): void {
    const url = source.url;
    if (!url) return;
    const interval = source.interval ?? DEFAULT_POLL_INTERVAL;

    const timer = setInterval(async () => {
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) return;
        const text = await res.text();
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const prev = this.pollHashes.get(url);
        this.pollHashes.set(url, hash);
        if (prev !== undefined && prev !== hash) {
          this.ingest({
            type: source.signalType || 'polling-change',
            description: `轮询目标内容变化: ${url}`,
            payload: { url, previousHash: prev.slice(0, 12), currentHash: hash.slice(0, 12) },
            source: `poll:${url}`,
            dedupeKey: `poll:${url}`,
          });
        }
      } catch {
        // 轮询失败静默跳过，下个周期重试
      }
    }, interval);
    timer.unref?.();
    this.pollTimers.push(timer);
  }
}
