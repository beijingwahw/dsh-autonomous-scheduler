/**
 * distributed-sync.ts — 分布式记忆同步引擎（协作层，依赖 long-term-memory + crypto-engine）
 *
 * 职责：
 * - 将本地记忆变更（模式增删改 / 画像更新 / 反馈新增 / 统计更新）记录为变更日志
 * - 通过逻辑时钟（Lamport Clock）跟踪各节点进度，按 peer 增量生成同步批次
 * - 接收远端批次并幂等应用，检测并自动仲裁并发冲突
 * - 支持 http-poll / file-share 两种传输协议，双向或单向同步
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. Lamport 逻辑时钟：接收批次时 localClock = max(local, remote) + 1，
 *    保证因果序；peer 进度单独跟踪，实现按 peer 的增量推送（不重复传输）
 * 2. 幂等应用：已应用的 changeId 集合持久化，重复批次安全跳过，
 *    网络重传不会造成记忆重复累加
 * 3. 冲突自动仲裁：同指纹并发修改按 (logicalClock, timestamp, sourceNodeId)
 *    三级仲裁，仲裁结果落 SyncConflict 审计记录，无需人工介入
 * 4. 批次完整性：SyncBatch 携带 batchHash（变更链哈希），接收端逐条校验，
 *    损坏批次整体拒收
 * 5. 双协议传输：http-poll（POST push + GET pull）与 file-share（共享目录
 *    交换批次文件），均支持 authToken 鉴权
 * 6. 状态持久化：时钟 / peer 进度 / 待推送变更 / 冲突记录 / 同步日志全部落盘，
 *    重启后无缝续传
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NetworkError } from '../errors.js';
import type { LongTermMemory, TaskPatternMemory, ModelLongTermProfile, DecisionFeedback, MemoryStore } from '../memory/long-term-memory.js';
import type { CryptoEngine } from '../security/crypto-engine.js';

/**
 * 变更载荷联合类型（按 ChangeEntry.type 判别）：
 * - pattern-created / pattern-updated：完整模式，或反思器产出的轻量变更描述
 * - model-profile-updated：模型画像
 * - feedback-created：决策反馈
 * - stats-updated：全局统计增量
 * - pattern-deleted：无载荷（null）
 */
export type ChangePayload =
  | TaskPatternMemory
  | ModelLongTermProfile
  | DecisionFeedback
  | MemoryStore['globalStats']
  | { taskType: string; complexity: number; outcome: 'success' | 'failure' }
  | null;

/** 同步 HTTP 响应（push/pull 端点统一结构） */
interface SyncHttpResponse {
  ok?: boolean;
  error?: string;
  batch?: SyncBatch;
  [key: string]: unknown;
}

/** 同步节点配置 */
export interface SyncNodeConfig {
  nodeId: string;
  name: string;
  protocol: 'http-poll' | 'websocket' | 'file-share';
  remoteUrl?: string;
  wsUrl?: string;
  sharePath?: string;
  pollInterval?: number;
  authToken?: string;
  bidirectional?: boolean;
  enabled?: boolean;
}

/** 单条变更条目 */
export interface ChangeEntry {
  id: string;
  type:
    | 'pattern-created'
    | 'pattern-updated'
    | 'pattern-deleted'
    | 'model-profile-updated'
    | 'feedback-created'
    | 'stats-updated';
  fingerprint: string;
  timestamp: number;
  sourceNodeId: string;
  payload: ChangePayload;
  logicalClock: number;
  dataHash: string;
}

/** 同步批次 */
export interface SyncBatch {
  batchId: string;
  sourceNodeId: string;
  changes: ChangeEntry[];
  timestamp: number;
  logicalClock: number;
  batchHash: string;
}

/** 同步冲突记录 */
export interface SyncConflict {
  changeId: string;
  fingerprint: string;
  localData: TaskPatternMemory;
  remoteData: ChangePayload;
  localClock: number;
  remoteClock: number;
  resolution: 'local-wins' | 'remote-wins' | 'merged' | 'pending';
  resolvedAt?: number;
  resolutionReason?: string;
}

