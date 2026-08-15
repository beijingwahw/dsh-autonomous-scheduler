/**
 * errors.ts — 统一错误体系（AppError）
 *
 * 架构文档要求：所有模块的错误处理使用统一的 AppError 体系。
 * 每个子类携带稳定的机器可读 code，便于 Tool 层与日志层统一消费。
 */

/** 应用错误基类，所有业务错误的根类型 */
export class AppError extends Error {
  /** 机器可读错误码，如 CRYPTO_ERROR / MEMORY_ERROR */
  public readonly code: string;
  /** 附加上下文信息（不含敏感数据） */
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'APP_ERROR', details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** 配置错误：cordis.yml / 租户配置非法或缺失 */
export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
  }
}

/** 加密错误：加解密失败、密钥无效、加密功能未启用 */
export class CryptoError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CRYPTO_ERROR', details);
  }
}

/** 记忆错误：持久化读写失败、记忆库损坏 */
export class MemoryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'MEMORY_ERROR', details);
  }
}

/** 网络错误：WebSocket / HTTP / 节点间通信失败 */
export class NetworkError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', details);
  }
}

/** 超时错误：模型调用或任务执行超过时限 */
export class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TIMEOUT_ERROR', details);
  }
}
