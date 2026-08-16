/**
 * resilience.ts — 弹性内核（项目 4.0「可靠执行」基石）
 *
 * 勘察结论（升级前）：task-executor 重试紧贴重发（无退避）、错误不分型
 * （网络错与质量错同路径）、无模型级熔断（同一坏模型被反复重试打爆配额）。
 *
 * 本内核把「熔断 + 退避 + 错误分型」做成全链路共享的纯组件：
 * - CircuitBreaker：closed → open（连续失败 ≥ 阈值）→ half-open（冷却后单试探，
 *   并发互斥——同一时刻只放行一个探测请求）→ closed（探测成功）
 * - CircuitBreakerRegistry：按 key（如 modelId）隔离的熔断器集合（容量上限防泄漏）
 * - backoffDelayMs：指数退避 + 全抖动（防惊群），可注入随机源保证测试确定性
 * - abortableSleep：可中止睡眠（全局超时到达时立即中断退避等待）
 * - classifyError：错误分型——可退避重试（网络/超时/限流）/ 立即重试 /
 *   换模型（能力类）/ 终止（不可恢复），驱动差异化重试策略
 */

import { TimeoutError, NetworkError } from '../errors.js';

/** 熔断器状态 */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  /** 连续失败进入熔断的阈值 */
  failureThreshold: number;
  /** 熔断冷却期（毫秒），期满转 half-open */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
};

/** 熔断器可执行性探测结果 */
export interface BreakerProbe {
  allowed: boolean;
  state: BreakerState;
  /** open 状态下距下次可试探的剩余毫秒 */
  msUntilRetry: number;
}

/** 熔断器状态快照（可观测性） */
export interface BreakerStatus {
  state: BreakerState;
  consecutiveFailures: number;
}

/**
 * 单 key 熔断器
 *
 * half-open 并发互斥：冷却期满后首个请求获得探测资格，其余请求仍被拒绝——
 * 避免冷却结束瞬间流量洪峰直接打到尚未恢复的下游。
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** half-open 探测互斥：>0 表示已有探测在途 */
  private halfOpenInFlight = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /** 探测当前是否放行（不改变状态；放行后调用方须成对调用 recordSuccess/recordFailure） */
  canExecute(now = Date.now()): BreakerProbe {
    if (this.state === 'open') {
      const elapsed = now - this.openedAt;
      if (elapsed < this.config.cooldownMs) {
        return { allowed: false, state: 'open', msUntilRetry: this.config.cooldownMs - elapsed };
      }
      this.state = 'half-open';
    }
    if (this.state === 'half-open') {
      // 并发互斥：已有探测在途时拒绝新请求
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      this.halfOpenInFlight += 1;
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    return { allowed: true, state: 'closed', msUntilRetry: 0 };
  }

  /**
   * 无副作用检查：纯读取当前可执行性（不获取 half-open 探测名额）
   *
   * 用于候选过滤/展示等「只看不执行」场景——canExecute 在 half-open 态
   * 会占用探测名额，纯检查场景必须用 peek，否则名额泄漏导致永久误判熔断。
   */
  peek(now = Date.now()): BreakerProbe {
    if (this.state === 'open') {
      const elapsed = now - this.openedAt;
      if (elapsed < this.config.cooldownMs) {
        return { allowed: false, state: 'open', msUntilRetry: this.config.cooldownMs - elapsed };
      }
      // 冷却期满：将以 half-open 放行（无在途探测时）
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    return { allowed: true, state: 'closed', msUntilRetry: 0 };
  }

  /** 成功回报：清零失败计数，half-open 探测成功 → 恢复闭合 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.state = 'closed';
  }

  /** 失败回报：累计连续失败，达阈值熔断；half-open 探测失败 → 重新熔断 */
  recordFailure(now = Date.now()): void {
    if (this.state === 'half-open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  /** 状态快照（可观测性） */
  getState(): BreakerStatus {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }

  /** 手动复位 */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
  }

  /**
   * 释放 half-open 探测资格（不改变成功/失败统计）
   *
   * 用于「请求已发出但无法判定下游可用性」的场景（如客户端 4xx）：
   * 探测互斥锁必须释放，否则后续请求永久被拒。
   */
  releaseProbe(): void {
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }
}

/**
 * 按 key 隔离的熔断器注册表
 *
 * 典型 key = modelId（模型 A 熔断不影响模型 B）；容量上限 + 简单 LRU 淘汰，
 * 防止长尾模型 id 导致的无界增长。
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private config: CircuitBreakerConfig;
  private capacity: number;

  constructor(config?: Partial<CircuitBreakerConfig> & { capacity?: number }) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.capacity = config?.capacity ?? 256;
  }

  private get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      if (this.breakers.size >= this.capacity) {
        // 淘汰最旧条目（Map 迭代序 = 插入序；重访问不保序，容量上限场景足够）
        const oldest = this.breakers.keys().next().value;
        if (oldest !== undefined) this.breakers.delete(oldest);
      }
      breaker = new CircuitBreaker(this.config);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  canExecute(key: string, now?: number): BreakerProbe {
    return this.get(key).canExecute(now);
  }

  /** 无副作用检查（纯读取，不占用 half-open 探测名额） */
  peek(key: string, now?: number): BreakerProbe {
    return this.get(key).peek(now);
  }

  recordSuccess(key: string): void {
    this.get(key).recordSuccess();
  }

  recordFailure(key: string): void {
    this.get(key).recordFailure();
  }

  releaseProbe(key: string): void {
    this.get(key).releaseProbe();
  }

  /** 全部熔断器状态（运维可观测） */
  snapshot(): Record<string, BreakerStatus> {
    const out: Record<string, BreakerStatus> = {};
    for (const [key, breaker] of this.breakers) out[key] = breaker.getState();
    return out;
  }

  /** 是否有任一 key 处于熔断（快速检查） */
  hasOpen(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.getState().state !== 'closed') return true;
    }
    return false;
  }

  reset(key?: string): void {
    if (key !== undefined) this.breakers.get(key)?.reset();
    else this.breakers.clear();
  }
}

