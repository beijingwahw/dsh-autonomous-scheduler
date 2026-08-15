/**
 * dashboard/index.ts — 实时仪表盘服务端（集成层前端组件）
 *
 * 职责：将自包含的仪表盘页面挂载到 ProgressBroadcaster 的 HTTP 端口
 * - GET /            → 仪表盘页面（内嵌 WebSocket 客户端，自动重连）
 * - GET /api/model-status → 模型运行时状态 JSON（5s 轮询数据源）
 * - 其余请求        → 交回 progress-ws 默认健康检查
 *
 * 设计约束：零第三方依赖、零外部静态资源，单 HTML 文件随插件打包。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProgressBroadcaster } from '../progress-ws.js';
import type { ModelRuntimeStatus } from '../llm-client.js';

/**
 * 将仪表盘挂载到进度广播器的 HTTP 端口
 * @param broadcaster 已创建的进度广播器（须在 start() 之前或之后调用均可）
 * @param getModelStatuses 模型状态提供函数（通常绑定 LLMClient.getModelStatuses）
 * @returns 卸载函数（恢复默认健康检查响应）
 */
export function attachDashboard(
  broadcaster: ProgressBroadcaster,
  getModelStatuses: () => ModelRuntimeStatus[],
): () => void {
  const html = loadDashboardHtml();

  broadcaster.setHttpHandler((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return true;
    }

    if (req.method === 'GET' && url === '/api/model-status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(getModelStatuses()));
      return true;
    }

    return false;
  });

  return () => broadcaster.setHttpHandler(null);
}

/** 读取仪表盘页面（优先 dist 打包路径，回退 src 源码路径） */
function loadDashboardHtml(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'index.html'),
    path.join(here, '..', '..', 'src', 'dashboard', 'index.html'),
    path.join(here, '..', 'src', 'dashboard', 'index.html'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf-8');
    } catch {
      /* 尝试下一个候选路径 */
    }
  }
  return '<html><body><h1>dashboard 页面未找到</h1></body></html>';
}
