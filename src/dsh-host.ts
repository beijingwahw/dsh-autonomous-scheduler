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
 * 由 index.ts 回退到 cordis.yml 中的 models 配置。
 */

import fs from 'node:fs';
import os from 'node:os';
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

/** 读取并缓存本地配置文件（只读一次，失败静默） */
let localConfigCache: any | null | undefined;
function loadLocalConfig(): any | null {
  if (localConfigCache !== undefined) return localConfigCache;
  for (const rawPath of LOCAL_CONFIG_PATHS) {
    const filePath = rawPath.startsWith('~') ? rawPath.replace('~', os.homedir()) : rawPath;
    try {
      localConfigCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return localConfigCache;
    } catch {
      /* 路径不存在或解析失败，继续下一个 */
    }
  }
  localConfigCache = null;
  return null;
}

/**
 * 本地密钥提供器：自动从宿主本地来源读取 Key 并填入 Authorization 请求头。
 * 查找顺序（首个命中即用）：
 * 1. 进程环境变量（按模型 id 前缀匹配厂商，如 DEEPSEEK_API_KEY）；
 * 2. DSH 本地配置文件（~/.dsh/config.json 等，用户在 Web UI 配置的落盘位置）。
 * 密钥只进内存、不落盘、不打印日志。
 * @returns 按 modelId 返回请求头的函数；无任何本地来源时仍返回函数（返回 undefined 头）
 */
export function resolveLocalKeyProvider(): (modelId: string) => Record<string, string> | undefined {
  return (modelId) => {
    const envKey = envKeyForModel(modelId);
    if (envKey) return { Authorization: `Bearer ${envKey}` };
    const fileKey = findApiKeyInConfig(loadLocalConfig(), modelId);
    if (fileKey) return { Authorization: `Bearer ${fileKey}` };
    return undefined;
  };
}