/** 退避配置 */
export interface BackoffConfig {
  /** 首次退避基数（毫秒） */
  baseMs: number;
  /** 指数因子 */
  factor: number;
  /** 退避上限（毫秒）——防止大重试次数下延迟爆炸 */
  maxMs: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseMs: 200,
  factor: 2,
  maxMs: 8_000,
};

/**
 * 指数退避延迟（全抖动：[0, min(base × factor^(attempt-1), max)] 均匀采样）
 *
 * 全抖动（full jitter）相对确定性退避的优势：并发重试错峰，防惊群。
 * @param attempt 本次失败后的重试序号（1 = 第一次重试）
 * @param rng 随机源（测试可注入确定性实现）
 */
export function backoffDelayMs(attempt: number, config?: Partial<BackoffConfig>, rng: () => number = Math.random): number {
  const cfg = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  const ceiling = Math.min(cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt - 1)), cfg.maxMs);
  return Math.max(0, Math.round(rng() * ceiling));
}

/**
 * 可中止睡眠：全局超时/中止信号到达时立即返回 false（放弃重试）
 * @returns true = 睡满（可继续重试）；false = 被中止（放弃）
 */
export function abortableSleep(ms: number, abortSignal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!abortSignal?.aborted);
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 错误重试分型 */
export type RetryClass =
  /** 网络抖动/限流/超时：指数退避后原路重试（下游可能恢复） */
  | 'retryable-backoff'
  /** 已知幂等瞬时错：立即重试（如队列争用） */
  | 'retryable-immediate'
  /** 执行到达但产出不达标：重试无益，换模型（能力问题） */
  | 'switch-model'
  /** 不可恢复（配置错/鉴权错/未知错）：停止重试 */
  | 'fatal';

export interface ErrorClassification {
  class: RetryClass;
  /** 机器可读错误类别名 */
  kind: 'timeout' | 'network' | 'rate-limit' | 'server' | 'client' | 'quality' | 'unknown';
  /** 人类可读说明 */
  reason: string;
}

/** LLM 客户端可重试状态码（与 llm-client.ts 口径一致） */
const RETRYABLE_LLM_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 错误分型（差异化重试的依据）
 *
 * 分型策略：
 * - TimeoutError → retryable-backoff（下游可能过载，退避让路）
 * - NetworkError → retryable-backoff（网络抖动，退避重试）
 * - 携带可重试状态码的 LLMError → retryable-backoff（429/5xx）
 * - 携带 4xx（非 408/429）状态码 → fatal（请求本身有问题，重试无意义）
 * - 质量不达标（由调用方在 verdict 层判定，不走本函数）→ switch-model
 * - 其余未知错误 → fatal（与升级前「非超时不重试」行为一致）
 */
export function classifyError(err: unknown): ErrorClassification {
  if (err instanceof TimeoutError) {
    return { class: 'retryable-backoff', kind: 'timeout', reason: '执行超时，退避后重试' };
  }
  if (err instanceof NetworkError) {
    return { class: 'retryable-backoff', kind: 'network', reason: '网络错误，退避后重试' };
  }
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429) return { class: 'retryable-backoff', kind: 'rate-limit', reason: `限流（${status}），退避后重试` };
    if (RETRYABLE_LLM_STATUS.has(status)) return { class: 'retryable-backoff', kind: 'server', reason: `服务端错误（${status}），退避后重试` };
    return { class: 'fatal', kind: 'client', reason: `客户端错误（${status}），重试无意义` };
  }
  return { class: 'fatal', kind: 'unknown', reason: '未知错误，保守终止重试' };
}