/** 单次同步日志 */
export interface SyncLogEntry {
  timestamp: number;
  direction: 'push' | 'pull';
  remoteNodeId: string;
  changesSent: number;
  changesReceived: number;
  conflictsDetected: number;
  conflictsResolved: number;
  errors: string[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
}

/** 同步状态（持久化结构） */
export interface SyncState {
  localClock: number;
  peerClocks: Record<string, number>;
  pendingChanges: ChangeEntry[];
  unresolvedConflicts: SyncConflict[];
  syncLog: SyncLogEntry[];
  lastSyncAt: Record<string, number>;
  /** 已应用变更 id（有界 FIFO；跨重启幂等去重的持久化载体） */
  appliedIds?: string[];
}

/** 同步引擎配置 */
interface DistributedSyncOptions {
  /** 状态持久化间隔（毫秒），默认 2000 */
  statePersistInterval?: number;
  /** 已应用变更 id 集合上限（FIFO 淘汰） */
  appliedSetLimit?: number;
  /** 同步日志保留条数 */
  syncLogLimit?: number;
  /** 待推送变更总字节上限（防单条大 payload 撑爆内存），默认 16 MB */
  maxPendingBytes?: number;
}

/** 已应用变更集合上限 */
const DEFAULT_APPLIED_LIMIT = 10_000;
/** 同步日志保留条数 */
const DEFAULT_LOG_LIMIT = 200;
/** 待推送变更上限（防止 peer 长期离线导致无限堆积） */
const MAX_PENDING_CHANGES = 5_000;
/** 待推送变更默认字节上限（条数之外的第二道闸：单条大 payload 场景） */
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * 分布式记忆同步引擎
 *
 * 被 index.ts 的 manage_sync Tool 调用（status / sync-now / register-node）。
 */
export class DistributedSync {
  private localNodeId: string;
  private memory: LongTermMemory;
  private statePath: string;
  private cryptoEngine?: CryptoEngine | null;
  private state: SyncState;
  /** 已应用的变更 id（幂等去重） */
  private appliedIds = new Set<string>();
  private nodes = new Map<string, SyncNodeConfig>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private options: Required<DistributedSyncOptions>;
  /** 各指纹最近一次本地变更时间戳（并发冲突仲裁的第二级依据） */
  private lastLocalChangeAt = new Map<string, number>();
  /** 待推送队列总字节数（含每条变更近似大小缓存） */
  private pendingBytes = new Map<string, number>();
  private totalPendingBytes = 0;

  /**
   * @param localNodeId 本节点 id
   * @param memory 本节点记忆库
   * @param statePath 同步状态持久化路径
   * @param cryptoEngine 可选加密引擎（状态文件加密落盘）
   */
  constructor(localNodeId: string, memory: LongTermMemory, statePath: string, cryptoEngine?: CryptoEngine | null) {
    this.localNodeId = localNodeId;
    this.memory = memory;
    this.statePath = statePath;
    this.cryptoEngine = cryptoEngine ?? null;
    this.options = {
      statePersistInterval: 2000,
      appliedSetLimit: DEFAULT_APPLIED_LIMIT,
      syncLogLimit: DEFAULT_LOG_LIMIT,
      maxPendingBytes: DEFAULT_MAX_PENDING_BYTES,
    };
    this.state = this.loadState();
    // 幂等集合跨重启恢复：原实现仅驻内存——重启后重投批次（peer 重推 /
    // inbox 未清理的文件）会被再次应用，feedback/stats 双重累加，
    // 「已应用的 changeId 集合持久化，重复批次安全跳过」的承诺落空
    if (Array.isArray(this.state.appliedIds)) {
      this.appliedIds = new Set(this.state.appliedIds.slice(-this.options.appliedSetLimit));
    }
    // 恢复待推队列字节计量（大小是载荷的派生量，无需持久化）
    for (const c of this.state.pendingChanges) {
      const size = this.approxSizeOf(c);
      this.pendingBytes.set(c.id, size);
      this.totalPendingBytes += size;
    }
  }

