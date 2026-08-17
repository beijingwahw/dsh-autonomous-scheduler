/**
 * dsh-host.ts — DSH 宿主集成层
 *
 * 职责：经 cordis ctx 上下文解析 DSH 宿主提供的 LLM 能力，
 * 使插件无需在配置中携带任何 API Key：
 *
 * 1. resolveHostLLM(ctx)：优先获取宿主已配置好的 LLM 客户端
 *    （服务名 llmClient / llm / modelClient / dsh.llm），委托全部模型调用；
 * 2. resolveHostModels(ctx)：获取宿主模型目录（llmModels / models / dsh.models），
 *    用于在宿主未提供客户端时注册端点（Key 由头部注入器提供）；
 * 3. resolveHeaderProvider(ctx)：获取宿主请求头注入器
 *    （llmHeaders / dsh.llmHeaders / 函数型 llmHeaderProvider），
 *    DSH 会把用户在 Web UI / 环境变量中配置的 Key 注入请求头。
 *
 * 解析顺序遵循"宿主优先、配置兜底"：任何一项解析失败都不阻断插件启动，
 * 由 index.ts 回退到 cordis.patch.yml 中的 models 配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatMessage, ChatOptions, LLMResponse, ModelConfig } from './llm-client.js';

/** 宿主 LLM 客户端的最小调用面（chat / complete / call 任一即可） */
export interface HostLLMClientLike {
  chat?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
  complete?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
  call?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
}

/** 宿主模型目录条目的宽松形态 */
interface HostModelEntry {
  id?: string;
  name?: string;
  model?: string;
  endpoint?: string;
  baseUrl?: string;
  base_url?: string;
  timeout?: number;
  maxConcurrency?: number;
  costPerKToken?: number;
  contextWindow?: number;
  initialCapabilities?: ModelConfig['initialCapabilities'];
}

/** 从 ctx 安全读取服务（不存在返回 undefined，不抛错） */
function tryGet(ctx: Context, name: string): any {
  try {
    return (ctx as any).get?.(name);
  } catch {
    return undefined;
  }
}

/** 归一化宿主客户端的返回值为 LLMResponse */
function normalizeResponse(raw: any, modelId: string): LLMResponse {
  return {
    content: typeof raw?.content === 'string' ? raw.content : '',
    model: raw?.model ?? modelId,
    latency: typeof raw?.latency === 'number' ? raw.latency : 0,
    tokensUsed: typeof raw?.tokensUsed === 'number' ? raw.tokensUsed : 0,
    cost: typeof raw?.cost === 'number' ? raw.cost : 0,
    retries: typeof raw?.retries === 'number' ? raw.retries : 0,
  };
}

/**
 * 解析宿主已配置的 LLM 客户端。
 * @returns 统一的调用器；宿主未提供时返回 undefined
 */
export function resolveHostLLM(
  ctx: Context,
): ((modelId: string, messages: ChatMessage[], options: ChatOptions) => Promise<LLMResponse>) | undefined {
  const candidates = [tryGet(ctx, 'llmClient'), tryGet(ctx, 'llm'), tryGet(ctx, 'modelClient'), tryGet(ctx, 'dsh.llm')];
  for (const client of candidates) {
    if (!client || typeof client !== 'object') continue;
    const host = client as HostLLMClientLike;
    const fn = host.chat ?? host.complete ?? host.call;
    if (typeof fn === 'function') {
      return async (modelId, messages, options) =>
        normalizeResponse(await fn.call(host, modelId, messages, options), modelId);
    }
  }
  return undefined;
}

/**
 * 解析宿主模型目录为插件 ModelConfig 列表（不含 Key）。
 * @returns 模型配置数组；宿主未提供时返回空数组
 */
export function resolveHostModels(ctx: Context): ModelConfig[] {
  const raw = tryGet(ctx, 'llmModels') ?? tryGet(ctx, 'models') ?? tryGet(ctx, 'dsh.models');
  if (!Array.isArray(raw)) return [];

  const models: ModelConfig[] = [];
  for (const entry of raw as HostModelEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id ?? entry.model ?? entry.name;
    const endpoint = entry.endpoint ?? entry.baseUrl ?? entry.base_url;
    if (!id || !endpoint) continue;
    models.push({
      id,
      name: entry.name,
      endpoint,
      timeout: entry.timeout,
      maxConcurrency: entry.maxConcurrency,
      costPerKToken: entry.costPerKToken,
      contextWindow: entry.contextWindow,
      initialCapabilities: entry.initialCapabilities,
    });
  }
  return models;
}

