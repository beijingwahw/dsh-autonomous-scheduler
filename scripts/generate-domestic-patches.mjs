/**
 * generate-domestic-patches.mjs — 自动生成全部国产模型的 cordis patch YML
 *
 * 用法：node scripts/generate-domestic-patches.mjs
 * 输出：patches/domestic-models/<vendor>.yml（每厂商一个）+ all-domestic.yml（全量合并）
 *
 * 设计原则：patch 中**不含任何 apiKey**。DSH 会根据用户在 Web UI / 环境变量
 * （见各文件头部注释中的变量名）中的配置，自动把 Key 注入请求头。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../patches/domestic-models');

/** 国产模型目录：vendor → 端点 / 环境变量 / 模型清单 */
const VENDORS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    endpoint: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    strategist: 'deepseek-v4-pro',
    models: [
      { id: 'deepseek-v4-pro', timeout: 90000, maxConcurrency: 3, costPerKToken: 0.014, contextWindow: 128000, taskScores: { 'code-generation': 0.9, architecture: 0.85, debugging: 0.85, refactoring: 0.8 } },
      { id: 'deepseek-v4-flash', timeout: 30000, maxConcurrency: 5, costPerKToken: 0.002, contextWindow: 128000, taskScores: { documentation: 0.8, 'test-generation': 0.75, general: 0.7 } },
    ],
  },
  {
    id: 'qwen',
    label: '通义千问 Qwen（阿里云 DashScope）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVar: 'DASHSCOPE_API_KEY',
    strategist: 'qwen-max',
    models: [
      { id: 'qwen-max', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.02, contextWindow: 32768, taskScores: { general: 0.85, analysis: 0.85, documentation: 0.8 } },
      { id: 'qwen-plus', timeout: 45000, maxConcurrency: 5, costPerKToken: 0.004, contextWindow: 131072, taskScores: { general: 0.75, documentation: 0.8, 'test-generation': 0.7 } },
      { id: 'qwen-turbo', timeout: 30000, maxConcurrency: 8, costPerKToken: 0.001, contextWindow: 1000000, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    strategist: 'glm-4.5',
    models: [
      { id: 'glm-4.5', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.004, contextWindow: 128000, taskScores: { 'code-generation': 0.8, general: 0.8, analysis: 0.8 } },
      { id: 'glm-4-flash', timeout: 30000, maxConcurrency: 8, costPerKToken: 0, contextWindow: 128000, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    strategist: 'moonshot-v1-128k',
    models: [
      { id: 'moonshot-v1-128k', timeout: 90000, maxConcurrency: 3, costPerKToken: 0.008, contextWindow: 131072, taskScores: { analysis: 0.85, documentation: 0.8, general: 0.75 } },
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    endpoint: 'https://api.minimax.chat/v1',
    envVar: 'MINIMAX_API_KEY',
    strategist: 'abab6.5s-chat',
    models: [
      { id: 'abab6.5s-chat', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.005, contextWindow: 245760, taskScores: { general: 0.7, documentation: 0.7 } },
    ],
  },
  {
    id: 'spark',
    label: '讯飞星火 Spark',
    endpoint: 'https://spark-api-open.xf-yun.com/v1',
    envVar: 'SPARK_API_KEY',
    strategist: 'generalv4.0',
    models: [
      { id: 'generalv4.0', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.005, contextWindow: 8192, taskScores: { general: 0.75, documentation: 0.7 } },
      { id: 'generalv3.5', timeout: 45000, maxConcurrency: 5, costPerKToken: 0.003, contextWindow: 8192, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'hunyuan',
    label: '腾讯混元 Hunyuan',
    endpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    envVar: 'HUNYUAN_API_KEY',
    strategist: 'hunyuan-pro',
    models: [
      { id: 'hunyuan-pro', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.01, contextWindow: 65536, taskScores: { general: 0.8, analysis: 0.8 } },
      { id: 'hunyuan-turbo', timeout: 30000, maxConcurrency: 5, costPerKToken: 0.003, contextWindow: 32768, taskScores: { general: 0.7 } },
    ],
  },
  {
    id: 'ernie',
    label: '百度文心 ERNIE（千帆）',
    endpoint: 'https://qianfan.baidubce.com/v2',
    envVar: 'QIANFAN_API_KEY',
    strategist: 'ernie-4.0-8k',
    models: [
      { id: 'ernie-4.0-8k', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.017, contextWindow: 8192, taskScores: { general: 0.8, documentation: 0.75 } },
      { id: 'ernie-speed-128k', timeout: 30000, maxConcurrency: 8, costPerKToken: 0, contextWindow: 131072, taskScores: { general: 0.65 } },
    ],
  },
  {
    id: 'sensechat',
    label: '商汤日日新 SenseChat',
    endpoint: 'https://api.sensenova.cn/v1',
    envVar: 'SENSENOVA_API_KEY',
    strategist: 'sensechat-5',
    models: [
      { id: 'sensechat-5', timeout: 60000, maxConcurrency: 3, costPerKToken: 0.006, contextWindow: 128000, taskScores: { general: 0.7, analysis: 0.7 } },
    ],
  },
];

/** 渲染单个模型条目（不含 apiKey） */
function renderModel(model, indent) {
  const pad = ' '.repeat(indent);
  const lines = [
    `${pad}- id: ${model.id}`,
    `${pad}  endpoint: ${VENDORS_CURRENT.endpoint}`,
    `${pad}  timeout: ${model.timeout}`,
    `${pad}  maxConcurrency: ${model.maxConcurrency}`,
    `${pad}  costPerKToken: ${model.costPerKToken}`,
    `${pad}  contextWindow: ${model.contextWindow}`,
    `${pad}  initialCapabilities:`,
    `${pad}    taskScores:`,
    ...Object.entries(model.taskScores).map(([task, score]) => `${pad}      ${task}: ${score}`),
  ];
  return lines.join('\n');
}

let VENDORS_CURRENT = null;

/** 渲染一个厂商的 patch 文件内容 */
function renderVendorPatch(vendor) {
  VENDORS_CURRENT = vendor;
  const modelBlocks = vendor.models.map((m) => renderModel(m, 6)).join('\n');
  return `# ${vendor.label} — cordis patch（国产模型）
# Key 由 DSH 自动注入请求头：在 Web UI 或环境变量 ${vendor.envVar} 中配置即可，本文件不含任何密钥。
# 用法：将本文件内容合并进 cordis.yml，或经 DSH patch 机制加载。
- name: dsh-autonomous-scheduler
  config:
    strategistModel:
      id: ${vendor.strategist}
      endpoint: ${vendor.endpoint}
    models:
${modelBlocks}
`;
}

/** 渲染全量合并 patch */
function renderAllPatch() {
  const allModels = [];
  for (const vendor of VENDORS) {
    VENDORS_CURRENT = vendor;
    for (const m of vendor.models) allModels.push(renderModel(m, 6));
  }
  return `# 全部国产模型 — cordis patch（合并版）
# 覆盖厂商：${VENDORS.map((v) => v.id).join(' / ')}
# Key 由 DSH 自动注入请求头（各厂商对应环境变量见各单厂商 patch 文件），本文件不含任何密钥。
- name: dsh-autonomous-scheduler
  config:
    strategistModel:
      id: deepseek-v4-pro
      endpoint: https://api.deepseek.com
    models:
${allModels.join('\n')}
`;
}

/** 渲染根目录 cordis patch YML（封装全部国产模型 + 运行配置，零密钥） */
function renderRootPatch() {
  const allModels = [];
  for (const vendor of VENDORS) {
    VENDORS_CURRENT = vendor;
    for (const m of vendor.models) allModels.push(renderModel(m, 6));
  }
  return `# cordis patch — dsh-autonomous-scheduler（开箱即用，零手动配置）
# 已封装全部国产模型：${VENDORS.map((v) => v.id).join(' / ')}
# 无需填写任何 apiKey：插件经 ctx 获取 DSH 已配置的 LLM 客户端，
# DSH 自动把用户配置的 Key（Web UI / 环境变量）注入请求头。
- name: dsh-autonomous-scheduler
  config:
    strategistModel:
      id: deepseek-v4-pro
      endpoint: https://api.deepseek.com
    models:
${allModels.join('\n')}
    sentinel:
      watchCodeChanges: true
      watchErrors: true
      watchPerformance: true
      aggregationWindow: 5
    qualityThreshold: 0.7
    maxRetries: 2
    globalTimeout: 300000
    enableProgress: true
    progressPort: 9877
    verbose: true
    experienceStorePath: .scheduler/memory.json
    encryption:
      enabled: false
      algorithm: aes-256-gcm
      fullFileEncryption: true
    sync:
      localNodeId: "node-dev-01"
      peers: []
    consensus:
      enabled: false
      localNodeId: "node-01"
      consensusPort: 9880
      electionTimeoutMin: 1500
      electionTimeoutMax: 3000
      heartbeatInterval: 500
      cluster: []
    hotReload:
      enabled: false
      watchDirs: [src]
      watchExtensions: [.ts, .tsx, .js]
      debounceMs: 1000
      buildCommand: pnpm build
      autoRollback: true
    tenants: []
`;
}

fs.mkdirSync(outDir, { recursive: true });
let count = 0;
for (const vendor of VENDORS) {
  fs.writeFileSync(path.join(outDir, `${vendor.id}.yml`), renderVendorPatch(vendor));
  count += 1;
}
fs.writeFileSync(path.join(outDir, 'all-domestic.yml'), renderAllPatch());
// 根目录 cordis.yml 同步升级为封装全部国产模型的 patch YML（零密钥、开箱即用）
fs.writeFileSync(path.resolve(__dirname, '../cordis.yml'), renderRootPatch());
console.log(`已生成 ${count} 个厂商 patch + all-domestic.yml → ${outDir}，并升级根目录 cordis.yml`);