  /**
   * 记录一条本地变更（由记忆写入路径调用）
   * @param type 变更类型
   * @param fingerprint 变更对象指纹（pattern 指纹 / 模型 id / 反馈 id）
   * @param payload 变更载荷
   */
  recordChange(type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload): void {
    this.state.localClock += 1;
    const entry: ChangeEntry = {
      id: `${this.localNodeId}:${this.state.localClock}:${crypto.randomBytes(4).toString('hex')}`,
      type,
      fingerprint,
      timestamp: Date.now(),
      sourceNodeId: this.localNodeId,
      payload,
      logicalClock: this.state.localClock,
      dataHash: this.hashPayload(payload),
    };
    // 指纹级本地变更时间：并发冲突仲裁第二级（本地侧）真实依据
    this.lastLocalChangeAt.set(fingerprint, entry.timestamp);
    this.state.pendingChanges.push(entry);
    const size = this.approxSizeOf(entry);
    this.pendingBytes.set(entry.id, size);
    this.totalPendingBytes += size;
    // 双闸淘汰：条数上限 + 字节上限（后者防单条大 payload——完整模式
    // 载荷可达数十 KB，条数闸下 5000 条足以撑出数百 MB 常驻内存）
    while (
      this.state.pendingChanges.length > MAX_PENDING_CHANGES ||
      (this.totalPendingBytes > this.options.maxPendingBytes && this.state.pendingChanges.length > 1)
    ) {
      const evicted = this.state.pendingChanges.shift();
      if (!evicted) break;
      const sz = this.pendingBytes.get(evicted.id);
      if (sz !== undefined) {
        this.totalPendingBytes -= sz;
        this.pendingBytes.delete(evicted.id);
      }
    }
    this.schedulePersist();
  }

  /**
   * 获取待推送给指定 peer 的增量变更（clock > peer 已知进度）
   * @param forPeerId 目标 peer，缺省返回全部待推送变更
   */
  getPendingChanges(forPeerId?: string): ChangeEntry[] {
    if (!forPeerId) return [...this.state.pendingChanges];
    const peerClock = this.state.peerClocks[forPeerId] ?? 0;
    return this.state.pendingChanges.filter((c) => c.logicalClock > peerClock);
  }

  /**
   * 确认 peer 已消费到指定时钟位点（可裁剪已确认变更）
   */
  acknowledgePeer(peerId: string, clock: number): void {
    this.state.peerClocks[peerId] = Math.max(this.state.peerClocks[peerId] ?? 0, clock);
    // 所有 peer 都已确认的变更可安全裁剪（同步回收字节计量）
    const minConfirmed = Math.min(...Object.values(this.state.peerClocks));
    if (Object.keys(this.state.peerClocks).length > 0 && Number.isFinite(minConfirmed)) {
      const before = this.state.pendingChanges.length;
      this.state.pendingChanges = this.state.pendingChanges.filter((c) => c.logicalClock > minConfirmed);
      if (this.state.pendingChanges.length !== before) {
        this.pendingBytes.clear();
        this.totalPendingBytes = 0;
        for (const c of this.state.pendingChanges) {
          const size = this.approxSizeOf(c);
          this.pendingBytes.set(c.id, size);
          this.totalPendingBytes += size;
        }
      }
    }
    this.schedulePersist();
  }

