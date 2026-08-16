/**
 * llm-client.ts — OpenAI 兼容 LLM 调用客户端（集成层基础设施）
 *
 * 职责：为战略决策（strategist）与执行器（executor）提供统一的模型调用入口
 * - OpenAI 兼容 /v1/chat/completions 协议（fetch 实现，零第三方依赖）
 * - 单请求超时控制（AbortController）
 * - 指数退避重试（仅对可重试错误：429 / 5xx / 网络错误 / 超时）
 * - 每模型并发度控制（信号量 + 排队队列，超限排队而非拒绝）
 * - 结构化 JSON 输出解析（容错代码块包裹 / 前后杂散文本）
 * - 调用统计（次数、成功率、平均延迟、token 消耗、成本估算）
 *
 * 升级点（相对裸 fetch 调用的质的提升）：
 * 1. 并发信号量带排队队列与队列上限，过载时快速失败而非无限堆积
 * 2. 重试预算与退避抖动（jitter）避免多客户端同步重试风暴
 * 3. fetchImpl 可注入，冒烟测试可完全离线模拟模型端点
 * 4. 成本估算内置：按 costPerKToken × tokensUsed 计算
 */

import { AppError, NetworkError, TimeoutError } from './errors.js';

/** 聊天消息（OpenAI 兼容格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** 模型端点配置（cordis.yml models[] 条目 + strategistModel 的公共形态） */
export interface ModelConfig {
  id: string;
  name?: string;
  /** API 基地址，如 https://api.deepseek.com（自动补 /v1/chat/completions） */
  endpoint: string;
  /**
   * API Key。可选：当 DSH 宿主经 ctx 注入请求头（headerProvider）时
   * 无需在配置中携带 Key，宿主会自动把用户配置的 Key 注入请求头。
   */
  apiKey?: string;
  /** 单请求超时（毫秒） */
  timeout?: number;
  /** 该模型最大并发请求数 */
  maxConcurrency?: number;
  /** 每千 token 成本（美元），用于成本估算 */
  costPerKToken?: number;
  /** 上下文窗口大小（token） */
  contextWindow?: number;
  /** 初始能力画像 */
  initialCapabilities?: { taskScores?: Record<string, number>; [key: string]: any };
}

/** LLM 客户端全局配置 */
export interface LLMClientConfig {
  /** 默认单请求超时（毫秒），可被单次调用覆盖 */
  timeout: number;
  /** 默认最大重试次数（不含首次调用） */
  maxRetries: number;
  /** 重试基础延迟（毫秒），指数退避基数 */
  retryBaseDelay: number;
  /** 默认每模型并发上限 */
  defaultMaxConcurrency: number;
  /** 每模型排队队列上限，超出直接拒绝 */
  maxQueueSize: number;
  /** fetch 实现注入点（测试/自定义运行时） */
  fetchImpl?: typeof fetch;
  /**
   * DSH 宿主请求头注入器：返回的头部会合并进每次模型调用
   * （如 Authorization），使插件无需在配置中持有 API Key。
   * keyAttempt 用于多密钥故障转移：认证/配额失败时递增，
   * 注入器可据此轮换到下一个候选密钥。
   */
  headerProvider?: (modelId: string, keyAttempt?: number) => Record<string, string> | undefined;
  /** 密钥结果回调：每次调用结束后上报成功/失败（含 HTTP 状态码），用于健康感知路由 */
  onKeyOutcome?: (modelId: string, keyAttempt: number, success: boolean, status?: number) => void;
  /**
   * DSH 宿主 LLM 客户端调用器：存在时所有模型调用委托给宿主客户端
   * （经 ctx 获取的已配置客户端），本客户端仅保留并发控制/统计/重试外壳。
   */
  externalChat?: (modelId: string, messages: ChatMessage[], options: ChatOptions) => Promise<LLMResponse>;
}

/** 单次调用选项 */
export interface ChatOptions {
  /** 覆盖超时（毫秒） */
  timeout?: number;
  /** 覆盖重试次数 */
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  /** 额外请求体字段（top_p 等） */
  extraBody?: Record<string, any>;
  /** 外部中止信号（与内部超时信号合并） */
  signal?: AbortSignal;
}

/** 调用结果 */
export interface LLMResponse {
  /** 模型输出文本 */
  content: string;
  /** 实际响应模型 id */
  model: string;
  /** 本次调用总耗时（毫秒，含重试） */
  latency: number;
  /** token 消耗（prompt + completion，端点未返回时为估算值） */
  tokensUsed: number;
  /** 成本估算（美元） */
  cost: number;
  /** 实际发生的重试次数 */
  retries: number;
}

/** 单模型运行时状态（供 model_dashboard Tool 消费） */
export interface ModelRuntimeStatus {
  id: string;
  name: string;
  endpoint: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrency: number;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatency: number;
  totalTokensUsed: number;
  totalCost: number;
  taskScores: Record<string, number>;
}