/**
 * 解析宿主请求头注入器（DSH 将用户配置的 Key 注入请求头）。
 * @returns 按 modelId 返回头部的函数；宿主未提供时返回 undefined
 */
export function resolveHeaderProvider(
  ctx: Context,
): ((modelId: string) => Record<string, string> | undefined) | undefined {
  const direct = tryGet(ctx, 'llmHeaderProvider');
  if (typeof direct === 'function') return direct;

  const provider = tryGet(ctx, 'llmHeaders') ?? tryGet(ctx, 'dsh.llmHeaders');
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider === 'object') {
    // 静态头部表：{ [modelId]: { Authorization: 'Bearer xxx' } } 或全局头部
    const table = provider as Record<string, any>;
    return (modelId) => {
      const perModel = table[modelId];
      if (perModel && typeof perModel === 'object') return perModel;
      if (table.Authorization || table.authorization) return table as Record<string, string>;
      return undefined;
    };
  }
  return undefined;
}

// ─────────────────────────── 本地密钥自动填入 ───────────────────────────

/** 厂商识别规则：模型 id 前缀 → 环境变量候选列表 */
const VENDOR_ENV_VARS: Array<{ match: RegExp; envVars: string[] }> = [
  { match: /^deepseek/i, envVars: ['DEEPSEEK_API_KEY'] },
  { match: /^qwen|^qwq/i, envVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ALIBABA_CLOUD_API_KEY'] },
  { match: /^glm|^chatglm/i, envVars: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'] },
  { match: /^moonshot|^kimi/i, envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { match: /^abab/i, envVars: ['MINIMAX_API_KEY'] },
  { match: /^general|^spark/i, envVars: ['SPARK_API_KEY', 'IFLYTEK_API_KEY', 'XFYUN_API_KEY'] },
  { match: /^hunyuan/i, envVars: ['HUNYUAN_API_KEY', 'TENCENT_HUNYUAN_API_KEY'] },
  { match: /^ernie/i, envVars: ['QIANFAN_API_KEY', 'ERNIE_API_KEY', 'BAIDU_API_KEY'] },
  { match: /^sensechat|^sense/i, envVars: ['SENSENOVA_API_KEY', 'SENSETIME_API_KEY'] },
];

/** DSH 本地配置文件探测路径（宿主在本地保存用户 Web UI 配置的常见位置） */
const LOCAL_CONFIG_PATHS = [
  '~/.dsh/config.json',
  '~/.dsh/llm.json',
  '~/.config/dsh/config.json',
  '~/.config/dsh/llm.json',
  '~/.deepseek-harness/config.json',
];

/** 按模型 id 识别厂商环境变量并返回首个非空值 */
function envKeyForModel(modelId: string): string | undefined {
  for (const rule of VENDOR_ENV_VARS) {
    if (!rule.match.test(modelId)) continue;
    for (const envVar of rule.envVars) {
      const value = process.env[envVar];
      if (value) return value;
    }
  }
  return undefined;
}

/** 深度优先查找对象中的 apiKey 字段（兼容 models 数组 / 厂商键两种形态） */
function findApiKeyInConfig(obj: any, modelId: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;

  // models 数组形态：[{ id, apiKey }]
  if (Array.isArray(obj.models)) {
    for (const entry of obj.models) {
      if (entry?.id === modelId && typeof entry.apiKey === 'string' && entry.apiKey) return entry.apiKey;
    }
  }

  // 精确模型键：{ "deepseek-v4-pro": { apiKey } } 或 { "deepseek-v4-pro": "sk-..." }
  const exact = obj[modelId];
  if (typeof exact === 'string' && exact) return exact;
  if (exact && typeof exact === 'object' && typeof exact.apiKey === 'string' && exact.apiKey) return exact.apiKey;

  // 厂商键：{ deepseek: { apiKey } } / { deepseek: "sk-..." }
  for (const rule of VENDOR_ENV_VARS) {
    if (!rule.match.test(modelId)) continue;
    for (const vendorKey of rule.envVars[0].replace(/_API_KEY$/, '').toLowerCase().split('_').slice(0, 1)) {
      const entry = obj[vendorKey];
      if (typeof entry === 'string' && entry) return entry;
      if (entry && typeof entry === 'object' && typeof entry.apiKey === 'string' && entry.apiKey) return entry.apiKey;
    }
  }

  // 全局兜底：{ apiKey } / { llm: { apiKey } }
  if (typeof obj.apiKey === 'string' && obj.apiKey) return obj.apiKey;
  if (obj.llm && typeof obj.llm === 'object') return findApiKeyInConfig(obj.llm, modelId);
  return undefined;
}

/** 本地配置文件发现/缓存状态（支持热更新：mtime 变化自动重读） */
let localConfigCache: any | null | undefined;
let localConfigPath: string | null | undefined;
let localConfigMtime = 0;
let localConfigMissAt = 0;
/** 未找到配置文件时的重新探测间隔（Web UI 后续写入也能被感知） */
const LOCAL_CONFIG_RETRY_MS = 60_000;

/** 探测首个可读的本地配置文件路径 */
function discoverLocalConfigPath(): string | null {
  for (const rawPath of LOCAL_CONFIG_PATHS) {
    const filePath = rawPath.startsWith('~') ? rawPath.replace('~', os.homedir()) : rawPath;
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return filePath;
    } catch {
      /* 路径不存在，继续下一个 */
    }
  }
  return null;
}

/** 读取本地配置文件（mtime 热更新 + 缺失时定期重探测，失败静默） */
function loadLocalConfig(): any | null {
  const now = Date.now();
  if (localConfigPath === undefined) {
    localConfigPath = discoverLocalConfigPath();
    if (!localConfigPath) localConfigMissAt = now;
  } else if (!localConfigPath && now - localConfigMissAt > LOCAL_CONFIG_RETRY_MS) {
    localConfigPath = discoverLocalConfigPath();
    if (!localConfigPath) localConfigMissAt = now;
  }
  if (!localConfigPath) return localConfigCache ?? null;
  try {
    const stat = fs.statSync(localConfigPath);
    if (localConfigCache === undefined || stat.mtimeMs !== localConfigMtime) {
      localConfigCache = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      localConfigMtime = stat.mtimeMs;
    }
    return localConfigCache;
  } catch {
    localConfigPath = undefined; // 文件被删/不可读，下次重新探测
    return localConfigCache ?? null;
  }
}

/**
 * 本地密钥候选列表（按优先级排序，支持多密钥故障转移）：
 * 1. 进程环境变量（按模型 id 前缀匹配厂商，多个候选变量依次排列）；
 * 2. DSH 本地配置文件（~/.dsh/config.json 等，用户在 Web UI 配置的落盘位置）。
 * @returns 带来源标记的密钥候选数组（可能为空）
 */
export function resolveLocalKeyCandidates(modelId: string): Array<{ source: string; key: string }> {
  const candidates: Array<{ source: string; key: string }> = [];
  const rule = VENDOR_ENV_VARS.find((r) => r.match.test(modelId));
  if (rule) {
    for (const envVar of rule.envVars) {
      const value = process.env[envVar];
      if (value) candidates.push({ source: `env:${envVar}`, key: value });
    }
  }
  const fileKey = findApiKeyInConfig(loadLocalConfig(), modelId);
  if (fileKey) candidates.push({ source: 'local-config', key: fileKey });
  return candidates;
}

/**
 * 本地密钥提供器：自动从宿主本地来源读取 Key 并填入 Authorization 请求头。
 * keyAttempt 用于故障转移：认证/配额失败时 LLMClient 递增 attempt。
 * 传入 manager 时启用健康感知路由（按健康度选择 + 冷却规避），
 * 否则退化为顺序轮换。密钥只进内存、不落盘、不打印日志。
 * @returns 按 (modelId, keyAttempt) 返回请求头的函数
 */
export function resolveLocalKeyProvider(
  manager?: KeyHealthManager,
): (modelId: string, keyAttempt?: number) => Record<string, string> | undefined {
  return (modelId, keyAttempt = 0) => {
    const candidates = resolveLocalKeyCandidates(modelId);
    if (candidates.length === 0) return undefined;
    const pick = manager
      ? manager.pick(modelId, keyAttempt, candidates)
      : candidates[Math.min(keyAttempt, candidates.length - 1)];
    return pick ? { Authorization: `Bearer ${pick.key}` } : undefined;
  };
}

/** 密钥来源可观测性：返回某模型可用的密钥来源标识（不含密钥值） */
export function describeKeySources(modelId: string): string[] {
  return resolveLocalKeyCandidates(modelId).map((c) => c.source);
}

// ─────────────────────────── 密钥健康感知路由 ───────────────────────────

/** 单密钥健康状态（不含密钥值） */
export interface KeyHealthStatus {
  source: string;
  successes: number;
  failures: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  lastErrorStatus?: number;
}

/**
 * 密钥健康管理器：把"顺序轮换"升级为"健康感知路由"。
 * - 用户顺序：用户可通过 setKeyOrder 指定密钥来源优先级（持久化，重启保留）；
 * - 选择策略：用户序优先 → 冷却规避 → 失败次数少 → 成功次数多；
 * - 冷却策略：429（配额/限流）冷却 1 分钟，401/403（认证）冷却 5 分钟；
 * - 成功即清零失败计数并解除冷却；
 * - 并发安全：按 (modelId, attempt) 记录每次选择，失败结果精确归因到所用密钥。
 */
export class KeyHealthManager {
  private health = new Map<string, KeyHealthStatus & { cooldownUntil: number }>();
  private lastPicks = new Map<string, string>();
  /** 用户自定义密钥来源优先级（来源标识数组，靠前优先） */
  private userOrder: string[] = [];
  private persistPath?: string;

  constructor(private readonly cooldownMs = 60_000, persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) this.loadOrder();
  }

  /** 设置用户密钥顺序（持久化） */
  setKeyOrder(order: string[]): void {
    this.userOrder = [...order];
    this.saveOrder();
  }

  /** 获取当前用户密钥顺序 */
  getKeyOrder(): string[] {
    return [...this.userOrder];
  }

  /** 清除用户顺序，恢复默认（环境变量序 → 本地配置） */
  clearKeyOrder(): void {
    this.userOrder = [];
    this.saveOrder();
  }

  private loadOrder(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistPath!, 'utf8'));
      if (Array.isArray(parsed.order)) this.userOrder = parsed.order.filter((s: unknown) => typeof s === 'string');
    } catch {
      /* 首次启动或文件损坏，使用默认顺序 */
    }
  }

  private saveOrder(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ order: this.userOrder }, null, 2));
    } catch {
      /* 持久化失败不影响运行时顺序 */
    }
  }

  private entry(source: string): KeyHealthStatus & { cooldownUntil: number } {
    let e = this.health.get(source);
    if (!e) {
      e = { source, successes: 0, failures: 0, coolingDown: false, cooldownRemainingMs: 0, cooldownUntil: 0 };
      this.health.set(source, e);
    }
    return e;
  }

  /** 为某次调用选择最优候选密钥（用户序优先，冷却规避；attempt>0 时排除上一次刚失败的来源） */
  pick(
    modelId: string,
    attempt: number,
    candidates: Array<{ source: string; key: string }>,
  ): { source: string; key: string } | undefined {
    if (candidates.length === 0) return undefined;
    const now = Date.now();
    const prev = attempt > 0 ? this.lastPicks.get(`${modelId}#${attempt - 1}`) : undefined;

    const orderIndex = (source: string) => {
      const idx = this.userOrder.indexOf(source);
      return idx === -1 ? this.userOrder.length : idx;
    };
    const scored = candidates.map((c) => ({ ...c, h: this.entry(c.source) }));
    // 综合排序：冷却中最后 → 用户序靠前 → 失败少 → 成功多
    const rank = (x: (typeof scored)[number]) =>
      (x.h.cooldownUntil <= now ? 0 : 1) * 10_000 + orderIndex(x.source) * 100 + x.h.failures - Math.min(x.h.successes, 100) / 1000;
    const rotated = scored.filter((c) => c.source !== prev);
    const pool = rotated.length > 0 ? rotated : scored;
    pool.sort((a, b) => rank(a) - rank(b));

    const chosen = pool[0];
    this.lastPicks.set(`${modelId}#${attempt}`, chosen.source);
    return { source: chosen.source, key: chosen.key };
  }

  /** 上报调用结果：成功清零失败；429/401/403 进入冷却 */
  recordOutcome(modelId: string, attempt: number, success: boolean, status?: number): void {
    const source = this.lastPicks.get(`${modelId}#${attempt}`);
    if (!source) return;
    const e = this.entry(source);
    if (success) {
      e.successes += 1;
      e.failures = 0;
      e.cooldownUntil = 0;
      e.coolingDown = false;
      e.cooldownRemainingMs = 0;
      return;
    }
    e.failures += 1;
    e.lastErrorStatus = status;
    if (status === 429) e.cooldownUntil = Date.now() + this.cooldownMs;
    else if (status === 401 || status === 403) e.cooldownUntil = Date.now() + this.cooldownMs * 5;
  }

  /** 全部密钥的健康汇总（供 query_memory 的 keys 查询） */
  status(): KeyHealthStatus[] {
    const now = Date.now();
    return [...this.health.values()].map((e) => ({
      source: e.source,
      successes: e.successes,
      failures: e.failures,
      coolingDown: e.cooldownUntil > now,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
      lastErrorStatus: e.lastErrorStatus,
    }));
  }
}