  /**
   * 接收并应用远端批次
   *
   * 流程：批次哈希校验 → 逐条幂等应用 → 冲突检测与仲裁 → 时钟推进
   */
  async receiveBatch(batch: SyncBatch): Promise<{ applied: number; conflicts: SyncConflict[]; errors: string[] }> {
    const errors: string[] = [];
    const conflicts: SyncConflict[] = [];
    let applied = 0;

    // 1. 批次完整性校验
    if (!this.verifyBatchHash(batch)) {
      return { applied: 0, conflicts, errors: ['批次哈希校验失败：数据可能已损坏或被篡改'] };
    }

    // 2. 逐条应用
    for (const change of batch.changes) {
      try {
        // 载荷哈希校验（先于幂等检查：篡改必须暴露，即使 id 已见过）
        if (this.hashPayload(change.payload) !== change.dataHash) {
          errors.push(`变更 ${change.id} 载荷哈希不匹配，已跳过`);
          continue;
        }
        // 幂等：已应用过的变更跳过
        if (this.appliedIds.has(change.id)) continue;
        const conflict = this.applyChange(change);
        if (conflict) conflicts.push(conflict);
        this.appliedIds.add(change.id);
        this.trimAppliedIds();
        applied += 1;
      } catch (err) {
        errors.push(`变更 ${change.id} 应用失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Lamport 时钟推进：max(local, remote) + 1
    this.state.localClock = Math.max(this.state.localClock, batch.logicalClock) + 1;
    this.state.lastSyncAt[batch.sourceNodeId] = Date.now();
    this.schedulePersist();

    return { applied, conflicts, errors };
  }

  /**
   * 为指定 peer 创建增量批次（无新变更时返回 null）
   */
  createBatch(forPeerId: string): SyncBatch | null {
    const changes = this.getPendingChanges(forPeerId);
    if (changes.length === 0) return null;
    const batch: SyncBatch = {
      batchId: `${this.localNodeId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      sourceNodeId: this.localNodeId,
      changes,
      timestamp: Date.now(),
      logicalClock: this.state.localClock,
      batchHash: '',
    };
    batch.batchHash = this.computeBatchHash(batch);
    return batch;
  }

  /**
   * 注册同步节点（enabled 的 http-poll 节点自动启动定时拉取）
   */
  registerNode(config: SyncNodeConfig): void {
    this.nodes.set(config.nodeId, config);
    if (config.enabled !== false && config.protocol === 'http-poll' && config.pollInterval && config.pollInterval > 0) {
      this.startPolling(config);
    }
    this.schedulePersist();
  }

  /**
   * 创建 HTTP 同步端点处理器（供集成层挂载到 HTTP 服务）
   *
   * - handlePush: POST 接收远端批次
   * - handlePull: GET 返回本地增量批次（?peerId=xxx&since=clock）
   * - handleStatus: GET 返回同步状态摘要
   */
  createSyncHandlers(): {
    handlePush: (body: unknown) => Promise<Record<string, unknown>>;
    handlePull: (query: { peerId?: string }) => { ok: boolean; batch: SyncBatch | null };
    handleAck: (body: { peerId?: string; clock?: number }) => Record<string, unknown>;
    handleStatus: () => Record<string, unknown>;
  } {
    return {
      handlePush: async (body: unknown) => {
        const batch = body as SyncBatch;
        if (!batch || !Array.isArray(batch.changes)) {
          return { ok: false, error: '非法批次结构' };
        }
        const result = await this.receiveBatch(batch);
        // 注意：此处不可 acknowledgePeer——推送方消费的是「它自己的时钟域」，
        // 而 peerClocks 记录的是「对方已消费我的变更到我的时钟几」。原实现
        // 把 sender 的 logicalClock 记进我的 peerClocks，之后 createBatch 给
        // 该 peer 的增量会错误跳过一批它从未收到的本地变更（永久丢失）
        return { ok: result.errors.length === 0, ...result };
      },
      handlePull: (query: { peerId?: string }) => {
        const peerId = query.peerId ?? 'unknown';
        const batch = this.createBatch(peerId);
        // 交付语义修复：此处不再立即确认进度——批次在拉取方应用失败
        // （传输中断 / 应用异常）时，提前确认会让该批变更永久漏推；
        // 改由拉取方应用成功后显式回执 handleAck（至少一次交付 +
        // 幂等应用 = 恰好一次效果）
        return { ok: true, batch };
      },
      handleAck: (body: { peerId?: string; clock?: number }) => {
        // 拉取方应用成功的显式回执：此刻确认「对方已消费我的时钟域到此」
        if (!body.peerId || typeof body.clock !== 'number' || !Number.isFinite(body.clock)) {
          return { ok: false, error: '非法回执：需要 peerId 与数字 clock' };
        }
        this.acknowledgePeer(body.peerId, body.clock);
        return { ok: true };
      },
      handleStatus: () => ({
        ok: true,
        nodeId: this.localNodeId,
        localClock: this.state.localClock,
        pendingChanges: this.state.pendingChanges.length,
        pendingBytes: this.totalPendingBytes,
        peers: Object.keys(this.state.peerClocks),
        unresolvedConflicts: this.state.unresolvedConflicts.length,
      }),
    };
  }

  /**
   * 立即与指定 peer 同步一次（push 本地增量 + 可选 pull 远端增量）
   * @param peerId 已注册节点 id
   */
  async syncNow(peerId: string): Promise<SyncLogEntry> {
    const startedAt = Date.now();
    const log: SyncLogEntry = {
      timestamp: startedAt,
      direction: 'push',
      remoteNodeId: peerId,
      changesSent: 0,
      changesReceived: 0,
      conflictsDetected: 0,
      conflictsResolved: 0,
      errors: [],
      duration: 0,
      status: 'success',
    };

    const node = this.nodes.get(peerId);
    if (!node) {
      log.status = 'failed';
      log.errors.push(`未注册的节点: ${peerId}`);
      this.appendSyncLog(log);
      return log;
    }

    try {
      if (node.protocol === 'http-poll') {
        await this.syncViaHttp(node, log);
      } else if (node.protocol === 'file-share') {
        await this.syncViaFileShare(node, log);
      } else {
        log.errors.push(`暂不支持的协议: ${node.protocol}`);
        log.status = 'failed';
      }
    } catch (err) {
      log.errors.push(err instanceof Error ? err.message : String(err));
      log.status = 'failed';
    }

    log.duration = Date.now() - startedAt;
    if (log.status !== 'failed' && log.errors.length > 0) log.status = 'partial';
    this.appendSyncLog(log);
    return log;
  }

  /**
   * 停止全部轮询定时器与持久化定时器
   */
  stop(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistState();
  }

  /**
   * 获取同步状态摘要（供 manage_sync status 使用）
   */
  /** 同步状态摘要（运维可观测） */
  getStatus(): {
    localNodeId: string;
    localClock: number;
    registeredNodes: Array<{ nodeId: string; name: string; protocol: SyncNodeConfig['protocol']; enabled: boolean }>;
    peerClocks: Record<string, number>;
    pendingChanges: number;
    unresolvedConflicts: number;
    recentSyncs: SyncLogEntry[];
    lastSyncAt: Record<string, number>;
  } {
    return {
      localNodeId: this.localNodeId,
      localClock: this.state.localClock,
      registeredNodes: [...this.nodes.values()].map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        protocol: n.protocol,
        enabled: n.enabled !== false,
      })),
      peerClocks: { ...this.state.peerClocks },
      pendingChanges: this.state.pendingChanges.length,
      unresolvedConflicts: this.state.unresolvedConflicts.length,
      recentSyncs: this.state.syncLog.slice(-5),
      lastSyncAt: { ...this.state.lastSyncAt },
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 应用单条变更到本地记忆库
   * @returns 检测到冲突时返回冲突记录（已自动仲裁）
   */
  private applyChange(change: ChangeEntry): SyncConflict | null {
    switch (change.type) {
      case 'pattern-created':
      case 'pattern-updated': {
        // 边界收窄：模式类变更载荷应为完整模式（轻量变更描述仅用于同步登记，不参与 upsert）
        const pattern = change.payload as TaskPatternMemory;
        const local = this.memory.getAllTaskPatterns().find((p) => p.fingerprint === change.fingerprint);
        if (local && change.type === 'pattern-updated') {
          // 并发修改冲突：三级仲裁 (clock, timestamp, nodeId)
          const localClock = this.state.localClock;
          const localTs = this.lastLocalChangeAt.get(change.fingerprint) ?? 0;
          const remoteWins = this.arbitrate(localClock, change.logicalClock, change.timestamp, localTs, change.sourceNodeId);
          const conflict: SyncConflict = {
            changeId: change.id,
            fingerprint: change.fingerprint,
            localData: local,
            remoteData: change.payload,
            localClock,
            remoteClock: change.logicalClock,
            resolution: remoteWins ? 'remote-wins' : 'local-wins',
            resolvedAt: Date.now(),
            resolutionReason: remoteWins
              ? '远端时钟/时间戳更新'
              : '本地时钟更新，保留本地版本',
          };
          this.state.unresolvedConflicts.push(conflict);
          if (remoteWins) {
            this.memory.upsertPattern(pattern);
          }
          return conflict;
        }
        this.memory.upsertPattern(pattern);
        return null;
      }
      case 'pattern-deleted':
        this.memory.removePattern(change.fingerprint);
        return null;
      case 'model-profile-updated':
        this.memory.upsertModelProfile(change.payload as ModelLongTermProfile);
        return null;
      case 'feedback-created':
        this.memory.appendFeedback(change.payload as DecisionFeedback);
        return null;
      case 'stats-updated':
        this.memory.mergeGlobalStats(change.payload as MemoryStore['globalStats']);
        return null;
      default:
        return null;
    }
  }

  /**
   * 三级仲裁：clock 高者胜 → timestamp 新者胜 → nodeId 字典序大者胜。
   * 第二级原实现用 Date.now() 近似本地变更时间——墙钟在「应用远端批次」
   * 的当下必然新于远端时间戳，等价于「时钟同段时远端恒胜」，仲裁退化为
   * 单级；现改用指纹级真实本地变更时间（recordChange 时记录）。
   * 第三级 nodeId 决胜保证双方独立仲裁结果一致（无分歧收敛）
   */
  private arbitrate(
    localClock: number,
    remoteClock: number,
    remoteTimestamp: number,
    localTimestamp: number,
    remoteNodeId: string,
  ): boolean {
    if (remoteClock !== localClock) return remoteClock > localClock;
    if (remoteTimestamp !== localTimestamp) return remoteTimestamp > localTimestamp;
    return remoteNodeId > this.localNodeId;
  }

  /** http-poll 协议同步：先 push 本地增量，再 pull 远端增量 */
  private async syncViaHttp(node: SyncNodeConfig, log: SyncLogEntry): Promise<void> {
    const baseUrl = node.remoteUrl?.replace(/\/$/, '');
    if (!baseUrl) throw new NetworkError(`节点 ${node.nodeId} 缺少 remoteUrl`);

    // push：本地增量 → 远端
    const outBatch = this.createBatch(node.nodeId);
    if (outBatch) {
      const pushResult = await this.httpRequest(`${baseUrl}/sync/push`, 'POST', outBatch, node.authToken);
      if (pushResult.ok) {
        log.changesSent = outBatch.changes.length;
        this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
      } else {
        log.errors.push(`push 被拒: ${pushResult.error ?? 'unknown'}`);
      }
    }

    // pull：远端增量 → 本地（双向同步时）
    if (node.bidirectional !== false) {
      const pullResult = await this.httpRequest(
        `${baseUrl}/sync/pull?peerId=${encodeURIComponent(this.localNodeId)}`,
        'GET',
        undefined,
        node.authToken,
      );
      if (pullResult.ok && pullResult.batch) {
        const received = await this.receiveBatch(pullResult.batch);
        log.changesReceived = received.applied;
        log.conflictsDetected = received.conflicts.length;
        log.conflictsResolved = received.conflicts.filter((c) => c.resolution !== 'pending').length;
        log.errors.push(...received.errors);
        // 拉回的是对方时钟域的增量：我消费它≠它消费我，不可记入
        // 我对它的 peerClocks（时钟域混记会让后续推送静默跳变更）。
        // 应用干净后显式回执对方的进度确认端点；有错误则不回执——
        // 对方重投整批，已应用部分由 appliedIds 幂等跳过
        if (received.errors.length === 0) {
          await this.httpRequest(
            `${baseUrl}/sync/ack`,
            'POST',
            { peerId: this.localNodeId, clock: pullResult.batch.logicalClock },
            node.authToken,
          ).catch(() => {
            /* 回执失败：对方保持未确认，下轮重投（幂等安全） */
          });
        }
      }
    }
  }

  /** file-share 协议同步：通过共享目录交换批次文件 */
  private async syncViaFileShare(node: SyncNodeConfig, log: SyncLogEntry): Promise<void> {
    const sharePath = node.sharePath;
    if (!sharePath) throw new NetworkError(`节点 ${node.nodeId} 缺少 sharePath`);
    const inboxDir = path.join(sharePath, node.nodeId, 'inbox');
    const outboxDir = path.join(sharePath, this.localNodeId, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });

    // push：写批次文件到对方 inbox
    const outBatch = this.createBatch(node.nodeId);
    if (outBatch) {
      const filePath = path.join(inboxDir, `${outBatch.batchId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(outBatch), 'utf-8');
      log.changesSent = outBatch.changes.length;
      this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
    }

    // pull：消费自己 inbox 中的批次文件
    if (node.bidirectional !== false && fs.existsSync(outboxDir)) {
      for (const file of fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort()) {
        const filePath = path.join(outboxDir, file);
        try {
          const batch = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SyncBatch;
          const received = await this.receiveBatch(batch);
          log.changesReceived += received.applied;
          log.conflictsDetected += received.conflicts.length;
          log.conflictsResolved += received.conflicts.filter((c) => c.resolution !== 'pending').length;
          log.errors.push(...received.errors);
          // 同上：对方时钟域的进度不可混记进 peerClocks（我的域）。
          // 应用干净才删文件；有错误保留待下轮重试（至少一次交付，
          // 已应用部分由 appliedIds 幂等跳过）——原实现无条件删除，
          // 部分应用失败即静默丢批
          if (received.errors.length === 0) {
            fs.rmSync(filePath);
          } else {
            log.errors.push(`批次 ${file} 部分应用失败，保留待重试`);
          }
        } catch (err) {
          // 解析/读取异常：保留批次文件待下轮重试——原实现无条件删除，
          // 处理中途异常即静默丢批
          log.errors.push(`批次文件处理失败 ${file}（保留待重试）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** 启动 http-poll 定时拉取 */
  private startPolling(node: SyncNodeConfig): void {
    if (this.pollTimers.has(node.nodeId)) return;
    const timer = setInterval(() => {
      this.syncNow(node.nodeId).catch(() => {
        /* 单次轮询失败不中断定时器 */
      });
    }, node.pollInterval! * 1000);
    timer.unref?.();
    this.pollTimers.set(node.nodeId, timer);
  }

  /** 简易 HTTP 请求（走环境代理，JSON 载荷） */
  private httpRequest(url: string, method: 'GET' | 'POST', body?: unknown, authToken?: string): Promise<SyncHttpResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data || '{}'));
            } catch {
              resolve({ ok: false, error: `非法响应: ${data.slice(0, 100)}` });
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new NetworkError(`请求超时: ${url}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 计算批次哈希（变更 id + dataHash 链式哈希） */
  private computeBatchHash(batch: SyncBatch): string {
    const chain = batch.changes.map((c) => `${c.id}:${c.dataHash}`).join('|');
    return crypto.createHash('sha256').update(`${batch.sourceNodeId}:${batch.logicalClock}:${chain}`).digest('hex');
  }

  /** 校验批次哈希 */
  private verifyBatchHash(batch: SyncBatch): boolean {
    return this.computeBatchHash(batch) === batch.batchHash;
  }

  /** 载荷哈希 */
  private hashPayload(payload: ChangePayload): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /** 变更条目近似字节数（载荷序列化长度 + 条目固定开销） */
  private approxSizeOf(entry: ChangeEntry): number {
    try {
      return JSON.stringify(entry.payload).length + 256;
    } catch {
      return 4096; // 序列化异常（循环引用等）按保守值计
    }
  }
  /** 已应用集合 FIFO 淘汰 */
  private trimAppliedIds(): void {
    if (this.appliedIds.size <= this.options.appliedSetLimit) return;
    const overflow = this.appliedIds.size - this.options.appliedSetLimit;
    const iter = this.appliedIds.values();
    for (let i = 0; i < overflow; i++) {
      const value = iter.next().value;
      if (value !== undefined) this.appliedIds.delete(value);
    }
  }

  /** 追加同步日志（限长） */
  private appendSyncLog(log: SyncLogEntry): void {
    this.state.syncLog.push(log);
    if (this.state.syncLog.length > this.options.syncLogLimit) {
      this.state.syncLog = this.state.syncLog.slice(-this.options.syncLogLimit);
    }
    this.schedulePersist();
  }

  /** 加载同步状态 */
  private loadState(): SyncState {
    const empty: SyncState = {
      localClock: 0,
      peerClocks: {},
      pendingChanges: [],
      unresolvedConflicts: [],
      syncLog: [],
      lastSyncAt: {},
    };
    if (!fs.existsSync(this.statePath)) return empty;
    try {
      let data: any;
      if (this.cryptoEngine) {
        data = this.cryptoEngine.readEncrypted(this.statePath).data;
      } else {
        data = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
      return { ...empty, ...data };
    } catch {
      return empty;
    }
  }

  /** 防抖持久化调度 */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistState();
    }, this.options.statePersistInterval);
    this.persistTimer.unref?.();
  }

  /** 执行状态持久化 */
  private persistState(): void {
    try {
      // 幂等集合随状态落盘（有界，FIFO 截断与内存淘汰口径一致）
      this.state.appliedIds = [...this.appliedIds].slice(-this.options.appliedSetLimit);
      if (this.cryptoEngine) {
        this.cryptoEngine.writeEncrypted(this.statePath, this.state);
        return;
      }
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.statePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmp, this.statePath);
    } catch {
      /* 状态持久化失败不阻塞同步流程 */
    }
  }
}
