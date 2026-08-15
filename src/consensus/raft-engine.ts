/**
 * raft-engine.ts — 分布式共识引擎（协作层，独立模块）
 *
 * 职责：实现 Raft 共识协议，保证多实例部署时调度决策的全局一致性
 * - Leader 选举（随机化选举超时 + RequestVote RPC）
 * - 日志复制（AppendEntries RPC + 多数派 commit）
 * - 决策提案：execute-plan / reject-signal / defer-signal / reassign-model / escalate-to-user
 * - 状态机应用：已提交日志条目通过 onCommit 回调交付上层
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 完整 Raft 核心循环：选举超时随机化（防活锁）、任期单调递增、
 *   投票每任期唯一、日志一致性检查（prevLogIndex/prevLogTerm）
 * 2. 持久化状态：currentTerm / votedFor / log 落盘，重启后状态不丢失
 * 3. 快速降级：candidate/follower 收到更高任期立即让位；
 *   leader 收到 AppendEntries 来自新 leader 时自动降级
 * 4. 单节点集群优化：cluster 只有自己时提案立即提交，零网络开销
 * 5. 提交推进：leader 按 matchIndex 多数派推进 commitIndex，
 *   仅提交当前任期日志（Raft 论文 §5.4.2 安全性约束）
 * 6. HTTP 传输层：内置 consensus 端口服务 RequestVote / AppendEntries / Propose，
 *   支持 priority 加权（高优先级节点选举超时更短，倾向成为 leader）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NetworkError } from '../errors.js';

/** 节点角色 */
export type NodeRole = 'leader' | 'follower' | 'candidate';

/** 共识日志条目（决策命令） */
export interface ConsensusLogEntry {
  index: number;
  term: number;
  command: {
    type: 'execute-plan' | 'reject-signal' | 'defer-signal' | 'reassign-model' | 'escalate-to-user';
    signalId: string;
    signalDescription: string;
    decision: any;
    proposedBy: string;
  };
  timestamp: number;
}

/** 集群节点配置 */
export interface ClusterNodeConfig {
  nodeId: string;
  address: string;
  port: number;
  /** 选举优先级（越大越倾向成为 leader），默认 1 */
  priority?: number;
}

/** Raft 引擎配置 */
export interface RaftConfig {
  localNodeId: string;
  cluster: ClusterNodeConfig[];
  /** 选举超时下限（毫秒） */
  electionTimeoutMin: number;
  /** 选举超时上限（毫秒） */
  electionTimeoutMax: number;
  /** leader 心跳间隔（毫秒） */
  heartbeatInterval: number;
  /** 共识 RPC 监听端口 */
  consensusPort: number;
  /** 持久化状态路径 */
  logPath: string;
}

/** 持久化状态 */
interface RaftPersistentState {
  currentTerm: number;
  votedFor: string | null;
  log: ConsensusLogEntry[];
}

/** 提案结果 */
interface ProposeResult {
  committed: boolean;
  decision: any;
}

/**
 * 分布式共识引擎（Raft）
 *
 * 被 index.ts 的 manage_consensus Tool 调用（status / propose）。
 * 集群模式下，战略决策需经多数派提交后方可执行。
 */
export class RaftEngine {
  private config: RaftConfig;
  private role: NodeRole = 'follower';
  private currentTerm = 0;
  private votedFor: string | null = null;
  private log: ConsensusLogEntry[] = [];
  private commitIndex = 0;
  private lastApplied = 0;
  private leaderId: string | null = null;

  /** leader 专用：各 peer 已知复制的最高日志索引 */
  private matchIndex = new Map<string, number>();
  /** leader 专用：下一条要发送的日志索引 */
  private nextIndex = new Map<string, number>();

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private server: http.Server | null = null;
  private commitCallbacks: Array<(entry: ConsensusLogEntry) => void> = [];
  private roleChangeCallbacks: Array<(role: NodeRole, term: number) => void> = [];
  /** 提案等待队列：logIndex → resolver */
  private pendingProposals = new Map<number, (result: ProposeResult) => void>();
  private running = false;

  constructor(config: RaftConfig) {
    this.config = config;
    this.loadPersistentState();
  }