/** 模型调用错误（携带 HTTP 状态与可重试标记） */
export class LLMError extends AppError {
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false, details?: Record<string, unknown>) {
    super(message, 'LLM_ERROR', details);
    this.status = status;
    this.retryable = retryable;
  }
}

/** 默认配置 */
export const DEFAULT_LLM_CLIENT_CONFIG: LLMClientConfig = {
  timeout: 60_000,
  maxRetries: 2,
  retryBaseDelay: 500,
  defaultMaxConcurrency: 3,
  maxQueueSize: 32,
};

/** 每模型并发控制与统计 */
interface ModelState {
  config: ModelConfig;
  maxConcurrency: number;
  active: number;
  queue: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  totalTokensUsed: number;
  totalCost: number;
}

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 触发密钥轮换的状态码（认证失败 / 配额耗尽） */
const KEY_ROTATABLE_STATUS = new Set([401, 403, 429]);

/**
 * OpenAI 兼容 LLM 客户端
 *
 * 被 index.ts 持有：strategist 决策与 executor 子任务执行均通过本客户端调用。
 */
export class LLMClient {
  private config: LLMClientConfig;
  private models = new Map<string, ModelState>();
  private fetchImpl: typeof fetch;
  private disposed = false;

  constructor(config?: Partial<LLMClientConfig>) {
    this.config = { ...DEFAULT_LLM_CLIENT_CONFIG, ...config };
    this.fetchImpl = this.config.fetchImpl ?? fetch;
  }

  /**
   * 注册一个模型端点（重复注册同 id 时覆盖配置并保留统计）
   * @param model 模型配置
   */
  registerModel(model: ModelConfig): void {
    const existing = this.models.get(model.id);
    this.models.set(model.id, {
      config: model,
      maxConcurrency: model.maxConcurrency ?? this.config.defaultMaxConcurrency,
      active: 0,
      queue: existing?.queue ?? [],
      totalCalls: existing?.totalCalls ?? 0,
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      totalLatency: existing?.totalLatency ?? 0,
      totalTokensUsed: existing?.totalTokensUsed ?? 0,
      totalCost: existing?.totalCost ?? 0,
    });
  }

