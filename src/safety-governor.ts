/**
 * safety-governor.ts — 安全治理器（自主智能"边界"支柱）
 *
 * 职责：自主性越强，越需要明确的边界。安全治理器为系统的自主行为
 * 设置硬性约束，确保"自主"不演变为"失控"。
 *
 * 能力矩阵：
 * 1. 限流（Rate Limiter）：限制单位时间内的自主动作次数，
 *    防止心跳循环或探索行为在短时间内过度消耗资源
 * 2. 预算（Budget）：限制累计 token 消耗 / 成本，
 *    超出预算后拒绝新的自主动作，防止成本失控
 * 3. 熔断器（Circuit Breaker）：连续失败超过阈值时熔断，
 *    暂停自主执行进入冷却期，冷却后半开试探，成功则恢复
 * 4. 置信度门控（Confidence Gate）：低置信度的决策不放行自主执行，
 *    要求转人工确认，防止盲目行动
 * 5. Kill Switch：全局紧急停止开关，一键冻结所有自主行为
 *
 * 设计要点：
 * - 治理器是"否决权"角色：不决定做什么，只决定"能不能做"
 * - 所有约束均可配置，且提供审计日志追溯每次拦截原因
 */

/** 治理动作类型 */
export type GovernedAction = 'autonomous-execute' | 'exploration' | 'goal-dispatch' | 'strategy-evolution';

/** 治理裁决 */
export interface GovernanceVerdict {
  allowed: boolean;
  /** 拦截原因（allowed=false 时） */
  reason?: string;
  /** 拦截类别 */
  blockedBy?: 'kill-switch' | 'rate-limit' | 'budget' | 'circuit-breaker' | 'confidence-gate';
}

/** 治理审计条目 */
export interface GovernanceAuditEntry {
  timestamp: number;
  action: GovernedAction;
  verdict: GovernanceVerdict;
}

/** 熔断器状态 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** 安全治理器配置 */
export interface SafetyGovernorConfig {
  /** 限流：每分钟最大自主动作数 */
  maxActionsPerMinute: number;
  /** 预算：累计 token 上限（0=不限制） */
  tokenBudget: number;
  /** 预算：累计成本上限（美元，0=不限制） */
  costBudget: number;
  /** 熔断：连续失败阈值 */
  circuitFailureThreshold: number;
  /** 熔断：冷却期（毫秒） */
  circuitCooldownMs: number;
  /** 置信度门控：低于该值的决策需人工确认 */
  confidenceThreshold: number;
  /** 治理审计日志上限 */
  auditLimit: number;
}

/** 默认配置 */
export const DEFAULT_SAFETY_GOVERNOR_CONFIG: SafetyGovernorConfig = {
  maxActionsPerMinute: 60,
  tokenBudget: 0,
  costBudget: 0,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 60_000,
  confidenceThreshold: 0.3,
  auditLimit: 200,
};

/**
 * 安全治理器
 *
 * 被 index.ts 持有：所有自主动作执行前调用 govern() 获取裁决，
 * 执行结果经 recordOutcome() 回写以驱动熔断器与预算统计。
 */
export class SafetyGovernor {
  private config: SafetyGovernorConfig;
  /** 限流：最近一分钟的动作时间戳 */
  private recentActions: number[] = [];
  /** 预算：累计消耗 */
  private totalTokensUsed = 0;
  private totalCost = 0;
  /** 熔断器状态 */
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  /** Kill Switch */
  private killSwitchEngaged = false;
  /** 审计日志 */
  private audit: GovernanceAuditEntry[] = [];

  constructor(config?: Partial<SafetyGovernorConfig>) {
    this.config = { ...DEFAULT_SAFETY_GOVERNOR_CONFIG, ...config };
  }

