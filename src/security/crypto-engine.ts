/**
 * crypto-engine.ts — 加密引擎（基础层，无内部依赖）
 *
 * 职责：
 * - 记忆库文件的整体加密 / 解密（fullFileEncryption）
 * - 敏感字段（如 apiKey）的字段级加密 / 解密
 * - 密钥轮换（rotateKey）与多版本密钥链管理
 * - 原子化落盘，避免写入中途崩溃导致记忆库损坏
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 主密钥经 scrypt KDF 派生为 32 字节工作密钥，避免弱口令直接作密钥
 * 2. 密钥链（keychain）支持多版本密钥并存，轮换后历史数据仍可解密
 * 3. 原子写入（tmp + rename），杜绝半写状态的记忆文件
 * 4. 密钥指纹使用 timingSafeEqual 比较，防时序侧信道
 * 5. 敏感字段深度递归扫描，支持任意嵌套层级
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CryptoError } from '../errors.js';

/** 加密引擎配置 */
export interface EncryptionConfig {
  /** 是否启用加密（关闭时 writeEncrypted 落明文 JSON） */
  enabled: boolean;
  /** 主密钥（任意字符串，内部经 scrypt 派生为工作密钥） */
  masterKey: string;
  /** 加密算法 */
  algorithm: 'aes-256-gcm' | 'aes-256-cbc';
  /** 需要字段级加密的字段名列表（递归匹配任意嵌套层级） */
  sensitiveFields: string[];
  /** 是否对整个文件加密（false 时仅加密敏感字段） */
  fullFileEncryption: boolean;
  /** 已轮换的历史主密钥（旧版本，用于解密历史数据） */
  rotatedKeys?: string[];
}

/** 字段级加密产物 */
export interface EncryptedField {
  __encrypted: true;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
}

/** 整文件加密产物 */
export interface EncryptedFile {
  __encrypted_file: true;
  version: number;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
  createdAt: number;
}

/** 加密操作结果 */
export interface CryptoResult {
  success: boolean;
  error?: string;
  fieldsEncrypted?: number;
  fieldsDecrypted?: number;
  fileEncrypted?: boolean;
  fileDecrypted?: boolean;
  keyRotated?: boolean;
}

/** scrypt 派生固定盐（项目域隔离） */
const KDF_SALT = 'dsh-proactive:v1:kdf';
/** AES-256 工作密钥长度 */
const KEY_LENGTH = 32;
/** GCM 推荐 IV 长度 */
const GCM_IV_LENGTH = 12;
/** CBC IV 长度 */
const CBC_IV_LENGTH = 16;

/**
 * 加密引擎
 *
 * 提供文件级与字段级两种加密粒度，以及密钥轮换能力。
 * 被 LongTermMemory（持久化加密）、DistributedSync（同步载荷加密）、
 * BenchmarkEngine（报告加密）依赖。
 */
export class CryptoEngine {
  private config: EncryptionConfig;
  /** 密钥链：index 0 对应 keyVersion 1，依次递增 */
  private keychain: Buffer[] = [];

  constructor(config: EncryptionConfig) {
    this.config = { ...config, rotatedKeys: [...(config.rotatedKeys ?? [])] };
    // 构建密钥链：历史轮换密钥在前，当前主密钥在最后（版本号最大）
    for (const oldKey of this.config.rotatedKeys ?? []) {
      this.keychain.push(this.deriveKey(oldKey));
    }
    this.keychain.push(this.deriveKey(this.config.masterKey));
  }

  /**
   * 加密整段内容为 EncryptedFile 结构
   * @param content 明文字符串（通常是 JSON.stringify 的结果）
   */
  encryptFile(content: string): EncryptedFile {
    const keyVersion = this.currentKeyVersion();
    const { ciphertext, iv, tag } = this.encryptRaw(content, this.currentKey());
    return {
      __encrypted_file: true,
      version: 1,
      algorithm: this.config.algorithm,
      iv,
      tag,
      ciphertext,
      keyVersion,
      createdAt: Date.now(),
    };
  }

  /**
   * 解密 EncryptedFile 结构，还原明文
   * @param file 加密文件结构
   * @throws CryptoError 密钥缺失或认证标签校验失败
   */
  decryptFile(file: EncryptedFile): string {
    const key = this.getKeyByVersion(file.keyVersion);
    return this.decryptRaw(
      { ciphertext: file.ciphertext, iv: file.iv, tag: file.tag },
      key,
      file.algorithm as EncryptionConfig['algorithm'],
    );
  }