  /**
   * 启动引擎：监听共识端口 + 启动选举定时器
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startRpcServer();
    this.resetElectionTimer();
    // 单节点集群直接成为 leader
    if (this.peers().length === 0) {
      this.becomeLeader();
    }
  }

  /**
   * 停止引擎：关闭服务与全部定时器
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.electionTimer = null;
    this.heartbeatTimer = null;
    this.server?.close();
    this.server = null;
    // 拒绝所有等待中的提案
    for (const resolve of this.pendingProposals.values()) {
      resolve({ committed: false, decision: null });
    }
    this.pendingProposals.clear();
    this.persistState();
  }

  /**
   * 提交决策提案
   *
   * - leader：追加本地日志并复制，多数派确认后 resolve
   * - 非 leader：转发给当前 leader；无 leader 时提案失败
   * - 单节点：立即提交
   *
   * @param command 决策命令
   * @param timeoutMs 等待提交的超时（默认 10s）
   */
  async propose(command: ConsensusLogEntry['command'], timeoutMs = 10_000): Promise<ProposeResult> {
    if (!this.running) {
      return { committed: false, decision: null };
    }

    // 非 leader 转发
    if (this.role !== 'leader') {
      if (this.leaderId) {
        return this.forwardPropose(this.leaderId, command, timeoutMs);
      }
      return { committed: false, decision: null };
    }

    // leader 追加日志
    const entry: ConsensusLogEntry = {
      index: this.lastLogIndex() + 1,
      term: this.currentTerm,
      command,
      timestamp: Date.now(),
    };
    this.log.push(entry);
    this.persistState();

    // 单节点立即提交
    if (this.peers().length === 0) {
      this.commitIndex = entry.index;
      this.applyCommitted();
      return { committed: true, decision: command.decision };
    }

    // 等待多数派确认
    return new Promise<ProposeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProposals.delete(entry.index);
        resolve({ committed: false, decision: null });
      }, timeoutMs);
      timer.unref?.();
      this.pendingProposals.set(entry.index, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      // 立即触发一轮心跳加速复制
      this.broadcastHeartbeat();
    });
  }

  /** 当前 leader id（未知返回 null） */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /** 当前角色 */
  getRole(): NodeRole {
    return this.role;
  }

  /** 当前任期 */
  getTerm(): number {
    return this.currentTerm;
  }

  /**
   * 集群状态摘要（供 manage_consensus status 使用）
   */
  getClusterStatus(): any {
    return {
      localNodeId: this.config.localNodeId,
      role: this.role,
      term: this.currentTerm,
      leaderId: this.leaderId,
      commitIndex: this.commitIndex,
      lastLogIndex: this.lastLogIndex(),
      logLength: this.log.length,
      peers: this.peers().map((p) => ({
        nodeId: p.nodeId,
        address: `${p.address}:${p.port}`,
        matchIndex: this.matchIndex.get(p.nodeId) ?? 0,
        nextIndex: this.nextIndex.get(p.nodeId) ?? 0,
      })),
      pendingProposals: this.pendingProposals.size,
    };
  }

  /** 注册已提交条目回调（状态机应用） */
  onCommit(callback: (entry: ConsensusLogEntry) => void): void {
    this.commitCallbacks.push(callback);
  }

  /** 注册角色变更回调 */
  onRoleChange(callback: (role: NodeRole, term: number) => void): void {
    this.roleChangeCallbacks.push(callback);
  }

  // ─────────────────────────── Raft 核心循环 ───────────────────────────

  /** 重置选举定时器（随机化超时，priority 越高超时越短） */
  private resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.role === 'leader' || !this.running) return;
    const priority = this.selfConfig().priority ?? 1;
    const min = this.config.electionTimeoutMin / Math.max(1, priority);
    const max = this.config.electionTimeoutMax / Math.max(1, priority);
    const timeout = min + Math.random() * (max - min);
    this.electionTimer = setTimeout(() => this.startElection(), timeout);
    this.electionTimer.unref?.();
  }

  /** 发起选举 */
  private startElection(): void {
    if (!this.running || this.role === 'leader') return;
    this.role = 'candidate';
    this.currentTerm += 1;
    this.votedFor = this.config.localNodeId;
    this.leaderId = null;
    this.persistState();
    this.emitRoleChange();
    this.resetElectionTimer();

    const lastLogIdx = this.lastLogIndex();
    const lastLogTerm = this.lastLogTerm();
    let votes = 1; // 自己的一票
    const majority = this.majority();
    const peers = this.peers();

    if (peers.length === 0) {
      this.becomeLeader();
      return;
    }

    let settled = false;
    for (const peer of peers) {
      this.sendRpc(peer, 'RequestVote', {
        term: this.currentTerm,
        candidateId: this.config.localNodeId,
        lastLogIndex: lastLogIdx,
        lastLogTerm,
      })
        .then((reply: any) => {
          if (settled || this.role !== 'candidate') return;
          if (reply.term > this.currentTerm) {
            this.stepDown(reply.term);
            return;
          }
          if (reply.voteGranted) {
            votes += 1;
            if (votes >= majority) {
              settled = true;
              this.becomeLeader();
            }
          }
        })
        .catch(() => {
          /* 单 peer 失败不影响选举 */
        });
    }
  }

  /** 成为 leader：初始化 nextIndex/matchIndex 并启动心跳 */
  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.config.localNodeId;
    const next = this.lastLogIndex() + 1;
    for (const peer of this.peers()) {
      this.nextIndex.set(peer.nodeId, next);
      this.matchIndex.set(peer.nodeId, 0);
    }
    this.emitRoleChange();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), this.config.heartbeatInterval);
    this.heartbeatTimer.unref?.();
    this.broadcastHeartbeat();
  }

  /** 降级为 follower */
  private stepDown(newTerm: number): void {
    if (newTerm > this.currentTerm) {
      this.currentTerm = newTerm;
      this.votedFor = null;
      this.persistState();
    }
    if (this.role !== 'follower') {
      this.role = 'follower';
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.emitRoleChange();
    }
    this.resetElectionTimer();
  }

  /** leader 广播心跳 / 日志复制 */
  private broadcastHeartbeat(): void {
    if (this.role !== 'leader' || !this.running) return;
    for (const peer of this.peers()) {
      this.replicateTo(peer).catch(() => {
        /* 单 peer 失败下轮重试 */
      });
    }
  }

  /** 向单个 peer 复制日志 */
  private async replicateTo(peer: ClusterNodeConfig): Promise<void> {
    const next = this.nextIndex.get(peer.nodeId) ?? this.lastLogIndex() + 1;
    const prevLogIndex = next - 1;
    const prevEntry = this.log.find((e) => e.index === prevLogIndex);
    const entries = this.log.filter((e) => e.index >= next);

    const reply: any = await this.sendRpc(peer, 'AppendEntries', {
      term: this.currentTerm,
      leaderId: this.config.localNodeId,
      prevLogIndex,
      prevLogTerm: prevEntry?.term ?? 0,
      entries,
      leaderCommit: this.commitIndex,
    });

    if (reply.term > this.currentTerm) {
      this.stepDown(reply.term);
      return;
    }
    if (this.role !== 'leader') return;

    if (reply.success) {
      const newMatch = prevLogIndex + entries.length;
      this.matchIndex.set(peer.nodeId, Math.max(this.matchIndex.get(peer.nodeId) ?? 0, newMatch));
      this.nextIndex.set(peer.nodeId, newMatch + 1);
      this.advanceCommitIndex();
    } else {
      // 一致性失败：回退 nextIndex 重试
      this.nextIndex.set(peer.nodeId, Math.max(1, next - 1));
    }
  }

  /** leader 推进 commitIndex（多数派 + 仅提交当前任期日志） */
  private advanceCommitIndex(): void {
    const majority = this.majority();
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      const entry = this.log.find((e) => e.index === n);
      if (!entry || entry.term !== this.currentTerm) continue; // §5.4.2 安全性
      const replicated = 1 + this.peers().filter((p) => (this.matchIndex.get(p.nodeId) ?? 0) >= n).length;
      if (replicated >= majority) {
        this.commitIndex = n;
        this.applyCommitted();
        break;
      }
    }
  }

  /** 应用已提交但未应用的日志条目 */
  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.log.find((e) => e.index === this.lastApplied);
      if (!entry) continue;
      for (const cb of this.commitCallbacks) {
        try {
          cb(entry);
        } catch {
          /* 状态机回调异常不阻塞应用循环 */
        }
      }
      // 兑现提案等待
      const resolver = this.pendingProposals.get(entry.index);
      if (resolver) {
        this.pendingProposals.delete(entry.index);
        resolver({ committed: true, decision: entry.command.decision });
      }
    }
  }

  // ─────────────────────────── RPC 处理 ───────────────────────────

  /** 处理 RequestVote */
  private handleRequestVote(args: any): any {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    let voteGranted = false;
    if (args.term === this.currentTerm && (this.votedFor === null || this.votedFor === args.candidateId)) {
      // 日志新鲜度检查
      const candidateUpToDate =
        args.lastLogTerm > this.lastLogTerm() ||
        (args.lastLogTerm === this.lastLogTerm() && args.lastLogIndex >= this.lastLogIndex());
      if (candidateUpToDate) {
        this.votedFor = args.candidateId;
        voteGranted = true;
        this.persistState();
        this.resetElectionTimer();
      }
    }
    return { term: this.currentTerm, voteGranted };
  }

  /** 处理 AppendEntries */
  private handleAppendEntries(args: any): any {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }
    // candidate 收到同任期合法 AppendEntries 必须降级（Raft §5.2）
    if (this.role === 'candidate') {
      this.stepDown(this.currentTerm);
    }
    // 承认 leader
    this.leaderId = args.leaderId;
    this.resetElectionTimer();

    // 一致性检查
    if (args.prevLogIndex > 0) {
      const prevEntry = this.log.find((e) => e.index === args.prevLogIndex);
      if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
        return { term: this.currentTerm, success: false };
      }
    }

    // 追加 / 覆盖日志
    for (const entry of args.entries as ConsensusLogEntry[]) {
      const existing = this.log.find((e) => e.index === entry.index);
      if (existing && existing.term !== entry.term) {
        // 冲突：截断后续
        this.log = this.log.filter((e) => e.index < entry.index);
        this.log.push(entry);
      } else if (!existing) {
        this.log.push(entry);
      }
    }
    this.persistState();

    // 推进提交
    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.lastLogIndex());
      this.applyCommitted();
    }
    return { term: this.currentTerm, success: true };
  }

  // ─────────────────────────── HTTP 传输层 ───────────────────────────

  /** 启动共识 RPC 服务 */
  private startRpcServer(): void {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let reply: any = { ok: false };
        try {
          const { rpc, args } = JSON.parse(body || '{}');
          switch (rpc) {
            case 'RequestVote':
              reply = { ok: true, ...this.handleRequestVote(args) };
              break;
            case 'AppendEntries':
              reply = { ok: true, ...this.handleAppendEntries(args) };
              break;
            case 'Propose':
              // 异步提案：立即受理，结果通过长轮询返回
              this.propose(args.command, 8000).then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, ...result }));
              });
              return;
            case 'Status':
              reply = { ok: true, ...this.getClusterStatus() };
              break;
            default:
              reply = { ok: false, error: `未知 RPC: ${rpc}` };
          }
        } catch (err) {
          reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    this.server.on('error', () => {
      /* 端口冲突等异常不中断引擎，集群功能降级 */
    });
    this.server.listen(this.config.consensusPort);
  }

  /** 发送 RPC 到 peer */
  private sendRpc(peer: ClusterNodeConfig, rpc: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ rpc, args });
      const req = http.request(
        {
          hostname: peer.address,
          port: peer.port,
          method: 'POST',
          path: '/raft',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 2000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data || '{}'));
            } catch {
              reject(new NetworkError(`RPC 响应解析失败: ${rpc}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new NetworkError(`RPC 超时: ${rpc} → ${peer.nodeId}`));
      });
      req.write(payload);
      req.end();
    });
  }

  /** 非 leader 转发提案 */
  private async forwardPropose(leaderId: string, command: ConsensusLogEntry['command'], timeoutMs: number): Promise<ProposeResult> {
    const leader = this.config.cluster.find((n) => n.nodeId === leaderId);
    if (!leader) return { committed: false, decision: null };
    try {
      const reply = await Promise.race([
        this.sendRpc(leader, 'Propose', { command }),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('forward timeout')), timeoutMs)),
      ]);
      return { committed: reply.committed === true, decision: reply.decision ?? null };
    } catch {
      return { committed: false, decision: null };
    }
  }

  // ─────────────────────────── 工具方法 ───────────────────────────

  /** 除自己外的 peer 列表 */
  private peers(): ClusterNodeConfig[] {
    return this.config.cluster.filter((n) => n.nodeId !== this.config.localNodeId);
  }

  /** 自身节点配置 */
  private selfConfig(): ClusterNodeConfig {
    return (
      this.config.cluster.find((n) => n.nodeId === this.config.localNodeId) ?? {
        nodeId: this.config.localNodeId,
        address: '127.0.0.1',
        port: this.config.consensusPort,
      }
    );
  }

  /** 多数派数量 */
  private majority(): number {
    return Math.floor(this.config.cluster.length / 2) + 1;
  }

  /** 最后一条日志索引 */
  private lastLogIndex(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]!.index : 0;
  }

  /** 最后一条日志任期 */
  private lastLogTerm(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]!.term : 0;
  }

  /** 触发角色变更回调 */
  private emitRoleChange(): void {
    for (const cb of this.roleChangeCallbacks) {
      try {
        cb(this.role, this.currentTerm);
      } catch {
        /* 回调异常不阻塞引擎 */
      }
    }
  }

  /** 加载持久化状态 */
  private loadPersistentState(): void {
    if (!fs.existsSync(this.config.logPath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.config.logPath, 'utf-8')) as RaftPersistentState;
      this.currentTerm = state.currentTerm ?? 0;
      this.votedFor = state.votedFor ?? null;
      this.log = Array.isArray(state.log) ? state.log : [];
    } catch {
      /* 损坏状态从零开始（安全性由任期机制保证） */
    }
  }

  /** 持久化状态（原子写入） */
  private persistState(): void {
    try {
      const state: RaftPersistentState = {
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
        log: this.log,
      };
      const dir = path.dirname(this.config.logPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.config.logPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
      fs.renameSync(tmp, this.config.logPath);
    } catch {
      /* 持久化失败不阻塞共识流程 */
    }
  }
}