  /**
   * 治理裁决：判定一个自主动作能否执行
   * @param action 动作类型
   * @param confidence 决策置信度（用于置信度门控）
   * @returns 裁决结果
   */
  govern(action: GovernedAction, confidence = 1): GovernanceVerdict {
    let verdict: GovernanceVerdict;

    // 1. Kill Switch（最高优先级）
    if (this.killSwitchEngaged) {
      verdict = { allowed: false, reason: '紧急停止开关已启用', blockedBy: 'kill-switch' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 2. 熔断器
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.config.circuitCooldownMs) {
        verdict = { allowed: false, reason: `熔断器开启（冷却期剩余 ${Math.ceil((this.config.circuitCooldownMs - elapsed) / 1000)}s）`, blockedBy: 'circuit-breaker' };
        this.logAudit(action, verdict);
        return verdict;
      }
      // 冷却期结束 → 半开试探
      this.circuitState = 'half-open';
    }

    // 3. 限流
    const now = Date.now();
    this.recentActions = this.recentActions.filter((t) => t > now - 60_000);
    if (this.recentActions.length >= this.config.maxActionsPerMinute) {
      verdict = { allowed: false, reason: `限流：每分钟最多 ${this.config.maxActionsPerMinute} 个自主动作`, blockedBy: 'rate-limit' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 4. 预算
    if (this.config.tokenBudget > 0 && this.totalTokensUsed >= this.config.tokenBudget) {
      verdict = { allowed: false, reason: `预算耗尽：token 已达上限 ${this.config.tokenBudget}`, blockedBy: 'budget' };
      this.logAudit(action, verdict);
      return verdict;
    }
    if (this.config.costBudget > 0 && this.totalCost >= this.config.costBudget) {
      verdict = { allowed: false, reason: `预算耗尽：成本已达上限 $${this.config.costBudget}`, blockedBy: 'budget' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 5. 置信度门控（探索动作豁免，探索本身允许低置信）
    if (action !== 'exploration' && confidence < this.config.confidenceThreshold) {
      verdict = { allowed: false, reason: `置信度过低（${confidence.toFixed(2)} < ${this.config.confidenceThreshold}），需人工确认`, blockedBy: 'confidence-gate' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 放行
    this.recentActions.push(now);
    verdict = { allowed: true };
    this.logAudit(action, verdict);
    return verdict;
  }

  /**
   * 回写动作结果（驱动熔断器与预算统计）
   * @param success 动作是否成功
   * @param tokensUsed 本次消耗 token
   * @param cost 本次成本
   */
  recordOutcome(success: boolean, tokensUsed = 0, cost = 0): void {
    this.totalTokensUsed += tokensUsed;
    this.totalCost += cost;

    if (success) {
      this.consecutiveFailures = 0;
      // 半开状态下成功 → 恢复闭合
      if (this.circuitState === 'half-open') this.circuitState = 'closed';
    } else {
      this.consecutiveFailures += 1;
      // 连续失败超阈值 → 熔断
      if (this.consecutiveFailures >= this.config.circuitFailureThreshold && this.circuitState !== 'open') {
        this.circuitState = 'open';
        this.circuitOpenedAt = Date.now();
      }
    }
  }

  /** 启用 Kill Switch */
  engageKillSwitch(): void {
    this.killSwitchEngaged = true;
  }

  /** 解除 Kill Switch */
  disengageKillSwitch(): void {
    this.killSwitchEngaged = false;
  }

  /** Kill Switch 状态 */
  isKillSwitchEngaged(): boolean {
    return this.killSwitchEngaged;
  }

  /** 手动重置熔断器 */
  resetCircuit(): void {
    this.circuitState = 'closed';
    this.consecutiveFailures = 0;
  }

  /** 熔断器状态 */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /** 治理状态摘要 */
  getStatus(): any {
    return {
      killSwitch: this.killSwitchEngaged,
      circuitState: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      recentActionsPerMinute: this.recentActions.filter((t) => t > Date.now() - 60_000).length,
      budget: {
        tokensUsed: this.totalTokensUsed,
        tokenBudget: this.config.tokenBudget,
        costUsed: Number(this.totalCost.toFixed(4)),
        costBudget: this.config.costBudget,
      },
      recentAudit: this.audit.slice(-10),
    };
  }

  /** 审计日志 */
  getAudit(limit = 50): GovernanceAuditEntry[] {
    return this.audit.slice(-limit);
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 记录审计日志 */
  private logAudit(action: GovernedAction, verdict: GovernanceVerdict): void {
    this.audit.push({ timestamp: Date.now(), action, verdict });
    if (this.audit.length > this.config.auditLimit) {
      this.audit.splice(0, this.audit.length - this.config.auditLimit);
    }
  }
}
