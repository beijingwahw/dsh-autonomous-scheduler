/**
 * progress-ws.ts — WebSocket 进度广播器（基础层，无内部依赖）
 *
 * 职责：向前端 Dashboard 实时广播执行链路的 13 种进度事件
 * （signal-received / batch-start / strategist-thinking / plan-start /
 *   node-start / node-complete / node-error / node-reflect /
 *   cascade-trigger / plan-complete / role-change / plugin-reloaded / connected）
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 零第三方依赖：基于 node:http + node:crypto 原生实现 RFC 6455 服务端，
 *    严格遵守"仅使用已声明依赖"的架构约束（不需要 ws 包）
 * 2. 连接即回放：新客户端连接后先回放最近 N 条事件环形缓冲，再收 connected，
 *    Dashboard 刷新后不丢失执行上下文
 * 3. 心跳保活：30s 服务端 ping + 死连接回收，防止半开连接堆积
 * 4. 背压保护：单连接写缓冲超限时主动断开慢客户端，避免拖垮广播循环
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { NetworkError } from './errors.js';

/** 进度事件（type 为附录协议中的 13 种事件名，可自由扩展） */
export interface ProgressEvent {
  type: string;
  timestamp: number;
  [key: string]: any;
}

/** WebSocket 握手魔数（RFC 6455 §4.2.2） */
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 回放缓冲上限 */
const REPLAY_BUFFER_SIZE = 50;
/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 单连接写缓冲上限（字节），超限视为慢客户端 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** 内部连接记录 */
interface WsConnection {
  socket: import('node:net').Socket;
  /** 是否已完成关闭握手 */
  closed: boolean;
}

/**
 * WebSocket 进度广播器
 *
 * 独立监听一个 HTTP 端口并升级为 WebSocket 服务。
 * 被 index.ts 集成层持有，执行链路各阶段调用 broadcast() 推送事件。
 */
export class ProgressBroadcaster {
  private port: number;
  private server: http.Server | null = null;
  private connections = new Set<WsConnection>();
  /** 环形回放缓冲 */
  private replayBuffer: ProgressEvent[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 可选 HTTP 请求处理器（dashboard 等静态页面复用本端口；返回 true 表示已响应） */
  private httpHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null = null;

  /**
   * @param port 监听端口，默认 9877（与 cordis.yml progressPort 一致）
   */
  constructor(port: number = 9877) {
    this.port = port;
  }

  /**
   * 注册 HTTP 请求处理器（非 WebSocket 升级请求优先交给它）
   * @param handler 返回 true 表示已处理该请求；返回 false 走默认健康检查响应
   */
  setHttpHandler(handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null): void {
    this.httpHandler = handler;
  }

  /**
   * 启动 WebSocket 服务
   * @throws NetworkError 端口被占用或监听失败时（通过异步错误事件抛出）
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.server = http.createServer((req, res) => {
      // 优先交给自定义 HTTP 处理器（dashboard 页面等）
      if (this.httpHandler && this.httpHandler(req, res)) return;
      // 非升级请求返回健康检查信息
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'dsh-autonomous-scheduler/progress-ws',
          clients: this.connections.size,
          bufferedEvents: this.replayBuffer.length,
        }),
      );
    });

    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as import('node:net').Socket));
    this.server.on('error', (err) => {
      throw new NetworkError(`进度广播服务异常: ${err.message}`, { port: this.port });
    });

    this.server.listen(this.port);

    // 心跳：定期 ping 所有客户端，回收无响应连接
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections) {
        try {
          this.sendFrame(conn.socket, Buffer.alloc(0), 0x9); // ping
        } catch {
          this.dropConnection(conn);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * 广播事件给所有在线客户端，并写入回放缓冲
   * @param event 进度事件（timestamp 缺省时自动补当前时间）
   */
  broadcast(event: ProgressEvent): void {
    const full: ProgressEvent = { ...event, timestamp: event.timestamp ?? Date.now() };

    // 环形缓冲
    this.replayBuffer.push(full);
    if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
      this.replayBuffer.shift();
    }

    const frame = Buffer.from(JSON.stringify(full), 'utf-8');
    for (const conn of this.connections) {
      if (conn.closed) continue;
      // 背压保护：慢客户端直接断开
      if (conn.socket.writableLength > MAX_BUFFERED_BYTES) {
        this.dropConnection(conn);
        continue;
      }
      try {
        this.sendFrame(conn.socket, frame, 0x1); // text frame
      } catch {
        this.dropConnection(conn);
      }
    }
  }

  /**
   * 停止服务：关闭所有连接与监听
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of [...this.connections]) {
      try {
        this.sendFrame(conn.socket, Buffer.alloc(0), 0x8); // close frame
      } catch {
        /* 忽略 */
      }
      conn.socket.destroy();
    }
    this.connections.clear();
    this.server?.close();
    this.server = null;
  }

  /** 当前在线连接数 */
  getClientCount(): number {
    return this.connections.size;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** RFC 6455 握手 */
  private handleUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_MAGIC_GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    const conn: WsConnection = { socket, closed: false };
    this.connections.add(conn);

    // 回放历史事件 → 再发 connected（附录协议）
    for (const past of this.replayBuffer) {
      this.sendFrame(socket, Buffer.from(JSON.stringify(past), 'utf-8'), 0x1);
    }
    const connectedEvent: ProgressEvent = { type: 'connected', timestamp: Date.now(), clientCount: this.connections.size };
    this.sendFrame(socket, Buffer.from(JSON.stringify(connectedEvent), 'utf-8'), 0x1);

    socket.on('data', (chunk: Buffer) => this.handleData(conn, chunk));
    socket.on('close', () => this.dropConnection(conn));
    socket.on('error', () => this.dropConnection(conn));
  }

  /**
   * 解析入站帧（客户端帧必带掩码）
   * 仅处理控制帧：close(0x8) / ping(0x9) / pong(0xA)；业务上行暂不需要
   */
  private handleData(conn: WsConnection, chunk: Buffer): void {
    let offset = 0;
    while (offset + 2 <= chunk.length) {
      const opcode = chunk[offset]! & 0x0f;
      const masked = (chunk[offset + 1]! & 0x80) !== 0;
      let payloadLength = chunk[offset + 1]! & 0x7f;
      let headerSize = 2;

      if (payloadLength === 126) {
        if (offset + 4 > chunk.length) return;
        payloadLength = chunk.readUInt16BE(offset + 2);
        headerSize = 4;
      } else if (payloadLength === 127) {
        if (offset + 10 > chunk.length) return;
        payloadLength = Number(chunk.readBigUInt64BE(offset + 2));
        headerSize = 10;
      }

      const maskSize = masked ? 4 : 0;
      const frameEnd = offset + headerSize + maskSize + payloadLength;
      if (frameEnd > chunk.length) return; // 等待更多数据

      if (opcode === 0x8) {
        // close：回应并断开
        try {
          this.sendFrame(conn.socket, Buffer.alloc(0), 0x8);
        } catch {
          /* 忽略 */
        }
        conn.socket.end();
        return;
      }
      if (opcode === 0x9) {
        // ping → pong
        this.sendFrame(conn.socket, Buffer.alloc(0), 0xa);
      }
      // pong(0xA) 与文本帧无需处理
      offset = frameEnd;
    }
  }

  /** 发送未掩码服务端帧 */
  private sendFrame(socket: import('node:net').Socket, payload: Buffer, opcode: number): void {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  /** 清理连接 */
  private dropConnection(conn: WsConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    conn.socket.destroy();
  }
}