  /**
   * 获取已注册模型配置
   * @param modelId 模型 id
   */
  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId)?.config;
  }

  /** 所有已注册模型 id */
  getModelIds(): string[] {
    return [...this.models.keys()];
  }

  /**
   * 发起一次聊天补全调用（含并发控制、超时、重试）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 调用结果
   * @throws LLMError / TimeoutError / NetworkError
   */
  async chat(modelId: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const state = this.models.get(modelId);
    if (!state) throw new LLMError(`未注册的模型: ${modelId}`);
    if (this.disposed) throw new LLMError('LLM 客户端已关闭');

    const startedAt = Date.now();
    await this.acquireSlot(state);
    try {
      const response = await this.chatWithRetry(state, messages, options);
      state.successCount += 1;
      return response;
    } catch (err) {
      state.failureCount += 1;
      throw err;
    } finally {
      state.totalCalls += 1;
      state.totalLatency += Date.now() - startedAt;
      this.releaseSlot(state);
    }
  }

  /**
   * 发起一次调用并将输出解析为 JSON（容错代码块包裹）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 解析后的 JSON 对象与调用元数据
   */
  async chatJSON<T = any>(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<{ data: T; response: LLMResponse }> {
    const response = await this.chat(modelId, messages, options);
    const data = parseJSONLoose<T>(response.content);
    if (data === undefined) {
      throw new LLMError(`模型输出无法解析为 JSON: ${truncate(response.content, 200)}`, undefined, false, {
        modelId,
      });
    }
    return { data, response };
  }

  /**
   * 获取所有模型的运行时状态（model_dashboard Tool 数据源）
   */
  getModelStatuses(): ModelRuntimeStatus[] {
    return [...this.models.values()].map((s) => ({
      id: s.config.id,
      name: s.config.name ?? s.config.id,
      endpoint: s.config.endpoint,
      activeRequests: s.active,
      queuedRequests: s.queue.length,
      maxConcurrency: s.maxConcurrency,
      totalCalls: s.totalCalls,
      successCount: s.successCount,
      failureCount: s.failureCount,
      successRate: s.totalCalls > 0 ? s.successCount / s.totalCalls : 1,
      avgLatency: s.totalCalls > 0 ? Math.round(s.totalLatency / s.totalCalls) : 0,
      totalTokensUsed: s.totalTokensUsed,
      totalCost: Number(s.totalCost.toFixed(6)),
      taskScores: s.config.initialCapabilities?.taskScores ?? {},
    }));
  }

  /**
   * 关闭客户端：拒绝所有排队中的请求
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.models.values()) {
      for (const waiter of state.queue.splice(0)) {
        waiter.reject(new LLMError('LLM 客户端已关闭，排队请求被取消'));
      }
    }
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 获取并发槽位（必要时排队） */
  private acquireSlot(state: ModelState): Promise<void> {
    if (state.active < state.maxConcurrency) {
      state.active += 1;
      return Promise.resolve();
    }
    if (state.queue.length >= this.config.maxQueueSize) {
      return Promise.reject(
        new LLMError(`模型 ${state.config.id} 并发过载，队列已满（${this.config.maxQueueSize}）`, 429, true),
      );
    }
    return new Promise<void>((resolve, reject) => {
      state.queue.push({ resolve, reject });
    });
  }

  /** 释放并发槽位并唤醒队首 */
  private releaseSlot(state: ModelState): void {
    const next = state.queue.shift();
    if (next) {
      // 槽位移交给下一个排队者
      next.resolve();
      return;
    }
    state.active = Math.max(0, state.active - 1);
  }

  /** 带重试的调用主循环（含多密钥故障转移） */
  private async chatWithRetry(state: ModelState, messages: ChatMessage[], options: ChatOptions): Promise<LLMResponse> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    let lastError: Error | null = null;
    let keyAttempt = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = this.config.retryBaseDelay * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
        await sleep(delay);
      }
      try {
        const response = this.config.externalChat
          ? await this.config.externalChat(state.config.id, messages, options)
          : await this.chatOnce(state, messages, options, keyAttempt);
        response.retries = attempt;
        state.totalTokensUsed += response.tokensUsed;
        state.totalCost += response.cost;
        this.config.onKeyOutcome?.(state.config.id, keyAttempt, true);
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.config.onKeyOutcome?.(
          state.config.id,
          keyAttempt,
          false,
          lastError instanceof LLMError ? lastError.status : undefined,
        );
        // 认证/配额失败且存在多个候选密钥时，轮换密钥重试
        if (err instanceof LLMError && err.status !== undefined && KEY_ROTATABLE_STATUS.has(err.status)) {
          keyAttempt += 1;
        }
        const retryable =
          err instanceof TimeoutError ||
          err instanceof NetworkError ||
          (err instanceof LLMError && (err.retryable || (err.status !== undefined && KEY_ROTATABLE_STATUS.has(err.status))));
        if (!retryable || attempt >= maxRetries) break;
      }
    }
    throw lastError ?? new LLMError(`模型 ${state.config.id} 调用失败`);
  }

  /** 单次 HTTP 调用（含超时控制；keyAttempt 用于多密钥轮换） */
  private async chatOnce(state: ModelState, messages: ChatMessage[], options: ChatOptions, keyAttempt = 0): Promise<LLMResponse> {
    const { config } = state;
    const timeout = options.timeout ?? this.config.timeout;
    const url = buildCompletionsUrl(config.endpoint);
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // 合并外部中止信号
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      // 头部合并顺序：固定头 → 模型自带 Key → 宿主注入头（宿主优先，
      // 使 DSH 经 ctx 注入的 Key 覆盖本地配置）
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const hostHeaders = this.config.headerProvider?.(config.id, keyAttempt);
      if (hostHeaders) Object.assign(headers, hostHeaders);

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.id,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.extraBody ?? {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LLMError(
          `模型 ${config.id} 返回 HTTP ${res.status}: ${truncate(body, 200)}`,
          res.status,
          RETRYABLE_STATUS.has(res.status),
        );
      }

      const json: any = await res.json();
      const content: string = json?.choices?.[0]?.message?.content ?? '';
      const usage = json?.usage;
      const tokensUsed: number =
        typeof usage?.total_tokens === 'number' ? usage.total_tokens : estimateTokens(messages, content);
      const costPerKToken = config.costPerKToken ?? 0;

      return {
        content,
        model: json?.model ?? config.id,
        latency: Date.now() - startedAt,
        tokensUsed,
        cost: (tokensUsed / 1000) * costPerKToken,
        retries: 0,
      };
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if ((err as any)?.name === 'AbortError') {
        throw new TimeoutError(`模型 ${config.id} 调用超时（${timeout}ms）`, { modelId: config.id, timeout });
      }
      throw new NetworkError(`模型 ${config.id} 网络错误: ${(err as Error)?.message ?? String(err)}`, {
        modelId: config.id,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * 宽松 JSON 解析：剥离 Markdown 代码块包裹，截取首个完整 JSON 片段
 * @param text 模型原始输出
 * @returns 解析结果，失败返回 undefined
 */
export function parseJSONLoose<T = any>(text: string): T | undefined {
  if (!text) return undefined;
  let candidate = text.trim();

  // 剥离 ```json ... ``` 包裹
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  // 直接尝试
  try {
    return JSON.parse(candidate) as T;
  } catch {
    /* 继续兜底 */
  }

  // 截取首个 { ... } 或 [ ... ] 片段（括号配对扫描）
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = candidate.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

/** 拼接 chat/completions 端点 URL */
function buildCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 粗略 token 估算（端点未返回 usage 时兜底：约 4 字符/token） */
function estimateTokens(messages: ChatMessage[], content: string): number {
  const inputChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil((inputChars + content.length) / 4);
}

/** 截断字符串用于错误信息 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 可中止的 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