  /**
   * 递归加密对象中的敏感字段
   * @param obj 任意对象（不会被原地修改，返回深拷贝）
   * @returns 加密后的对象与被加密字段数
   */
  encryptSensitiveFields(obj: any): { result: any; encryptedCount: number } {
    let count = 0;
    const walk = (node: any): any => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(walk);
      // 已加密的字段保持原样
      if ((node as EncryptedField).__encrypted === true) return node;
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node)) {
        if (this.config.sensitiveFields.includes(key) && typeof value === 'string' && value.length > 0) {
          out[key] = this.encryptStringToField(value);
          count += 1;
        } else {
          out[key] = walk(value);
        }
      }
      return out;
    };
    return { result: walk(structuredClone(obj)), encryptedCount: count };
  }

  /**
   * 递归解密对象中所有 EncryptedField 结构
   * @param obj 含加密字段的对象（不会被原地修改，返回深拷贝）
   * @returns 解密后的对象与被解密字段数
   */
  decryptSensitiveFields(obj: any): { result: any; decryptedCount: number } {
    let count = 0;
    const walk = (node: any): any => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(walk);
      if ((node as EncryptedField).__encrypted === true) {
        const field = node as EncryptedField;
        const key = this.getKeyByVersion(field.keyVersion);
        count += 1;
        return this.decryptRaw(
          { ciphertext: field.ciphertext, iv: field.iv, tag: field.tag },
          key,
          field.algorithm as EncryptionConfig['algorithm'],
        );
      }
      const out: Record<string, any> = {};
      for (const [key, value] of Object.entries(node)) {
        out[key] = walk(value);
      }
      return out;
    };
    return { result: walk(structuredClone(obj)), decryptedCount: count };
  }

  /**
   * 将数据加密后写入文件（原子写入）
   *
   * 行为矩阵：
   * - enabled && fullFileEncryption  → 整文件加密
   * - enabled && !fullFileEncryption → 仅加密敏感字段后写明文 JSON
   * - !enabled                       → 直接写明文 JSON
   */
  writeEncrypted(filePath: string, data: any): CryptoResult {
    try {
      if (!this.config.enabled) {
        this.atomicWrite(filePath, JSON.stringify(data, null, 2));
        return { success: true, fileEncrypted: false };
      }
      if (this.config.fullFileEncryption) {
        const encrypted = this.encryptFile(JSON.stringify(data));
        this.atomicWrite(filePath, JSON.stringify(encrypted));
        return { success: true, fileEncrypted: true };
      }
      const { result, encryptedCount } = this.encryptSensitiveFields(data);
      this.atomicWrite(filePath, JSON.stringify(result, null, 2));
      return { success: true, fileEncrypted: false, fieldsEncrypted: encryptedCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * 读取文件并自动解密（兼容明文 / 字段加密 / 整文件加密三种形态）
   */
  readEncrypted(filePath: string): { data: any; result: CryptoResult } {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // 形态一：整文件加密
      if (parsed && typeof parsed === 'object' && parsed.__encrypted_file === true) {
        const plain = this.decryptFile(parsed as EncryptedFile);
        return { data: JSON.parse(plain), result: { success: true, fileDecrypted: true } };
      }
      // 形态二 / 三：字段加密或纯明文
      const { result, decryptedCount } = this.decryptSensitiveFields(parsed);
      return {
        data: result,
        result: { success: true, fileDecrypted: false, fieldsDecrypted: decryptedCount },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CryptoError(`读取加密文件失败: ${filePath}`, { cause: message });
    }
  }

  /**
   * 密钥轮换：用新主密钥重新加密指定文件
   * @param filePath 目标文件
   * @param newMasterKey 新主密钥
   * @param keepOldKey 是否保留旧密钥到 rotatedKeys（保留后历史 keyVersion 仍可解密）
   */
  rotateKey(filePath: string, newMasterKey: string, keepOldKey = true): CryptoResult {
    try {
      // 1. 用当前密钥链读出明文数据
      const { data } = this.readEncrypted(filePath);
      // 2. 旧主密钥归档
      if (keepOldKey) {
        this.config.rotatedKeys = [...(this.config.rotatedKeys ?? []), this.config.masterKey];
      }
      // 3. 切换主密钥并扩展密钥链
      this.config.masterKey = newMasterKey;
      this.keychain.push(this.deriveKey(newMasterKey));
      // 4. 用新密钥重写文件
      const writeResult = this.writeEncrypted(filePath, data);
      if (!writeResult.success) {
        return { success: false, error: writeResult.error };
      }
      return { ...writeResult, keyRotated: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * 生成随机主密钥（64 位 hex）
   */
  static generateKey(): string {
    return crypto.randomBytes(KEY_LENGTH).toString('hex');
  }

  /**
   * 获取指定版本密钥的指纹（SHA-256 前 16 位 hex），用于安全展示与比对
   * @param version 密钥版本，缺省为当前版本
   */
  getKeyFingerprint(version?: number): string {
    const v = version ?? this.currentKeyVersion();
    const key = this.getKeyByVersion(v);
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /**
   * 判断磁盘文件是否为整文件加密形态
   */
  static isFileEncrypted(filePath: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return parsed && typeof parsed === 'object' && parsed.__encrypted_file === true;
    } catch {
      return false;
    }
  }

  /**
   * 判断对象中是否包含加密字段（任意嵌套层级）
   */
  static hasEncryptedFields(obj: any): boolean {
    const walk = (node: any): boolean => {
      if (node === null || typeof node !== 'object') return false;
      if (Array.isArray(node)) return node.some(walk);
      if (node.__encrypted === true) return true;
      return Object.values(node).some(walk);
    };
    return walk(obj);
  }

  /**
   * 时序安全的指纹比对（防时序侧信道）
   * @param a 指纹 A
   * @param b 指纹 B
   */
  static safeCompareFingerprint(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 当前密钥版本号（密钥链长度） */
  private currentKeyVersion(): number {
    return this.keychain.length;
  }

  /** 当前工作密钥 */
  private currentKey(): Buffer {
    return this.keychain[this.keychain.length - 1]!;
  }

  /** 按版本号取密钥 */
  private getKeyByVersion(version: number): Buffer {
    const key = this.keychain[version - 1];
    if (!key) {
      throw new CryptoError(`密钥版本 ${version} 不存在于密钥链中（可能已轮换且未保留旧密钥）`, {
        keyVersion: version,
        chainLength: this.keychain.length,
      });
    }
    return key;
  }

  /** scrypt 派生工作密钥 */
  private deriveKey(masterKey: string): Buffer {
    if (!masterKey) {
      throw new CryptoError('主密钥不能为空');
    }
    return crypto.scryptSync(masterKey, KDF_SALT, KEY_LENGTH);
  }

  /** 字符串 → EncryptedField */
  private encryptStringToField(text: string): EncryptedField {
    const { ciphertext, iv, tag } = this.encryptRaw(text, this.currentKey());
    return {
      __encrypted: true,
      algorithm: this.config.algorithm,
      iv,
      tag,
      ciphertext,
      keyVersion: this.currentKeyVersion(),
    };
  }

  /** 底层加密原语 */
  private encryptRaw(
    plaintext: string,
    key: Buffer,
  ): { ciphertext: string; iv: string; tag?: string } {
    const isGcm = this.config.algorithm === 'aes-256-gcm';
    const iv = crypto.randomBytes(isGcm ? GCM_IV_LENGTH : CBC_IV_LENGTH);
    const cipher = crypto.createCipheriv(this.config.algorithm, key, iv);
    let ciphertext = cipher.update(plaintext, 'utf-8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = isGcm ? (cipher as crypto.CipherGCM).getAuthTag().toString('hex') : undefined;
    return { ciphertext, iv: iv.toString('hex'), tag };
  }

  /** 底层解密原语 */
  private decryptRaw(
    data: { ciphertext: string; iv: string; tag?: string },
    key: Buffer,
    algorithm: EncryptionConfig['algorithm'],
  ): string {
    try {
      const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(data.iv, 'hex'));
      if (algorithm === 'aes-256-gcm') {
        if (!data.tag) {
          throw new CryptoError('GCM 密文缺少认证标签 tag');
        }
        (decipher as crypto.DecipherGCM).setAuthTag(Buffer.from(data.tag, 'hex'));
      }
      let plain = decipher.update(data.ciphertext, 'hex', 'utf-8');
      plain += decipher.final('utf-8');
      return plain;
    } catch (err) {
      if (err instanceof CryptoError) throw err;
      throw new CryptoError('解密失败：密钥不匹配或数据已被篡改');
    }
  }

  /** 原子写入：先写临时文件再 rename，防止半写损坏 */
  private atomicWrite(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
}
