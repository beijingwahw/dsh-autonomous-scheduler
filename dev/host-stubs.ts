/**
 * 开发期宿主服务桩（仅 `npm run dev` 的独立 cordis 进程使用，不参与构建产物）。
 *
 * dsh-proactive 经 duck-typing 探测宿主 `tools` 服务（ctx.get('tools')）并桥接
 * 14 个内部 Tool；独立 cordis 进程无该服务时会静默降级为纯内部模式。
 * 提供此桩让开发进程走完整桥接链路（更接近 dsh 运行时形态）：
 * register 返回函数型 disposer（桥接代码会 `typeof dispose === 'function'` 检查）。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dev-host-stubs'

export function apply(ctx: Context): void {
  const registered = new Set<string>()
  ctx.provide('tools', {
    /** 记录注册名并返回函数型 disposer（对齐 dsh ToolRegistry 契约）。 */
    register(def: { name: string }) {
      registered.add(def.name)
      return () => {
        registered.delete(def.name)
      }
    },
    /** 已注册工具名快照（调试观察用）。 */
    list: () => [...registered],
  })
}
