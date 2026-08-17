import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import crypto, { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
//#region src/errors.ts
/**
* errors.ts — 统一错误体系（AppError）
*
* 架构文档要求：所有模块的错误处理使用统一的 AppError 体系。
* 每个子类携带稳定的机器可读 code，便于 Tool 层与日志层统一消费。
*/
/** 应用错误基类，所有业务错误的根类型 */
var AppError = class extends Error {
	/** 机器可读错误码，如 CRYPTO_ERROR / MEMORY_ERROR */
	code;
	/** 附加上下文信息（不含敏感数据） */
	details;
	constructor(message, code = "APP_ERROR", details) {
		super(message);
		this.name = new.target.name;
		this.code = code;
		this.details = details;
	}
};
/** 配置错误：cordis.patch.yml / 租户配置非法或缺失 */
var ConfigError = class extends AppError {
	constructor(message, details) {
		super(message, "CONFIG_ERROR", details);
	}
};
/** 加密错误：加解密失败、密钥无效、加密功能未启用 */
var CryptoError = class extends AppError {
	constructor(message, details) {
		super(message, "CRYPTO_ERROR", details);
	}
};
/** 记忆错误：持久化读写失败、记忆库损坏 */
var MemoryError = class extends AppError {
	constructor(message, details) {
		super(message, "MEMORY_ERROR", details);
	}
};
/** 网络错误：WebSocket / HTTP / 节点间通信失败 */
var NetworkError = class extends AppError {
	constructor(message, details) {
		super(message, "NETWORK_ERROR", details);
	}
};
/** 超时错误：模型调用或任务执行超过时限 */
var TimeoutError = class extends AppError {
	constructor(message, details) {
		super(message, "TIMEOUT_ERROR", details);
	}
};
//#endregion
//#region src/security/crypto-engine.ts
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
/** scrypt 派生固定盐（项目域隔离） */
const KDF_SALT = "dsh-proactive:v1:kdf";
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
var CryptoEngine = class {
	config;
	/** 密钥链：index 0 对应 keyVersion 1，依次递增 */
	keychain = [];
	constructor(config) {
		this.config = {
			...config,
			rotatedKeys: [...config.rotatedKeys ?? []]
		};
		for (const oldKey of this.config.rotatedKeys ?? []) this.keychain.push(this.deriveKey(oldKey));
		this.keychain.push(this.deriveKey(this.config.masterKey));
	}
	/**
	* 加密整段内容为 EncryptedFile 结构
	* @param content 明文字符串（通常是 JSON.stringify 的结果）
	*/
	encryptFile(content) {
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
			createdAt: Date.now()
		};
	}
	/**
	* 解密 EncryptedFile 结构，还原明文
	* @param file 加密文件结构
	* @throws CryptoError 密钥缺失或认证标签校验失败
	*/
	decryptFile(file) {
		const key = this.getKeyByVersion(file.keyVersion);
		return this.decryptRaw({
			ciphertext: file.ciphertext,
			iv: file.iv,
			tag: file.tag
		}, key, file.algorithm);
	}
	/**
	* 递归加密对象中的敏感字段
	* @param obj 任意对象（不会被原地修改，返回深拷贝）
	* @returns 加密后的对象与被加密字段数
	*/
	encryptSensitiveFields(obj) {
		let count = 0;
		const walk = (node) => {
			if (node === null || typeof node !== "object") return node;
			if (Array.isArray(node)) return node.map(walk);
			if (node.__encrypted === true) return node;
			const out = {};
			for (const [key, value] of Object.entries(node)) if (this.config.sensitiveFields.includes(key) && typeof value === "string" && value.length > 0) {
				out[key] = this.encryptStringToField(value);
				count += 1;
			} else out[key] = walk(value);
			return out;
		};
		return {
			result: walk(structuredClone(obj)),
			encryptedCount: count
		};
	}
	/**
	* 递归解密对象中所有 EncryptedField 结构
	* @param obj 含加密字段的对象（不会被原地修改，返回深拷贝）
	* @returns 解密后的对象与被解密字段数
	*/
	decryptSensitiveFields(obj) {
		let count = 0;
		const walk = (node) => {
			if (node === null || typeof node !== "object") return node;
			if (Array.isArray(node)) return node.map(walk);
			if (node.__encrypted === true) {
				const field = node;
				const key = this.getKeyByVersion(field.keyVersion);
				count += 1;
				return this.decryptRaw({
					ciphertext: field.ciphertext,
					iv: field.iv,
					tag: field.tag
				}, key, field.algorithm);
			}
			const out = {};
			for (const [key, value] of Object.entries(node)) out[key] = walk(value);
			return out;
		};
		return {
			result: walk(structuredClone(obj)),
			decryptedCount: count
		};
	}
	/**
	* 将数据加密后写入文件（原子写入）
	*
	* 行为矩阵：
	* - enabled && fullFileEncryption  → 整文件加密
	* - enabled && !fullFileEncryption → 仅加密敏感字段后写明文 JSON
	* - !enabled                       → 直接写明文 JSON
	*/
	writeEncrypted(filePath, data) {
		try {
			if (!this.config.enabled) {
				this.atomicWrite(filePath, JSON.stringify(data, null, 2));
				return {
					success: true,
					fileEncrypted: false
				};
			}
			if (this.config.fullFileEncryption) {
				const encrypted = this.encryptFile(JSON.stringify(data));
				this.atomicWrite(filePath, JSON.stringify(encrypted));
				return {
					success: true,
					fileEncrypted: true
				};
			}
			const { result, encryptedCount } = this.encryptSensitiveFields(data);
			this.atomicWrite(filePath, JSON.stringify(result, null, 2));
			return {
				success: true,
				fileEncrypted: false,
				fieldsEncrypted: encryptedCount
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	}
	/**
	* 读取文件并自动解密（兼容明文 / 字段加密 / 整文件加密三种形态）
	*/
	readEncrypted(filePath) {
		try {
			const raw = fs.readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && parsed.__encrypted_file === true) {
				const plain = this.decryptFile(parsed);
				return {
					data: JSON.parse(plain),
					result: {
						success: true,
						fileDecrypted: true
					}
				};
			}
			const { result, decryptedCount } = this.decryptSensitiveFields(parsed);
			return {
				data: result,
				result: {
					success: true,
					fileDecrypted: false,
					fieldsDecrypted: decryptedCount
				}
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
	rotateKey(filePath, newMasterKey, keepOldKey = true) {
		try {
			const { data } = this.readEncrypted(filePath);
			if (keepOldKey) this.config.rotatedKeys = [...this.config.rotatedKeys ?? [], this.config.masterKey];
			this.config.masterKey = newMasterKey;
			this.keychain.push(this.deriveKey(newMasterKey));
			const writeResult = this.writeEncrypted(filePath, data);
			if (!writeResult.success) return {
				success: false,
				error: writeResult.error
			};
			return {
				...writeResult,
				keyRotated: true
			};
		} catch (err) {
			return {
				success: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	}
	/**
	* 生成随机主密钥（64 位 hex）
	*/
	static generateKey() {
		return crypto.randomBytes(KEY_LENGTH).toString("hex");
	}
	/**
	* 获取指定版本密钥的指纹（SHA-256 前 16 位 hex），用于安全展示与比对
	* @param version 密钥版本，缺省为当前版本
	*/
	getKeyFingerprint(version) {
		const v = version ?? this.currentKeyVersion();
		const key = this.getKeyByVersion(v);
		return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
	}
	/**
	* 判断磁盘文件是否为整文件加密形态
	*/
	static isFileEncrypted(filePath) {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			return parsed && typeof parsed === "object" && parsed.__encrypted_file === true;
		} catch {
			return false;
		}
	}
	/**
	* 判断对象中是否包含加密字段（任意嵌套层级）
	*/
	static hasEncryptedFields(obj) {
		const walk = (node) => {
			if (node === null || typeof node !== "object") return false;
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
	static safeCompareFingerprint(a, b) {
		const bufA = Buffer.from(a, "utf-8");
		const bufB = Buffer.from(b, "utf-8");
		if (bufA.length !== bufB.length) return false;
		return crypto.timingSafeEqual(bufA, bufB);
	}
	/** 当前密钥版本号（密钥链长度） */
	currentKeyVersion() {
		return this.keychain.length;
	}
	/** 当前工作密钥 */
	currentKey() {
		return this.keychain[this.keychain.length - 1];
	}
	/** 按版本号取密钥 */
	getKeyByVersion(version) {
		const key = this.keychain[version - 1];
		if (!key) throw new CryptoError(`密钥版本 ${version} 不存在于密钥链中（可能已轮换且未保留旧密钥）`, {
			keyVersion: version,
			chainLength: this.keychain.length
		});
		return key;
	}
	/** scrypt 派生工作密钥 */
	deriveKey(masterKey) {
		if (!masterKey) throw new CryptoError("主密钥不能为空");
		return crypto.scryptSync(masterKey, KDF_SALT, KEY_LENGTH);
	}
	/** 字符串 → EncryptedField */
	encryptStringToField(text) {
		const { ciphertext, iv, tag } = this.encryptRaw(text, this.currentKey());
		return {
			__encrypted: true,
			algorithm: this.config.algorithm,
			iv,
			tag,
			ciphertext,
			keyVersion: this.currentKeyVersion()
		};
	}
	/** 底层加密原语 */
	encryptRaw(plaintext, key) {
		const isGcm = this.config.algorithm === "aes-256-gcm";
		const iv = crypto.randomBytes(isGcm ? GCM_IV_LENGTH : CBC_IV_LENGTH);
		const cipher = crypto.createCipheriv(this.config.algorithm, key, iv);
		let ciphertext = cipher.update(plaintext, "utf-8", "hex");
		ciphertext += cipher.final("hex");
		const tag = isGcm ? cipher.getAuthTag().toString("hex") : void 0;
		return {
			ciphertext,
			iv: iv.toString("hex"),
			tag
		};
	}
	/** 底层解密原语 */
	decryptRaw(data, key, algorithm) {
		try {
			const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(data.iv, "hex"));
			if (algorithm === "aes-256-gcm") {
				if (!data.tag) throw new CryptoError("GCM 密文缺少认证标签 tag");
				decipher.setAuthTag(Buffer.from(data.tag, "hex"));
			}
			let plain = decipher.update(data.ciphertext, "hex", "utf-8");
			plain += decipher.final("utf-8");
			return plain;
		} catch (err) {
			if (err instanceof CryptoError) throw err;
			throw new CryptoError("解密失败：密钥不匹配或数据已被篡改");
		}
	}
	/** 原子写入：先写临时文件再 rename，防止半写损坏 */
	atomicWrite(filePath, content) {
		const dir = path.dirname(filePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
		fs.writeFileSync(tmpPath, content, "utf-8");
		fs.renameSync(tmpPath, filePath);
	}
};
//#endregion
//#region src/memory/backend.ts
/**
* backend.ts — 记忆持久化后端抽象（验收标准 3：SQLite 持久化）
*
* 两种后端，统一 MemoryBackend 接口：
* - SqliteMemoryBackend：基于 Node 内置 node:sqlite（DatabaseSync），零依赖，
*   完全关系化 schema（v2）：热查询字段提升为类型化列 + 索引（SQL 可直接查询/聚合），
*   data 列存完整记录 JSON 保留演进弹性；WAL 模式读写并发、预编译语句缓存、
*   增量 UPSERT 同步（不再全表重建）；旧版 v1 blob 表首次打开自动无损升级
* - JsonMemoryBackend：JSON 原子写回退（加密启用时沿用，保持 CryptoEngine 兼容；
*   宿主 Node 不支持 node:sqlite 时自动降级）
*
* 选型策略（createMemoryBackend）：
* 1. 加密启用 → JsonMemoryBackend（加密与 SQLite 互斥，沿用既有加密落盘）
* 2. node:sqlite 可用 → SqliteMemoryBackend（旧版 JSON 记忆文件由 LongTermMemory 自动迁移）
* 3. node:sqlite 不可用 → JsonMemoryBackend（兼容旧 Node）
*/
/** 空记忆库工厂 */
function emptyMemoryStore() {
	return {
		version: 1,
		createdAt: Date.now(),
		lastUpdatedAt: Date.now(),
		taskPatterns: [],
		modelProfiles: [],
		decisionFeedback: [],
		distilledStrategies: [],
		semanticMemories: [],
		proceduralMemories: [],
		globalStats: {
			totalExecutions: 0,
			totalSuccesses: 0,
			totalFailures: 0,
			totalTokensUsed: 0,
			totalCostEstimate: 0,
			averageQualityScore: 0,
			averageExecutionTime: 0
		}
	};
}
/** 结构校验与缺省补全（JSON 加载与旧文件迁移共用） */
function sanitizeMemoryStore(raw) {
	const data = raw;
	if (!data || typeof data !== "object" || !Array.isArray(data.taskPatterns)) throw new MemoryError("记忆库结构非法：缺少 taskPatterns 数组");
	return {
		version: data.version ?? 1,
		createdAt: data.createdAt ?? Date.now(),
		lastUpdatedAt: data.lastUpdatedAt ?? Date.now(),
		taskPatterns: data.taskPatterns,
		modelProfiles: data.modelProfiles ?? [],
		decisionFeedback: data.decisionFeedback ?? [],
		distilledStrategies: data.distilledStrategies ?? [],
		semanticMemories: data.semanticMemories ?? [],
		proceduralMemories: data.proceduralMemories ?? [],
		globalStats: {
			totalExecutions: 0,
			totalSuccesses: 0,
			totalFailures: 0,
			totalTokensUsed: 0,
			totalCostEstimate: 0,
			averageQualityScore: 0,
			averageExecutionTime: 0,
			...data.globalStats
		}
	};
}
/** JSON 持久化路径 → SQLite 文件路径（memory.json → memory.db） */
function sqlitePathFor(persistPath) {
	return persistPath.endsWith(".json") ? `${persistPath.slice(0, -5)}.db` : `${persistPath}.db`;
}
/** 惰性加载 node:sqlite 模块（不可用时返回 null，避免静态 import 拖垮旧 Node） */
let sqliteModuleCache;
function getSqliteModule() {
	if (sqliteModuleCache !== void 0) return sqliteModuleCache;
	try {
		sqliteModuleCache = createRequire(import.meta.url)("node:sqlite");
	} catch {
		sqliteModuleCache = null;
	}
	return sqliteModuleCache;
}
/** 宿主是否支持内置 SQLite */
function sqliteAvailable() {
	return getSqliteModule() !== null;
}
/**
* 轻量中文分词（jieba 式管道的零依赖实现）：
* - ASCII/数字串按词切分
* - 连续 CJK 串切分为二元组（bigram），覆盖无词典场景下的中文词级匹配
*
* 若宿主提供真实 jieba 管道（如 jieba-wasm），可通过 setChineseTokenizer 注入替换。
*/
function tokenizeChinese(text) {
	const tokens = [];
	for (const word of text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []) tokens.push(word);
	for (const run of text.match(/[一-鿿]+/g) ?? []) {
		if (run.length <= 2) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i + 2 <= run.length; i += 1) tokens.push(run.slice(i, i + 2));
	}
	return [...new Set(tokens)];
}
let customTokenizer = null;
/** 注入真实 jieba 分词管道（可选；缺省使用内置轻量分词） */
function setChineseTokenizer(fn) {
	customTokenizer = fn;
}
/** 分词入口：优先外部注入的 jieba 管道，缺省轻量分词 */
function segment(text) {
	return customTokenizer ? customTokenizer(text) : tokenizeChinese(text);
}
/** 稀疏词频向量（sqlite-vec 不可用时的零依赖向量检索） */
function toSparseVector(text) {
	const vec = {};
	for (const token of segment(text)) vec[token] = (vec[token] ?? 0) + 1;
	return vec;
}
function cosineSimilarity(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [token, weight] of Object.entries(a)) {
		normA += weight * weight;
		if (b[token]) dot += weight * b[token];
	}
	for (const weight of Object.values(b)) normB += weight * weight;
	return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}
/** 当前 SQLite schema 版本（v2 = 关系化列 + 索引；v1 = 纯 blob 表） */
const SCHEMA_VERSION = 2;
/**
* 版本化迁移注册表：新增迁移在数组末尾追加 { to, up }，
* migrateIfNeeded 按顺序执行未应用步骤（每步独立事务）。
*/
const MIGRATIONS = [{
	to: 2,
	up: (backend) => backend.migrateV1toV2()
}];
/**
* SQLite 后端（node:sqlite 内置，零依赖，完全关系化）
*
* schema v2：热查询/聚合字段提升为类型化列并建索引，SQL 可直接查询，
* data 列存完整记录 JSON 保留 schema 演进弹性：
* - meta(key PK, value)：schema_version / createdAt / lastUpdatedAt / globalStats(JSON)
* - task_patterns(fingerprint PK, task_type, confidence REAL, frequency, last_seen_at, last_decay_at, data)
*   + idx(task_type, confidence)：支撑"按类型取最优模式"类 SQL 聚合
* - model_profiles(id PK, best_task_type, data)
* - decision_feedback(id PK, ts, signal_type, decision, outcome, data)
*   + idx(signal_type, ts)：支撑"按信号类型的决策成功率"类 SQL 统计
* - distilled_strategies(id PK, task_type, confidence REAL, support_count, last_applied_at, data)
*   + idx(task_type, confidence)
*
* 工程特性：
* - WAL 模式（journal_mode=WAL）：读写不互斥、崩溃恢复更快
* - 预编译语句缓存（stmt）：热路径零重复编译开销
* - 增量 UPSERT 同步：save 按主键 upsert + 删除已消失行，不再全表重建
* - 旧版 v1 blob 表首次打开自动无损升级为 v2
*/
var SqliteMemoryBackend = class {
	kind = "sqlite";
	db;
	dbPath;
	stmts = /* @__PURE__ */ new Map();
	/** sqlite-vec 扩展是否加载成功（在线/预装环境启用；缺省走零依赖稀疏向量） */
	vecAvailable;
	/** FTS5 是否可用（node:sqlite 内置；极端裁剪构建可能缺失） */
	ftsAvailable;
	constructor(dbPath) {
		const mod = getSqliteModule();
		if (!mod) throw new MemoryError("当前 Node 运行时不支持 node:sqlite");
		this.dbPath = dbPath;
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		try {
			this.db = new mod.DatabaseSync(dbPath, { allowExtension: true });
		} catch {
			this.db = new mod.DatabaseSync(dbPath);
		}
		this.vecAvailable = this.tryLoadVec();
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_patterns (
        fingerprint TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        frequency INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_patterns_type_conf ON task_patterns (task_type, confidence);
      CREATE TABLE IF NOT EXISTS model_profiles (
        id TEXT PRIMARY KEY,
        best_task_type TEXT,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_feedback (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        outcome TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decision_feedback_signal_ts ON decision_feedback (signal_type, ts);
      CREATE TABLE IF NOT EXISTS distilled_strategies (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_distilled_strategies_type_conf ON distilled_strategies (task_type, confidence);
      -- 第二阶段三层记忆扩展：语义记忆 + 程序记忆（CREATE IF NOT EXISTS 幂等加表，旧库自动建表）
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_memories_domain_conf ON semantic_memories (domain, confidence);
      CREATE TABLE IF NOT EXISTS procedural_memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_type TEXT NOT NULL,
        confidence REAL NOT NULL,
        support_count INTEGER NOT NULL,
        last_applied_at INTEGER,
        last_decay_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_procedural_memories_kind_conf ON procedural_memories (kind, confidence);
      CREATE TABLE IF NOT EXISTS memory_vectors (ref_id TEXT PRIMARY KEY, kind TEXT NOT NULL, vector TEXT NOT NULL);
    `);
		this.ftsAvailable = this.createFtsTables();
		this.migrateIfNeeded();
	}
	/** sqlite-vec 接缝：宿主预装扩展时启用，失败静默回退稀疏向量 */
	tryLoadVec() {
		try {
			this.db.enableLoadExtension(true);
			for (const name of ["vec0", "sqlite-vec"]) try {
				this.db.loadExtension(name);
				return true;
			} catch {}
			return false;
		} catch {
			return false;
		}
	}
	createFtsTables() {
		try {
			this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(ref_id UNINDEXED, kind UNINDEXED, content, tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tok USING fts5(ref_id UNINDEXED, kind UNINDEXED, content);
      `);
			return true;
		} catch {
			return false;
		}
	}
	/** 预编译语句缓存：同一条 SQL 只编译一次 */
	stmt(sql) {
		let s = this.stmts.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmts.set(sql, s);
		}
		return s;
	}
	/**
	* 版本化迁移框架：按 schema_version 顺序执行 MIGRATIONS 中未应用的步骤，
	* 每步独立事务，失败即停（保留现场便于诊断）。新增迁移只需在数组末尾追加。
	*/
	migrateIfNeeded() {
		let version = Number(this.getMeta("schema_version") ?? 0);
		for (const migration of MIGRATIONS) {
			if (version >= migration.to) continue;
			this.db.exec("BEGIN");
			try {
				migration.up(this);
				this.setMeta("schema_version", String(migration.to));
				this.db.exec("COMMIT");
			} catch (err) {
				this.db.exec("ROLLBACK");
				throw new MemoryError(`SQLite schema 迁移 v${version}→v${migration.to} 失败`, { cause: err instanceof Error ? err.message : String(err) });
			}
			version = migration.to;
		}
	}
	/** 迁移步骤可访问的内部工具 */
	hasColumn(table, column) {
		return this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
	}
	/** v1（纯 blob 表）→ v2（关系化列）：从 data blob 回填类型化列 */
	migrateV1toV2() {
		const hasLegacyColumns = (table, column) => this.hasColumn(table, column);
		if (!hasLegacyColumns("task_patterns", "task_type")) {
			this.db.exec("ALTER TABLE task_patterns ADD COLUMN task_type TEXT;");
			this.db.exec("ALTER TABLE task_patterns ADD COLUMN confidence REAL;");
			this.db.exec("ALTER TABLE task_patterns ADD COLUMN frequency INTEGER;");
			this.db.exec("ALTER TABLE task_patterns ADD COLUMN last_seen_at INTEGER;");
			this.db.exec("ALTER TABLE task_patterns ADD COLUMN last_decay_at INTEGER;");
			this.db.exec(`
        UPDATE task_patterns SET
          task_type = CASE WHEN instr(fingerprint, '::') > 0
            THEN substr(fingerprint, 1, instr(fingerprint, '::') - 1) ELSE fingerprint END,
          confidence = json_extract(data, '$.confidence'),
          frequency = json_extract(data, '$.frequency'),
          last_seen_at = json_extract(data, '$.lastSeenAt'),
          last_decay_at = json_extract(data, '$.lastDecayAt');
      `);
		}
		if (!hasLegacyColumns("decision_feedback", "signal_type")) {
			this.db.exec("ALTER TABLE decision_feedback ADD COLUMN signal_type TEXT;");
			this.db.exec("ALTER TABLE decision_feedback ADD COLUMN decision TEXT;");
			this.db.exec("ALTER TABLE decision_feedback ADD COLUMN outcome TEXT;");
			this.db.exec(`
        UPDATE decision_feedback SET
          signal_type = json_extract(data, '$.signalType'),
          decision = json_extract(data, '$.decision'),
          outcome = json_extract(data, '$.outcome');
      `);
		}
		if (!hasLegacyColumns("distilled_strategies", "task_type")) {
			this.db.exec("ALTER TABLE distilled_strategies ADD COLUMN task_type TEXT;");
			this.db.exec("ALTER TABLE distilled_strategies ADD COLUMN confidence REAL;");
			this.db.exec("ALTER TABLE distilled_strategies ADD COLUMN support_count INTEGER;");
			this.db.exec("ALTER TABLE distilled_strategies ADD COLUMN last_applied_at INTEGER;");
			this.db.exec(`
        UPDATE distilled_strategies SET
          task_type = json_extract(data, '$.taskType'),
          confidence = json_extract(data, '$.confidence'),
          support_count = json_extract(data, '$.supportCount'),
          last_applied_at = json_extract(data, '$.lastAppliedAt');
      `);
		}
		if (!hasLegacyColumns("model_profiles", "best_task_type")) {
			this.db.exec("ALTER TABLE model_profiles ADD COLUMN best_task_type TEXT;");
			this.db.exec(`UPDATE model_profiles SET best_task_type = json_extract(data, '$.bestTaskType');`);
		}
		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_patterns_type_conf ON task_patterns (task_type, confidence);
      CREATE INDEX IF NOT EXISTS idx_decision_feedback_signal_ts ON decision_feedback (signal_type, ts);
      CREATE INDEX IF NOT EXISTS idx_distilled_strategies_type_conf ON distilled_strategies (task_type, confidence);
    `);
	}
	getMeta(key) {
		const row = this.stmt("SELECT value FROM meta WHERE key = ?").get(key);
		return row ? row.value : null;
	}
	setMeta(key, value) {
		this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}
	load() {
		const store = emptyMemoryStore();
		const createdAt = this.getMeta("createdAt");
		if (createdAt) store.createdAt = Number(createdAt);
		const lastUpdatedAt = this.getMeta("lastUpdatedAt");
		if (lastUpdatedAt) store.lastUpdatedAt = Number(lastUpdatedAt);
		const stats = this.getMeta("globalStats");
		if (stats) store.globalStats = {
			...store.globalStats,
			...JSON.parse(stats)
		};
		store.taskPatterns = this.stmt("SELECT data FROM task_patterns").all().map((r) => JSON.parse(r.data));
		store.modelProfiles = this.stmt("SELECT data FROM model_profiles").all().map((r) => JSON.parse(r.data));
		store.decisionFeedback = this.stmt("SELECT data FROM decision_feedback ORDER BY ts").all().map((r) => JSON.parse(r.data));
		store.distilledStrategies = this.stmt("SELECT data FROM distilled_strategies").all().map((r) => JSON.parse(r.data));
		store.semanticMemories = this.stmt("SELECT data FROM semantic_memories").all().map((r) => JSON.parse(r.data));
		store.proceduralMemories = this.stmt("SELECT data FROM procedural_memories").all().map((r) => JSON.parse(r.data));
		return store;
	}
	/** 增量同步：按主键 UPSERT + 删除已消失行，单事务保证一致性 */
	save(store) {
		this.db.exec("BEGIN");
		try {
			const upPattern = this.stmt(`
        INSERT INTO task_patterns (fingerprint, task_type, confidence, frequency, last_seen_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET
          task_type = excluded.task_type, confidence = excluded.confidence, frequency = excluded.frequency,
          last_seen_at = excluded.last_seen_at, last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
			const seenPatterns = /* @__PURE__ */ new Set();
			for (const p of store.taskPatterns) {
				seenPatterns.add(p.fingerprint);
				const taskType = p.fingerprint.split("::")[0] ?? "";
				upPattern.run(p.fingerprint, taskType, p.confidence, p.frequency, p.lastSeenAt, p.lastDecayAt ?? null, JSON.stringify(p));
			}
			this.stmt("DELETE FROM task_patterns WHERE fingerprint NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenPatterns]));
			const upProfile = this.stmt(`
        INSERT INTO model_profiles (id, best_task_type, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET best_task_type = excluded.best_task_type, data = excluded.data
      `);
			const seenProfiles = /* @__PURE__ */ new Set();
			for (const m of store.modelProfiles) {
				seenProfiles.add(m.id);
				upProfile.run(m.id, m.bestTaskType ?? null, JSON.stringify(m));
			}
			this.stmt("DELETE FROM model_profiles WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenProfiles]));
			const upFeedback = this.stmt(`
        INSERT INTO decision_feedback (id, ts, signal_type, decision, outcome, data) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, signal_type = excluded.signal_type,
          decision = excluded.decision, outcome = excluded.outcome, data = excluded.data
      `);
			const seenFeedback = /* @__PURE__ */ new Set();
			for (const f of store.decisionFeedback) {
				seenFeedback.add(f.id);
				upFeedback.run(f.id, f.timestamp, f.signalType, f.decision, f.outcome, JSON.stringify(f));
			}
			this.stmt("DELETE FROM decision_feedback WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenFeedback]));
			const upStrategy = this.stmt(`
        INSERT INTO distilled_strategies (id, task_type, confidence, support_count, last_applied_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET task_type = excluded.task_type, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at, data = excluded.data
      `);
			const seenStrategies = /* @__PURE__ */ new Set();
			for (const s of store.distilledStrategies) {
				seenStrategies.add(s.id);
				upStrategy.run(s.id, s.taskType, s.confidence, s.supportCount, s.lastAppliedAt ?? null, JSON.stringify(s));
			}
			this.stmt("DELETE FROM distilled_strategies WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenStrategies]));
			const upSemantic = this.stmt(`
        INSERT INTO semantic_memories (id, domain, confidence, support_count, last_applied_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at,
          last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
			const seenSemantic = /* @__PURE__ */ new Set();
			for (const m of store.semanticMemories) {
				seenSemantic.add(m.id);
				upSemantic.run(m.id, m.domain, m.confidence, m.supportCount, m.lastAppliedAt ?? null, m.lastDecayAt ?? null, JSON.stringify(m));
			}
			this.stmt("DELETE FROM semantic_memories WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenSemantic]));
			const upProcedural = this.stmt(`
        INSERT INTO procedural_memories (id, kind, task_type, confidence, support_count, last_applied_at, last_decay_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, task_type = excluded.task_type, confidence = excluded.confidence,
          support_count = excluded.support_count, last_applied_at = excluded.last_applied_at,
          last_decay_at = excluded.last_decay_at, data = excluded.data
      `);
			const seenProcedural = /* @__PURE__ */ new Set();
			for (const p of store.proceduralMemories) {
				seenProcedural.add(p.id);
				const primaryTaskType = p.taskTypes[0] ?? "";
				upProcedural.run(p.id, p.kind, primaryTaskType, p.confidence, p.supportCount, p.lastAppliedAt ?? null, p.lastDecayAt ?? null, JSON.stringify(p));
			}
			this.stmt("DELETE FROM procedural_memories WHERE id NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify([...seenProcedural]));
			if (this.ftsAvailable) {
				this.db.exec("DELETE FROM memory_fts; DELETE FROM memory_fts_tok; DELETE FROM memory_vectors;");
				const insFts = this.stmt("INSERT INTO memory_fts (ref_id, kind, content) VALUES (?, ?, ?)");
				const insFtsTok = this.stmt("INSERT INTO memory_fts_tok (ref_id, kind, content) VALUES (?, ?, ?)");
				const insVec = this.stmt("INSERT INTO memory_vectors (ref_id, kind, vector) VALUES (?, ?, ?)");
				for (const p of store.taskPatterns) {
					const content = `${p.taskSummary} ${p.fingerprint}`;
					insFts.run(p.fingerprint, "pattern", content);
					insFtsTok.run(p.fingerprint, "pattern", segment(content).join(" "));
					insVec.run(p.fingerprint, "pattern", JSON.stringify(toSparseVector(content)));
				}
				for (const s of store.distilledStrategies) {
					insFts.run(s.id, "strategy", s.description);
					insFtsTok.run(s.id, "strategy", segment(s.description).join(" "));
					insVec.run(s.id, "strategy", JSON.stringify(toSparseVector(s.description)));
				}
				for (const m of store.semanticMemories) {
					insFts.run(m.id, "semantic", m.statement);
					insFtsTok.run(m.id, "semantic", segment(m.statement).join(" "));
					insVec.run(m.id, "semantic", JSON.stringify(toSparseVector(m.statement)));
				}
				for (const p of store.proceduralMemories) {
					const content = `${p.name} ${p.action.rationale}`;
					insFts.run(p.id, "procedural", content);
					insFtsTok.run(p.id, "procedural", segment(content).join(" "));
					insVec.run(p.id, "procedural", JSON.stringify(toSparseVector(content)));
				}
			}
			this.setMeta("createdAt", String(store.createdAt));
			this.setMeta("lastUpdatedAt", String(store.lastUpdatedAt));
			this.setMeta("globalStats", JSON.stringify(store.globalStats));
			this.setMeta("schema_version", String(SCHEMA_VERSION));
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}
	/**
	* FTS5 全文检索（混合检索增强）：
	* - trigram 表：原始内容子串级匹配（中文无需分词即可命中）
	* - 分词表：jieba 式 token 级 OR 匹配（词级语义召回）
	* 两路结果按 rank 合并去重。
	*/
	fullTextSearch(query, limit = 5) {
		if (!this.ftsAvailable) return [];
		const hits = /* @__PURE__ */ new Map();
		try {
			const trigramQ = `"${query.replace(/"/g, "")}"`;
			for (const row of this.stmt("SELECT ref_id, kind, rank FROM memory_fts WHERE content MATCH ? ORDER BY rank LIMIT ?").all(trigramQ, limit)) {
				const score = Math.max(0, -row.rank);
				const prev = hits.get(row.ref_id);
				if (!prev || prev.score < score) hits.set(row.ref_id, {
					kind: row.kind,
					refId: row.ref_id,
					score
				});
			}
			const tokQ = segment(query).map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
			if (tokQ) for (const row of this.stmt("SELECT ref_id, kind, rank FROM memory_fts_tok WHERE content MATCH ? ORDER BY rank LIMIT ?").all(tokQ, limit)) {
				const score = Math.max(0, -row.rank);
				const prev = hits.get(row.ref_id);
				if (!prev || prev.score < score) hits.set(row.ref_id, {
					kind: row.kind,
					refId: row.ref_id,
					score
				});
			}
		} catch {}
		return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
	}
	/** 稀疏向量检索（sqlite-vec 不可用时的零依赖语义召回） */
	vectorSearch(query, limit = 5) {
		const qVec = toSparseVector(query);
		const scored = [];
		for (const row of this.stmt("SELECT ref_id, kind, vector FROM memory_vectors").all()) {
			const score = cosineSimilarity(qVec, JSON.parse(row.vector));
			if (score > 0) scored.push({
				kind: row.kind,
				refId: row.ref_id,
				score
			});
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	}
	/** 完整性检查（PRAGMA integrity_check），返回 ok 或错误描述 */
	integrityCheck() {
		return this.stmt("PRAGMA integrity_check").get().integrity_check;
	}
	/** 数据库统计（运维可观测：行数、页大小、WAL 状态、schema 版本、扩展能力） */
	stats() {
		const count = (table) => this.stmt(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
		let walSize = 0;
		try {
			walSize = fs.statSync(`${this.dbPath}-wal`).size;
		} catch {}
		return {
			patterns: count("task_patterns"),
			profiles: count("model_profiles"),
			feedback: count("decision_feedback"),
			strategies: count("distilled_strategies"),
			semantic: count("semantic_memories"),
			procedural: count("procedural_memories"),
			pageSize: this.stmt("PRAGMA page_size").get().page_size,
			pageCount: this.stmt("PRAGMA page_count").get().page_count,
			walSize,
			schemaVersion: Number(this.getMeta("schema_version") ?? 0),
			fts: this.ftsAvailable,
			vec: this.vecAvailable
		};
	}
	/** WAL checkpoint（TRUNCATE）：把 WAL 合并回主库，缩小文件、便于备份 */
	checkpoint() {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	}
	/** VACUUM：回收碎片空间（阻塞式，建议低峰期调用） */
	vacuum() {
		this.db.exec("VACUUM;");
	}
	/**
	* 热备份：checkpoint 后复制主库文件（node:sqlite 无 backup API，
	* 采用「checkpoint + 文件复制」保证备份一致性），返回备份路径
	*/
	backup(destPath) {
		this.checkpoint();
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
		fs.copyFileSync(this.dbPath, destPath);
		return destPath;
	}
	/** 只读查询通道（运维/诊断用；调用方自行保证 SQL 只读） */
	rawQuery(sql, params = []) {
		return this.stmt(sql).all(...params);
	}
	close() {
		this.stmts.clear();
		this.db.close();
	}
};
/** JSON 后端（原子写 + 可选加密，回退/兼容路径） */
var JsonMemoryBackend = class {
	persistPath;
	cryptoEngine;
	kind = "json";
	constructor(persistPath, cryptoEngine) {
		this.persistPath = persistPath;
		this.cryptoEngine = cryptoEngine;
	}
	load() {
		if (!fs.existsSync(this.persistPath)) return emptyMemoryStore();
		try {
			if (this.cryptoEngine) {
				const { data } = this.cryptoEngine.readEncrypted(this.persistPath);
				return sanitizeMemoryStore(data);
			}
			return sanitizeMemoryStore(JSON.parse(fs.readFileSync(this.persistPath, "utf-8")));
		} catch (err) {
			if (err instanceof MemoryError) throw err;
			const backup = `${this.persistPath}.corrupt.${Date.now()}`;
			try {
				fs.copyFileSync(this.persistPath, backup);
			} catch {}
			throw new MemoryError(`记忆库加载失败，已备份至 ${backup}`, { persistPath: this.persistPath });
		}
	}
	save(store) {
		try {
			if (this.cryptoEngine) {
				const result = this.cryptoEngine.writeEncrypted(this.persistPath, store);
				if (!result.success) throw new MemoryError(`记忆库写入失败: ${result.error}`);
				return;
			}
			const dir = path.dirname(this.persistPath);
			fs.mkdirSync(dir, { recursive: true });
			const tmp = `${this.persistPath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
			fs.renameSync(tmp, this.persistPath);
		} catch (err) {
			if (err instanceof MemoryError) throw err;
			throw new MemoryError("记忆库持久化失败", {
				persistPath: this.persistPath,
				cause: err instanceof Error ? err.message : String(err)
			});
		}
	}
	close() {}
};
/**
* 后端选型：加密启用 → JSON；否则 node:sqlite 可用 → SQLite；不可用 → JSON 回退
*/
function createMemoryBackend(persistPath, cryptoEngine) {
	if (cryptoEngine) return new JsonMemoryBackend(persistPath, cryptoEngine);
	try {
		return new SqliteMemoryBackend(sqlitePathFor(persistPath));
	} catch {
		return new JsonMemoryBackend(persistPath);
	}
}
//#endregion
//#region src/core/evidence.ts
/**
* evidence.ts — 统一证据内核（项目 3.0「全层证据统一 + 自知之明」基石）
*
* 项目级质升前的问题（勘察结论）：
* - 时间衰减 / Wilson 下界 / Beta 后验只服务于模型画像（ModelTaskStats）一层；
*   蒸馏策略、语义记忆、程序记忆仍用裸 confidence + 裸计数，检索排序裸置信度；
* - 沙盒校准读裸 avgQualityScore / totalCalls，旧证据与漂移无法感知；
* - 各层统计口径（confidence / posteriorMean / wilsonLower）混用互不可比。
*
* 本内核把同一套统计语言铺到所有记忆层：
* - wilsonLowerBound：小样本保守的置信下界（排序与校准的统一度量）
* - decayFactor：时间衰减（30 天半衰期，旧证据自然让位）
* - MemoryEvidence：可持久化的时间加权 Beta 证据（ws/wf/lastDecayedAt）
* - observeEvidence：写入式观测（惰性衰减 + 累积，读取零开销）
* - readEvidence：读取式视图（纯函数衰减，不回写）
* - evidenceRankScore：证据化排序分（confidence × Wilson 下界等权混合；
*   无证据时回退裸 confidence，行为与升级前逐位一致——并行旁路设计）
*
* 兼容性：旧格式记忆无 evidence 字段 → 首次观测时从裸计数按 0.5 折价初始化
* （与模型画像 legacy 回退语义一致），confidence 更新公式保持不变。
*/
/** Wilson 置信下界（纯函数，全部层共享的统一不确定性度量） */
function wilsonLowerBound(successes, failures, z = 1.96) {
	const n = successes + failures;
	if (n <= 0) return 0;
	const p = successes / n;
	const denom = 1 + z * z / n;
	const centre = p + z * z / (2 * n);
	const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
	return Math.max(0, (centre - margin) / denom);
}
/**
* Wilson 置信上界（4.0：金丝雀/回归判定的「乐观边界」）
*
* 用途：只有当乐观边界也低于期望阈值时才确认劣化——单侧噪声不触发回滚。
* 如 7/10 成功（raw 0.7 < 期望 0.85-0.1）但上界 0.89 ≥ 0.75 → 未确认，继续观察；
* 0/5 全败上界 0.43 << 0.75 → 立即确认。
*/
function wilsonUpperBound(successes, failures, z = 1.96) {
	const n = successes + failures;
	if (n <= 0) return 1;
	const p = successes / n;
	const denom = 1 + z * z / n;
	const centre = p + z * z / (2 * n);
	const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
	return Math.min(1, (centre + margin) / denom);
}
/** 证据时间衰减半衰期（天）——30 天前的证据权重折半 */
const DECAY_HALF_LIFE_DAYS = 30;
/** Beta 先验强度（均匀先验 Beta(1,1)） */
const BAYES_PRIOR_STRENGTH = 1;
/** 证据参与排序/校准的最小有效样本量（低于此值回退裸 confidence） */
const EVIDENCE_MIN_SAMPLES = 3;
/** 旧格式（无时间信息）证据折价系数 */
const LEGACY_EVIDENCE_DISCOUNT = .5;
/** 排序混合权重：confidence 与 Wilson 下界各占一半 */
const EVIDENCE_RANK_BLEND = .5;
/** 一天的毫秒数 */
const DAY_MS = 864e5;
/** 时间衰减因子：0.5 ^ (elapsedMs / halfLife），未来时间不放大 */
function decayFactor(elapsedMs, halfLifeDays = 30) {
	if (elapsedMs <= 0) return 1;
	return Math.pow(.5, elapsedMs / (halfLifeDays * DAY_MS));
}
/** 从裸计数初始化证据（无时间信息 → 0.5 折价，与模型画像 legacy 回退一致） */
function initEvidence(successes, total, at) {
	const failures = Math.max(0, total - Math.max(0, successes));
	return {
		weightedSuccesses: Math.max(0, successes) * LEGACY_EVIDENCE_DISCOUNT,
		weightedFailures: failures * LEGACY_EVIDENCE_DISCOUNT,
		lastDecayedAt: at
	};
}
/** 写入式观测：先惰性衰减到 now，再计入新证据（原地更新，读取零开销） */
function observeEvidence(evidence, success, now) {
	const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
	evidence.weightedSuccesses *= decay;
	evidence.weightedFailures *= decay;
	if (success) evidence.weightedSuccesses += 1;
	else evidence.weightedFailures += 1;
	evidence.lastDecayedAt = now;
}
/**
* 加权观测（4.0：连续收益 0~1 的证据化，如进化引擎的 outcome reward）
*
* 把一次 value∈[0,1] 的连续观测拆为 success=value / failure=1-value 计入——
* 布鲁厄姆/冯·诺依曼式分数观测：连续信号无需离散化即可进入统一 Beta 证据，
* 时间衰减语义与 observeEvidence 完全一致。
*/
function observeWeightedEvidence(evidence, value, now) {
	const v = Math.max(0, Math.min(1, value));
	const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
	evidence.weightedSuccesses *= decay;
	evidence.weightedFailures *= decay;
	evidence.weightedSuccesses += v;
	evidence.weightedFailures += 1 - v;
	evidence.lastDecayedAt = now;
}
/** 读取式视图：纯函数衰减（不回写），供排序/报告/沙盒校准消费 */
function readEvidence(evidence, now) {
	const decay = decayFactor(Math.max(0, now - evidence.lastDecayedAt));
	const ws = evidence.weightedSuccesses * decay;
	const wf = evidence.weightedFailures * decay;
	const alpha = ws + 1;
	const beta = wf + 1;
	return {
		weightedSuccesses: ws,
		weightedFailures: wf,
		effectiveSamples: ws + wf,
		posteriorMean: alpha / (alpha + beta),
		wilsonLower: wilsonLowerBound(ws, wf)
	};
}
/**
* 证据化排序分：confidence 与 Wilson 下界等权混合
*
* 质变：0.95 置信度但仅 3 次应用（下界 ≈ 0.44）的记忆，排序分 ≈ 0.70；
* 0.85 置信度且 50 次应用 48 成（下界 ≈ 0.79）的记忆，排序分 ≈ 0.82——
* 小样本高置信不再压过大样本稳置信。
*
* 兼容：无证据或有效样本 < EVIDENCE_MIN_SAMPLES → 原样返回 confidence
* （与升级前排序行为逐位一致，既有消费方零感知）。
*/
function evidenceRankScore(confidence, evidence, now) {
	if (!evidence) return confidence;
	const view = readEvidence(evidence, now);
	if (view.effectiveSamples < 3) return confidence;
	return EVIDENCE_RANK_BLEND * confidence + .5 * view.wilsonLower;
}
//#endregion
//#region src/memory/long-term-memory.ts
/**
* long-term-memory.ts — 跨会话长期记忆引擎（基础层）
*
* 职责：
* - 任务模式记忆（TaskPatternMemory）：相似任务的成功方案沉淀与检索
* - 模型长期画像（ModelLongTermProfile）：按任务类型统计成功率/延迟/质量/成本
* - 决策反馈（DecisionFeedback）：信号决策的结果复盘与经验教训
* - 全局统计（globalStats）：执行总量、成功率、token 消耗、成本估算
*
* 升级点（相对基础实现的质的提升）：
* 1. 模糊经验匹配：findPattern 不再要求指纹精确命中，而是按
*    taskType 相似度 + complexity 距离 + features 重叠度加权打分，
*    返回置信度最高的模式（含最低相似度门槛）
* 2. 防抖持久化 + 原子写入 + 进程退出兜底 flush，杜绝记忆丢失
* 3. 与 CryptoEngine 无缝集成，持久化形态自动适配加密配置
* 4. 模型画像自动推导 bestTaskType / worstTaskType / stability
* 5. 模式置信度动态演化：成功加分、失败扣分，衰减由频率驱动
* 6. 对冲机制（防止"越学越错"，缺一不可）：
*    - 遗忘曲线（applyForgettingCurve）：幂等衰减，以 lastDecayAt 为基准，
*      多次维护调用不复合叠加；长期未用模式降置信直至彻底遗忘
*    - 置信度衰减：覆盖任务模式与蒸馏策略两类记忆（策略以 lastAppliedAt 为基准），
*      长期未被应用/验证的策略同样衰减直至清除
*    - 阈值自校准：委托反思引擎（reflection-engine.calibrateThreshold），
*      质量分布偏高收紧、偏低放宽，避免无效重试风暴
*/
/** outcome → 数值映射（用于决策成功率统计） */
const OUTCOME_SCORE = {
	excellent: 1,
	good: .8,
	acceptable: .6,
	poor: .3,
	failed: 0
};
/** 任务模式指纹（taskType + complexity 分桶 + 特征排序，全组件统一约定） */
function buildPatternFingerprint(taskType, complexity, features) {
	return `${taskType}::${Math.round(complexity * 10) / 10}::${[...features].sort().join(",")}`;
}
/** 条件维度 → 上下文取值（未知维度返回 undefined，保守不命中） */
function conditionValueOf(dimension, taskType, context) {
	switch (dimension) {
		case "task-type": return taskType;
		case "feature": return context.features;
		case "complexity": return context.complexity;
		case "length": return context.length;
		case "token-cost": return context.tokenCost;
		case "outcome": return context.outcome;
		case "root-cause": return context.rootCause;
		default: return;
	}
}
/** 单条件求值（actual 未知时除空值场景外均不命中） */
function evaluateMemoryCondition(actual, operator, expected) {
	if (actual === void 0) return false;
	switch (operator) {
		case "eq": return actual === expected;
		case "gt": return typeof actual === "number" && typeof expected === "number" && actual > expected;
		case "gte": return typeof actual === "number" && typeof expected === "number" && actual >= expected;
		case "lt": return typeof actual === "number" && typeof expected === "number" && actual < expected;
		case "lte": return typeof actual === "number" && typeof expected === "number" && actual <= expected;
		case "contains":
			if (typeof actual === "string") return actual.includes(String(expected));
			if (Array.isArray(actual)) return actual.includes(String(expected));
			return false;
		case "in":
			if (Array.isArray(expected)) {
				if (Array.isArray(actual)) return actual.some((a) => expected.includes(a));
				return expected.includes(String(actual));
			}
			return false;
		default: return false;
	}
}
/** 合取条件匹配：全部条件满足才返回 true（供优化器检索复用） */
function matchesMemoryConditions(conditions, taskType, context) {
	for (const cond of conditions) if (!evaluateMemoryCondition(conditionValueOf(cond.dimension, taskType, context), cond.operator, cond.value)) return false;
	return true;
}
/** 条件列表 → 归一化签名（排序后拼接，维度无关顺序） */
function conditionSignature(conditions) {
	return conditions.map((c) => `${c.dimension}:${c.operator}:${Array.isArray(c.value) ? [...c.value].sort().join("|") : String(c.value)}`).sort().join("&");
}
/** 语义记忆结构签名（domain + 结论类型 + 条件）：签名相同且结论值不同 → 规律冲突 */
function semanticSignature(m) {
	return `${m.domain}|${m.conclusion.type}|${conditionSignature(m.conditions)}`;
}
/** 模糊匹配最低相似度门槛 */
const MIN_SIMILARITY = .4;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/** 单个模式保留的成功方案上限（保留质量最高者） */
const MAX_SUCCESSFUL_PLANS = 20;
/** 单个模式保留的失败记录上限 */
const MAX_FAILURE_RECORDS = 20;
/**
* 跨会话长期记忆引擎
*
* 被 migration-tool / tenant-manager / benchmark-engine / distributed-sync 依赖。
*
* 3.0 工程升级：热路径全量索引化——record/upsert/find/get 的 O(n) 数组扫描
* 替换为 Map 索引 O(1) 查找（模式指纹 / 画像 id / 策略 id+描述 / 语义 id+陈述 /
* 程序 id+名称 / 反馈 id），写入方法同步维护索引，批量变更（prune/遗忘曲线/
* 载入）后统一重建。
*/
var LongTermMemory = class {
	persistPath;
	backend;
	store;
	persistTimer = null;
	flushOnExit;
	idxPattern = /* @__PURE__ */ new Map();
	idxProfile = /* @__PURE__ */ new Map();
	idxStrategy = /* @__PURE__ */ new Map();
	idxStrategyDesc = /* @__PURE__ */ new Map();
	idxSemantic = /* @__PURE__ */ new Map();
	idxSemanticStatement = /* @__PURE__ */ new Map();
	idxProcedural = /* @__PURE__ */ new Map();
	idxProceduralName = /* @__PURE__ */ new Map();
	idxFeedbackId = /* @__PURE__ */ new Set();
	/** 从 store 全量重建索引（构造载入 / 批量过滤后调用） */
	reindex() {
		this.idxPattern = new Map(this.store.taskPatterns.map((p) => [p.fingerprint, p]));
		this.idxProfile = new Map(this.store.modelProfiles.map((p) => [p.id, p]));
		this.idxStrategy = new Map(this.store.distilledStrategies.map((s) => [s.id, s]));
		this.idxStrategyDesc = new Map(this.store.distilledStrategies.map((s) => [s.description, s]));
		this.idxSemantic = new Map(this.store.semanticMemories.map((m) => [m.id, m]));
		this.idxSemanticStatement = new Map(this.store.semanticMemories.map((m) => [m.statement, m]));
		this.idxProcedural = new Map(this.store.proceduralMemories.map((p) => [p.id, p]));
		this.idxProceduralName = new Map(this.store.proceduralMemories.map((p) => [p.name, p]));
		this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
	}
	/** 当前持久化后端类型（sqlite / json） */
	get backendKind() {
		return this.backend.kind;
	}
	/**
	* @param persistPath 持久化文件路径（如 .scheduler/memory.json；SQLite 后端自动映射为 .db）
	* @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置（走 JSON 后端）
	*/
	constructor(persistPath, cryptoEngine) {
		this.persistPath = persistPath;
		this.backend = createMemoryBackend(persistPath, cryptoEngine);
		if (this.backend.kind === "sqlite" && fs.existsSync(persistPath)) try {
			const legacy = sanitizeMemoryStore(JSON.parse(fs.readFileSync(persistPath, "utf-8")));
			this.backend.save(legacy);
			fs.renameSync(persistPath, `${persistPath}.migrated`);
		} catch {}
		this.store = this.backend.load();
		this.reindex();
		this.flushOnExit = () => this.flushSync();
		process.once("beforeExit", this.flushOnExit);
	}
	/**
	* 模糊经验匹配：按 taskType + complexity + features 检索最相似的任务模式
	*
	* 打分公式：0.5 × taskType相似度 + 0.25 × complexity接近度 + 0.25 × features重叠度
	* 仅返回相似度 ≥ 0.4 的模式中的最优者。
	*
	* @param taskType 任务类型（如 code-generation）
	* @param complexity 复杂度 0~1
	* @param features 任务特征标签列表
	* @returns 最匹配的模式，无合格匹配时返回 undefined
	*/
	findPattern(taskType, complexity, features = []) {
		let best;
		let bestScore = 0;
		for (const pattern of this.store.taskPatterns) {
			const score = this.similarity(pattern, taskType, complexity, features);
			if (score > bestScore) {
				bestScore = score;
				best = pattern;
			}
		}
		return bestScore >= MIN_SIMILARITY ? best : void 0;
	}
	/**
	* 记录一次成功执行：沉淀任务模式 + 更新模型画像 + 全局统计
	*/
	recordSuccess(params) {
		const now = Date.now();
		const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
		let pattern = this.idxPattern.get(fingerprint);
		if (!pattern) {
			pattern = {
				fingerprint,
				taskSummary: params.taskSummary,
				frequency: 0,
				firstSeenAt: now,
				lastSeenAt: now,
				successfulPlans: [],
				failureRecords: [],
				confidence: .5,
				avgExecutionTime: 0,
				avgQualityScore: 0
			};
			this.store.taskPatterns.push(pattern);
			this.idxPattern.set(fingerprint, pattern);
		}
		pattern.frequency += 1;
		pattern.lastSeenAt = now;
		const record = {
			timestamp: now,
			plan: params.plan,
			modelAssignments: params.modelAssignments,
			totalLatency: params.totalLatency,
			qualityScores: params.qualityScores,
			tokenCost: params.tokenCost
		};
		pattern.successfulPlans.push(record);
		if (pattern.successfulPlans.length > MAX_SUCCESSFUL_PLANS) {
			pattern.successfulPlans.sort((a, b) => this.avgQuality(b.qualityScores) - this.avgQuality(a.qualityScores));
			pattern.successfulPlans = pattern.successfulPlans.slice(0, MAX_SUCCESSFUL_PLANS);
		}
		pattern.confidence = Math.min(.99, pattern.confidence + .05);
		pattern.avgExecutionTime = this.avg(pattern.successfulPlans.map((p) => p.totalLatency));
		pattern.avgQualityScore = this.avg(pattern.successfulPlans.map((p) => this.avgQuality(p.qualityScores)));
		pattern.bestModelCombination = { ...params.modelAssignments };
		Object.values(params.qualityScores);
		for (const [nodeId, modelId] of Object.entries(params.modelAssignments)) {
			const quality = params.qualityScores[nodeId] ?? this.avgQuality(params.qualityScores);
			this.updateModelProfile(modelId, params.taskType, true, params.totalLatency, quality, params.tokenCost);
		}
		const stats = this.store.globalStats;
		stats.totalExecutions += 1;
		stats.totalSuccesses += 1;
		stats.totalTokensUsed += params.tokenCost;
		stats.totalCostEstimate += params.tokenCost * .001;
		stats.averageQualityScore = this.rollingAvg(stats.averageQualityScore, this.avgQuality(params.qualityScores), stats.totalSuccesses);
		stats.averageExecutionTime = this.rollingAvg(stats.averageExecutionTime, params.totalLatency, stats.totalSuccesses);
		this.schedulePersist();
	}
	/**
	* 记录一次失败执行
	*/
	recordFailure(params) {
		const now = Date.now();
		const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
		let pattern = this.idxPattern.get(fingerprint);
		if (!pattern) {
			pattern = {
				fingerprint,
				taskSummary: `[失败] ${params.taskType}: ${params.reason}`,
				frequency: 0,
				firstSeenAt: now,
				lastSeenAt: now,
				successfulPlans: [],
				failureRecords: [],
				confidence: .5,
				avgExecutionTime: 0,
				avgQualityScore: 0
			};
			this.store.taskPatterns.push(pattern);
			this.idxPattern.set(fingerprint, pattern);
		}
		pattern.frequency += 1;
		pattern.lastSeenAt = now;
		pattern.failureRecords.push({
			timestamp: now,
			reason: params.reason,
			failedNodeId: params.failedNodeId,
			failedModelId: params.failedModelId,
			errorMessage: params.errorMessage
		});
		if (pattern.failureRecords.length > MAX_FAILURE_RECORDS) pattern.failureRecords = pattern.failureRecords.slice(-20);
		pattern.confidence = Math.max(.01, pattern.confidence - .08);
		this.updateModelProfile(params.failedModelId, params.taskType, false, 0, 0, 0);
		this.store.globalStats.totalExecutions += 1;
		this.store.globalStats.totalFailures += 1;
		this.schedulePersist();
	}
	/**
	* 记录一次决策反馈（execute/defer/dismiss/ask-user 的结果复盘）
	*/
	recordDecisionFeedback(params) {
		const feedback = {
			id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: Date.now(),
			...params
		};
		this.store.decisionFeedback.push(feedback);
		this.idxFeedbackId.add(feedback.id);
		if (this.store.decisionFeedback.length > 500) {
			this.store.decisionFeedback = this.store.decisionFeedback.slice(-500);
			this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
		}
		this.schedulePersist();
	}
	/** 获取全局统计 */
	getGlobalStats() {
		return { ...this.store.globalStats };
	}
	/**
	* 获取置信度最高的任务模式
	* @param limit 返回数量上限，默认 10
	*/
	getTopPatterns(limit = 10) {
		return [...this.store.taskPatterns].sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency).slice(0, limit);
	}
	/** 获取指定模型画像 */
	getModelProfile(modelId) {
		return this.idxProfile.get(modelId);
	}
	/**
	* 贝叶斯能力估计（2.0：模型 × 任务类型的 Beta 后验推断）
	*
	* 时间加权证据 → Beta(1+ws, 1+wf) 后验：
	* - posteriorMean：调度预测置信度来源（校准闭环素材）
	* - wilsonLower：小样本保守的利用端评分依据
	* - drift：近期成功率 - 裸成功率，感知模型能力漂移（升级/降级）
	*
	* 读取零额外开销（衰减在写入时惰性完成）；旧持久化字段缺失时
	* 回退裸计数（半衰期从查询时刻起步，下次写入完成初始化）。
	*/
	getBayesianEstimate(modelId, taskType) {
		const profile = this.idxProfile.get(modelId);
		const history = profile?.taskHistory[taskType];
		if (!profile || !history) return void 0;
		const legacy = history.weightedSuccesses === void 0 || history.weightedFailures === void 0;
		const rawWs = history.weightedSuccesses ?? history.successCount;
		const rawWf = history.weightedFailures ?? history.totalCalls - history.successCount;
		const legacyDiscount = legacy ? .5 : 1;
		const ws = rawWs * legacyDiscount;
		const wf = rawWf * legacyDiscount;
		const alpha = ws + 1;
		const beta = wf + 1;
		const posteriorMean = alpha / (alpha + beta);
		const effectiveSamples = ws + wf;
		const rawSuccessRate = history.totalCalls > 0 ? history.successCount / history.totalCalls : 0;
		const weightedRate = effectiveSamples > 0 ? ws / effectiveSamples : 0;
		const elapsedSinceDecay = Math.max(0, Date.now() - (history.lastDecayedAt ?? history.lastCalledAt ?? Date.now()));
		const decayedSamples = effectiveSamples * Math.pow(.5, elapsedSinceDecay / 2592e6);
		return {
			modelId,
			taskType,
			alpha: Number(alpha.toFixed(6)),
			beta: Number(beta.toFixed(6)),
			posteriorMean: Number(posteriorMean.toFixed(6)),
			wilsonLower: Number(wilsonLowerBound(ws, wf).toFixed(6)),
			effectiveSamples: Number(decayedSamples.toFixed(6)),
			rawSuccessRate: Number(rawSuccessRate.toFixed(6)),
			drift: effectiveSamples >= 2 ? Number((weightedRate - rawSuccessRate).toFixed(6)) : 0,
			emaQuality: history.emaQuality ?? 0
		};
	}
	/** 获取全部模型画像 */
	getAllModelProfiles() {
		return [...this.store.modelProfiles];
	}
	/** 获取全部任务模式（迁移导出用） */
	getAllTaskPatterns() {
		return [...this.store.taskPatterns];
	}
	/** 获取全部决策反馈（迁移导出用） */
	getAllDecisionFeedback() {
		return [...this.store.decisionFeedback];
	}
	/**
	* 插入或更新任务模式（迁移导入用）
	* @returns 'created' 新增 / 'updated' 覆盖
	*/
	upsertPattern(pattern) {
		const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === pattern.fingerprint);
		if (index >= 0) {
			this.store.taskPatterns[index] = pattern;
			this.idxPattern.set(pattern.fingerprint, pattern);
			this.schedulePersist();
			return "updated";
		}
		this.store.taskPatterns.push(pattern);
		this.idxPattern.set(pattern.fingerprint, pattern);
		this.schedulePersist();
		return "created";
	}
	/**
	* 按指纹删除任务模式（分布式同步 pattern-deleted 变更用）
	* @returns 是否实际删除
	*/
	removePattern(fingerprint) {
		const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === fingerprint);
		if (index < 0) return false;
		this.store.taskPatterns.splice(index, 1);
		this.idxPattern.delete(fingerprint);
		this.schedulePersist();
		return true;
	}
	/**
	* 插入或更新模型画像（迁移导入用）
	* @returns 'created' 新增 / 'updated' 覆盖
	*/
	upsertModelProfile(profile) {
		const index = this.store.modelProfiles.findIndex((p) => p.id === profile.id);
		if (index >= 0) {
			this.store.modelProfiles[index] = profile;
			this.idxProfile.set(profile.id, profile);
			this.schedulePersist();
			return "updated";
		}
		this.store.modelProfiles.push(profile);
		this.idxProfile.set(profile.id, profile);
		this.schedulePersist();
		return "created";
	}
	/**
	* 追加一条决策反馈（迁移导入用，按 id 去重）
	* @returns 是否实际写入（重复 id 返回 false）
	*/
	appendFeedback(feedback) {
		if (this.idxFeedbackId.has(feedback.id)) return false;
		this.store.decisionFeedback.push(feedback);
		this.idxFeedbackId.add(feedback.id);
		this.schedulePersist();
		return true;
	}
	/**
	* 累加式合并全局统计（迁移导入用）
	* 计数类字段相加，均值类字段按执行次数加权平均
	*/
	mergeGlobalStats(incoming) {
		const local = this.store.globalStats;
		const totalExec = local.totalExecutions + incoming.totalExecutions;
		const totalSucc = local.totalSuccesses + incoming.totalSuccesses;
		const mergedAvg = (a, aWeight, b, bWeight) => {
			const w = aWeight + bWeight;
			return w > 0 ? (a * aWeight + b * bWeight) / w : 0;
		};
		local.averageQualityScore = mergedAvg(local.averageQualityScore, local.totalSuccesses, incoming.averageQualityScore, incoming.totalSuccesses);
		local.averageExecutionTime = mergedAvg(local.averageExecutionTime, local.totalExecutions, incoming.averageExecutionTime, incoming.totalExecutions);
		local.totalExecutions = totalExec;
		local.totalSuccesses = totalSucc;
		local.totalFailures += incoming.totalFailures;
		local.totalTokensUsed += incoming.totalTokensUsed;
		local.totalCostEstimate += incoming.totalCostEstimate;
		this.schedulePersist();
	}
	/**
	* 获取最近的决策反馈
	* @param limit 返回数量上限，默认 20
	*/
	getRecentFeedback(limit = 20) {
		return this.store.decisionFeedback.slice(-limit).reverse();
	}
	/**
	* 统计某类信号的决策成功率
	* @param signalType 信号类型
	*/
	getDecisionSuccessRate(signalType) {
		const relevant = this.store.decisionFeedback.filter((f) => f.signalType === signalType);
		if (relevant.length === 0) return {
			total: 0,
			successRate: 0,
			avgOutcome: "n/a"
		};
		const scores = relevant.map((f) => OUTCOME_SCORE[f.outcome]);
		const avgScore = this.avg(scores);
		const successRate = scores.filter((s) => s >= .6).length / scores.length;
		const avgOutcome = Object.entries(OUTCOME_SCORE).sort((a, b) => Math.abs(a[1] - avgScore) - Math.abs(b[1] - avgScore))[0][0];
		return {
			total: relevant.length,
			successRate,
			avgOutcome
		};
	}
	/**
	* 生成记忆库人类可读摘要（供 query_memory Tool 使用）
	*/
	getMemorySummary() {
		const s = this.store.globalStats;
		const successRate = s.totalExecutions > 0 ? (s.totalSuccesses / s.totalExecutions * 100).toFixed(1) : "0";
		const topPatterns = this.getTopPatterns(3).map((p) => `  - ${p.taskSummary}（置信度 ${p.confidence.toFixed(2)}，出现 ${p.frequency} 次）`).join("\n");
		const profiles = this.store.modelProfiles.map((p) => `  - ${p.id}: 最佳 ${p.bestTaskType || "-"} / 最差 ${p.worstTaskType || "-"} / 稳定性 ${p.stability.toFixed(2)}`).join("\n");
		return [
			`📊 记忆库摘要`,
			`总执行: ${s.totalExecutions} | 成功: ${s.totalSuccesses} | 失败: ${s.totalFailures} | 成功率: ${successRate}%`,
			`总 token: ${s.totalTokensUsed} | 估算成本: ${s.totalCostEstimate.toFixed(4)}`,
			`平均质量分: ${s.averageQualityScore.toFixed(3)} | 平均耗时: ${Math.round(s.averageExecutionTime)}ms`,
			`任务模式数: ${this.store.taskPatterns.length} | 模型画像数: ${this.store.modelProfiles.length} | 决策反馈数: ${this.store.decisionFeedback.length} | 蒸馏策略数: ${this.store.distilledStrategies.length} | 语义记忆数: ${this.store.semanticMemories.length} | 程序记忆数: ${this.store.proceduralMemories.length}`,
			topPatterns ? `Top 任务模式:\n${topPatterns}` : "",
			profiles ? `模型画像:\n${profiles}` : ""
		].filter(Boolean).join("\n");
	}
	/**
	* 清理过期记忆
	* @param maxAgeDays 最大保留天数，默认 90
	* @returns 被清理的条目数
	*/
	prune(maxAgeDays = 90) {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3;
		let pruned = 0;
		const beforePatterns = this.store.taskPatterns.length;
		this.store.taskPatterns = this.store.taskPatterns.filter((p) => p.lastSeenAt >= cutoff);
		pruned += beforePatterns - this.store.taskPatterns.length;
		const beforeFeedback = this.store.decisionFeedback.length;
		this.store.decisionFeedback = this.store.decisionFeedback.filter((f) => f.timestamp >= cutoff);
		pruned += beforeFeedback - this.store.decisionFeedback.length;
		if (pruned > 0) {
			this.reindex();
			this.schedulePersist();
		}
		return pruned;
	}
	/**
	* 经验蒸馏：从高置信度任务模式中提炼可复用策略
	*
	* 蒸馏规则：
	* 1. 模型偏好策略：某模型在该任务类型的成功方案中出现占比 ≥ 60% → 偏好策略
	* 2. 并行策略：成功方案的 parallelismStrategy 众数 → 并行偏好
	* 3. 仅蒸馏 confidence ≥ 0.6 且成功次数 ≥ 3 的模式，保证策略可靠性
	*
	* @param minConfidence 参与蒸馏的最低模式置信度，默认 0.6
	* @returns 本次新蒸馏的策略列表
	*/
	distillExperience(minConfidence = .6) {
		const fresh = [];
		const now = Date.now();
		/** 策略 id 铸币：同毫秒内多次蒸馏时保证全局唯一（防 memory_vectors ref_id 冲突） */
		const mintStrategyId = (infix) => {
			let seq = this.store.distilledStrategies.length + fresh.length;
			let id = `strategy-${now}-${infix}${seq}`;
			while (this.idxStrategy.has(id) || fresh.some((s) => s.id === id)) {
				seq += 1;
				id = `strategy-${now}-${infix}${seq}`;
			}
			return id;
		};
		for (const pattern of this.store.taskPatterns) {
			if (pattern.confidence < minConfidence || pattern.successfulPlans.length < 3) continue;
			const taskType = pattern.taskSummary.split(":")[0].replace("[失败] ", "").trim() || "general";
			const modelWins = /* @__PURE__ */ new Map();
			let totalAssignments = 0;
			for (const plan of pattern.successfulPlans) for (const modelId of Object.values(plan.modelAssignments)) {
				modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
				totalAssignments += 1;
			}
			if (totalAssignments > 0) for (const [modelId, wins] of modelWins) {
				const ratio = wins / totalAssignments;
				if (ratio >= .6) {
					const description = `${taskType} 类任务优先使用模型 ${modelId}（成功方案占比 ${(ratio * 100).toFixed(0)}%）`;
					if (!this.hasStrategy(description)) {
						const strategy = {
							id: mintStrategyId(""),
							taskType,
							description,
							sourceFingerprint: pattern.fingerprint,
							supportCount: wins,
							confidence: Math.min(.95, pattern.confidence * ratio + .1),
							distilledAt: now,
							appliedSuccesses: 0,
							appliedTotal: 0,
							evidence: initEvidence(wins, wins, now)
						};
						this.store.distilledStrategies.push(strategy);
						this.idxStrategy.set(strategy.id, strategy);
						this.idxStrategyDesc.set(strategy.description, strategy);
						fresh.push(strategy);
					}
				}
			}
			const strategyCounts = /* @__PURE__ */ new Map();
			for (const plan of pattern.successfulPlans) strategyCounts.set(plan.plan.parallelismStrategy, (strategyCounts.get(plan.plan.parallelismStrategy) ?? 0) + 1);
			let bestStrategy = "";
			let bestCount = 0;
			for (const [strategy, count] of strategyCounts) if (count > bestCount) {
				bestCount = count;
				bestStrategy = strategy;
			}
			if (bestStrategy && bestCount / pattern.successfulPlans.length >= .6) {
				const description = `${taskType} 类任务推荐 ${bestStrategy} 并行策略（${bestCount}/${pattern.successfulPlans.length} 次成功）`;
				if (!this.hasStrategy(description)) {
					const strategy = {
						id: mintStrategyId("p"),
						taskType,
						description,
						sourceFingerprint: pattern.fingerprint,
						supportCount: bestCount,
						confidence: Math.min(.9, pattern.confidence * .9),
						distilledAt: now,
						appliedSuccesses: 0,
						appliedTotal: 0,
						evidence: initEvidence(bestCount, bestCount, now)
					};
					this.store.distilledStrategies.push(strategy);
					this.idxStrategy.set(strategy.id, strategy);
					this.idxStrategyDesc.set(strategy.description, strategy);
					fresh.push(strategy);
				}
			}
		}
		if (fresh.length > 0) this.schedulePersist();
		return fresh;
	}
	/**
	* 获取指定任务类型的蒸馏策略（3.0：按证据化排序分降序——confidence × Wilson 下界等权混合）
	* @param taskType 任务类型
	* @param limit 返回上限
	*/
	getStrategies(taskType, limit = 5) {
		const now = Date.now();
		return this.store.distilledStrategies.filter((s) => s.taskType === taskType).sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now)).slice(0, limit);
	}
	/** 全部蒸馏策略 */
	getAllStrategies() {
		return [...this.store.distilledStrategies];
	}
	/**
	* 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
	*
	* 3.0：同步观测统一证据（时间加权 Beta）——旧实体首次观测时从
	* 裸计数折价初始化，与模型画像 legacy 回退语义一致。
	*
	* @param strategyId 策略 id
	* @param success 本次应用是否成功
	*/
	recordStrategyOutcome(strategyId, success) {
		const strategy = this.idxStrategy.get(strategyId);
		if (!strategy) return;
		const now = Date.now();
		if (!strategy.evidence) strategy.evidence = initEvidence(strategy.appliedSuccesses, strategy.appliedTotal, now);
		strategy.appliedTotal += 1;
		strategy.lastAppliedAt = now;
		if (success) strategy.appliedSuccesses += 1;
		observeEvidence(strategy.evidence, success, now);
		const appliedRate = strategy.appliedSuccesses / strategy.appliedTotal;
		strategy.confidence = strategy.confidence * .7 + appliedRate * .3;
		this.schedulePersist();
	}
	/**
	* 查找匹配的语义记忆
	*
	* 匹配规则：taskTypes 包含目标 taskType（或为空表示通用）+ conditions 全部满足。
	* 多条命中时按置信度降序返回最优。
	*
	* @param taskType 任务类型
	* @param context 条件上下文（任务特征 / 复杂度 / 长度等）
	* @returns 最匹配的语义记忆，无命中时 undefined
	*/
	findSemanticMemory(taskType, context = {}) {
		const now = Date.now();
		const candidates = this.store.semanticMemories.filter((m) => m.taskTypes.length === 0 || m.taskTypes.includes(taskType));
		let best;
		let bestScore = 0;
		for (const mem of candidates) {
			if (!this.matchConditions(mem.conditions, taskType, context)) continue;
			const supportBoost = Math.min(1.5, 1 + Math.log10(1 + mem.supportCount) * .15);
			const score = evidenceRankScore(mem.confidence, mem.evidence, now) * supportBoost;
			if (score > bestScore) {
				bestScore = score;
				best = mem;
			}
		}
		return best;
	}
	/** 获取指定任务类型的语义记忆（3.0：按证据化排序分降序） */
	getSemanticMemories(taskType, limit = 5) {
		const now = Date.now();
		return this.store.semanticMemories.filter((m) => m.taskTypes.length === 0 || m.taskTypes.includes(taskType)).sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now)).slice(0, limit);
	}
	/** 全部语义记忆 */
	getAllSemanticMemories() {
		return [...this.store.semanticMemories];
	}
	/**
	* 插入或更新语义记忆（第二阶段升级：证据合并增强 + 冲突消解）
	*
	* 写入语义（按优先级判定）：
	* 1. 冲突消解：同结构签名（domain + 结论类型 + 条件）但结论值不同 →
	*    新证据支撑 ≥ 旧证据 1.5 倍且 ≥ 3 时取代旧规律（'superseded'），否则丢弃（'duplicate'）
	* 2. 证据合并：同 id 或同 statement 的既有规律 → 不再丢弃新证据，而是
	*    支撑数累加、置信度按证据加权、溯源指纹取并集、衰减基准重置（'merged'）
	* 3. 同 id 直接覆盖（'updated'） / 新增（'created'）
	*
	* @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
	*/
	upsertSemanticMemory(memory) {
		const signature = semanticSignature(memory);
		const conflicting = this.store.semanticMemories.find((m) => m.id !== memory.id && semanticSignature(m) === signature && m.conclusion.value !== memory.conclusion.value);
		if (conflicting) {
			if (memory.supportCount >= conflicting.supportCount * 1.5 && memory.supportCount >= 3) {
				const superseded = {
					...memory,
					supportCount: memory.supportCount + conflicting.supportCount,
					sourceFingerprints: [.../* @__PURE__ */ new Set([...memory.sourceFingerprints, ...conflicting.sourceFingerprints])].slice(0, 50),
					appliedTotal: conflicting.appliedTotal,
					appliedSuccesses: conflicting.appliedSuccesses,
					lastAppliedAt: conflicting.lastAppliedAt,
					evidence: memory.evidence ?? conflicting.evidence
				};
				this.store.semanticMemories[this.store.semanticMemories.indexOf(conflicting)] = superseded;
				this.idxSemantic.delete(conflicting.id);
				this.idxSemanticStatement.delete(conflicting.statement);
				this.idxSemantic.set(superseded.id, superseded);
				this.idxSemanticStatement.set(superseded.statement, superseded);
				this.schedulePersist();
				return "superseded";
			}
			return "duplicate";
		}
		const existing = this.idxSemantic.get(memory.id) ?? this.idxSemanticStatement.get(memory.statement);
		if (existing && existing.id === memory.id) {
			const replacement = memory.appliedTotal === 0 && (existing.appliedTotal > 0 || existing.appliedSuccesses > 0) ? {
				...memory,
				appliedTotal: existing.appliedTotal,
				appliedSuccesses: existing.appliedSuccesses,
				lastAppliedAt: existing.lastAppliedAt
			} : memory;
			if (!replacement.evidence && existing.evidence) replacement.evidence = existing.evidence;
			this.store.semanticMemories[this.store.semanticMemories.indexOf(existing)] = replacement;
			if (existing.statement !== replacement.statement) this.idxSemanticStatement.delete(existing.statement);
			this.idxSemantic.set(replacement.id, replacement);
			this.idxSemanticStatement.set(replacement.statement, replacement);
			this.schedulePersist();
			return "updated";
		}
		if (existing) {
			const totalSupport = existing.supportCount + memory.supportCount;
			existing.confidence = Math.min(.98, (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport));
			existing.supportCount = totalSupport;
			existing.sourceFingerprints = [.../* @__PURE__ */ new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
			existing.taskTypes = [.../* @__PURE__ */ new Set([...existing.taskTypes, ...memory.taskTypes])];
			if (existing.statement !== memory.statement) {
				this.idxSemanticStatement.delete(existing.statement);
				existing.statement = memory.statement;
				this.idxSemanticStatement.set(existing.statement, existing);
			}
			existing.conclusion = memory.conclusion;
			existing.distilledAt = memory.distilledAt;
			existing.lastDecayAt = memory.distilledAt;
			if (memory.evidence) {
				if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
				existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
				existing.evidence.weightedFailures += memory.evidence.weightedFailures;
				existing.evidence.lastDecayedAt = memory.distilledAt;
			}
			this.schedulePersist();
			return "merged";
		}
		this.store.semanticMemories.push(memory);
		this.idxSemantic.set(memory.id, memory);
		this.idxSemanticStatement.set(memory.statement, memory);
		this.schedulePersist();
		return "created";
	}
	/** 按指纹溯源删除语义记忆（分布式同步用；3.0 索引同步删除） */
	removeSemanticMemory(id) {
		const mem = this.idxSemantic.get(id);
		if (!mem) return false;
		const index = this.store.semanticMemories.indexOf(mem);
		if (index < 0) return false;
		this.store.semanticMemories.splice(index, 1);
		this.idxSemantic.delete(id);
		if (this.idxSemanticStatement.get(mem.statement) === mem) this.idxSemanticStatement.delete(mem.statement);
		this.schedulePersist();
		return true;
	}
	/** 语义记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
	recordSemanticOutcome(id, success) {
		const mem = this.idxSemantic.get(id);
		if (!mem) return;
		const now = Date.now();
		if (!mem.evidence) mem.evidence = initEvidence(mem.appliedSuccesses, mem.appliedTotal, now);
		mem.appliedTotal += 1;
		mem.lastAppliedAt = now;
		if (success) mem.appliedSuccesses += 1;
		observeEvidence(mem.evidence, success, now);
		const appliedRate = mem.appliedSuccesses / mem.appliedTotal;
		mem.confidence = mem.confidence * .7 + appliedRate * .3;
		this.schedulePersist();
	}
	/**
	* 查找匹配的程序记忆
	*
	* 匹配规则：kind 匹配 + taskTypes 适配 + conditions 合取全部满足。
	* 多条命中时按置信度降序返回最优。
	*
	* @param kind 规则类别（scheduling / reflection）
	* @param taskType 任务类型
	* @param context 条件上下文
	*/
	findProceduralMemory(kind, taskType, context = {}) {
		const candidates = this.store.proceduralMemories.filter((p) => p.kind === kind && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType)));
		let best;
		let bestScore = 0;
		const now = Date.now();
		for (const proc of candidates) {
			if (!this.matchProceduralConditions(proc.conditions, taskType, context)) continue;
			const supportBoost = Math.min(1.5, 1 + Math.log10(1 + proc.supportCount) * .15);
			const score = evidenceRankScore(proc.confidence, proc.evidence, now) * supportBoost;
			if (score > bestScore) {
				bestScore = score;
				best = proc;
			}
		}
		return best;
	}
	/** 获取指定任务类型的程序记忆（3.0：按证据化排序分降序） */
	getProceduralMemories(taskType, kind, limit = 5) {
		const now = Date.now();
		return this.store.proceduralMemories.filter((p) => (kind ? p.kind === kind : true) && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType))).sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now)).slice(0, limit);
	}
	/** 全部程序记忆 */
	getAllProceduralMemories() {
		return [...this.store.proceduralMemories];
	}
	/**
	* 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
	*
	* 冲突判定：同结构签名（kind + 动作类型 + 目标模型维度 + 条件）但目标模型不同
	* （如"长代码任务偏好模型A" vs "偏好模型B"）→ 新证据显著更强时取代，否则丢弃。
	*
	* @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
	*/
	upsertProceduralMemory(memory) {
		const conditionSig = conditionSignature(memory.conditions);
		const realConflicting = this.store.proceduralMemories.find((p) => {
			if (p.id === memory.id) return false;
			if (p.kind !== memory.kind || p.action.type !== memory.action.type) return false;
			if (conditionSignature(p.conditions) !== conditionSig) return false;
			const targetA = p.action.params["model"];
			const targetB = memory.action.params["model"];
			return typeof targetA === "string" && typeof targetB === "string" && targetA !== targetB;
		});
		if (realConflicting) {
			if (memory.supportCount >= realConflicting.supportCount * 1.5 && memory.supportCount >= 3) {
				const superseded = {
					...memory,
					supportCount: memory.supportCount + realConflicting.supportCount,
					sourceFingerprints: [.../* @__PURE__ */ new Set([...memory.sourceFingerprints, ...realConflicting.sourceFingerprints])].slice(0, 50),
					appliedTotal: realConflicting.appliedTotal,
					appliedSuccesses: realConflicting.appliedSuccesses,
					lastAppliedAt: realConflicting.lastAppliedAt,
					evidence: memory.evidence ?? realConflicting.evidence
				};
				this.store.proceduralMemories[this.store.proceduralMemories.indexOf(realConflicting)] = superseded;
				this.idxProcedural.delete(realConflicting.id);
				this.idxProceduralName.delete(realConflicting.name);
				this.idxProcedural.set(superseded.id, superseded);
				this.idxProceduralName.set(superseded.name, superseded);
				this.schedulePersist();
				return "superseded";
			}
			return "duplicate";
		}
		const existing = this.idxProcedural.get(memory.id) ?? this.idxProceduralName.get(memory.name);
		if (existing && existing.id === memory.id) {
			if (!memory.evidence && existing.evidence) memory.evidence = existing.evidence;
			this.store.proceduralMemories[this.store.proceduralMemories.indexOf(existing)] = memory;
			if (existing.name !== memory.name) this.idxProceduralName.delete(existing.name);
			this.idxProcedural.set(memory.id, memory);
			this.idxProceduralName.set(memory.name, memory);
			this.schedulePersist();
			return "updated";
		}
		if (existing) {
			const totalSupport = existing.supportCount + memory.supportCount;
			existing.confidence = Math.min(.98, (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport));
			existing.supportCount = totalSupport;
			existing.sourceFingerprints = [.../* @__PURE__ */ new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
			existing.taskTypes = [.../* @__PURE__ */ new Set([...existing.taskTypes, ...memory.taskTypes])];
			if (existing.name !== memory.name) {
				this.idxProceduralName.delete(existing.name);
				existing.name = memory.name;
				this.idxProceduralName.set(existing.name, existing);
			}
			existing.action = memory.action;
			existing.distilledAt = memory.distilledAt;
			existing.lastDecayAt = memory.distilledAt;
			if (memory.evidence) {
				if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
				existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
				existing.evidence.weightedFailures += memory.evidence.weightedFailures;
				existing.evidence.lastDecayedAt = memory.distilledAt;
			}
			this.schedulePersist();
			return "merged";
		}
		this.store.proceduralMemories.push(memory);
		this.idxProcedural.set(memory.id, memory);
		this.idxProceduralName.set(memory.name, memory);
		this.schedulePersist();
		return "created";
	}
	/** 删除程序记忆（3.0 索引同步删除） */
	removeProceduralMemory(id) {
		const proc = this.idxProcedural.get(id);
		if (!proc) return false;
		const index = this.store.proceduralMemories.indexOf(proc);
		if (index < 0) return false;
		this.store.proceduralMemories.splice(index, 1);
		this.idxProcedural.delete(id);
		if (this.idxProceduralName.get(proc.name) === proc) this.idxProceduralName.delete(proc.name);
		this.schedulePersist();
		return true;
	}
	/** 程序记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
	recordProceduralOutcome(id, success) {
		const proc = this.idxProcedural.get(id);
		if (!proc) return;
		const now = Date.now();
		if (!proc.evidence) proc.evidence = initEvidence(proc.appliedSuccesses, proc.appliedTotal, now);
		proc.appliedTotal += 1;
		proc.lastAppliedAt = now;
		if (success) proc.appliedSuccesses += 1;
		observeEvidence(proc.evidence, success, now);
		const appliedRate = proc.appliedSuccesses / proc.appliedTotal;
		proc.confidence = proc.confidence * .7 + appliedRate * .3;
		this.schedulePersist();
	}
	/**
	* 情景事件水位：距上次知识蒸馏新增了多少情景事件（成功+失败均计）
	*
	* 反思器据此实现"达到阈值时自动蒸馏"，替代纯周期触发，
	* 高负载时更快沉淀知识、低负载时不做无效全量蒸馏。
	* 水位持久化于 globalStats.lastDistillationEventCount（重启不丢）。
	*/
	getDistillationProgress() {
		const episodicEventCount = this.store.globalStats.totalExecutions;
		const lastDistillationEventCount = this.store.globalStats.lastDistillationEventCount ?? episodicEventCount;
		return {
			episodicEventCount,
			lastDistillationEventCount,
			pendingSinceLastDistillation: Math.max(0, episodicEventCount - lastDistillationEventCount)
		};
	}
	/** 蒸馏完成检查点：刷新水位（供 distillKnowledge 成功后调用） */
	noteDistillationCheckpoint() {
		this.store.globalStats.lastDistillationEventCount = this.store.globalStats.totalExecutions;
		this.schedulePersist();
	}
	/**
	* 证据普查（3.0：自知之明报告——全层不确定性一览）
	*
	* 系统级自检 API：
	* - 各记忆层的证据覆盖度（withEvidence / total）、平均有效样本量、证据枯竭数
	* - 模型画像层基于既有时间加权证据换算（legacy 裸计数折价，口径与 getBayesianEstimate 一致）
	* - 能力漂移检测：|drift| > 0.1 且有效样本 ≥ 5 的模型 × 任务组合
	*   （模型修复被察觉 / 模型退化被预警）
	*/
	evidenceCensus() {
		const now = Date.now();
		const layerOf = (layer, items) => {
			let withEvidence = 0;
			let exhausted = 0;
			let totalSamples = 0;
			for (const item of items) {
				if (!item.evidence) continue;
				withEvidence += 1;
				const view = readEvidence(item.evidence, now);
				totalSamples += view.effectiveSamples;
				if (view.effectiveSamples < 1) exhausted += 1;
			}
			return {
				layer,
				total: items.length,
				withEvidence,
				avgEffectiveSamples: items.length > 0 ? Number((totalSamples / items.length).toFixed(3)) : 0,
				evidenceExhausted: exhausted
			};
		};
		const profileItems = [];
		for (const profile of this.store.modelProfiles) for (const history of Object.values(profile.taskHistory)) {
			const legacy = history.weightedSuccesses === void 0 || history.weightedFailures === void 0;
			profileItems.push({ evidence: {
				weightedSuccesses: (history.weightedSuccesses ?? history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
				weightedFailures: (history.weightedFailures ?? history.totalCalls - history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
				lastDecayedAt: history.lastDecayedAt ?? history.lastCalledAt ?? now
			} });
		}
		const driftedModels = [];
		for (const profile of this.store.modelProfiles) for (const taskType of Object.keys(profile.taskHistory)) {
			const est = this.getBayesianEstimate(profile.id, taskType);
			if (!est || est.effectiveSamples < 5 || Math.abs(est.drift) <= .1) continue;
			driftedModels.push({
				modelId: profile.id,
				taskType,
				drift: est.drift,
				effectiveSamples: est.effectiveSamples,
				posteriorMean: est.posteriorMean
			});
		}
		return {
			generatedAt: now,
			layers: [
				layerOf("strategy", this.store.distilledStrategies),
				layerOf("semantic", this.store.semanticMemories),
				layerOf("procedural", this.store.proceduralMemories),
				layerOf("model-profile", profileItems)
			],
			driftedModels
		};
	}
	/**
	* 通用条件匹配（语义记忆用，第二阶段升级：委托导出的纯函数 matchesMemoryConditions，
	* 与优化器检索共用同一套求值语义，避免两处实现漂移）
	*/
	matchConditions(conditions, taskType, context) {
		return matchesMemoryConditions(conditions, taskType, context);
	}
	/** 程序记忆条件匹配（含 outcome/root-cause 维度） */
	matchProceduralConditions(conditions, taskType, context) {
		return matchesMemoryConditions(conditions, taskType, context);
	}
	/**
	* 遗忘曲线（对冲机制一）：按艾宾浩斯衰减模型对长期未使用的记忆降低置信度
	*
	* 覆盖四类记忆：任务模式（基准 lastSeenAt）、蒸馏策略（基准 lastAppliedAt）、
	* 语义记忆与程序记忆（基准 lastAppliedAt，第二阶段新增）。
	*
	* 幂等性（关键修正）：衰减以 lastDecayAt 为基准计算"自上次衰减以来的闲置天数"，
	* 而非自 lastSeenAt 起的累计天数——否则高频维护调用会把同一段闲置时间
	* 重复计入，导致复合叠加过度衰减。多次调用只推进衰减窗口，不重复惩罚。
	*
	* 衰减公式：confidence ×= 0.5 ^ (daysIdle / effectiveHalfLife)
	* - 高频模式（frequency 高）半衰期更长，不易遗忘
	* - 置信度低于 forgetThreshold 的记忆直接清除（彻底遗忘）
	*
	* @param halfLifeDays 基准半衰期（天），默认 30
	* @param forgetThreshold 低于该置信度彻底遗忘，默认 0.2
	* @returns { decayed: 衰减的记忆数, forgotten: 彻底遗忘的记忆数 }
	*/
	applyForgettingCurve(halfLifeDays = 30, forgetThreshold = .2) {
		const now = Date.now();
		const DAY = 864e5;
		let decayed = 0;
		let forgotten = 0;
		const survivors = [];
		for (const pattern of this.store.taskPatterns) {
			const daysIdle = (now - (pattern.lastDecayAt ?? pattern.lastSeenAt)) / DAY;
			if (daysIdle < 1) {
				survivors.push(pattern);
				continue;
			}
			const effectiveHalfLife = halfLifeDays * Math.min(3, 1 + pattern.frequency / 10);
			const decayFactor = Math.pow(.5, daysIdle / effectiveHalfLife);
			const newConfidence = pattern.confidence * decayFactor;
			if (newConfidence < forgetThreshold) {
				forgotten += 1;
				continue;
			}
			if (newConfidence < pattern.confidence - .001) {
				pattern.confidence = newConfidence;
				decayed += 1;
			}
			pattern.lastDecayAt = now;
			survivors.push(pattern);
		}
		const strategySurvivors = [];
		for (const strategy of this.store.distilledStrategies) {
			const daysIdle = (now - (strategy.lastAppliedAt ?? strategy.distilledAt)) / DAY;
			if (daysIdle < 1) {
				strategySurvivors.push(strategy);
				continue;
			}
			const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + strategy.supportCount / 20);
			const decayFactor = Math.pow(.5, daysIdle / effectiveHalfLife);
			const newConfidence = strategy.confidence * decayFactor;
			if (newConfidence < forgetThreshold) {
				forgotten += 1;
				continue;
			}
			if (newConfidence < strategy.confidence - .001) {
				strategy.confidence = newConfidence;
				decayed += 1;
			}
			strategy.lastAppliedAt = now;
			strategySurvivors.push(strategy);
		}
		const semanticSurvivors = this.decayMemory(this.store.semanticMemories, halfLifeDays, forgetThreshold, now, DAY, (count) => forgotten += count, (count) => decayed += count);
		const proceduralSurvivors = this.decayMemory(this.store.proceduralMemories, halfLifeDays, forgetThreshold, now, DAY, (count) => forgotten += count, (count) => decayed += count);
		if (forgotten > 0 || decayed > 0) {
			this.store.taskPatterns = survivors;
			this.store.distilledStrategies = strategySurvivors;
			this.store.semanticMemories = semanticSurvivors;
			this.store.proceduralMemories = proceduralSurvivors;
			this.reindex();
			this.schedulePersist();
		}
		return {
			decayed,
			forgotten
		};
	}
	/**
	* 通用衰减器（供语义/程序记忆复用，结构同 DistilledStrategy 衰减逻辑）
	*
	* @param items 待衰减的记忆数组
	* @param halfLifeDays 基准半衰期
	* @param forgetThreshold 遗忘阈值
	* @param now 当前时间戳
	* @param DAY 一天的毫秒数
	* @param onForget 遗忘计数回调
	* @param onDecay 衰减计数回调
	* @returns 衰减后的存活数组
	*/
	decayMemory(items, halfLifeDays, forgetThreshold, now, DAY, onForget, onDecay) {
		const survivors = [];
		for (const item of items) {
			const daysIdle = (now - (item.lastDecayAt ?? item.lastAppliedAt ?? item.distilledAt)) / DAY;
			if (daysIdle < 1) {
				survivors.push(item);
				continue;
			}
			const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + item.supportCount / 20);
			const decayFactor = Math.pow(.5, daysIdle / effectiveHalfLife);
			const newConfidence = item.confidence * decayFactor;
			if (newConfidence < forgetThreshold) {
				onForget(1);
				continue;
			}
			if (newConfidence < item.confidence - .001) {
				item.confidence = newConfidence;
				onDecay(1);
			}
			item.lastDecayAt = now;
			survivors.push(item);
		}
		return survivors;
	}
	/** FTS5 全文检索（混合检索增强，委托 SQLite 后端；JSON 后端返回空） */
	fullTextSearch(query, limit = 5) {
		return this.backend.fullTextSearch?.(query, limit) ?? [];
	}
	/** 向量检索（稀疏向量回退，委托 SQLite 后端；JSON 后端返回空） */
	vectorSearch(query, limit = 5) {
		return this.backend.vectorSearch?.(query, limit) ?? [];
	}
	/** 完整性检查（JSON 后端恒 ok） */
	integrityCheck() {
		return this.backend.integrityCheck?.() ?? "ok";
	}
	/** 数据库统计（JSON 后端返回内存计数） */
	dbStats() {
		return this.backend.stats?.() ?? {
			patterns: this.store.taskPatterns.length,
			profiles: this.store.modelProfiles.length,
			feedback: this.store.decisionFeedback.length,
			strategies: this.store.distilledStrategies.length,
			semantic: this.store.semanticMemories.length,
			procedural: this.store.proceduralMemories.length,
			pageSize: 0,
			pageCount: 0,
			walSize: 0,
			schemaVersion: 0,
			fts: false,
			vec: false
		};
	}
	/** WAL checkpoint（仅 SQLite 后端有效） */
	checkpoint() {
		this.backend.checkpoint?.();
	}
	/** VACUUM 回收碎片空间（仅 SQLite 后端有效） */
	vacuum() {
		this.backend.vacuum?.();
	}
	/** 热备份（仅 SQLite 后端；返回备份路径） */
	backup(destPath) {
		return this.backend.backup?.(destPath);
	}
	/** 只读 SQL 查询通道（仅 SQLite 后端；JSON 后端返回空） */
	rawQuery(sql, params = []) {
		return this.backend.rawQuery?.(sql, params) ?? [];
	}
	/** 立即同步落盘（进程退出前调用） */
	flushSync() {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.persist();
	}
	/** 释放资源（落盘 + 移除 beforeExit 监听 + 关闭后端连接） */
	dispose() {
		this.flushSync();
		process.removeListener("beforeExit", this.flushOnExit);
		this.backend.close();
	}
	/** 判断同描述策略是否已存在（蒸馏去重；3.0 索引化 O(1)） */
	hasStrategy(description) {
		return this.idxStrategyDesc.has(description);
	}
	/** 从持久化后端加载记忆库（损坏时由后端备份并抛出） */
	load() {
		return this.backend.load();
	}
	/** 防抖持久化调度 */
	schedulePersist() {
		this.store.lastUpdatedAt = Date.now();
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.persist();
		}, PERSIST_DEBOUNCE_MS);
		this.persistTimer.unref?.();
	}
	/** 执行持久化（委托后端：SQLite 事务 / JSON 原子写 / 加密落盘） */
	persist() {
		this.backend.save(this.store);
	}
	/** 更新模型画像 */
	updateModelProfile(modelId, taskType, success, latency, quality, tokenCost) {
		let profile = this.idxProfile.get(modelId);
		if (!profile) {
			profile = {
				id: modelId,
				name: modelId,
				taskHistory: {},
				costEfficiency: {},
				bestTaskType: "",
				worstTaskType: "",
				stability: .5
			};
			this.store.modelProfiles.push(profile);
			this.idxProfile.set(modelId, profile);
		}
		const history = profile.taskHistory[taskType] ??= {
			totalCalls: 0,
			successCount: 0,
			totalLatency: 0,
			totalQualityScore: 0,
			avgQualityScore: 0,
			lastCalledAt: 0
		};
		history.totalCalls += 1;
		if (success) {
			history.successCount += 1;
			history.totalLatency += latency;
			history.totalQualityScore += quality;
		}
		history.lastCalledAt = Date.now();
		const now = history.lastCalledAt;
		const decayBase = history.lastDecayedAt ?? history.lastCalledAt ?? now;
		const decay = Math.pow(.5, Math.max(0, now - decayBase) / 2592e6);
		const ws = (history.weightedSuccesses ?? history.successCount - (success ? 1 : 0)) * decay;
		const wf = (history.weightedFailures ?? history.totalCalls - history.successCount - (success ? 0 : 1)) * decay;
		history.weightedSuccesses = success ? ws + 1 : ws;
		history.weightedFailures = success ? wf : wf + 1;
		history.lastDecayedAt = now;
		if (success) history.emaQuality = history.emaQuality == null ? quality : .7 * history.emaQuality + .3 * quality;
		history.avgQualityScore = history.successCount > 0 ? history.totalQualityScore / history.successCount : 0;
		if (success && tokenCost > 0) {
			const prev = profile.costEfficiency[taskType] ?? 0;
			profile.costEfficiency[taskType] = (prev + quality / (tokenCost / 1e3 + 1)) / 2;
		}
		const ranked = Object.entries(profile.taskHistory).filter(([, h]) => h.totalCalls >= 2).sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);
		if (ranked.length > 0) {
			profile.bestTaskType = ranked[0][0];
			profile.worstTaskType = ranked[ranked.length - 1][0];
		}
		const totalCalls = Object.values(profile.taskHistory).reduce((s, h) => s + h.totalCalls, 0);
		const totalSuccess = Object.values(profile.taskHistory).reduce((s, h) => s + h.successCount, 0);
		const currentRate = totalCalls > 0 ? totalSuccess / totalCalls : .5;
		profile.stability = profile.stability * .7 + currentRate * .3;
	}
	/** 构建任务指纹：taskType + 复杂度分桶 + 排序后的特征 */
	buildFingerprint(taskType, complexity, features) {
		return buildPatternFingerprint(taskType, complexity, features);
	}
	/**
	* 相似度打分（0~1）
	* 0.5 × taskType 匹配 + 0.25 × complexity 接近度 + 0.25 × features Jaccard
	*/
	similarity(pattern, taskType, complexity, features) {
		const patternType = pattern.fingerprint.split("::")[0] ?? "";
		const typeScore = patternType === taskType ? 1 : patternType.startsWith(taskType) || taskType.startsWith(patternType) ? .5 : 0;
		const patternComplexity = Number(pattern.fingerprint.split("::")[1] ?? .5);
		const complexityScore = Math.max(0, 1 - Math.abs(patternComplexity - complexity) * 2);
		const patternFeatures = (pattern.fingerprint.split("::")[2] ?? "").split(",").filter(Boolean);
		let featureScore = 0;
		if (features.length === 0 && patternFeatures.length === 0) featureScore = 1;
		else if (features.length > 0 || patternFeatures.length > 0) {
			const setA = new Set(features);
			const setB = new Set(patternFeatures);
			const intersection = [...setA].filter((f) => setB.has(f)).length;
			const union = (/* @__PURE__ */ new Set([...setA, ...setB])).size;
			featureScore = union > 0 ? intersection / union : 0;
		}
		return .5 * typeScore + .25 * complexityScore + .25 * featureScore;
	}
	/** 质量分字典的平均值 */
	avgQuality(scores) {
		const values = Object.values(scores);
		return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
	}
	/** 数值数组平均值 */
	avg(values) {
		return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
	}
	/** 滚动平均（避免保存全量历史） */
	rollingAvg(prevAvg, newValue, count) {
		return count <= 1 ? newValue : prevAvg + (newValue - prevAvg) / count;
	}
};
//#endregion
//#region src/memory/memory-graph.ts
/**
* memory-graph.ts — 记忆网络与主题树（自主学习建议 2：自定义数据结构序列化）
*
* SQLite 擅长行列存储，但图结构（记忆网络、主题树）是其短板。本组件将复杂关系
* 保留在内存中管理与检索，定期序列化到本地 JSON 文件，Agent 启动时加载恢复：
*
* - 记忆网络：节点（任务模式 / 蒸馏策略 / 主题）+ 共现边（权重随共现次数增长），
*   支撑"由一条记忆联想到相关记忆"的图检索（优化器混合检索的联想增强）
* - 主题树：按 taskType 归类的层级结构（根主题 → 子主题 → 模式叶节点）
*
* 持久化：JSON 原子写（与记忆库同目录 memory-graph.json），dispose/flush 时落盘。
*/
var MemoryGraph = class {
	nodes = /* @__PURE__ */ new Map();
	edges = /* @__PURE__ */ new Map();
	topics = /* @__PURE__ */ new Map();
	persistPath;
	constructor(persistPath) {
		this.persistPath = persistPath;
		this.load();
	}
	edgeKey(a, b) {
		return [a, b].sort().join("::");
	}
	/** 确保节点存在（幂等） */
	ensureNode(id, kind, label) {
		if (!this.nodes.has(id)) this.nodes.set(id, {
			id,
			kind,
			label,
			createdAt: Date.now()
		});
	}
	/** 记录共现：边权重随共现次数增长（上限 1） */
	link(a, b) {
		const key = this.edgeKey(a, b);
		let edge = this.edges.get(key);
		if (!edge) {
			edge = {
				source: key.split("::")[0],
				target: key.split("::")[1],
				cooccurrences: 0,
				weight: 0,
				lastAt: Date.now()
			};
			this.edges.set(key, edge);
		}
		edge.cooccurrences += 1;
		edge.weight = Math.min(1, edge.cooccurrences / 5);
		edge.lastAt = Date.now();
		return edge;
	}
	/** 图联想：按边权重返回相邻节点 id（混合检索的联想增强） */
	related(id, limit = 5) {
		const neighbors = [];
		for (const edge of this.edges.values()) if (edge.source === id) neighbors.push({
			id: edge.target,
			weight: edge.weight
		});
		else if (edge.target === id) neighbors.push({
			id: edge.source,
			weight: edge.weight
		});
		return neighbors.sort((a, b) => b.weight - a.weight).slice(0, limit).map((n) => n.id);
	}
	/** 将模式挂到主题树（根主题 = taskType） */
	attachTopic(patternId, topicName, parentTopic) {
		let root = [...this.topics.values()].find((t) => t.name === topicName && t.parentId === null);
		if (!root) {
			root = {
				id: `topic:${topicName}`,
				name: topicName,
				parentId: null,
				childIds: [],
				patternIds: []
			};
			this.topics.set(root.id, root);
		}
		if (parentTopic) {
			let parent = [...this.topics.values()].find((t) => t.name === parentTopic && t.parentId === null);
			if (parent && parent.id !== root.id && !parent.childIds.includes(root.id)) {
				parent.childIds.push(root.id);
				root.parentId = parent.id;
			}
		}
		if (!root.patternIds.includes(patternId)) root.patternIds.push(patternId);
		this.ensureNode(patternId, "pattern", patternId);
		this.ensureNode(root.id, "topic", topicName);
		return root;
	}
	/** 主题树（仅根节点，含子主题与叶模式） */
	topicTree() {
		return [...this.topics.values()].filter((t) => t.parentId === null);
	}
	getNode(id) {
		return this.nodes.get(id);
	}
	stats() {
		return {
			nodes: this.nodes.size,
			edges: this.edges.size,
			topics: this.topics.size
		};
	}
	/** 序列化到本地 JSON（原子写） */
	save() {
		const file = {
			version: 1,
			nodes: [...this.nodes.values()],
			edges: [...this.edges.values()],
			topics: [...this.topics.values()]
		};
		const dir = path.dirname(this.persistPath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${this.persistPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(file), "utf-8");
		fs.renameSync(tmp, this.persistPath);
	}
	/** 启动时从本地 JSON 加载（损坏/缺失时从空图开始） */
	load() {
		if (!fs.existsSync(this.persistPath)) return;
		try {
			const file = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
			for (const node of file.nodes ?? []) this.nodes.set(node.id, node);
			for (const edge of file.edges ?? []) this.edges.set(this.edgeKey(edge.source, edge.target), edge);
			for (const topic of file.topics ?? []) this.topics.set(topic.id, topic);
		} catch {}
	}
};
//#endregion
//#region src/memory/alias-map.ts
/**
* alias-map.ts — 防幻觉短索引映射（自主学习建议 3）
*
* 将冗长的记忆 ID（指纹 / 策略 id / 教训 id）在注入大模型前转换为短索引（#1, #2, #3），
* 模型只需引用短索引，输出后再反向解析回完整 ID：
* - 降低模型复述长 ID 产生的幻觉率
* - 减少注入与输出的 Token 消耗
*
* 映射为请求级临时对象（不持久化）：每次注入前新建，注入与反解共用同一实例。
*/
var AliasMap = class {
	encodeMap = /* @__PURE__ */ new Map();
	decodeMap = /* @__PURE__ */ new Map();
	next = 1;
	/** 为完整 ID 分配短索引（幂等），返回形如 #1 */
	encode(id) {
		let alias = this.encodeMap.get(id);
		if (!alias) {
			alias = `#${this.next}`;
			this.next += 1;
			this.encodeMap.set(id, alias);
			this.decodeMap.set(alias.slice(1), id);
		}
		return alias;
	}
	/** 短索引 → 完整 ID（未知索引返回 undefined） */
	resolve(alias) {
		return this.decodeMap.get(alias.startsWith("#") ? alias.slice(1) : alias);
	}
	/** 将文本中的完整 ID 替换为短索引（按 ID 长度降序，避免前缀误替换） */
	encodeText(text) {
		let out = text;
		for (const id of [...this.encodeMap.keys()].sort((a, b) => b.length - a.length)) out = out.split(id).join(this.encodeMap.get(id));
		return out;
	}
	/** 将文本中的短索引反向解析回完整 ID（未登记的索引原样保留） */
	decodeText(text) {
		return text.replace(/#(\d+)/g, (match, n) => this.decodeMap.get(n) ?? match);
	}
	/** 当前映射条目（调试/日志） */
	entries() {
		return [...this.encodeMap.entries()].map(([id, alias]) => ({
			alias,
			id
		}));
	}
	get size() {
		return this.encodeMap.size;
	}
};
//#endregion
//#region src/memory/migration-tool.ts
/**
* migration-tool.ts — 记忆迁移工具（能力层，依赖 long-term-memory）
*
* 职责：
* - 将记忆库导出为自包含的迁移包（MigrationPackage），支持文件落盘
* - 将迁移包导入目标记忆库，支持四种冲突合并策略
* - dryRun 预演冲突与统计，不产生任何写入
* - 跨租户记忆迁移（源记忆库 → 目标记忆库）
*
* 升级点（相对基础实现的质的提升）：
* 1. 完整性保护：迁移包携带 data 段的 SHA-256 校验和，导入前强制校验，
*    防止传输/存储过程中的静默损坏与人为篡改
* 2. 语义化冲突检测：pattern 按 fingerprint、model-profile 按 id、
*    feedback 按 id 建立冲突键，冲突双方数据完整保留在 MigrationConflict 中供审计
* 3. newer-wins 策略基于 lastSeenAt/timestamp 做时间戳仲裁，而非盲目覆盖
* 4. merge 策略对任务模式做深度合并（成功方案并集 + 失败记录并集 + 统计重算），
*    而非简单二选一，最大化保留双方经验
* 5. 全程错误隔离：单条记录导入失败不中断整体迁移，错误收集进 MigrationReport.errors
*
* 4.0 修复（数据丢失）：语义记忆与程序记忆此前完全不参与导出/导入——跨实例/
* 跨租户迁移后蒸馏出的规律与 if-then 规则全部丢失。现补全：
* - 导出包含 semanticMemories / proceduralMemories（可分别关闭）
* - 导入按 id 建冲突键，四种策略仲裁；merge 复用记忆库自身的
*   证据合并语义（支撑累加 + 证据继承），newer-wins 按 distilledAt/lastAppliedAt 仲裁
* - dryRun 同步预演语义/程序记忆的冲突与新增量
*/
/** 迁移包格式版本 */
const PACKAGE_VERSION = 1;
/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION$1 = "0.1.0";
/**
* 记忆迁移工具
*
* 被 index.ts 的 memory_migration Tool 调用（export/import/dry-run/migrate-tenant）。
*/
var MigrationTool = class {
	instanceId;
	/**
	* @param instanceId 当前实例标识（写入迁移包 source），缺省自动生成
	*/
	constructor(instanceId) {
		this.instanceId = instanceId ?? `instance-${crypto.randomBytes(4).toString("hex")}`;
	}
	/**
	* 从记忆库实例导出迁移包
	* @param memory 源记忆库
	* @param options 导出范围选项（缺省全量导出）
	*/
	exportFromMemory(memory, options) {
		const opts = {
			includePatterns: options?.includePatterns ?? true,
			includeModelProfiles: options?.includeModelProfiles ?? true,
			includeFeedback: options?.includeFeedback ?? true,
			includeSemanticMemories: options?.includeSemanticMemories ?? true,
			includeProceduralMemories: options?.includeProceduralMemories ?? true,
			includeGlobalStats: options?.includeGlobalStats ?? true,
			tenantFilter: options?.tenantFilter,
			instanceName: options?.instanceName
		};
		const data = {};
		if (opts.includePatterns) data.taskPatterns = memory.getAllTaskPatterns();
		if (opts.includeModelProfiles) data.modelProfiles = memory.getAllModelProfiles();
		if (opts.includeFeedback) data.decisionFeedback = memory.getAllDecisionFeedback();
		if (opts.includeSemanticMemories) data.semanticMemories = memory.getAllSemanticMemories();
		if (opts.includeProceduralMemories) data.proceduralMemories = memory.getAllProceduralMemories();
		if (opts.includeGlobalStats) data.globalStats = memory.getGlobalStats();
		return this.buildPackage(data, opts);
	}
	/**
	* 从磁盘文件读取迁移包（含校验和验证）
	* @param filePath 迁移包文件路径
	* @throws MemoryError 文件不存在 / JSON 非法 / 校验和不匹配
	*/
	exportFromFile(filePath) {
		if (!fs.existsSync(filePath)) throw new MemoryError(`迁移包文件不存在: ${filePath}`);
		let pkg;
		try {
			pkg = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		} catch (err) {
			throw new MemoryError(`迁移包解析失败: ${filePath}`, { cause: err instanceof Error ? err.message : String(err) });
		}
		this.verifyChecksum(pkg);
		return pkg;
	}
	/**
	* 导出迁移包并写入文件
	* @param memory 源记忆库
	* @param outputPath 输出路径
	* @param options 导出范围选项
	*/
	exportToFile(memory, outputPath, options) {
		const pkg = this.exportFromMemory(memory, options);
		const dir = path.dirname(outputPath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${outputPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(pkg, null, 2), "utf-8");
		fs.renameSync(tmp, outputPath);
	}
	/**
	* 将迁移包导入目标记忆库
	* @param memory 目标记忆库
	* @param pkg 迁移包
	* @param strategy 冲突合并策略，默认 merge
	*/
	importToMemory(memory, pkg, strategy = "merge") {
		const startedAt = Date.now();
		const report = {
			success: true,
			strategy,
			imported: {
				patterns: 0,
				modelProfiles: 0,
				feedback: 0,
				semantic: 0,
				procedural: 0
			},
			skipped: 0,
			conflicts: [],
			errors: [],
			duration: 0
		};
		try {
			this.verifyChecksum(pkg);
			for (const remote of pkg.data.taskPatterns ?? []) try {
				const local = memory.getAllTaskPatterns().find((p) => p.fingerprint === remote.fingerprint);
				if (!local) {
					memory.upsertPattern(remote);
					report.imported.patterns += 1;
					continue;
				}
				const conflict = {
					type: "pattern",
					key: remote.fingerprint,
					localVersion: local,
					remoteVersion: remote,
					resolution: strategy
				};
				report.conflicts.push(conflict);
				const winner = this.resolvePatternConflict(local, remote, strategy);
				if (winner === null) report.skipped += 1;
				else {
					memory.upsertPattern(winner);
					report.imported.patterns += 1;
				}
			} catch (err) {
				report.errors.push(`pattern[${remote.fingerprint}]: ${err instanceof Error ? err.message : String(err)}`);
			}
			for (const remote of pkg.data.modelProfiles ?? []) try {
				const local = memory.getModelProfile(remote.id);
				if (!local) {
					memory.upsertModelProfile(remote);
					report.imported.modelProfiles += 1;
					continue;
				}
				const conflict = {
					type: "model-profile",
					key: remote.id,
					localVersion: local,
					remoteVersion: remote,
					resolution: strategy
				};
				report.conflicts.push(conflict);
				const winner = this.resolveProfileConflict(local, remote, strategy);
				if (winner === null) report.skipped += 1;
				else {
					memory.upsertModelProfile(winner);
					report.imported.modelProfiles += 1;
				}
			} catch (err) {
				report.errors.push(`model-profile[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
			}
			for (const remote of pkg.data.semanticMemories ?? []) try {
				const local = memory.getAllSemanticMemories().find((m) => m.id === remote.id);
				if (!local) {
					memory.upsertSemanticMemory(remote);
					report.imported.semantic += 1;
					continue;
				}
				const conflict = {
					type: "semantic",
					key: remote.id,
					localVersion: local,
					remoteVersion: remote,
					resolution: strategy
				};
				report.conflicts.push(conflict);
				const winner = this.resolveSemanticConflict(local, remote, strategy);
				if (winner === null) report.skipped += 1;
				else {
					memory.upsertSemanticMemory(winner);
					report.imported.semantic += 1;
				}
			} catch (err) {
				report.errors.push(`semantic[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
			}
			for (const remote of pkg.data.proceduralMemories ?? []) try {
				const local = memory.getAllProceduralMemories().find((p) => p.id === remote.id);
				if (!local) {
					memory.upsertProceduralMemory(remote);
					report.imported.procedural += 1;
					continue;
				}
				const conflict = {
					type: "procedural",
					key: remote.id,
					localVersion: local,
					remoteVersion: remote,
					resolution: strategy
				};
				report.conflicts.push(conflict);
				const winner = this.resolveProceduralConflict(local, remote, strategy);
				if (winner === null) report.skipped += 1;
				else {
					memory.upsertProceduralMemory(winner);
					report.imported.procedural += 1;
				}
			} catch (err) {
				report.errors.push(`procedural[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
			}
			for (const remote of pkg.data.decisionFeedback ?? []) try {
				if (memory.appendFeedback(remote)) report.imported.feedback += 1;
				else report.skipped += 1;
			} catch (err) {
				report.errors.push(`feedback[${remote.id}]: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (pkg.data.globalStats && (strategy === "merge" || strategy === "overwrite")) memory.mergeGlobalStats(pkg.data.globalStats);
			report.success = report.errors.length === 0;
		} catch (err) {
			report.success = false;
			report.errors.push(err instanceof Error ? err.message : String(err));
		}
		report.duration = Date.now() - startedAt;
		return report;
	}
	/**
	* 从文件读取迁移包并导入
	* @param memory 目标记忆库
	* @param filePath 迁移包文件路径
	* @param strategy 冲突合并策略，默认 merge
	*/
	importFromFile(memory, filePath, strategy = "merge") {
		const pkg = this.exportFromFile(filePath);
		return this.importToMemory(memory, pkg, strategy);
	}
	/**
	* 预演导入：检测冲突与统计，不产生任何写入
	* @param memory 目标记忆库
	* @param pkg 迁移包
	*/
	dryRun(memory, pkg) {
		this.verifyChecksum(pkg);
		const conflicts = [];
		let newPatterns = 0;
		let newProfiles = 0;
		let newFeedback = 0;
		let newSemantic = 0;
		let newProcedural = 0;
		let duplicates = 0;
		const localPatterns = memory.getAllTaskPatterns();
		const localFeedbackIds = new Set(memory.getAllDecisionFeedback().map((f) => f.id));
		const localSemanticIds = new Set(memory.getAllSemanticMemories().map((m) => m.id));
		const localProceduralIds = new Set(memory.getAllProceduralMemories().map((p) => p.id));
		for (const remote of pkg.data.taskPatterns ?? []) {
			const local = localPatterns.find((p) => p.fingerprint === remote.fingerprint);
			if (local) conflicts.push({
				type: "pattern",
				key: remote.fingerprint,
				localVersion: local,
				remoteVersion: remote
			});
			else newPatterns += 1;
		}
		for (const remote of pkg.data.modelProfiles ?? []) {
			const local = memory.getModelProfile(remote.id);
			if (local) conflicts.push({
				type: "model-profile",
				key: remote.id,
				localVersion: local,
				remoteVersion: remote
			});
			else newProfiles += 1;
		}
		for (const remote of pkg.data.decisionFeedback ?? []) if (localFeedbackIds.has(remote.id)) duplicates += 1;
		else newFeedback += 1;
		for (const remote of pkg.data.semanticMemories ?? []) if (localSemanticIds.has(remote.id)) conflicts.push({
			type: "semantic",
			key: remote.id,
			localVersion: memory.getAllSemanticMemories().find((m) => m.id === remote.id),
			remoteVersion: remote
		});
		else newSemantic += 1;
		for (const remote of pkg.data.proceduralMemories ?? []) if (localProceduralIds.has(remote.id)) conflicts.push({
			type: "procedural",
			key: remote.id,
			localVersion: memory.getAllProceduralMemories().find((p) => p.id === remote.id),
			remoteVersion: remote
		});
		else newProcedural += 1;
		return {
			conflicts,
			summary: {
				newPatterns,
				newProfiles,
				newFeedback,
				newSemantic,
				newProcedural,
				conflicts: conflicts.length,
				duplicates,
				totalIncoming: (pkg.data.taskPatterns?.length ?? 0) + (pkg.data.modelProfiles?.length ?? 0) + (pkg.data.decisionFeedback?.length ?? 0) + (pkg.data.semanticMemories?.length ?? 0) + (pkg.data.proceduralMemories?.length ?? 0)
			}
		};
	}
	/**
	* 跨租户迁移：源记忆库 → 目标记忆库
	* @param sourceMemory 源租户记忆库
	* @param targetMemory 目标租户记忆库
	* @param options 迁移选项（范围 + 策略）
	*/
	migrateBetweenTenants(sourceMemory, targetMemory, options) {
		const pkg = this.exportFromMemory(sourceMemory, options);
		return this.importToMemory(targetMemory, pkg, options?.strategy ?? "merge");
	}
	/** 构建带校验和的迁移包 */
	buildPackage(data, opts) {
		return {
			version: PACKAGE_VERSION,
			exportedAt: Date.now(),
			source: {
				instanceId: this.instanceId,
				instanceName: opts.instanceName,
				pluginVersion: PLUGIN_VERSION$1
			},
			scope: {
				includePatterns: opts.includePatterns ?? true,
				includeModelProfiles: opts.includeModelProfiles ?? true,
				includeFeedback: opts.includeFeedback ?? true,
				includeSemanticMemories: opts.includeSemanticMemories ?? true,
				includeProceduralMemories: opts.includeProceduralMemories ?? true,
				includeGlobalStats: opts.includeGlobalStats ?? true,
				tenantFilter: opts.tenantFilter
			},
			checksum: this.computeChecksum(data),
			data
		};
	}
	/** 计算 data 段的 SHA-256（深度键序规范化序列化，与键序无关） */
	computeChecksum(data) {
		return crypto.createHash("sha256").update(this.canonicalStringify(data)).digest("hex");
	}
	/** 递归按键名排序的规范化 JSON 序列化（保证任意嵌套层级的确定性） */
	canonicalStringify(value) {
		if (value === null || typeof value !== "object") return JSON.stringify(value);
		if (Array.isArray(value)) return `[${value.map((v) => this.canonicalStringify(v)).join(",")}]`;
		const record = value;
		return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${this.canonicalStringify(record[k])}`).join(",")}}`;
	}
	/** 校验迁移包完整性 */
	verifyChecksum(pkg) {
		if (!pkg || typeof pkg !== "object" || !pkg.data || typeof pkg.checksum !== "string") throw new MemoryError("迁移包结构非法：缺少 data 或 checksum");
		const expected = this.computeChecksum(pkg.data);
		if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(pkg.checksum, "hex"))) throw new MemoryError("迁移包校验和不匹配：数据可能已损坏或被篡改");
	}
	/**
	* 任务模式冲突仲裁
	* @returns 胜出者；skip 策略返回 null 表示保留本地
	*/
	resolvePatternConflict(local, remote, strategy) {
		switch (strategy) {
			case "overwrite": return remote;
			case "skip": return null;
			case "newer-wins": return remote.lastSeenAt >= local.lastSeenAt ? remote : local;
			default: return this.mergePatterns(local, remote);
		}
	}
	/** 深度合并两个任务模式：方案并集 + 记录并集 + 统计重算 */
	mergePatterns(local, remote) {
		const planKey = (p) => `${p.timestamp}:${p.totalLatency}:${p.tokenCost}`;
		const planMap = /* @__PURE__ */ new Map();
		for (const p of [...local.successfulPlans, ...remote.successfulPlans]) planMap.set(planKey(p), p);
		const successfulPlans = [...planMap.values()].sort((a, b) => b.timestamp - a.timestamp);
		const failKey = (f) => `${f.timestamp}:${f.errorMessage}`;
		const failMap = /* @__PURE__ */ new Map();
		for (const f of [...local.failureRecords, ...remote.failureRecords]) failMap.set(failKey(f), f);
		const failureRecords = [...failMap.values()].sort((a, b) => b.timestamp - a.timestamp);
		const avg = (values) => values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
		return {
			fingerprint: local.fingerprint,
			taskSummary: local.taskSummary,
			frequency: local.frequency + remote.frequency,
			firstSeenAt: Math.min(local.firstSeenAt, remote.firstSeenAt),
			lastSeenAt: Math.max(local.lastSeenAt, remote.lastSeenAt),
			successfulPlans,
			failureRecords,
			confidence: (local.confidence * local.frequency + remote.confidence * remote.frequency) / Math.max(1, local.frequency + remote.frequency),
			bestModelCombination: remote.lastSeenAt >= local.lastSeenAt ? remote.bestModelCombination : local.bestModelCombination,
			avgExecutionTime: avg(successfulPlans.map((p) => p.totalLatency)),
			avgQualityScore: avg(successfulPlans.map((p) => {
				const values = Object.values(p.qualityScores);
				return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
			}))
		};
	}
	/**
	* 模型画像冲突仲裁
	* @returns 胜出者；skip 策略返回 null 表示保留本地
	*/
	resolveProfileConflict(local, remote, strategy) {
		switch (strategy) {
			case "overwrite": return remote;
			case "skip": return null;
			case "newer-wins": {
				const localLast = Math.max(0, ...Object.values(local.taskHistory).map((h) => h.lastCalledAt));
				return Math.max(0, ...Object.values(remote.taskHistory).map((h) => h.lastCalledAt)) >= localLast ? remote : local;
			}
			default: return this.mergeProfiles(local, remote);
		}
	}
	/** 深度合并两个模型画像：taskHistory 按任务类型累加 */
	mergeProfiles(local, remote) {
		const taskHistory = {};
		const types = /* @__PURE__ */ new Set([...Object.keys(local.taskHistory), ...Object.keys(remote.taskHistory)]);
		for (const type of types) {
			const l = local.taskHistory[type];
			const r = remote.taskHistory[type];
			if (l && r) taskHistory[type] = {
				totalCalls: l.totalCalls + r.totalCalls,
				successCount: l.successCount + r.successCount,
				totalLatency: l.totalLatency + r.totalLatency,
				totalQualityScore: l.totalQualityScore + r.totalQualityScore,
				avgQualityScore: l.successCount + r.successCount > 0 ? (l.totalQualityScore + r.totalQualityScore) / (l.successCount + r.successCount) : 0,
				lastCalledAt: Math.max(l.lastCalledAt, r.lastCalledAt)
			};
			else taskHistory[type] = { ...l ?? r };
		}
		const costEfficiency = { ...local.costEfficiency };
		for (const [type, value] of Object.entries(remote.costEfficiency)) costEfficiency[type] = costEfficiency[type] !== void 0 ? (costEfficiency[type] + value) / 2 : value;
		const ranked = Object.entries(taskHistory).filter(([, h]) => h.totalCalls >= 2).sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);
		return {
			id: local.id,
			name: local.name,
			taskHistory,
			costEfficiency,
			bestTaskType: ranked[0]?.[0] ?? local.bestTaskType,
			worstTaskType: ranked[ranked.length - 1]?.[0] ?? local.worstTaskType,
			stability: (local.stability + remote.stability) / 2
		};
	}
	/**
	* 语义记忆冲突仲裁（4.0 补全）
	*
	* merge 不做二选一：交给记忆库 upsert 的证据合并语义（同 id 覆盖时
	* 继承既有 evidence 与应用反馈统计；同 statement 时支撑累加合并）。
	* newer-wins 按 max(distilledAt, lastAppliedAt) 仲裁。
	* @returns 胜出者；skip 策略返回 null 表示保留本地
	*/
	resolveSemanticConflict(local, remote, strategy) {
		switch (strategy) {
			case "overwrite": return remote;
			case "skip": return null;
			case "newer-wins": {
				const freshness = (m) => Math.max(m.distilledAt, m.lastAppliedAt ?? 0);
				return freshness(remote) >= freshness(local) ? remote : local;
			}
			default: return remote;
		}
	}
	/**
	* 程序记忆冲突仲裁（4.0 补全；语义同 resolveSemanticConflict）
	* @returns 胜出者；skip 策略返回 null 表示保留本地
	*/
	resolveProceduralConflict(local, remote, strategy) {
		switch (strategy) {
			case "overwrite": return remote;
			case "skip": return null;
			case "newer-wins": {
				const freshness = (m) => Math.max(m.distilledAt, m.lastAppliedAt ?? 0);
				return freshness(remote) >= freshness(local) ? remote : local;
			}
			default: return remote;
		}
	}
};
//#endregion
//#region src/progress-ws.ts
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
/** WebSocket 握手魔数（RFC 6455 §4.2.2） */
const WS_MAGIC_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** 回放缓冲上限 */
const REPLAY_BUFFER_SIZE = 50;
/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 3e4;
/** 单连接写缓冲上限（字节），超限视为慢客户端 */
const MAX_BUFFERED_BYTES = 1048576;
/**
* WebSocket 进度广播器
*
* 独立监听一个 HTTP 端口并升级为 WebSocket 服务。
* 被 index.ts 集成层持有，执行链路各阶段调用 broadcast() 推送事件。
*/
var ProgressBroadcaster = class {
	port;
	server = null;
	connections = /* @__PURE__ */ new Set();
	/** 环形回放缓冲 */
	replayBuffer = [];
	heartbeatTimer = null;
	started = false;
	/** 可选 HTTP 请求处理器（dashboard 等静态页面复用本端口；返回 true 表示已响应） */
	httpHandler = null;
	/**
	* @param port 监听端口，默认 9877（与 cordis.patch.yml progressPort 一致）
	*/
	constructor(port = 9877) {
		this.port = port;
	}
	/**
	* 注册 HTTP 请求处理器（非 WebSocket 升级请求优先交给它）
	* @param handler 返回 true 表示已处理该请求；返回 false 走默认健康检查响应
	*/
	setHttpHandler(handler) {
		this.httpHandler = handler;
	}
	/**
	* 启动 WebSocket 服务
	* 监听失败（端口冲突等）通过 'error' 事件降级停机并记录，
	* 不抛出——EventEmitter 回调内 throw 会成为进程级未捕获异常
	*/
	start() {
		if (this.started) return;
		this.started = true;
		this.server = http.createServer((req, res) => {
			if (this.httpHandler && this.httpHandler(req, res)) return;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({
				service: "dsh-proactive/progress-ws",
				clients: this.connections.size,
				bufferedEvents: this.replayBuffer.length
			}));
		});
		this.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
		this.server.on("error", (err) => {
			console.error(`[progress-ws] 进度广播服务异常（端口 ${this.port}），已降级停机: ${err.message}`);
			this.stop();
		});
		this.server.listen(this.port);
		this.heartbeatTimer = setInterval(() => {
			const deadline = Date.now() - 2 * HEARTBEAT_INTERVAL_MS;
			for (const conn of [...this.connections]) {
				if (conn.lastPongAt < deadline) {
					this.dropConnection(conn);
					continue;
				}
				try {
					this.sendFrame(conn.socket, Buffer.alloc(0), 9);
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
	broadcast(event) {
		const full = {
			...event,
			timestamp: event.timestamp ?? Date.now()
		};
		this.replayBuffer.push(full);
		if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) this.replayBuffer.shift();
		const frame = Buffer.from(JSON.stringify(full), "utf-8");
		for (const conn of this.connections) {
			if (conn.closed) continue;
			if (conn.socket.writableLength > MAX_BUFFERED_BYTES) {
				this.dropConnection(conn);
				continue;
			}
			try {
				this.sendFrame(conn.socket, frame, 1);
			} catch {
				this.dropConnection(conn);
			}
		}
	}
	/**
	* 停止服务：关闭所有连接与监听
	*/
	stop() {
		if (!this.started) return;
		this.started = false;
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		for (const conn of [...this.connections]) {
			try {
				this.sendFrame(conn.socket, Buffer.alloc(0), 8);
			} catch {}
			conn.socket.destroy();
		}
		this.connections.clear();
		this.server?.close();
		this.server = null;
	}
	/** 当前在线连接数 */
	getClientCount() {
		return this.connections.size;
	}
	/** RFC 6455 握手 */
	handleUpgrade(req, socket) {
		const key = req.headers["sec-websocket-key"];
		if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const accept = crypto.createHash("sha1").update(key + WS_MAGIC_GUID).digest("base64");
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"\r\n"
		].join("\r\n"));
		const conn = {
			socket,
			closed: false,
			lastPongAt: Date.now()
		};
		this.connections.add(conn);
		for (const past of this.replayBuffer) this.sendFrame(socket, Buffer.from(JSON.stringify(past), "utf-8"), 1);
		const connectedEvent = {
			type: "connected",
			timestamp: Date.now(),
			clientCount: this.connections.size
		};
		this.sendFrame(socket, Buffer.from(JSON.stringify(connectedEvent), "utf-8"), 1);
		socket.on("data", (chunk) => this.handleData(conn, chunk));
		socket.on("close", () => this.dropConnection(conn));
		socket.on("error", () => this.dropConnection(conn));
	}
	/**
	* 解析入站帧（客户端帧必带掩码）
	* 仅处理控制帧：close(0x8) / ping(0x9) / pong(0xA)；业务上行暂不需要
	*/
	handleData(conn, chunk) {
		conn.lastPongAt = Date.now();
		let offset = 0;
		while (offset + 2 <= chunk.length) {
			const opcode = chunk[offset] & 15;
			const masked = (chunk[offset + 1] & 128) !== 0;
			let payloadLength = chunk[offset + 1] & 127;
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
			if (frameEnd > chunk.length) return;
			if (opcode === 8) {
				try {
					this.sendFrame(conn.socket, Buffer.alloc(0), 8);
				} catch {}
				conn.socket.end();
				return;
			}
			if (opcode === 9) this.sendFrame(conn.socket, Buffer.alloc(0), 10);
			offset = frameEnd;
		}
	}
	/** 发送未掩码服务端帧 */
	sendFrame(socket, payload, opcode) {
		const length = payload.length;
		let header;
		if (length < 126) header = Buffer.from([128 | opcode, length]);
		else if (length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 128 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 128 | opcode;
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		socket.write(Buffer.concat([header, payload]));
	}
	/** 清理连接 */
	dropConnection(conn) {
		if (conn.closed) return;
		conn.closed = true;
		this.connections.delete(conn);
		conn.socket.destroy();
	}
};
//#endregion
//#region src/tenant/tenant-manager.ts
/**
* tenant-manager.ts — 多租户管理器（能力层，依赖 long-term-memory）
*
* 职责：
* - 租户注册 / 移除 / 更新 / 查询（含按标签检索）
* - 每个租户持有独立的 LongTermMemory 实例与运行时状态（TenantRuntime）
* - 按文件路径匹配租户（matchTenantByPath）
* - 信号路由：将外部信号分发到最合适的租户（routeSignal）
* - 租户注册表持久化与全局统计
*
* 升级点（相对基础实现的质的提升）：
* 1. 注册表持久化：租户配置落盘到 registry.json，进程重启后自动恢复全部运行时
* 2. 信号路由评分制：按 payload 路径前缀匹配深度 + 信号类型命中 + 标签命中
*    加权打分，选择得分最高的租户，而非简单首个匹配
* 3. 路径匹配安全化：workDir 规范化后做前缀比较，防止相对路径逃逸误匹配
* 4. 租户级记忆隔离：每个租户独立 memoryPath 与 LongTermMemory 实例，
*    移除租户时可选级联删除数据
* 5. 运行时统计自维护：activeExecutions / pendingSignals / stats 全量跟踪，
*    供 model_dashboard 与 manage_tenants Tool 直接消费
*/
/** 注册表默认值（与 cordis.patch.yml 全局配置对齐） */
const DEFAULT_GLOBALS = {
	qualityThreshold: .7,
	maxRetries: 2,
	globalTimeout: 3e5,
	aggregationWindow: 5
};
/**
* 多租户管理器
*
* 被 index.ts 集成层持有，manage_tenants Tool 的全部 action 映射到本类方法。
*/
var TenantManager = class {
	dataDir;
	registryPath;
	registry;
	runtimes = /* @__PURE__ */ new Map();
	cryptoEngine;
	/**
	* @param dataDir 租户数据根目录（注册表与各租户记忆库的存放处）
	* @param cryptoEngine 可选加密引擎，透传给各租户的记忆库
	*/
	constructor(dataDir, cryptoEngine) {
		this.dataDir = dataDir;
		this.cryptoEngine = cryptoEngine;
		this.registryPath = path.join(dataDir, "registry.json");
		this.registry = this.loadRegistry();
		for (const config of this.registry.tenants) if (config.enabled !== false) this.runtimes.set(config.id, this.buildRuntime(config));
	}
	/**
	* 注册新租户并创建运行时
	* @param config 租户配置（createdAt / lastActiveAt 自动填充）
	* @throws ConfigError id 重复或必填字段缺失
	*/
	registerTenant(config) {
		if (!config.id || !config.name || !config.workDir) throw new ConfigError("租户配置缺少必填字段: id / name / workDir");
		if (this.registry.tenants.some((t) => t.id === config.id)) throw new ConfigError(`租户已存在: ${config.id}`);
		const now = Date.now();
		const fullConfig = {
			enabled: true,
			...config,
			createdAt: now,
			lastActiveAt: now
		};
		this.registry.tenants.push(fullConfig);
		this.persistRegistry();
		const runtime = this.buildRuntime(fullConfig);
		this.runtimes.set(fullConfig.id, runtime);
		return runtime;
	}
	/**
	* 移除租户
	* @param tenantId 租户 id
	* @param deleteData 是否级联删除租户记忆数据，默认 false
	*/
	removeTenant(tenantId, deleteData = false) {
		const index = this.registry.tenants.findIndex((t) => t.id === tenantId);
		if (index < 0) throw new ConfigError(`租户不存在: ${tenantId}`);
		const [removed] = this.registry.tenants.splice(index, 1);
		const runtime = this.runtimes.get(tenantId);
		if (runtime) {
			if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
			runtime.memory.dispose();
			this.runtimes.delete(tenantId);
		}
		this.persistRegistry();
		if (deleteData && removed) {
			const memoryPath = this.resolveMemoryPath(removed);
			try {
				if (fs.existsSync(memoryPath)) fs.rmSync(memoryPath);
			} catch {}
		}
	}
	/**
	* 更新租户配置（增量合并）
	* @param tenantId 租户 id
	* @param updates 需要更新的字段
	*/
	updateTenant(tenantId, updates) {
		const config = this.registry.tenants.find((t) => t.id === tenantId);
		if (!config) throw new ConfigError(`租户不存在: ${tenantId}`);
		const { id: _ignored, ...safeUpdates } = updates;
		Object.assign(config, safeUpdates);
		this.persistRegistry();
		const runtime = this.runtimes.get(tenantId);
		if (config.enabled === false && runtime) {
			if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
			runtime.pendingSignals.length = 0;
			runtime.memory.dispose();
			this.runtimes.delete(tenantId);
		} else if (config.enabled !== false && !runtime) this.runtimes.set(tenantId, this.buildRuntime(config));
		else if (runtime) runtime.config = config;
	}
	/** 获取单个租户运行时 */
	getTenant(tenantId) {
		return this.runtimes.get(tenantId);
	}
	/** 获取全部租户运行时 */
	getAllTenants() {
		return [...this.runtimes.values()];
	}
	/** 按标签检索租户 */
	getTenantsByTag(tag) {
		return this.getAllTenants().filter((rt) => rt.config.tags?.includes(tag));
	}
	/**
	* 按文件路径匹配租户（路径规范化后做前缀比较）
	* @param filePath 文件或目录绝对路径
	* @returns workDir 最深匹配的租户运行时，无匹配返回 undefined
	*/
	matchTenantByPath(filePath) {
		const normalized = path.resolve(filePath);
		let best;
		let bestDepth = -1;
		for (const rt of this.runtimes.values()) {
			const workDir = path.resolve(rt.config.workDir);
			if (normalized === workDir || normalized.startsWith(workDir + path.sep)) {
				const depth = workDir.split(path.sep).length;
				if (depth > bestDepth) {
					bestDepth = depth;
					best = rt;
				}
			}
		}
		return best;
	}
	/**
	* 信号路由：将信号分发到最合适的租户
	*
	* 评分规则（加权）：
	* - payload 中的路径字段命中租户 workDir：+2 × 路径深度
	* - 信号类型命中租户 sentinel.signalSources：+3
	* - 信号类型命中租户 tags：+1
	* 得分最高者胜出，全部为 0 分时返回 undefined（由默认实例接管）。
	*
	* @param signal 外部信号 { type, payload }
	*/
	routeSignal(signal) {
		let best;
		let bestScore = 0;
		for (const rt of this.runtimes.values()) {
			let score = 0;
			const workDir = path.resolve(rt.config.workDir);
			for (const value of Object.values(signal.payload)) if (typeof value === "string" && (value.includes("/") || value.includes(path.sep))) {
				const resolved = path.resolve(value);
				if (resolved === workDir || resolved.startsWith(workDir + path.sep)) {
					score += 2 * workDir.split(path.sep).length;
					break;
				}
			}
			if ((rt.config.sentinel?.signalSources ?? []).some((s) => s.signalType === signal.type)) score += 3;
			if (rt.config.tags?.includes(signal.type)) score += 1;
			if (score > bestScore) {
				bestScore = score;
				best = rt;
			}
		}
		return best;
	}
	/** 刷新租户活跃时间 */
	touchTenant(tenantId) {
		const config = this.registry.tenants.find((t) => t.id === tenantId);
		if (config) {
			config.lastActiveAt = Date.now();
			this.persistRegistry();
		}
	}
	/**
	* 全局统计（跨租户汇总，供 manage_tenants stats 使用）
	*/
	getGlobalStats() {
		const tenants = this.getAllTenants();
		const sum = (fn) => tenants.reduce((s, rt) => s + fn(rt), 0);
		return {
			tenantCount: tenants.length,
			activeTenants: tenants.filter((rt) => rt.config.enabled !== false).length,
			executingTenants: tenants.filter((rt) => rt.isExecuting).length,
			totalExecutions: sum((rt) => rt.stats.totalExecutions),
			totalSuccesses: sum((rt) => rt.stats.totalSuccesses),
			totalFailures: sum((rt) => rt.stats.totalFailures),
			totalSignals: sum((rt) => rt.stats.totalSignals),
			totalTokensUsed: sum((rt) => rt.stats.totalTokensUsed),
			pendingSignals: sum((rt) => rt.pendingSignals.length),
			globalDefaults: { ...this.registry.globalDefaults }
		};
	}
	/** 释放全部运行时（进程退出前调用） */
	dispose() {
		for (const rt of this.runtimes.values()) {
			if (rt.aggregationTimer) clearTimeout(rt.aggregationTimer);
			rt.memory.dispose();
		}
		this.runtimes.clear();
	}
	/** 加载注册表（不存在时初始化） */
	loadRegistry() {
		if (!fs.existsSync(this.registryPath)) return {
			version: 1,
			tenants: [],
			globalDefaults: { ...DEFAULT_GLOBALS }
		};
		try {
			const raw = JSON.parse(fs.readFileSync(this.registryPath, "utf-8"));
			if (!Array.isArray(raw.tenants)) throw new Error("注册表结构非法：缺少 tenants 数组");
			return {
				version: raw.version ?? 1,
				tenants: raw.tenants,
				globalDefaults: {
					...DEFAULT_GLOBALS,
					...raw.globalDefaults
				}
			};
		} catch (err) {
			throw new ConfigError(`租户注册表加载失败: ${this.registryPath}`, { cause: err instanceof Error ? err.message : String(err) });
		}
	}
	/** 持久化注册表（原子写入） */
	persistRegistry() {
		fs.mkdirSync(this.dataDir, { recursive: true });
		const tmp = `${this.registryPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(this.registry, null, 2), "utf-8");
		fs.renameSync(tmp, this.registryPath);
	}
	/** 解析租户记忆库路径 */
	resolveMemoryPath(config) {
		if (config.memoryPath) return path.isAbsolute(config.memoryPath) ? config.memoryPath : path.join(this.dataDir, config.id, config.memoryPath);
		return path.join(this.dataDir, config.id, "memory.json");
	}
	/** 构建租户运行时 */
	buildRuntime(config) {
		const memoryPath = this.resolveMemoryPath(config);
		fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
		return {
			config,
			memory: new LongTermMemory(memoryPath, this.cryptoEngine),
			activeExecutions: 0,
			pendingSignals: [],
			isExecuting: false,
			modelProfiles: /* @__PURE__ */ new Map(),
			aggregationTimer: null,
			stats: {
				totalExecutions: 0,
				totalSuccesses: 0,
				totalFailures: 0,
				totalSignals: 0,
				totalTokensUsed: 0
			}
		};
	}
};
//#endregion
//#region src/sentinel.ts
/**
* sentinel.ts — 信号感知哨兵（集成层，执行链路第 1~2 步）
*
* 职责：主动感知环境变化，统一封装为 Signal 对象并在聚合窗口内合并相关信号
* - 三种信号源：webhook（HTTP 接入）/ filesystem（文件监听）/ polling（轮询比对）
* - 手动注入入口（autonomous_execute Tool 与级联触发共用）
* - 聚合窗口：aggregationWindow 内相关信号合并去重，窗口结束批量交付
* - 交付回调 onBatch 由 index.ts 编排层消费，进入优先级排序与战略决策
*
* 升级点（相对单一 webhook 的质的提升）：
* 1. 窗口内同源去重：type + dedupeKey 相同的信号合并计数，避免重复决策
* 2. 批次双触发：窗口到期或达到 maxBatchSize 立即交付，兼顾时延与吞吐
* 3. 文件监听防抖 + 忽略规则（node_modules / dist / .git），杜绝噪声风暴
* 4. 轮询源内容哈希比对：仅在内容真实变化时产生信号
* 5. 全部资源（server / watcher / timer）由 stop() 统一回收，支持 cordis fiber 清理
*/
/** 文件监听忽略目录 */
const IGNORED_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	"dist",
	".git",
	".scheduler",
	".cache",
	"coverage"
]);
/** 文件监听防抖（毫秒） */
const FS_DEBOUNCE_MS = 300;
/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL = 3e4;
/**
* 信号感知哨兵
*
* 被 index.ts 持有：start() 后持续产生 SignalBatch，
* 编排层对每个批次执行第 3~10 步链路。
*/
var Sentinel = class {
	config;
	onBatch;
	fetchImpl;
	pending = [];
	dedupeIndex = /* @__PURE__ */ new Map();
	windowTimer = null;
	webhookServers = [];
	fsWatchers = [];
	pollTimers = [];
	pollHashes = /* @__PURE__ */ new Map();
	fsDebounceTimer = null;
	fsPendingPaths = /* @__PURE__ */ new Set();
	running = false;
	totalIngested = 0;
	totalBatches = 0;
	/** 各类型信号到达时间戳环形缓冲（突发检测 / 速率统计） */
	arrivalHistory = /* @__PURE__ */ new Map();
	/** 各类型信号历史总次数 */
	historicalCounts = /* @__PURE__ */ new Map();
	/** 各类型信号到达速率基线（指数移动平均，次/分钟） */
	rateBaseline = /* @__PURE__ */ new Map();
	/** 最近注入的信号（关联分析用，保留 50 条；ingest 时即记录，无需等待交付） */
	recentSignals = [];
	/** 当前自适应窗口（毫秒） */
	currentWindowMs;
	/** 突发计数（最近窗口内被判定为突发的次数） */
	burstCount = 0;
	/**
	* @param config 哨兵配置
	* @param onBatch 批次交付回调（编排层入口）
	*/
	constructor(config, onBatch) {
		this.config = config;
		this.onBatch = onBatch;
		this.fetchImpl = config.fetchImpl ?? fetch;
		this.currentWindowMs = Math.max(.1, config.aggregationWindow) * 1e3;
	}
	/**
	* 启动所有信号源
	*/
	start() {
		if (this.running) return;
		this.running = true;
		for (const source of this.config.signalSources ?? []) try {
			if (source.type === "webhook") this.startWebhook(source);
			else if (source.type === "filesystem") this.startFileWatch(source);
			else if (source.type === "polling") this.startPolling(source);
		} catch (err) {
			this.ingest({
				type: "sentinel-error",
				description: `信号源启动失败(${source.type}): ${err.message}`,
				payload: { source },
				source: "sentinel"
			});
		}
		if (this.config.watchCodeChanges && this.config.watchDir) {
			if (!(this.config.signalSources ?? []).some((s) => s.type === "filesystem")) this.startFileWatch({
				type: "filesystem",
				path: this.config.watchDir,
				signalType: "code-change"
			});
		}
	}
	/**
	* 停止所有信号源并清空待处理缓冲（不交付残余信号）
	*/
	stop() {
		if (!this.running) return;
		this.running = false;
		for (const server of this.webhookServers) server.close();
		this.webhookServers = [];
		for (const watcher of this.fsWatchers) watcher.close();
		this.fsWatchers = [];
		for (const timer of this.pollTimers) clearInterval(timer);
		this.pollTimers = [];
		if (this.windowTimer) {
			clearTimeout(this.windowTimer);
			this.windowTimer = null;
		}
		if (this.fsDebounceTimer) {
			clearTimeout(this.fsDebounceTimer);
			this.fsDebounceTimer = null;
		}
		this.pending = [];
		this.dedupeIndex.clear();
		this.fsPendingPaths.clear();
	}
	/**
	* 注入一个信号（手动 / webhook / 文件监听 / 轮询 / 级联统一入口）
	* @param partial 信号字段（id / receivedAt / occurrences 自动补齐）
	* @returns 归一化后的 Signal（若被窗口内去重则返回已存在的信号）
	*/
	ingest(partial) {
		const signal = {
			id: partial.id ?? `sig-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
			type: partial.type,
			description: partial.description,
			payload: partial.payload ?? {},
			urgency: partial.urgency,
			receivedAt: partial.receivedAt ?? Date.now(),
			source: partial.source ?? "manual",
			dedupeKey: partial.dedupeKey,
			occurrences: 1,
			tenantId: partial.tenantId,
			deadlineMs: partial.deadlineMs
		};
		this.totalIngested += 1;
		const enrichment = this.enrich(signal);
		signal.enrichment = enrichment;
		this.recentSignals.push({
			id: signal.id,
			type: signal.type,
			receivedAt: signal.receivedAt
		});
		if (this.recentSignals.length > 50) this.recentSignals.splice(0, this.recentSignals.length - 50);
		const key = signal.dedupeKey ?? `${signal.type}:${signal.description}`;
		const existing = this.dedupeIndex.get(key);
		if (existing) {
			existing.occurrences += 1;
			existing.payload = {
				...existing.payload,
				lastMergedAt: Date.now(),
				mergedCount: existing.occurrences
			};
			existing.enrichment = enrichment;
			return existing;
		}
		this.pending.push(signal);
		this.dedupeIndex.set(key, signal);
		this.ensureWindowTimer();
		const maxBatchSize = this.config.maxBatchSize ?? 10;
		if (this.pending.length >= maxBatchSize) this.flush("max-size");
		return signal;
	}
	/**
	* 信号富化：到达速率统计 + 突发检测 + 关联分析 + 自适应窗口调整
	* @param signal 待富化信号
	*/
	enrich(signal) {
		const now = Date.now();
		const history = this.arrivalHistory.get(signal.type) ?? [];
		history.push(now);
		const cutoff = now - 3e5;
		while (history.length > 0 && history[0] < cutoff) history.shift();
		this.arrivalHistory.set(signal.type, history);
		const recentWindow = now - 6e4;
		const recentRatePerMin = history.filter((t) => t >= recentWindow).length;
		const historicalCount = (this.historicalCounts.get(signal.type) ?? 0) + 1;
		this.historicalCounts.set(signal.type, historicalCount);
		const hasBaseline = this.rateBaseline.has(signal.type);
		const prevBaseline = this.rateBaseline.get(signal.type) ?? 0;
		const isBurst = hasBaseline && recentRatePerMin >= 3 && recentRatePerMin > prevBaseline * 3;
		if (isBurst) this.burstCount += 1;
		if (!hasBaseline) this.rateBaseline.set(signal.type, recentRatePerMin);
		else if (!isBurst) this.rateBaseline.set(signal.type, prevBaseline * .9 + recentRatePerMin * .1);
		this.adaptWindow(isBurst);
		return {
			recentRatePerMin,
			historicalCount,
			isBurst,
			correlatedSignalIds: this.recentSignals.filter((s) => s.id !== signal.id && now - s.receivedAt < 3e4 && s.type !== signal.type).slice(-5).map((s) => s.id),
			effectiveWindowMs: this.currentWindowMs
		};
	}
	/** 自适应窗口调整：突发 → 缩短至 1/4（下限 50ms）；平稳 → 逐步恢复配置值 */
	adaptWindow(isBurst) {
		const configuredMs = Math.max(.1, this.config.aggregationWindow) * 1e3;
		if (isBurst) this.currentWindowMs = Math.max(50, Math.floor(this.currentWindowMs / 4));
		else if (this.currentWindowMs < configuredMs) this.currentWindowMs = Math.min(configuredMs, Math.ceil(this.currentWindowMs * 1.25));
	}
	/**
	* 立即交付当前待处理批次（无待处理信号时为空操作）
	* @param reason 交付原因标记
	*/
	flush(reason = "flush") {
		if (this.windowTimer) {
			clearTimeout(this.windowTimer);
			this.windowTimer = null;
		}
		if (this.pending.length === 0) return;
		const batch = {
			signals: this.pending,
			aggregatedAt: Date.now(),
			reason
		};
		this.pending = [];
		this.dedupeIndex.clear();
		this.totalBatches += 1;
		try {
			this.onBatch(batch);
		} catch {}
	}
	/** 当前待处理信号（只读快照） */
	getPendingSignals() {
		return [...this.pending];
	}
	/**
	* 哨兵运行状态（manage_consensus / model_dashboard 等 Tool 可引用）
	*/
	getStatus() {
		const sources = [];
		for (const server of this.webhookServers) {
			const addr = server.address();
			sources.push({
				type: "webhook",
				detail: `port:${typeof addr === "object" && addr ? addr.port : "?"}`,
				active: true
			});
		}
		for (const source of this.config.signalSources ?? []) {
			if (source.type === "filesystem") sources.push({
				type: "filesystem",
				detail: source.path ?? "",
				active: true
			});
			if (source.type === "polling") sources.push({
				type: "polling",
				detail: source.url ?? "",
				active: true
			});
		}
		return {
			running: this.running,
			pendingSignals: this.pending.length,
			totalIngested: this.totalIngested,
			totalBatches: this.totalBatches,
			sources,
			aggregationWindow: this.config.aggregationWindow,
			effectiveWindowMs: this.currentWindowMs,
			burstCount: this.burstCount,
			historicalCounts: Object.fromEntries(this.historicalCounts)
		};
	}
	/** 确保聚合窗口定时器存在（首个信号触发开窗，使用自适应窗口） */
	ensureWindowTimer() {
		if (this.windowTimer) return;
		this.windowTimer = setTimeout(() => {
			this.windowTimer = null;
			this.flush("window");
		}, this.currentWindowMs);
		this.windowTimer.unref?.();
	}
	/** 启动 webhook 信号源 */
	startWebhook(source) {
		const port = source.port ?? 9878;
		const server = http.createServer((req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "method not allowed" }));
				return;
			}
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 1048576) req.destroy();
			});
			req.on("end", () => {
				try {
					const payload = body ? JSON.parse(body) : {};
					const signal = this.ingest({
						type: source.signalType || "webhook",
						description: payload.description ?? payload.title ?? "webhook 信号",
						payload,
						source: `webhook:${port}`,
						dedupeKey: payload.dedupeKey
					});
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: true,
						signalId: signal.id,
						occurrences: signal.occurrences
					}));
				} catch (err) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: err.message
					}));
				}
			});
		});
		server.on("error", (err) => {
			throw new NetworkError(`webhook 信号源异常: ${err.message}`, { port });
		});
		server.listen(port);
		this.webhookServers.push(server);
	}
	/** 启动文件监听信号源（递归监听 + 防抖 + 忽略规则） */
	startFileWatch(source) {
		const target = source.path ?? this.config.watchDir ?? process.cwd();
		if (!fs.existsSync(target)) return;
		const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const normalized = filename.replace(/\\/g, "/");
			if (normalized.split("/").some((seg) => IGNORED_DIRS.has(seg))) return;
			this.fsPendingPaths.add(path.join(target, normalized));
			if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
			this.fsDebounceTimer = setTimeout(() => {
				const paths = [...this.fsPendingPaths];
				this.fsPendingPaths.clear();
				this.fsDebounceTimer = null;
				if (paths.length === 0) return;
				this.ingest({
					type: source.signalType || "code-change",
					description: `检测到 ${paths.length} 个文件变更`,
					payload: {
						files: paths.slice(0, 50),
						totalFiles: paths.length
					},
					source: `fs:${target}`,
					dedupeKey: `${source.signalType || "code-change"}:${target}`
				});
			}, FS_DEBOUNCE_MS);
			this.fsDebounceTimer.unref?.();
		});
		this.fsWatchers.push(watcher);
	}
	/** 启动轮询信号源（内容哈希比对） */
	startPolling(source) {
		const url = source.url;
		if (!url) return;
		const interval = source.interval ?? DEFAULT_POLL_INTERVAL;
		const timer = setInterval(async () => {
			try {
				const res = await this.fetchImpl(url);
				if (!res.ok) return;
				const text = await res.text();
				const hash = crypto.createHash("sha256").update(text).digest("hex");
				const prev = this.pollHashes.get(url);
				this.pollHashes.set(url, hash);
				if (prev !== void 0 && prev !== hash) this.ingest({
					type: source.signalType || "polling-change",
					description: `轮询目标内容变化: ${url}`,
					payload: {
						url,
						previousHash: prev.slice(0, 12),
						currentHash: hash.slice(0, 12)
					},
					source: `poll:${url}`,
					dedupeKey: `poll:${url}`
				});
			} catch {}
		}, interval);
		timer.unref?.();
		this.pollTimers.push(timer);
	}
};
//#endregion
//#region src/sync/distributed-sync.ts
/**
* distributed-sync.ts — 分布式记忆同步引擎（协作层，依赖 long-term-memory + crypto-engine）
*
* 职责：
* - 将本地记忆变更（模式增删改 / 画像更新 / 反馈新增 / 统计更新）记录为变更日志
* - 通过逻辑时钟（Lamport Clock）跟踪各节点进度，按 peer 增量生成同步批次
* - 接收远端批次并幂等应用，检测并自动仲裁并发冲突
* - 支持 http-poll / file-share 两种传输协议，双向或单向同步
*
* 升级点（相对基础实现的质的提升）：
* 1. Lamport 逻辑时钟：接收批次时 localClock = max(local, remote) + 1，
*    保证因果序；peer 进度单独跟踪，实现按 peer 的增量推送（不重复传输）
* 2. 幂等应用：已应用的 changeId 集合持久化，重复批次安全跳过，
*    网络重传不会造成记忆重复累加
* 3. 冲突自动仲裁：同指纹并发修改按 (logicalClock, timestamp, sourceNodeId)
*    三级仲裁，仲裁结果落 SyncConflict 审计记录，无需人工介入
* 4. 批次完整性：SyncBatch 携带 batchHash（变更链哈希），接收端逐条校验，
*    损坏批次整体拒收
* 5. 双协议传输：http-poll（POST push + GET pull）与 file-share（共享目录
*    交换批次文件），均支持 authToken 鉴权
* 6. 状态持久化：时钟 / peer 进度 / 待推送变更 / 冲突记录 / 同步日志全部落盘，
*    重启后无缝续传
*/
/** 已应用变更集合上限 */
const DEFAULT_APPLIED_LIMIT = 1e4;
/** 同步日志保留条数 */
const DEFAULT_LOG_LIMIT = 200;
/** 待推送变更上限（防止 peer 长期离线导致无限堆积） */
const MAX_PENDING_CHANGES = 5e3;
/** 待推送变更默认字节上限（条数之外的第二道闸：单条大 payload 场景） */
const DEFAULT_MAX_PENDING_BYTES = 16777216;
/**
* 分布式记忆同步引擎
*
* 被 index.ts 的 manage_sync Tool 调用（status / sync-now / register-node）。
*/
var DistributedSync = class {
	localNodeId;
	memory;
	statePath;
	cryptoEngine;
	state;
	/** 已应用的变更 id（幂等去重） */
	appliedIds = /* @__PURE__ */ new Set();
	nodes = /* @__PURE__ */ new Map();
	pollTimers = /* @__PURE__ */ new Map();
	persistTimer = null;
	options;
	/** 各指纹最近一次本地变更时间戳（并发冲突仲裁的第二级依据） */
	lastLocalChangeAt = /* @__PURE__ */ new Map();
	/** 待推送队列总字节数（含每条变更近似大小缓存） */
	pendingBytes = /* @__PURE__ */ new Map();
	totalPendingBytes = 0;
	/**
	* @param localNodeId 本节点 id
	* @param memory 本节点记忆库
	* @param statePath 同步状态持久化路径
	* @param cryptoEngine 可选加密引擎（状态文件加密落盘）
	*/
	constructor(localNodeId, memory, statePath, cryptoEngine) {
		this.localNodeId = localNodeId;
		this.memory = memory;
		this.statePath = statePath;
		this.cryptoEngine = cryptoEngine ?? null;
		this.options = {
			statePersistInterval: 2e3,
			appliedSetLimit: DEFAULT_APPLIED_LIMIT,
			syncLogLimit: DEFAULT_LOG_LIMIT,
			maxPendingBytes: DEFAULT_MAX_PENDING_BYTES
		};
		this.state = this.loadState();
		if (Array.isArray(this.state.appliedIds)) this.appliedIds = new Set(this.state.appliedIds.slice(-this.options.appliedSetLimit));
		for (const c of this.state.pendingChanges) {
			const size = this.approxSizeOf(c);
			this.pendingBytes.set(c.id, size);
			this.totalPendingBytes += size;
		}
	}
	/**
	* 记录一条本地变更（由记忆写入路径调用）
	* @param type 变更类型
	* @param fingerprint 变更对象指纹（pattern 指纹 / 模型 id / 反馈 id）
	* @param payload 变更载荷
	*/
	recordChange(type, fingerprint, payload) {
		this.state.localClock += 1;
		const entry = {
			id: `${this.localNodeId}:${this.state.localClock}:${crypto.randomBytes(4).toString("hex")}`,
			type,
			fingerprint,
			timestamp: Date.now(),
			sourceNodeId: this.localNodeId,
			payload,
			logicalClock: this.state.localClock,
			dataHash: this.hashPayload(payload)
		};
		this.lastLocalChangeAt.set(fingerprint, entry.timestamp);
		this.state.pendingChanges.push(entry);
		const size = this.approxSizeOf(entry);
		this.pendingBytes.set(entry.id, size);
		this.totalPendingBytes += size;
		while (this.state.pendingChanges.length > MAX_PENDING_CHANGES || this.totalPendingBytes > this.options.maxPendingBytes && this.state.pendingChanges.length > 1) {
			const evicted = this.state.pendingChanges.shift();
			if (!evicted) break;
			const sz = this.pendingBytes.get(evicted.id);
			if (sz !== void 0) {
				this.totalPendingBytes -= sz;
				this.pendingBytes.delete(evicted.id);
			}
		}
		this.schedulePersist();
	}
	/**
	* 获取待推送给指定 peer 的增量变更（clock > peer 已知进度）
	* @param forPeerId 目标 peer，缺省返回全部待推送变更
	*/
	getPendingChanges(forPeerId) {
		if (!forPeerId) return [...this.state.pendingChanges];
		const peerClock = this.state.peerClocks[forPeerId] ?? 0;
		return this.state.pendingChanges.filter((c) => c.logicalClock > peerClock);
	}
	/**
	* 确认 peer 已消费到指定时钟位点（可裁剪已确认变更）
	*/
	acknowledgePeer(peerId, clock) {
		this.state.peerClocks[peerId] = Math.max(this.state.peerClocks[peerId] ?? 0, clock);
		const minConfirmed = Math.min(...Object.values(this.state.peerClocks));
		if (Object.keys(this.state.peerClocks).length > 0 && Number.isFinite(minConfirmed)) {
			const before = this.state.pendingChanges.length;
			this.state.pendingChanges = this.state.pendingChanges.filter((c) => c.logicalClock > minConfirmed);
			if (this.state.pendingChanges.length !== before) {
				this.pendingBytes.clear();
				this.totalPendingBytes = 0;
				for (const c of this.state.pendingChanges) {
					const size = this.approxSizeOf(c);
					this.pendingBytes.set(c.id, size);
					this.totalPendingBytes += size;
				}
			}
		}
		this.schedulePersist();
	}
	/**
	* 接收并应用远端批次
	*
	* 流程：批次哈希校验 → 逐条幂等应用 → 冲突检测与仲裁 → 时钟推进
	*/
	async receiveBatch(batch) {
		const errors = [];
		const conflicts = [];
		let applied = 0;
		if (!this.verifyBatchHash(batch)) return {
			applied: 0,
			conflicts,
			errors: ["批次哈希校验失败：数据可能已损坏或被篡改"]
		};
		for (const change of batch.changes) try {
			if (this.hashPayload(change.payload) !== change.dataHash) {
				errors.push(`变更 ${change.id} 载荷哈希不匹配，已跳过`);
				continue;
			}
			if (this.appliedIds.has(change.id)) continue;
			const conflict = this.applyChange(change);
			if (conflict) conflicts.push(conflict);
			this.appliedIds.add(change.id);
			this.trimAppliedIds();
			applied += 1;
		} catch (err) {
			errors.push(`变更 ${change.id} 应用失败: ${err instanceof Error ? err.message : String(err)}`);
		}
		this.state.localClock = Math.max(this.state.localClock, batch.logicalClock) + 1;
		this.state.lastSyncAt[batch.sourceNodeId] = Date.now();
		this.schedulePersist();
		return {
			applied,
			conflicts,
			errors
		};
	}
	/**
	* 为指定 peer 创建增量批次（无新变更时返回 null）
	*/
	createBatch(forPeerId) {
		const changes = this.getPendingChanges(forPeerId);
		if (changes.length === 0) return null;
		const batch = {
			batchId: `${this.localNodeId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
			sourceNodeId: this.localNodeId,
			changes,
			timestamp: Date.now(),
			logicalClock: this.state.localClock,
			batchHash: ""
		};
		batch.batchHash = this.computeBatchHash(batch);
		return batch;
	}
	/**
	* 注册同步节点（enabled 的 http-poll 节点自动启动定时拉取）
	*/
	registerNode(config) {
		this.nodes.set(config.nodeId, config);
		if (config.enabled !== false && config.protocol === "http-poll" && config.pollInterval && config.pollInterval > 0) this.startPolling(config);
		this.schedulePersist();
	}
	/**
	* 创建 HTTP 同步端点处理器（供集成层挂载到 HTTP 服务）
	*
	* - handlePush: POST 接收远端批次
	* - handlePull: GET 返回本地增量批次（?peerId=xxx&since=clock）
	* - handleStatus: GET 返回同步状态摘要
	*/
	createSyncHandlers() {
		return {
			handlePush: async (body) => {
				const batch = body;
				if (!batch || !Array.isArray(batch.changes)) return {
					ok: false,
					error: "非法批次结构"
				};
				const result = await this.receiveBatch(batch);
				return {
					ok: result.errors.length === 0,
					...result
				};
			},
			handlePull: (query) => {
				const peerId = query.peerId ?? "unknown";
				return {
					ok: true,
					batch: this.createBatch(peerId)
				};
			},
			handleAck: (body) => {
				if (!body.peerId || typeof body.clock !== "number" || !Number.isFinite(body.clock)) return {
					ok: false,
					error: "非法回执：需要 peerId 与数字 clock"
				};
				this.acknowledgePeer(body.peerId, body.clock);
				return { ok: true };
			},
			handleStatus: () => ({
				ok: true,
				nodeId: this.localNodeId,
				localClock: this.state.localClock,
				pendingChanges: this.state.pendingChanges.length,
				pendingBytes: this.totalPendingBytes,
				peers: Object.keys(this.state.peerClocks),
				unresolvedConflicts: this.state.unresolvedConflicts.length
			})
		};
	}
	/**
	* 立即与指定 peer 同步一次（push 本地增量 + 可选 pull 远端增量）
	* @param peerId 已注册节点 id
	*/
	async syncNow(peerId) {
		const startedAt = Date.now();
		const log = {
			timestamp: startedAt,
			direction: "push",
			remoteNodeId: peerId,
			changesSent: 0,
			changesReceived: 0,
			conflictsDetected: 0,
			conflictsResolved: 0,
			errors: [],
			duration: 0,
			status: "success"
		};
		const node = this.nodes.get(peerId);
		if (!node) {
			log.status = "failed";
			log.errors.push(`未注册的节点: ${peerId}`);
			this.appendSyncLog(log);
			return log;
		}
		try {
			if (node.protocol === "http-poll") await this.syncViaHttp(node, log);
			else if (node.protocol === "file-share") await this.syncViaFileShare(node, log);
			else {
				log.errors.push(`暂不支持的协议: ${node.protocol}`);
				log.status = "failed";
			}
		} catch (err) {
			log.errors.push(err instanceof Error ? err.message : String(err));
			log.status = "failed";
		}
		log.duration = Date.now() - startedAt;
		if (log.status !== "failed" && log.errors.length > 0) log.status = "partial";
		this.appendSyncLog(log);
		return log;
	}
	/**
	* 停止全部轮询定时器与持久化定时器
	*/
	stop() {
		for (const timer of this.pollTimers.values()) clearInterval(timer);
		this.pollTimers.clear();
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		this.persistState();
	}
	/**
	* 获取同步状态摘要（供 manage_sync status 使用）
	*/
	/** 同步状态摘要（运维可观测） */
	getStatus() {
		return {
			localNodeId: this.localNodeId,
			localClock: this.state.localClock,
			registeredNodes: [...this.nodes.values()].map((n) => ({
				nodeId: n.nodeId,
				name: n.name,
				protocol: n.protocol,
				enabled: n.enabled !== false
			})),
			peerClocks: { ...this.state.peerClocks },
			pendingChanges: this.state.pendingChanges.length,
			unresolvedConflicts: this.state.unresolvedConflicts.length,
			recentSyncs: this.state.syncLog.slice(-5),
			lastSyncAt: { ...this.state.lastSyncAt }
		};
	}
	/**
	* 应用单条变更到本地记忆库
	* @returns 检测到冲突时返回冲突记录（已自动仲裁）
	*/
	applyChange(change) {
		switch (change.type) {
			case "pattern-created":
			case "pattern-updated": {
				const pattern = change.payload;
				const local = this.memory.getAllTaskPatterns().find((p) => p.fingerprint === change.fingerprint);
				if (local && change.type === "pattern-updated") {
					const localClock = this.state.localClock;
					const localTs = this.lastLocalChangeAt.get(change.fingerprint) ?? 0;
					const remoteWins = this.arbitrate(localClock, change.logicalClock, change.timestamp, localTs, change.sourceNodeId);
					const conflict = {
						changeId: change.id,
						fingerprint: change.fingerprint,
						localData: local,
						remoteData: change.payload,
						localClock,
						remoteClock: change.logicalClock,
						resolution: remoteWins ? "remote-wins" : "local-wins",
						resolvedAt: Date.now(),
						resolutionReason: remoteWins ? "远端时钟/时间戳更新" : "本地时钟更新，保留本地版本"
					};
					this.state.unresolvedConflicts.push(conflict);
					if (remoteWins) this.memory.upsertPattern(pattern);
					return conflict;
				}
				this.memory.upsertPattern(pattern);
				return null;
			}
			case "pattern-deleted":
				this.memory.removePattern(change.fingerprint);
				return null;
			case "model-profile-updated":
				this.memory.upsertModelProfile(change.payload);
				return null;
			case "feedback-created":
				this.memory.appendFeedback(change.payload);
				return null;
			case "stats-updated":
				this.memory.mergeGlobalStats(change.payload);
				return null;
			default: return null;
		}
	}
	/**
	* 三级仲裁：clock 高者胜 → timestamp 新者胜 → nodeId 字典序大者胜。
	* 第二级原实现用 Date.now() 近似本地变更时间——墙钟在「应用远端批次」
	* 的当下必然新于远端时间戳，等价于「时钟同段时远端恒胜」，仲裁退化为
	* 单级；现改用指纹级真实本地变更时间（recordChange 时记录）。
	* 第三级 nodeId 决胜保证双方独立仲裁结果一致（无分歧收敛）
	*/
	arbitrate(localClock, remoteClock, remoteTimestamp, localTimestamp, remoteNodeId) {
		if (remoteClock !== localClock) return remoteClock > localClock;
		if (remoteTimestamp !== localTimestamp) return remoteTimestamp > localTimestamp;
		return remoteNodeId > this.localNodeId;
	}
	/** http-poll 协议同步：先 push 本地增量，再 pull 远端增量 */
	async syncViaHttp(node, log) {
		const baseUrl = node.remoteUrl?.replace(/\/$/, "");
		if (!baseUrl) throw new NetworkError(`节点 ${node.nodeId} 缺少 remoteUrl`);
		const outBatch = this.createBatch(node.nodeId);
		if (outBatch) {
			const pushResult = await this.httpRequest(`${baseUrl}/sync/push`, "POST", outBatch, node.authToken);
			if (pushResult.ok) {
				log.changesSent = outBatch.changes.length;
				this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
			} else log.errors.push(`push 被拒: ${pushResult.error ?? "unknown"}`);
		}
		if (node.bidirectional !== false) {
			const pullResult = await this.httpRequest(`${baseUrl}/sync/pull?peerId=${encodeURIComponent(this.localNodeId)}`, "GET", void 0, node.authToken);
			if (pullResult.ok && pullResult.batch) {
				const received = await this.receiveBatch(pullResult.batch);
				log.changesReceived = received.applied;
				log.conflictsDetected = received.conflicts.length;
				log.conflictsResolved = received.conflicts.filter((c) => c.resolution !== "pending").length;
				log.errors.push(...received.errors);
				if (received.errors.length === 0) await this.httpRequest(`${baseUrl}/sync/ack`, "POST", {
					peerId: this.localNodeId,
					clock: pullResult.batch.logicalClock
				}, node.authToken).catch(() => {});
			}
		}
	}
	/** file-share 协议同步：通过共享目录交换批次文件 */
	async syncViaFileShare(node, log) {
		const sharePath = node.sharePath;
		if (!sharePath) throw new NetworkError(`节点 ${node.nodeId} 缺少 sharePath`);
		const inboxDir = path.join(sharePath, node.nodeId, "inbox");
		const outboxDir = path.join(sharePath, this.localNodeId, "inbox");
		fs.mkdirSync(inboxDir, { recursive: true });
		fs.mkdirSync(outboxDir, { recursive: true });
		const outBatch = this.createBatch(node.nodeId);
		if (outBatch) {
			const filePath = path.join(inboxDir, `${outBatch.batchId}.json`);
			fs.writeFileSync(filePath, JSON.stringify(outBatch), "utf-8");
			log.changesSent = outBatch.changes.length;
			this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
		}
		if (node.bidirectional !== false && fs.existsSync(outboxDir)) for (const file of fs.readdirSync(outboxDir).filter((f) => f.endsWith(".json")).sort()) {
			const filePath = path.join(outboxDir, file);
			try {
				const batch = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				const received = await this.receiveBatch(batch);
				log.changesReceived += received.applied;
				log.conflictsDetected += received.conflicts.length;
				log.conflictsResolved += received.conflicts.filter((c) => c.resolution !== "pending").length;
				log.errors.push(...received.errors);
				if (received.errors.length === 0) fs.rmSync(filePath);
				else log.errors.push(`批次 ${file} 部分应用失败，保留待重试`);
			} catch (err) {
				log.errors.push(`批次文件处理失败 ${file}（保留待重试）: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	/** 启动 http-poll 定时拉取 */
	startPolling(node) {
		if (this.pollTimers.has(node.nodeId)) return;
		const timer = setInterval(() => {
			this.syncNow(node.nodeId).catch(() => {});
		}, node.pollInterval * 1e3);
		timer.unref?.();
		this.pollTimers.set(node.nodeId, timer);
	}
	/** 简易 HTTP 请求（走环境代理，JSON 载荷） */
	httpRequest(url, method, body, authToken) {
		return new Promise((resolve, reject) => {
			const parsed = new URL(url);
			const payload = body !== void 0 ? JSON.stringify(body) : void 0;
			const req = http.request({
				hostname: parsed.hostname,
				port: parsed.port || 80,
				path: parsed.pathname + parsed.search,
				method,
				headers: {
					"Content-Type": "application/json",
					...payload ? { "Content-Length": Buffer.byteLength(payload) } : {},
					...authToken ? { Authorization: `Bearer ${authToken}` } : {}
				},
				timeout: 1e4
			}, (res) => {
				let data = "";
				res.on("data", (c) => data += c);
				res.on("end", () => {
					try {
						resolve(JSON.parse(data || "{}"));
					} catch {
						resolve({
							ok: false,
							error: `非法响应: ${data.slice(0, 100)}`
						});
					}
				});
			});
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new NetworkError(`请求超时: ${url}`));
			});
			if (payload) req.write(payload);
			req.end();
		});
	}
	/** 计算批次哈希（变更 id + dataHash 链式哈希） */
	computeBatchHash(batch) {
		const chain = batch.changes.map((c) => `${c.id}:${c.dataHash}`).join("|");
		return crypto.createHash("sha256").update(`${batch.sourceNodeId}:${batch.logicalClock}:${chain}`).digest("hex");
	}
	/** 校验批次哈希 */
	verifyBatchHash(batch) {
		return this.computeBatchHash(batch) === batch.batchHash;
	}
	/** 载荷哈希 */
	hashPayload(payload) {
		return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	}
	/** 变更条目近似字节数（载荷序列化长度 + 条目固定开销） */
	approxSizeOf(entry) {
		try {
			return JSON.stringify(entry.payload).length + 256;
		} catch {
			return 4096;
		}
	}
	/** 已应用集合 FIFO 淘汰 */
	trimAppliedIds() {
		if (this.appliedIds.size <= this.options.appliedSetLimit) return;
		const overflow = this.appliedIds.size - this.options.appliedSetLimit;
		const iter = this.appliedIds.values();
		for (let i = 0; i < overflow; i++) {
			const value = iter.next().value;
			if (value !== void 0) this.appliedIds.delete(value);
		}
	}
	/** 追加同步日志（限长） */
	appendSyncLog(log) {
		this.state.syncLog.push(log);
		if (this.state.syncLog.length > this.options.syncLogLimit) this.state.syncLog = this.state.syncLog.slice(-this.options.syncLogLimit);
		this.schedulePersist();
	}
	/** 加载同步状态 */
	loadState() {
		const empty = {
			localClock: 0,
			peerClocks: {},
			pendingChanges: [],
			unresolvedConflicts: [],
			syncLog: [],
			lastSyncAt: {}
		};
		if (!fs.existsSync(this.statePath)) return empty;
		try {
			let data;
			if (this.cryptoEngine) data = this.cryptoEngine.readEncrypted(this.statePath).data;
			else data = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));
			return {
				...empty,
				...data
			};
		} catch {
			return empty;
		}
	}
	/** 防抖持久化调度 */
	schedulePersist() {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			this.persistState();
		}, this.options.statePersistInterval);
		this.persistTimer.unref?.();
	}
	/** 执行状态持久化 */
	persistState() {
		try {
			this.state.appliedIds = [...this.appliedIds].slice(-this.options.appliedSetLimit);
			if (this.cryptoEngine) {
				this.cryptoEngine.writeEncrypted(this.statePath, this.state);
				return;
			}
			const dir = path.dirname(this.statePath);
			fs.mkdirSync(dir, { recursive: true });
			const tmp = `${this.statePath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
			fs.renameSync(tmp, this.statePath);
		} catch {}
	}
};
//#endregion
//#region src/consensus/raft-engine.ts
/**
* 分布式共识引擎（Raft）
*
* 被 index.ts 的 manage_consensus Tool 调用（status / propose）。
* 集群模式下，战略决策需经多数派提交后方可执行。
*/
var RaftEngine = class {
	config;
	role = "follower";
	currentTerm = 0;
	votedFor = null;
	log = [];
	commitIndex = 0;
	lastApplied = 0;
	leaderId = null;
	/** leader 专用：各 peer 已知复制的最高日志索引 */
	matchIndex = /* @__PURE__ */ new Map();
	/** leader 专用：下一条要发送的日志索引 */
	nextIndex = /* @__PURE__ */ new Map();
	electionTimer = null;
	heartbeatTimer = null;
	server = null;
	commitCallbacks = [];
	roleChangeCallbacks = [];
	/** 提案等待队列：logIndex → { term, resolver }（term 防跨任期错配兑现） */
	pendingProposals = /* @__PURE__ */ new Map();
	running = false;
	constructor(config) {
		this.config = config;
		this.loadPersistentState();
	}
	/**
	* 启动引擎：监听共识端口 + 启动选举定时器
	*/
	start() {
		if (this.running) return;
		this.running = true;
		this.startRpcServer();
		this.resetElectionTimer();
		if (this.peers().length === 0) this.becomeLeader();
	}
	/**
	* 停止引擎：关闭服务与全部定时器
	*/
	stop() {
		if (!this.running) return;
		this.running = false;
		if (this.electionTimer) clearTimeout(this.electionTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.electionTimer = null;
		this.heartbeatTimer = null;
		this.server?.close();
		this.server = null;
		for (const p of this.pendingProposals.values()) p.resolve({
			committed: false,
			decision: null
		});
		this.pendingProposals.clear();
		this.persistState();
	}
	/**
	* 提交决策提案
	*
	* - leader：追加本地日志并复制，多数派确认后 resolve
	* - 非 leader：转发给当前 leader；无 leader 时提案失败
	* - 单节点：立即提交
	*
	* @param command 决策命令
	* @param timeoutMs 等待提交的超时（默认 10s）
	*/
	async propose(command, timeoutMs = 1e4) {
		if (!this.running) return {
			committed: false,
			decision: null
		};
		if (this.role !== "leader") {
			if (this.leaderId) return this.forwardPropose(this.leaderId, command, timeoutMs);
			return {
				committed: false,
				decision: null
			};
		}
		const entry = {
			index: this.lastLogIndex() + 1,
			term: this.currentTerm,
			command,
			timestamp: Date.now()
		};
		this.log.push(entry);
		this.persistState();
		if (this.peers().length === 0) {
			this.commitIndex = entry.index;
			this.applyCommitted();
			return {
				committed: true,
				decision: command.decision
			};
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingProposals.delete(entry.index);
				resolve({
					committed: false,
					decision: null
				});
			}, timeoutMs);
			timer.unref?.();
			this.pendingProposals.set(entry.index, {
				term: this.currentTerm,
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				}
			});
			this.broadcastHeartbeat();
		});
	}
	/** 当前 leader id（未知返回 null） */
	getLeaderId() {
		return this.leaderId;
	}
	/** 当前角色 */
	getRole() {
		return this.role;
	}
	/** 当前任期 */
	getTerm() {
		return this.currentTerm;
	}
	/**
	* 集群状态摘要（供 manage_consensus status 使用）
	*/
	getClusterStatus() {
		return {
			localNodeId: this.config.localNodeId,
			role: this.role,
			term: this.currentTerm,
			leaderId: this.leaderId,
			commitIndex: this.commitIndex,
			lastLogIndex: this.lastLogIndex(),
			logLength: this.log.length,
			peers: this.peers().map((p) => ({
				nodeId: p.nodeId,
				address: `${p.address}:${p.port}`,
				matchIndex: this.matchIndex.get(p.nodeId) ?? 0,
				nextIndex: this.nextIndex.get(p.nodeId) ?? 0
			})),
			pendingProposals: this.pendingProposals.size
		};
	}
	/** 注册已提交条目回调（状态机应用） */
	onCommit(callback) {
		this.commitCallbacks.push(callback);
	}
	/** 注册角色变更回调 */
	onRoleChange(callback) {
		this.roleChangeCallbacks.push(callback);
	}
	/** 重置选举定时器（随机化超时，priority 越高超时越短） */
	resetElectionTimer() {
		if (this.electionTimer) clearTimeout(this.electionTimer);
		if (this.role === "leader" || !this.running) return;
		const priority = this.selfConfig().priority ?? 1;
		const min = this.config.electionTimeoutMin / Math.max(1, priority);
		const max = this.config.electionTimeoutMax / Math.max(1, priority);
		const timeout = min + Math.random() * (max - min);
		this.electionTimer = setTimeout(() => this.startElection(), timeout);
		this.electionTimer.unref?.();
	}
	/** 发起选举 */
	startElection() {
		if (!this.running || this.role === "leader") return;
		this.role = "candidate";
		this.currentTerm += 1;
		this.votedFor = this.config.localNodeId;
		this.leaderId = null;
		this.persistState();
		this.emitRoleChange();
		this.resetElectionTimer();
		const lastLogIdx = this.lastLogIndex();
		const lastLogTerm = this.lastLogTerm();
		let votes = 1;
		const majority = this.majority();
		const peers = this.peers();
		if (peers.length === 0) {
			this.becomeLeader();
			return;
		}
		let settled = false;
		for (const peer of peers) this.sendRpc(peer, "RequestVote", {
			term: this.currentTerm,
			candidateId: this.config.localNodeId,
			lastLogIndex: lastLogIdx,
			lastLogTerm
		}).then((reply) => {
			if (settled || this.role !== "candidate") return;
			if (reply.term > this.currentTerm) {
				this.stepDown(reply.term);
				return;
			}
			if (reply.voteGranted) {
				votes += 1;
				if (votes >= majority) {
					settled = true;
					this.becomeLeader();
				}
			}
		}).catch(() => {});
	}
	/** 成为 leader：初始化 nextIndex/matchIndex 并启动心跳 */
	becomeLeader() {
		this.role = "leader";
		this.leaderId = this.config.localNodeId;
		const next = this.lastLogIndex() + 1;
		for (const peer of this.peers()) {
			this.nextIndex.set(peer.nodeId, next);
			this.matchIndex.set(peer.nodeId, 0);
		}
		this.emitRoleChange();
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = setInterval(() => this.broadcastHeartbeat(), this.config.heartbeatInterval);
		this.heartbeatTimer.unref?.();
		this.broadcastHeartbeat();
	}
	/** 降级为 follower */
	stepDown(newTerm) {
		if (newTerm > this.currentTerm) {
			this.currentTerm = newTerm;
			this.votedFor = null;
			this.persistState();
		}
		if (this.role !== "follower") {
			this.role = "follower";
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			this.emitRoleChange();
		}
		this.resetElectionTimer();
	}
	/** leader 广播心跳 / 日志复制 */
	broadcastHeartbeat() {
		if (this.role !== "leader" || !this.running) return;
		for (const peer of this.peers()) this.replicateTo(peer).catch(() => {});
	}
	/** 向单个 peer 复制日志 */
	async replicateTo(peer) {
		const next = this.nextIndex.get(peer.nodeId) ?? this.lastLogIndex() + 1;
		const prevLogIndex = next - 1;
		const prevEntry = this.findByIndex(prevLogIndex);
		const entries = this.log.filter((e) => e.index >= next);
		const reply = await this.sendRpc(peer, "AppendEntries", {
			term: this.currentTerm,
			leaderId: this.config.localNodeId,
			prevLogIndex,
			prevLogTerm: prevEntry?.term ?? 0,
			entries,
			leaderCommit: this.commitIndex
		});
		if (reply.term > this.currentTerm) {
			this.stepDown(reply.term);
			return;
		}
		if (this.role !== "leader") return;
		if (reply.success) {
			const newMatch = prevLogIndex + entries.length;
			this.matchIndex.set(peer.nodeId, Math.max(this.matchIndex.get(peer.nodeId) ?? 0, newMatch));
			this.nextIndex.set(peer.nodeId, newMatch + 1);
			this.advanceCommitIndex();
		} else {
			const fallback = Math.max(1, next - 1);
			const hinted = reply.conflictIndex && reply.conflictIndex >= 1 ? Math.min(next, reply.conflictIndex) : fallback;
			this.nextIndex.set(peer.nodeId, Math.max(1, Math.min(hinted, fallback)));
		}
	}
	/** leader 推进 commitIndex（多数派 + 仅提交当前任期日志） */
	advanceCommitIndex() {
		const majority = this.majority();
		for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
			const entry = this.findByIndex(n);
			if (!entry || entry.term !== this.currentTerm) continue;
			if (1 + this.peers().filter((p) => (this.matchIndex.get(p.nodeId) ?? 0) >= n).length >= majority) {
				this.commitIndex = n;
				this.applyCommitted();
				break;
			}
		}
	}
	/** 应用已提交但未应用的日志条目 */
	applyCommitted() {
		while (this.lastApplied < this.commitIndex) {
			this.lastApplied += 1;
			const entry = this.findByIndex(this.lastApplied);
			if (!entry) continue;
			for (const cb of this.commitCallbacks) try {
				cb(entry);
			} catch {}
			const pending = this.pendingProposals.get(entry.index);
			if (pending) {
				this.pendingProposals.delete(entry.index);
				pending.resolve(pending.term === entry.term ? {
					committed: true,
					decision: entry.command.decision
				} : {
					committed: false,
					decision: null
				});
			}
		}
	}
	/** 处理 RequestVote */
	handleRequestVote(args) {
		if (args.term > this.currentTerm) this.stepDown(args.term);
		let voteGranted = false;
		if (args.term === this.currentTerm && (this.votedFor === null || this.votedFor === args.candidateId)) {
			if (args.lastLogTerm > this.lastLogTerm() || args.lastLogTerm === this.lastLogTerm() && args.lastLogIndex >= this.lastLogIndex()) {
				this.votedFor = args.candidateId;
				voteGranted = true;
				this.persistState();
				this.resetElectionTimer();
			}
		}
		return {
			term: this.currentTerm,
			voteGranted
		};
	}
	/** 处理 AppendEntries */
	handleAppendEntries(args) {
		if (args.term > this.currentTerm) this.stepDown(args.term);
		if (args.term < this.currentTerm) return {
			term: this.currentTerm,
			success: false
		};
		if (this.role === "candidate") this.stepDown(this.currentTerm);
		this.leaderId = args.leaderId;
		this.resetElectionTimer();
		if (args.prevLogIndex > 0) {
			const prevEntry = this.findByIndex(args.prevLogIndex);
			if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
				let conflictIndex;
				if (!prevEntry) conflictIndex = Math.min(this.lastLogIndex() + 1, args.prevLogIndex);
				else {
					let i = args.prevLogIndex;
					while (i > 1) {
						const e = this.findByIndex(i - 1);
						if (!e || e.term !== prevEntry.term) break;
						i -= 1;
					}
					conflictIndex = i;
				}
				return {
					term: this.currentTerm,
					success: false,
					conflictIndex
				};
			}
		}
		let firstConflict = -1;
		for (let i = 0; i < args.entries.length; i += 1) {
			const entry = args.entries[i];
			const existing = this.findByIndex(entry.index);
			if (!existing || existing.term === entry.term) continue;
			firstConflict = i;
			break;
		}
		let mutated = false;
		if (firstConflict >= 0) {
			const cutIndex = args.entries[firstConflict].index;
			this.log = this.log.filter((e) => e.index < cutIndex);
			for (let i = firstConflict; i < args.entries.length; i += 1) this.log.push(args.entries[i]);
			mutated = true;
		} else for (const entry of args.entries) if (this.insertOrdered(entry)) mutated = true;
		if (mutated) this.persistState();
		if (args.leaderCommit > this.commitIndex) {
			this.commitIndex = Math.min(args.leaderCommit, this.lastLogIndex());
			this.applyCommitted();
		}
		return {
			term: this.currentTerm,
			success: true
		};
	}
	/** 启动共识 RPC 服务 */
	startRpcServer() {
		this.server = http.createServer((req, res) => {
			let body = "";
			req.on("data", (c) => body += c);
			req.on("end", () => {
				let reply = { ok: false };
				try {
					const { rpc, args } = JSON.parse(body || "{}");
					switch (rpc) {
						case "RequestVote":
							reply = {
								ok: true,
								...this.handleRequestVote(args)
							};
							break;
						case "AppendEntries":
							reply = {
								ok: true,
								...this.handleAppendEntries(args)
							};
							break;
						case "Propose":
							this.propose(args.command, 8e3).then((result) => {
								res.writeHead(200, { "Content-Type": "application/json" });
								res.end(JSON.stringify({
									ok: true,
									...result
								}));
							});
							return;
						case "Status":
							reply = {
								ok: true,
								...this.getClusterStatus()
							};
							break;
						default: reply = {
							ok: false,
							error: `未知 RPC: ${rpc}`
						};
					}
				} catch (err) {
					reply = {
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					};
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(reply));
			});
		});
		this.server.on("error", () => {});
		this.server.listen(this.config.consensusPort);
	}
	/** 发送 RPC 到 peer（泛型响应类型，JSON 边界处一次性断言） */
	sendRpc(peer, rpc, args) {
		return new Promise((resolve, reject) => {
			const payload = JSON.stringify({
				rpc,
				args
			});
			const req = http.request({
				hostname: peer.address,
				port: peer.port,
				method: "POST",
				path: "/raft",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload)
				},
				timeout: 2e3
			}, (res) => {
				let data = "";
				res.on("data", (c) => data += c);
				res.on("end", () => {
					try {
						resolve(JSON.parse(data || "{}"));
					} catch {
						reject(new NetworkError(`RPC 响应解析失败: ${rpc}`));
					}
				});
			});
			req.on("error", reject);
			req.on("timeout", () => {
				req.destroy();
				reject(new NetworkError(`RPC 超时: ${rpc} → ${peer.nodeId}`));
			});
			req.write(payload);
			req.end();
		});
	}
	/** 非 leader 转发提案 */
	async forwardPropose(leaderId, command, timeoutMs) {
		const leader = this.config.cluster.find((n) => n.nodeId === leaderId);
		if (!leader) return {
			committed: false,
			decision: null
		};
		let timer;
		try {
			const reply = await Promise.race([this.sendRpc(leader, "Propose", { command }), new Promise((_, reject) => {
				timer = setTimeout(() => reject(new NetworkError("forward timeout")), timeoutMs);
				timer.unref?.();
			})]);
			return {
				committed: reply.committed === true,
				decision: reply.decision ?? null
			};
		} catch {
			return {
				committed: false,
				decision: null
			};
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	/** 除自己外的 peer 列表 */
	peers() {
		return this.config.cluster.filter((n) => n.nodeId !== this.config.localNodeId);
	}
	/** 自身节点配置 */
	selfConfig() {
		return this.config.cluster.find((n) => n.nodeId === this.config.localNodeId) ?? {
			nodeId: this.config.localNodeId,
			address: "127.0.0.1",
			port: this.config.consensusPort
		};
	}
	/** 多数派数量 */
	majority() {
		return Math.floor(this.config.cluster.length / 2) + 1;
	}
	/** 最后一条日志索引 */
	lastLogIndex() {
		return this.log.length > 0 ? this.log[this.log.length - 1].index : 0;
	}
	/**
	* 按索引二分查找日志条目（日志保持 index 升序不变量）。
	* 原实现 Array.find 线性扫描——advanceCommitIndex 每轮对每个 n 都
	* 全表扫，日志增长到数千条后复制心跳的 CPU 开销平方级膨胀
	*/
	findByIndex(index) {
		let lo = 0;
		let hi = this.log.length - 1;
		while (lo <= hi) {
			const mid = lo + hi >> 1;
			const e = this.log[mid];
			if (e.index === index) return e;
			if (e.index < index) lo = mid + 1;
			else hi = mid - 1;
		}
	}
	/**
	* 有序插入：索引已存在返回 false；否则按升序插入到正确位次
	* （纯追加路径 index > 尾元素 → O(1) 尾推）
	*/
	insertOrdered(entry) {
		const last = this.log[this.log.length - 1];
		if (last) {
			if (last.index === entry.index) return false;
			if (last.index < entry.index) {
				this.log.push(entry);
				return true;
			}
		} else {
			this.log.push(entry);
			return true;
		}
		let lo = 0;
		let hi = this.log.length - 1;
		while (lo <= hi) {
			const mid = lo + hi >> 1;
			if (this.log[mid].index < entry.index) lo = mid + 1;
			else hi = mid - 1;
		}
		if (this.log[lo]?.index === entry.index) return false;
		this.log.splice(lo, 0, entry);
		return true;
	}
	/** 最后一条日志任期 */
	lastLogTerm() {
		return this.log.length > 0 ? this.log[this.log.length - 1].term : 0;
	}
	/** 触发角色变更回调 */
	emitRoleChange() {
		for (const cb of this.roleChangeCallbacks) try {
			cb(this.role, this.currentTerm);
		} catch {}
	}
	/** 加载持久化状态 */
	loadPersistentState() {
		if (!fs.existsSync(this.config.logPath)) return;
		try {
			const state = JSON.parse(fs.readFileSync(this.config.logPath, "utf-8"));
			this.currentTerm = state.currentTerm ?? 0;
			this.votedFor = state.votedFor ?? null;
			this.log = Array.isArray(state.log) ? state.log : [];
		} catch {}
	}
	/** 持久化状态（原子写入） */
	persistState() {
		try {
			const state = {
				currentTerm: this.currentTerm,
				votedFor: this.votedFor,
				log: this.log
			};
			const dir = path.dirname(this.config.logPath);
			fs.mkdirSync(dir, { recursive: true });
			const tmp = `${this.config.logPath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
			fs.renameSync(tmp, this.config.logPath);
		} catch {}
	}
};
//#endregion
//#region src/core/resilience.ts
/**
* resilience.ts — 弹性内核（项目 4.0「可靠执行」基石）
*
* 勘察结论（升级前）：task-executor 重试紧贴重发（无退避）、错误不分型
* （网络错与质量错同路径）、无模型级熔断（同一坏模型被反复重试打爆配额）。
*
* 本内核把「熔断 + 退避 + 错误分型」做成全链路共享的纯组件：
* - CircuitBreaker：closed → open（连续失败 ≥ 阈值）→ half-open（冷却后单试探，
*   并发互斥——同一时刻只放行一个探测请求）→ closed（探测成功）
* - CircuitBreakerRegistry：按 key（如 modelId）隔离的熔断器集合（容量上限防泄漏）
* - backoffDelayMs：指数退避 + 全抖动（防惊群），可注入随机源保证测试确定性
* - abortableSleep：可中止睡眠（全局超时到达时立即中断退避等待）
* - classifyError：错误分型——可退避重试（网络/超时/限流）/ 立即重试 /
*   换模型（能力类）/ 终止（不可恢复），驱动差异化重试策略
*/
const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
	failureThreshold: 5,
	cooldownMs: 6e4
};
/**
* 单 key 熔断器
*
* half-open 并发互斥：冷却期满后首个请求获得探测资格，其余请求仍被拒绝——
* 避免冷却结束瞬间流量洪峰直接打到尚未恢复的下游。
*/
var CircuitBreaker = class {
	config;
	state = "closed";
	consecutiveFailures = 0;
	openedAt = 0;
	/** half-open 探测互斥：>0 表示已有探测在途 */
	halfOpenInFlight = 0;
	constructor(config) {
		this.config = {
			...DEFAULT_CIRCUIT_BREAKER_CONFIG,
			...config
		};
	}
	/** 探测当前是否放行（不改变状态；放行后调用方须成对调用 recordSuccess/recordFailure） */
	canExecute(now = Date.now()) {
		if (this.state === "open") {
			const elapsed = now - this.openedAt;
			if (elapsed < this.config.cooldownMs) return {
				allowed: false,
				state: "open",
				msUntilRetry: this.config.cooldownMs - elapsed
			};
			this.state = "half-open";
		}
		if (this.state === "half-open") {
			if (this.halfOpenInFlight > 0) return {
				allowed: false,
				state: "half-open",
				msUntilRetry: this.config.cooldownMs
			};
			this.halfOpenInFlight += 1;
			return {
				allowed: true,
				state: "half-open",
				msUntilRetry: 0
			};
		}
		return {
			allowed: true,
			state: "closed",
			msUntilRetry: 0
		};
	}
	/**
	* 无副作用检查：纯读取当前可执行性（不获取 half-open 探测名额）
	*
	* 用于候选过滤/展示等「只看不执行」场景——canExecute 在 half-open 态
	* 会占用探测名额，纯检查场景必须用 peek，否则名额泄漏导致永久误判熔断。
	*/
	peek(now = Date.now()) {
		if (this.state === "open") {
			const elapsed = now - this.openedAt;
			if (elapsed < this.config.cooldownMs) return {
				allowed: false,
				state: "open",
				msUntilRetry: this.config.cooldownMs - elapsed
			};
			if (this.halfOpenInFlight > 0) return {
				allowed: false,
				state: "half-open",
				msUntilRetry: this.config.cooldownMs
			};
			return {
				allowed: true,
				state: "half-open",
				msUntilRetry: 0
			};
		}
		if (this.state === "half-open") {
			if (this.halfOpenInFlight > 0) return {
				allowed: false,
				state: "half-open",
				msUntilRetry: this.config.cooldownMs
			};
			return {
				allowed: true,
				state: "half-open",
				msUntilRetry: 0
			};
		}
		return {
			allowed: true,
			state: "closed",
			msUntilRetry: 0
		};
	}
	/** 成功回报：清零失败计数，half-open 探测成功 → 恢复闭合 */
	recordSuccess() {
		this.consecutiveFailures = 0;
		if (this.state === "half-open") this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
		this.state = "closed";
	}
	/** 失败回报：累计连续失败，达阈值熔断；half-open 探测失败 → 重新熔断 */
	recordFailure(now = Date.now()) {
		if (this.state === "half-open") this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures >= this.config.failureThreshold && this.state !== "open") {
			this.state = "open";
			this.openedAt = now;
		}
	}
	/** 状态快照（可观测性） */
	getState() {
		return {
			state: this.state,
			consecutiveFailures: this.consecutiveFailures
		};
	}
	/** 手动复位 */
	reset() {
		this.state = "closed";
		this.consecutiveFailures = 0;
		this.halfOpenInFlight = 0;
	}
	/**
	* 释放 half-open 探测资格（不改变成功/失败统计）
	*
	* 用于「请求已发出但无法判定下游可用性」的场景（如客户端 4xx）：
	* 探测互斥锁必须释放，否则后续请求永久被拒。
	*/
	releaseProbe() {
		this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
	}
};
/**
* 按 key 隔离的熔断器注册表
*
* 典型 key = modelId（模型 A 熔断不影响模型 B）；容量上限 + 简单 LRU 淘汰，
* 防止长尾模型 id 导致的无界增长。
*/
var CircuitBreakerRegistry = class {
	breakers = /* @__PURE__ */ new Map();
	config;
	capacity;
	constructor(config) {
		this.config = {
			...DEFAULT_CIRCUIT_BREAKER_CONFIG,
			...config
		};
		this.capacity = config?.capacity ?? 256;
	}
	get(key) {
		let breaker = this.breakers.get(key);
		if (!breaker) {
			if (this.breakers.size >= this.capacity) {
				const oldest = this.breakers.keys().next().value;
				if (oldest !== void 0) this.breakers.delete(oldest);
			}
			breaker = new CircuitBreaker(this.config);
			this.breakers.set(key, breaker);
		}
		return breaker;
	}
	canExecute(key, now) {
		return this.get(key).canExecute(now);
	}
	/** 无副作用检查（纯读取，不占用 half-open 探测名额） */
	peek(key, now) {
		return this.get(key).peek(now);
	}
	recordSuccess(key) {
		this.get(key).recordSuccess();
	}
	recordFailure(key) {
		this.get(key).recordFailure();
	}
	releaseProbe(key) {
		this.get(key).releaseProbe();
	}
	/** 全部熔断器状态（运维可观测） */
	snapshot() {
		const out = {};
		for (const [key, breaker] of this.breakers) out[key] = breaker.getState();
		return out;
	}
	/** 是否有任一 key 处于熔断（快速检查） */
	hasOpen() {
		for (const breaker of this.breakers.values()) if (breaker.getState().state !== "closed") return true;
		return false;
	}
	reset(key) {
		if (key !== void 0) this.breakers.get(key)?.reset();
		else this.breakers.clear();
	}
};
const DEFAULT_BACKOFF_CONFIG = {
	baseMs: 200,
	factor: 2,
	maxMs: 8e3
};
/**
* 指数退避延迟（全抖动：[0, min(base × factor^(attempt-1), max)] 均匀采样）
*
* 全抖动（full jitter）相对确定性退避的优势：并发重试错峰，防惊群。
* @param attempt 本次失败后的重试序号（1 = 第一次重试）
* @param rng 随机源（测试可注入确定性实现）
*/
function backoffDelayMs(attempt, config, rng = Math.random) {
	const cfg = {
		...DEFAULT_BACKOFF_CONFIG,
		...config
	};
	const ceiling = Math.min(cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt - 1)), cfg.maxMs);
	return Math.max(0, Math.round(rng() * ceiling));
}
/**
* 可中止睡眠：全局超时/中止信号到达时立即返回 false（放弃重试）
* @returns true = 睡满（可继续重试）；false = 被中止（放弃）
*/
function abortableSleep(ms, abortSignal) {
	if (ms <= 0) return Promise.resolve(!abortSignal?.aborted);
	return new Promise((resolve) => {
		if (abortSignal?.aborted) {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			abortSignal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** LLM 客户端可重试状态码（与 llm-client.ts 口径一致） */
const RETRYABLE_LLM_STATUS = /* @__PURE__ */ new Set([
	408,
	429,
	500,
	502,
	503,
	504
]);
/**
* 错误分型（差异化重试的依据）
*
* 分型策略：
* - TimeoutError → retryable-backoff（下游可能过载，退避让路）
* - NetworkError → retryable-backoff（网络抖动，退避重试）
* - 携带可重试状态码的 LLMError → retryable-backoff（429/5xx）
* - 携带 4xx（非 408/429）状态码 → fatal（请求本身有问题，重试无意义）
* - 质量不达标（由调用方在 verdict 层判定，不走本函数）→ switch-model
* - 其余未知错误 → fatal（与升级前「非超时不重试」行为一致）
*/
function classifyError(err) {
	if (err instanceof TimeoutError) return {
		class: "retryable-backoff",
		kind: "timeout",
		reason: "执行超时，退避后重试"
	};
	if (err instanceof NetworkError) return {
		class: "retryable-backoff",
		kind: "network",
		reason: "网络错误，退避后重试"
	};
	const status = err?.status;
	if (typeof status === "number") {
		if (status === 429) return {
			class: "retryable-backoff",
			kind: "rate-limit",
			reason: `限流（${status}），退避后重试`
		};
		if (RETRYABLE_LLM_STATUS.has(status)) return {
			class: "retryable-backoff",
			kind: "server",
			reason: `服务端错误（${status}），退避后重试`
		};
		return {
			class: "fatal",
			kind: "client",
			reason: `客户端错误（${status}），重试无意义`
		};
	}
	return {
		class: "fatal",
		kind: "unknown",
		reason: "未知错误，保守终止重试"
	};
}
//#endregion
//#region src/benchmark/benchmark-engine.ts
/**
* benchmark-engine.ts — 性能基准测试引擎（能力层，依赖 long-term-memory + crypto-engine）
*
* 职责：
* - 场景化压测：按 target 维度（sentinel/strategist/executor/memory/sync/
*   consensus/encryption/full-pipeline）注册并执行基准场景
* - 统计计算：成功率、延迟分位数（p50/p90/p95/p99）、标准差、吞吐率、峰值内存
* - 阈值门禁：每类 target 有默认性能阈值，违反即判定不通过
* - 报告管理：持久化报告、历史对比、Markdown 报告生成
*
* 升级点（相对基础实现的质的提升）：
* 1. 真实并发池：按 scenario.concurrency 并发调度 + 预热阶段（warmupRequests
*    结果不计入统计），避免 JIT 冷启动污染数据
* 2. 无侵入内置场景：memory / encryption 场景直接压测真实模块，
*    strategist / executor 等需要 LLM 的场景在 callLLM 缺省时自动跳过并标注原因，
*    保证离线环境也能产出有效报告
* 3. 分 target 阈值门禁：不同 target 使用不同阈值（如 encryption 要求 p95 < 50ms，
*    full-pipeline 放宽到 p95 < 30s），阈值违反逐条列出
* 4. 延迟分布直方图：指数分桶（<1ms / 1-10ms / ... / >10s），直观呈现长尾
* 5. 报告对比：compareReports 输出逐场景的延迟与吞吐变化率，用于回归检测
*/
/** 分 target 默认阈值 */
const DEFAULT_THRESHOLDS = {
	sentinel: {
		maxP95Latency: 100,
		minThroughput: 50,
		minSuccessRate: .99,
		maxP99Latency: 300
	},
	strategist: {
		maxP95Latency: 15e3,
		minThroughput: .05,
		minSuccessRate: .9,
		maxP99Latency: 3e4
	},
	executor: {
		maxP95Latency: 2e4,
		minThroughput: .05,
		minSuccessRate: .9,
		maxP99Latency: 45e3
	},
	memory: {
		maxP95Latency: 20,
		minThroughput: 100,
		minSuccessRate: .999,
		maxP99Latency: 100
	},
	sync: {
		maxP95Latency: 200,
		minThroughput: 20,
		minSuccessRate: .99,
		maxP99Latency: 500
	},
	consensus: {
		maxP95Latency: 500,
		minThroughput: 10,
		minSuccessRate: .99,
		maxP99Latency: 1e3
	},
	encryption: {
		maxP95Latency: 50,
		minThroughput: 50,
		minSuccessRate: .999,
		maxP99Latency: 200
	},
	"full-pipeline": {
		maxP95Latency: 3e4,
		minThroughput: .02,
		minSuccessRate: .85,
		maxP99Latency: 6e4
	}
};
/** 延迟分布桶边界（毫秒） */
const LATENCY_BUCKETS = [
	{
		bucket: "<1ms",
		max: 1
	},
	{
		bucket: "1-10ms",
		max: 10
	},
	{
		bucket: "10-50ms",
		max: 50
	},
	{
		bucket: "50-100ms",
		max: 100
	},
	{
		bucket: "100-500ms",
		max: 500
	},
	{
		bucket: "500ms-1s",
		max: 1e3
	},
	{
		bucket: "1-5s",
		max: 5e3
	},
	{
		bucket: "5-10s",
		max: 1e4
	},
	{
		bucket: ">10s",
		max: Infinity
	}
];
/** 插件版本（与 package.json 对齐） */
const PLUGIN_VERSION = "0.1.0";
/**
* 性能基准测试引擎
*
* 被 index.ts 的 run_benchmark Tool 调用
* （run-all / list-scenarios / list-reports / compare / generate-report）。
*/
var BenchmarkEngine = class {
	reportDir;
	scenarios = /* @__PURE__ */ new Map();
	thresholds = { ...DEFAULT_THRESHOLDS };
	/**
	* @param reportDir 报告持久化目录（如 .scheduler/benchmarks）
	*/
	constructor(reportDir) {
		this.reportDir = reportDir;
		fs.mkdirSync(reportDir, { recursive: true });
	}
	/**
	* 注册自定义场景（同名覆盖）
	*/
	registerScenario(scenario) {
		this.scenarios.set(scenario.name, scenario);
	}
	/**
	* 覆盖指定 target 的性能阈值
	*/
	setThreshold(target, threshold) {
		this.thresholds[target] = {
			...this.thresholds[target],
			...threshold
		};
	}
	/** 获取已注册场景名列表 */
	listScenarios() {
		return [...this.scenarios.values()].map((s) => ({
			name: s.name,
			target: s.target,
			concurrency: s.concurrency,
			totalRequests: s.totalRequests
		}));
	}
	/**
	* 注册内置场景
	*
	* - memory / encryption / sentinel / executor / sync / consensus 场景直接压测
	*   真实模块（离线可运行；executor 压测其弹性内核：熔断/退避/错误分型）
	* - strategist / full-pipeline 场景依赖 context.callLLM，
	*   缺省时注册为"跳过型"场景（执行时立即标注 skipped 原因）
	*/
	registerBuiltinScenarios(context) {
		const { memory, cryptoEngine, callLLM, models } = context;
		const benchStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.registerScenario({
			name: "memory-write-read",
			description: "记忆库写入 + findPattern 检索混合负载",
			target: "memory",
			concurrency: 8,
			totalRequests: 500,
			warmupRequests: 50,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					if (iteration % 2 === 0) memory.findPattern("code-generation", iteration % 10 / 10, ["typescript"]);
					else memory.recordDecisionFeedback({
						signalType: "benchmark",
						signalDescription: `bench-${iteration}`,
						decision: "execute",
						outcome: "good",
						outcomeReason: "benchmark synthetic"
					});
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			}
		});
		this.registerScenario({
			name: "encryption-roundtrip",
			description: "敏感字段加密 + 解密回环",
			target: "encryption",
			concurrency: 8,
			totalRequests: 500,
			warmupRequests: 50,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					const payload = {
						apiKey: `sk-bench-${iteration}`,
						nested: { password: `pw-${iteration}` },
						plain: "x".repeat(200)
					};
					const { result } = cryptoEngine.encryptSensitiveFields(payload);
					cryptoEngine.decryptSensitiveFields(result);
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			}
		});
		const benchSentinel = new Sentinel({
			watchCodeChanges: false,
			watchErrors: false,
			watchPerformance: false,
			aggregationWindow: .05,
			maxBatchSize: 32
		}, () => {});
		this.registerScenario({
			name: "sentinel-ingest-flush",
			description: "哨兵信号注入 + 窗口聚合去重 + 批次交付",
			target: "sentinel",
			concurrency: 4,
			totalRequests: 400,
			warmupRequests: 40,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					for (let i = 0; i < 5; i += 1) benchSentinel.ingest({
						type: i % 2 === 0 ? "code-change" : "error-detected",
						description: `bench-signal-${iteration}-${i}`,
						payload: {
							iteration,
							i
						},
						source: "bench",
						dedupeKey: `bench:${iteration % 64}:${i % 2}`
					});
					benchSentinel.flush("flush");
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			},
			teardown: () => benchSentinel.stop()
		});
		const benchBreakers = new CircuitBreakerRegistry({
			failureThreshold: 5,
			cooldownMs: 1e3,
			capacity: 64
		});
		this.registerScenario({
			name: "executor-resilience-kernel",
			description: "执行器弹性内核：模型级熔断探测/回报 + 全抖动退避 + 错误分型",
			target: "executor",
			concurrency: 4,
			totalRequests: 400,
			warmupRequests: 40,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					const key = `bench-model-${iteration % 8}`;
					if (benchBreakers.canExecute(key).allowed) {
						if (iteration % 3 === 0) benchBreakers.recordFailure(key);
						else benchBreakers.recordSuccess(key);
					}
					for (let attempt = 1; attempt <= 4; attempt += 1) backoffDelayMs(attempt);
					classifyError(new TimeoutError("bench timeout"));
					classifyError(Object.assign(/* @__PURE__ */ new Error("bench rate limited"), { status: 429 }));
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			},
			teardown: () => benchBreakers.reset()
		});
		const syncNodeA = new DistributedSync("bench-node-a", memory, path.join(os.tmpdir(), `dsh-bench-sync-a-${benchStamp}.json`), null);
		const syncNodeB = new DistributedSync("bench-node-b", new LongTermMemory(path.join(os.tmpdir(), `dsh-bench-sync-memb-${benchStamp}.json`)), path.join(os.tmpdir(), `dsh-bench-sync-b-${benchStamp}.json`), null);
		this.registerScenario({
			name: "sync-batch-roundtrip",
			description: "分布式同步：变更登记 + 增量批次创建 + 对端哈希校验/幂等应用",
			target: "sync",
			concurrency: 2,
			totalRequests: 200,
			warmupRequests: 20,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					syncNodeA.recordChange("feedback-created", `bench-fb-${iteration}`, {
						id: `bench-fb-${iteration}`,
						timestamp: Date.now(),
						signalType: "benchmark-sync",
						signalDescription: `sync-${iteration}`,
						decision: "execute",
						outcome: "good",
						outcomeReason: "benchmark synthetic"
					});
					const batch = syncNodeA.createBatch("bench-node-b");
					if (batch) {
						const result = await syncNodeB.receiveBatch(batch);
						if (result.errors.length > 0) return {
							success: false,
							latency: Date.now() - startedAt,
							error: result.errors[0]
						};
						syncNodeA.acknowledgePeer("bench-node-b", batch.logicalClock);
					}
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			},
			teardown: () => {
				syncNodeA.stop();
				syncNodeB.stop();
			}
		});
		const raftEngine = new RaftEngine({
			localNodeId: "bench-raft-node",
			cluster: [],
			electionTimeoutMin: 150,
			electionTimeoutMax: 300,
			heartbeatInterval: 50,
			consensusPort: 25e3 + Math.floor(Math.random() * 2e4),
			logPath: path.join(os.tmpdir(), `dsh-bench-raft-${benchStamp}.json`)
		});
		let raftStarted = false;
		this.registerScenario({
			name: "consensus-single-node-propose",
			description: "共识引擎：单节点集群提案 → 日志追加 → 多数派（自身）提交",
			target: "consensus",
			concurrency: 1,
			totalRequests: 100,
			warmupRequests: 10,
			timeout: 5e3,
			execute: async (iteration) => {
				const startedAt = Date.now();
				try {
					if (!raftStarted) {
						raftEngine.start();
						raftStarted = true;
					}
					const result = await raftEngine.propose({
						type: "execute-plan",
						signalId: `bench-sig-${iteration}`,
						signalDescription: `consensus bench ${iteration}`,
						decision: null,
						proposedBy: "bench-raft-node"
					}, 3e3);
					return {
						success: result.committed,
						latency: Date.now() - startedAt,
						error: result.committed ? void 0 : "提案未提交"
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			},
			teardown: () => {
				raftEngine.stop();
			}
		});
		this.registerScenario({
			name: "strategist-decision",
			description: "战略决策模型调用延迟与成功率",
			target: "strategist",
			concurrency: 2,
			totalRequests: 10,
			warmupRequests: 1,
			timeout: 6e4,
			execute: async (iteration) => {
				const startedAt = Date.now();
				if (typeof callLLM !== "function") return {
					success: false,
					latency: 0,
					error: "skipped: callLLM 未提供"
				};
				try {
					await Promise.race([callLLM({
						task: `benchmark-decision-${iteration}`,
						models
					}), new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), 6e4))]);
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			}
		});
		this.registerScenario({
			name: "full-pipeline-e2e",
			description: "信号 → 决策 → 计划 → 执行 → 沉淀全链路",
			target: "full-pipeline",
			concurrency: 1,
			totalRequests: 5,
			warmupRequests: 0,
			timeout: 12e4,
			execute: async (iteration) => {
				const startedAt = Date.now();
				if (typeof callLLM !== "function") return {
					success: false,
					latency: 0,
					error: "skipped: callLLM 未提供"
				};
				try {
					await callLLM({
						task: `benchmark-pipeline-${iteration}`,
						models
					});
					memory.recordDecisionFeedback({
						signalType: "benchmark-pipeline",
						signalDescription: `e2e-${iteration}`,
						decision: "execute",
						outcome: "good",
						outcomeReason: "benchmark synthetic"
					});
					return {
						success: true,
						latency: Date.now() - startedAt
					};
				} catch (err) {
					return {
						success: false,
						latency: Date.now() - startedAt,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			}
		});
	}
	/**
	* 执行单个场景
	* @param scenario 场景定义
	* @param onProgress 进度回调 (done, total)
	*/
	async runScenario(scenario, onProgress) {
		const total = scenario.totalRequests + scenario.warmupRequests;
		const latencies = [];
		const errors = {};
		let successCount = 0;
		let failCount = 0;
		let done = 0;
		let peakMemoryMB = 0;
		const startedAt = performance.now();
		let cursor = 0;
		const worker = async () => {
			while (cursor < total) {
				const iteration = cursor++;
				const isWarmup = iteration < scenario.warmupRequests;
				let result;
				let timeoutId;
				try {
					result = await Promise.race([scenario.execute(iteration), new Promise((_, reject) => {
						timeoutId = setTimeout(() => reject(/* @__PURE__ */ new Error(`scenario timeout after ${scenario.timeout}ms`)), scenario.timeout);
					})]);
				} catch (err) {
					result = {
						success: false,
						latency: 0,
						error: err instanceof Error ? err.message : String(err)
					};
				} finally {
					clearTimeout(timeoutId);
				}
				if (!isWarmup) {
					if (result.success) {
						successCount += 1;
						latencies.push(result.latency);
					} else {
						failCount += 1;
						const key = result.error ?? "unknown";
						errors[key] = (errors[key] ?? 0) + 1;
					}
				}
				done += 1;
				const mem = process.memoryUsage();
				peakMemoryMB = Math.max(peakMemoryMB, mem.heapUsed / 1024 / 1024);
				onProgress?.(done, total);
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, scenario.concurrency) }, () => worker()));
		const totalDuration = performance.now() - startedAt;
		try {
			await scenario.teardown?.();
		} catch {}
		const stats = this.computeStats(latencies, successCount, failCount, errors, totalDuration, peakMemoryMB);
		const latencyDistribution = this.buildDistribution(latencies);
		const thresholdViolations = this.checkThresholds(scenario.target, stats);
		return {
			stats,
			latencyDistribution,
			passed: thresholdViolations.length === 0,
			thresholdViolations
		};
	}
	/**
	* 执行全部已注册场景并生成报告（自动持久化）
	* @param onProgress 进度回调 (scenarioName, done, total)
	*/
	async runAll(onProgress) {
		const startedAt = Date.now();
		const report = {
			id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			timestamp: Date.now(),
			environment: {
				nodeVersion: process.version,
				platform: process.platform,
				arch: process.arch,
				cpuCount: os.cpus().length,
				totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
				pluginVersion: PLUGIN_VERSION
			},
			scenarios: [],
			overallPassed: true,
			totalDuration: 0
		};
		for (const scenario of this.scenarios.values()) {
			const { stats, latencyDistribution, passed, thresholdViolations } = await this.runScenario(scenario, (done, total) => onProgress?.(scenario.name, done, total));
			report.scenarios.push({
				name: scenario.name,
				description: scenario.description,
				target: scenario.target,
				concurrency: scenario.concurrency,
				stats,
				passed,
				thresholdViolations,
				latencyDistribution
			});
			if (!passed) report.overallPassed = false;
		}
		report.totalDuration = Date.now() - startedAt;
		this.saveReport(report);
		return report;
	}
	/** 加载全部历史报告（按时间倒序） */
	loadReports() {
		if (!fs.existsSync(this.reportDir)) return [];
		const files = fs.readdirSync(this.reportDir).filter((f) => f.endsWith(".json"));
		const reports = [];
		for (const file of files) try {
			reports.push(JSON.parse(fs.readFileSync(path.join(this.reportDir, file), "utf-8")));
		} catch {}
		return reports.sort((a, b) => b.timestamp - a.timestamp);
	}
	/**
	* 对比两份报告，输出逐场景变化（用于性能回归检测）
	* @param beforeId 基线报告 id
	* @param afterId 新报告 id
	*/
	compareReports(beforeId, afterId) {
		const reports = this.loadReports();
		const before = reports.find((r) => r.id === beforeId);
		const after = reports.find((r) => r.id === afterId);
		if (!before || !after) throw new AppError(`报告不存在: before=${beforeId}, after=${afterId}`, "BENCHMARK_ERROR");
		const lines = [
			`# 基准对比报告`,
			`- 基线: ${before.id} (${new Date(before.timestamp).toISOString()})`,
			`- 当前: ${after.id} (${new Date(after.timestamp).toISOString()})`,
			""
		];
		for (const afterScenario of after.scenarios) {
			const beforeScenario = before.scenarios.find((s) => s.name === afterScenario.name);
			if (!beforeScenario) {
				lines.push(`## ${afterScenario.name} — 新增场景（无基线）`);
				continue;
			}
			const b = beforeScenario.stats;
			const a = afterScenario.stats;
			const delta = (prev, curr) => {
				if (prev === 0) return curr === 0 ? "0%" : "+∞";
				const pct = (curr - prev) / prev * 100;
				return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
			};
			lines.push(`## ${afterScenario.name} [${afterScenario.target}]`, `- p95 延迟: ${b.p95Latency}ms → ${a.p95Latency}ms (${delta(b.p95Latency, a.p95Latency)})`, `- p99 延迟: ${b.p99Latency}ms → ${a.p99Latency}ms (${delta(b.p99Latency, a.p99Latency)})`, `- 吞吐率: ${b.throughput.toFixed(2)} → ${a.throughput.toFixed(2)} req/s (${delta(b.throughput, a.throughput)})`, `- 成功率: ${(b.successRate * 100).toFixed(2)}% → ${(a.successRate * 100).toFixed(2)}%`, `- 判定: ${beforeScenario.passed ? "PASS" : "FAIL"} → ${afterScenario.passed ? "PASS" : "FAIL"}`, "");
		}
		return lines.join("\n");
	}
	/**
	* 生成 Markdown 格式报告
	*/
	generateMarkdownReport(report) {
		const lines = [
			`# 基准测试报告 ${report.id}`,
			"",
			`> ${new Date(report.timestamp).toISOString()} | Node ${report.environment.nodeVersion} | ${report.environment.platform}/${report.environment.arch} | ${report.environment.cpuCount} CPU | ${report.environment.totalMemoryMB}MB RAM`,
			"",
			`**总体判定: ${report.overallPassed ? "✅ PASS" : "❌ FAIL"}** | 总耗时 ${(report.totalDuration / 1e3).toFixed(1)}s`,
			"",
			`| 场景 | target | 并发 | 请求数 | 成功率 | avg | p95 | p99 | 吞吐(req/s) | 判定 |`,
			`|------|--------|------|--------|--------|-----|-----|-----|-------------|------|`
		];
		for (const s of report.scenarios) lines.push(`| ${s.name} | ${s.target} | ${s.concurrency} | ${s.stats.totalRequests} | ${(s.stats.successRate * 100).toFixed(2)}% | ${s.stats.avgLatency.toFixed(1)}ms | ${s.stats.p95Latency.toFixed(1)}ms | ${s.stats.p99Latency.toFixed(1)}ms | ${s.stats.throughput.toFixed(2)} | ${s.passed ? "✅" : "❌"} |`);
		lines.push("");
		for (const s of report.scenarios) {
			if (s.thresholdViolations.length > 0) lines.push(`### ⚠️ ${s.name} 阈值违反`, ...s.thresholdViolations.map((v) => `- ${v}`), "");
			if (Object.keys(s.stats.errorDistribution).length > 0) {
				lines.push(`### ❌ ${s.name} 错误分布`);
				for (const [err, count] of Object.entries(s.stats.errorDistribution)) lines.push(`- ${err}: ${count} 次`);
				lines.push("");
			}
		}
		return lines.join("\n");
	}
	/** 计算聚合统计 */
	computeStats(latencies, successCount, failCount, errors, totalDuration, peakMemoryMB) {
		const total = successCount + failCount;
		const sorted = [...latencies].sort((a, b) => a - b);
		const percentile = (p) => {
			if (sorted.length === 0) return 0;
			const index = Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1);
			return sorted[Math.max(0, index)];
		};
		const avg = sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
		const variance = sorted.length > 0 ? sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / sorted.length : 0;
		return {
			totalRequests: total,
			successCount,
			failCount,
			successRate: total > 0 ? successCount / total : 0,
			minLatency: sorted[0] ?? 0,
			maxLatency: sorted[sorted.length - 1] ?? 0,
			avgLatency: avg,
			p50Latency: percentile(50),
			p90Latency: percentile(90),
			p95Latency: percentile(95),
			p99Latency: percentile(99),
			stdDev: Math.sqrt(variance),
			throughput: totalDuration > 0 ? total / totalDuration * 1e3 : 0,
			totalDuration,
			peakMemoryMB: Math.round(peakMemoryMB * 100) / 100,
			errorDistribution: errors
		};
	}
	/** 构建延迟分布直方图 */
	buildDistribution(latencies) {
		const distribution = LATENCY_BUCKETS.map((b) => ({
			bucket: b.bucket,
			count: 0
		}));
		for (const latency of latencies) {
			const bucketIndex = LATENCY_BUCKETS.findIndex((b) => latency < b.max);
			distribution[bucketIndex >= 0 ? bucketIndex : LATENCY_BUCKETS.length - 1].count += 1;
		}
		return distribution;
	}
	/** 阈值门禁检查 */
	checkThresholds(target, stats) {
		const threshold = this.thresholds[target] ?? DEFAULT_THRESHOLDS[target];
		const violations = [];
		if (stats.totalRequests === 0) return violations;
		if (stats.p95Latency > threshold.maxP95Latency) violations.push(`p95 延迟 ${stats.p95Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP95Latency}ms`);
		if (stats.p99Latency > threshold.maxP99Latency) violations.push(`p99 延迟 ${stats.p99Latency.toFixed(1)}ms 超过阈值 ${threshold.maxP99Latency}ms`);
		if (stats.throughput < threshold.minThroughput) violations.push(`吞吐率 ${stats.throughput.toFixed(2)} req/s 低于阈值 ${threshold.minThroughput} req/s`);
		if (stats.successRate < threshold.minSuccessRate) violations.push(`成功率 ${(stats.successRate * 100).toFixed(2)}% 低于阈值 ${(threshold.minSuccessRate * 100).toFixed(2)}%`);
		return violations;
	}
	/** 持久化报告 */
	saveReport(report) {
		fs.mkdirSync(this.reportDir, { recursive: true });
		const filePath = path.join(this.reportDir, `${report.id}.json`);
		const tmp = `${filePath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(report, null, 2), "utf-8");
		fs.renameSync(tmp, filePath);
	}
};
//#endregion
//#region src/hot-reload/hot-reload-engine.ts
/**
* hot-reload-engine.ts — 插件热更新引擎（协作层，独立模块）
*
* 职责：在不中断服务的前提下完成插件代码的版本迭代
* - 监听源码目录变更（防抖合并）
* - 触发构建命令并校验产物
* - 优雅停机（等待活跃任务完成）→ 版本切换 → 失败自动回滚
* - 版本历史管理（保留 N 个历史版本，支持手动部署与回滚）
*
* 升级点（相对基础实现的质的提升）：
* 1. 完整版本生命周期状态机：deploying → active → rolling-back → retired/failed，
*    每次部署生成内容哈希指纹，杜绝重复部署相同代码
* 2. 优雅停机双保险：先等待活跃任务自然结束（gracefulShutdownTimeout），
*    超时后强制切换，保证热更新不会无限阻塞
* 3. 构建产物校验：部署前检查 distDir/entryFile 存在性与代码哈希，
*    构建失败自动触发 rollback（autoRollback）
* 4. 事件流全量广播：12 种 HotReloadEvent 通过 EventEmitter 推送，
*    集成层可桥接到 ProgressBroadcaster 的 plugin-reloaded 事件
* 5. 版本历史磁盘持久化：versions.json 记录全部版本元数据，
*    重启后可回滚到任意历史版本
*/
/**
* 插件热更新引擎
*
* 被 index.ts 的 manage_hot_reload Tool 调用
* （status / rollback / deploy-version / stop-watching / start-watching）。
*/
var HotReloadEngine = class extends EventEmitter {
	config;
	watchers = [];
	debounceTimer = null;
	versions = [];
	activeTasks = /* @__PURE__ */ new Map();
	versionsIndexPath;
	deploying = false;
	watching = false;
	constructor(config) {
		super();
		this.config = config;
		this.versionsIndexPath = path.join(config.versionsDir, "versions.json");
		this.loadVersions();
	}
	/**
	* 启动文件监听（enabled=false 时为空操作）
	*/
	startWatching() {
		if (!this.config.enabled || this.watching) return;
		this.watching = true;
		for (const dir of this.config.watchDirs) {
			if (!fs.existsSync(dir)) continue;
			try {
				const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
					if (!filename) return;
					const ext = path.extname(filename);
					if (!this.config.watchExtensions.includes(ext)) return;
					this.emitEvent({
						type: "file-changed",
						filePath: filename,
						timestamp: Date.now()
					});
					this.scheduleReload(filename);
				});
				this.watchers.push(watcher);
			} catch {}
		}
	}
	/**
	* 停止文件监听
	*/
	stopWatching() {
		this.watching = false;
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
	/**
	* 注册活跃任务（执行层开始子任务时调用）
	*/
	registerTask(taskId, taskType) {
		this.activeTasks.set(taskId, {
			id: taskId,
			type: taskType,
			startedAt: Date.now(),
			version: this.getActiveVersion()?.version ?? "unknown"
		});
	}
	/**
	* 注销活跃任务（子任务完成/失败时调用）
	*/
	unregisterTask(taskId) {
		this.activeTasks.delete(taskId);
	}
	/** 当前活跃任务数 */
	getActiveTaskCount() {
		return this.activeTasks.size;
	}
	/**
	* 回滚到上一个 active 历史版本
	* @throws 无可回滚版本时 reject
	*/
	async rollback() {
		const current = this.getActiveVersion();
		const target = [...this.versions].sort((a, b) => b.deployedAt - a.deployedAt).find((v) => v.version !== current?.version && v.status !== "failed");
		if (!target) {
			const error = "没有可回滚的历史版本";
			this.emitEvent({
				type: "rollback-failed",
				error,
				timestamp: Date.now()
			});
			throw new Error(error);
		}
		this.emitEvent({
			type: "rollback-started",
			fromVersion: current?.version ?? "none",
			toVersion: target.version,
			timestamp: Date.now()
		});
		try {
			await this.gracefulShutdown(current?.version ?? "none");
			if (current) {
				current.active = false;
				current.status = "retired";
			}
			target.active = true;
			target.status = "active";
			this.persistVersions();
			this.emitEvent({
				type: "rollback-succeeded",
				version: target.version,
				timestamp: Date.now()
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.emitEvent({
				type: "rollback-failed",
				error: message,
				timestamp: Date.now()
			});
			throw err;
		}
	}
	/**
	* 手动部署指定版本（从版本历史中选择）
	* @param versionId 目标版本号
	*/
	async manualDeploy(versionId) {
		const target = this.versions.find((v) => v.version === versionId);
		if (!target) throw new Error(`版本不存在: ${versionId}`);
		const current = this.getActiveVersion();
		this.emitEvent({
			type: "deploy-started",
			version: versionId,
			timestamp: Date.now()
		});
		try {
			await this.gracefulShutdown(current?.version ?? "none");
			if (current) {
				current.active = false;
				current.status = "retired";
			}
			target.active = true;
			target.status = "active";
			this.persistVersions();
			this.emitEvent({
				type: "deploy-succeeded",
				version: versionId,
				previousVersion: current?.version ?? null,
				timestamp: Date.now()
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.emitEvent({
				type: "deploy-failed",
				version: versionId,
				error: message,
				timestamp: Date.now()
			});
			throw err;
		}
	}
	/**
	* 引擎状态摘要（供 manage_hot_reload status 使用）
	*/
	getStatus() {
		const active = this.getActiveVersion();
		return {
			enabled: this.config.enabled,
			watching: this.watching,
			deploying: this.deploying,
			activeVersion: active?.version ?? null,
			activeTaskCount: this.activeTasks.size,
			versionCount: this.versions.length,
			recentVersions: [...this.versions].sort((a, b) => b.deployedAt - a.deployedAt).slice(0, 5).map((v) => ({
				version: v.version,
				status: v.status,
				deployedAt: v.deployedAt,
				source: v.source
			}))
		};
	}
	/**
	* 停止引擎：停止监听并清理
	*/
	stop() {
		this.stopWatching();
		this.removeAllListeners();
	}
	/** 防抖调度重载流程 */
	scheduleReload(triggerFile) {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.reloadPipeline(triggerFile).catch(() => {});
		}, this.config.debounceMs);
		this.debounceTimer.unref?.();
	}
	/** 完整重载管道：构建 → 校验 → 优雅停机 → 切换 */
	async reloadPipeline(trigger) {
		if (this.deploying) return;
		this.deploying = true;
		const version = `v-${Date.now().toString(36)}`;
		try {
			this.emitEvent({
				type: "compilation-started",
				version,
				timestamp: Date.now()
			});
			const buildStartedAt = Date.now();
			const buildOk = await this.runBuild();
			if (!buildOk.ok) {
				this.emitEvent({
					type: "compilation-failed",
					version,
					error: buildOk.error ?? "构建失败",
					timestamp: Date.now()
				});
				if (this.config.autoRollback && this.getActiveVersion()) await this.rollback().catch(() => void 0);
				return;
			}
			this.emitEvent({
				type: "compilation-succeeded",
				version,
				duration: Date.now() - buildStartedAt,
				timestamp: Date.now()
			});
			const bundlePath = path.join(this.config.distDir, this.config.entryFile);
			if (!fs.existsSync(bundlePath)) throw new Error(`构建产物缺失: ${bundlePath}`);
			const codeHash = crypto.createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
			if (this.getActiveVersion()?.codeHash === codeHash) return;
			this.emitEvent({
				type: "deploy-started",
				version,
				timestamp: Date.now()
			});
			const previous = this.getActiveVersion();
			await this.gracefulShutdown(previous?.version ?? "none");
			const record = {
				version,
				codeHash,
				bundlePath,
				deployedAt: Date.now(),
				source: "file-watch",
				active: true,
				status: "active"
			};
			if (previous) {
				previous.active = false;
				previous.status = "retired";
			}
			this.versions.push(record);
			this.trimVersionHistory();
			this.persistVersions();
			this.emitEvent({
				type: "deploy-succeeded",
				version,
				previousVersion: previous?.version ?? null,
				timestamp: Date.now()
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.emitEvent({
				type: "deploy-failed",
				version,
				error: message,
				timestamp: Date.now()
			});
			if (this.config.autoRollback && this.getActiveVersion()) await this.rollback().catch(() => void 0);
		} finally {
			this.deploying = false;
		}
	}
	/** 执行构建命令 */
	runBuild() {
		return new Promise((resolve) => {
			const [cmd, ...args] = this.config.buildCommand.split(/\s+/);
			if (!cmd) {
				resolve({
					ok: false,
					error: "buildCommand 为空"
				});
				return;
			}
			execFile(cmd, args, {
				timeout: 12e4,
				cwd: process.cwd()
			}, (error, _stdout, stderr) => {
				if (error) resolve({
					ok: false,
					error: stderr.slice(0, 500) || error.message
				});
				else resolve({ ok: true });
			});
		});
	}
	/**
	* 优雅停机：等待活跃任务结束（超时强制继续）
	*/
	async gracefulShutdown(version) {
		const taskCount = this.activeTasks.size;
		if (taskCount === 0) return;
		this.emitEvent({
			type: "graceful-shutdown-started",
			version,
			activeTasks: taskCount,
			timestamp: Date.now()
		});
		const deadline = Date.now() + this.config.gracefulShutdownTimeout;
		while (this.activeTasks.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		this.emitEvent({
			type: "graceful-shutdown-completed",
			version,
			timestamp: Date.now()
		});
	}
	/** 获取当前激活版本 */
	getActiveVersion() {
		return this.versions.find((v) => v.active);
	}
	/** 版本历史上限裁剪（保留 active + 最近 N 个） */
	trimVersionHistory() {
		const sorted = [...this.versions].sort((a, b) => b.deployedAt - a.deployedAt);
		const keep = new Set([this.getActiveVersion()?.version].filter(Boolean));
		for (const v of sorted.slice(0, this.config.maxVersionHistory)) keep.add(v.version);
		this.versions = this.versions.filter((v) => keep.has(v.version));
	}
	/** 发射事件（类型安全封装） */
	emitEvent(event) {
		this.emit("event", event);
		this.emit(event.type, event);
	}
	/** 加载版本历史 */
	loadVersions() {
		if (!fs.existsSync(this.versionsIndexPath)) return;
		try {
			const raw = JSON.parse(fs.readFileSync(this.versionsIndexPath, "utf-8"));
			if (Array.isArray(raw)) this.versions = raw;
		} catch {
			this.versions = [];
		}
	}
	/** 持久化版本历史 */
	persistVersions() {
		try {
			fs.mkdirSync(this.config.versionsDir, { recursive: true });
			const tmp = `${this.versionsIndexPath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(this.versions, null, 2), "utf-8");
			fs.renameSync(tmp, this.versionsIndexPath);
		} catch {}
	}
};
//#endregion
//#region src/llm-client.ts
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
/** 模型调用错误（携带 HTTP 状态与可重试标记） */
var LLMError = class extends AppError {
	status;
	retryable;
	constructor(message, status, retryable = false, details) {
		super(message, "LLM_ERROR", details);
		this.status = status;
		this.retryable = retryable;
	}
};
/** 默认配置 */
const DEFAULT_LLM_CLIENT_CONFIG = {
	timeout: 6e4,
	maxRetries: 2,
	retryBaseDelay: 500,
	defaultMaxConcurrency: 3,
	maxQueueSize: 32
};
/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = /* @__PURE__ */ new Set([
	408,
	429,
	500,
	502,
	503,
	504
]);
/** 触发密钥轮换的状态码（认证失败 / 配额耗尽） */
const KEY_ROTATABLE_STATUS = /* @__PURE__ */ new Set([
	401,
	403,
	429
]);
/**
* OpenAI 兼容 LLM 客户端
*
* 被 index.ts 持有：strategist 决策与 executor 子任务执行均通过本客户端调用。
*/
var LLMClient = class {
	config;
	models = /* @__PURE__ */ new Map();
	fetchImpl;
	disposed = false;
	constructor(config) {
		this.config = {
			...DEFAULT_LLM_CLIENT_CONFIG,
			...config
		};
		this.fetchImpl = this.config.fetchImpl ?? fetch;
	}
	/**
	* 注册一个模型端点（重复注册同 id 时覆盖配置并保留统计）
	* @param model 模型配置
	*/
	registerModel(model) {
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
			totalCost: existing?.totalCost ?? 0
		});
	}
	/**
	* 获取已注册模型配置
	* @param modelId 模型 id
	*/
	getModel(modelId) {
		return this.models.get(modelId)?.config;
	}
	/** 所有已注册模型 id */
	getModelIds() {
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
	async chat(modelId, messages, options = {}) {
		const state = this.models.get(modelId);
		if (!state) throw new LLMError(`未注册的模型: ${modelId}`);
		if (this.disposed) throw new LLMError("LLM 客户端已关闭");
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
	async chatJSON(modelId, messages, options = {}) {
		const response = await this.chat(modelId, messages, options);
		const data = parseJSONLoose(response.content);
		if (data === void 0) throw new LLMError(`模型输出无法解析为 JSON: ${truncate(response.content, 200)}`, void 0, false, { modelId });
		return {
			data,
			response
		};
	}
	/**
	* 获取所有模型的运行时状态（model_dashboard Tool 数据源）
	*/
	getModelStatuses() {
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
			taskScores: s.config.initialCapabilities?.taskScores ?? {}
		}));
	}
	/**
	* 关闭客户端：拒绝所有排队中的请求
	*/
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const state of this.models.values()) for (const waiter of state.queue.splice(0)) waiter.reject(new LLMError("LLM 客户端已关闭，排队请求被取消"));
	}
	/** 获取并发槽位（必要时排队） */
	acquireSlot(state) {
		if (state.active < state.maxConcurrency) {
			state.active += 1;
			return Promise.resolve();
		}
		if (state.queue.length >= this.config.maxQueueSize) return Promise.reject(new LLMError(`模型 ${state.config.id} 并发过载，队列已满（${this.config.maxQueueSize}）`, 429, true));
		return new Promise((resolve, reject) => {
			state.queue.push({
				resolve,
				reject
			});
		});
	}
	/** 释放并发槽位并唤醒队首 */
	releaseSlot(state) {
		const next = state.queue.shift();
		if (next) {
			next.resolve();
			return;
		}
		state.active = Math.max(0, state.active - 1);
	}
	/** 带重试的调用主循环（含多密钥故障转移） */
	async chatWithRetry(state, messages, options) {
		const maxRetries = options.maxRetries ?? this.config.maxRetries;
		let lastError = null;
		let keyAttempt = 0;
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			if (attempt > 0) await sleep(this.config.retryBaseDelay * 2 ** (attempt - 1) * (.5 + Math.random() * .5));
			try {
				const response = this.config.externalChat ? await this.config.externalChat(state.config.id, messages, options) : await this.chatOnce(state, messages, options, keyAttempt);
				response.retries = attempt;
				state.totalTokensUsed += response.tokensUsed;
				state.totalCost += response.cost;
				this.config.onKeyOutcome?.(state.config.id, keyAttempt, true);
				return response;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				this.config.onKeyOutcome?.(state.config.id, keyAttempt, false, lastError instanceof LLMError ? lastError.status : void 0);
				if (err instanceof LLMError && err.status !== void 0 && KEY_ROTATABLE_STATUS.has(err.status)) keyAttempt += 1;
				if (!(err instanceof TimeoutError || err instanceof NetworkError || err instanceof LLMError && (err.retryable || err.status !== void 0 && KEY_ROTATABLE_STATUS.has(err.status))) || attempt >= maxRetries) break;
			}
		}
		throw lastError ?? new LLMError(`模型 ${state.config.id} 调用失败`);
	}
	/** 单次 HTTP 调用（含超时控制；keyAttempt 用于多密钥轮换） */
	async chatOnce(state, messages, options, keyAttempt = 0) {
		const { config } = state;
		const timeout = options.timeout ?? this.config.timeout;
		const url = buildCompletionsUrl(config.endpoint);
		const startedAt = Date.now();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const onExternalAbort = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", onExternalAbort, { once: true });
		}
		try {
			const headers = { "Content-Type": "application/json" };
			if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
			const hostHeaders = this.config.headerProvider?.(config.id, keyAttempt);
			if (hostHeaders) Object.assign(headers, hostHeaders);
			const res = await this.fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: config.id,
					messages,
					...options.temperature !== void 0 ? { temperature: options.temperature } : {},
					...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
					...options.extraBody ?? {}
				}),
				signal: controller.signal
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new LLMError(`模型 ${config.id} 返回 HTTP ${res.status}: ${truncate(body, 200)}`, res.status, RETRYABLE_STATUS.has(res.status));
			}
			const json = await res.json();
			const content = json?.choices?.[0]?.message?.content ?? "";
			const usage = json?.usage;
			const tokensUsed = typeof usage?.total_tokens === "number" ? usage.total_tokens : estimateTokens(messages, content);
			const costPerKToken = config.costPerKToken ?? 0;
			return {
				content,
				model: json?.model ?? config.id,
				latency: Date.now() - startedAt,
				tokensUsed,
				cost: tokensUsed / 1e3 * costPerKToken,
				retries: 0
			};
		} catch (err) {
			if (err instanceof LLMError) throw err;
			if (err?.name === "AbortError") throw new TimeoutError(`模型 ${config.id} 调用超时（${timeout}ms）`, {
				modelId: config.id,
				timeout
			});
			throw new NetworkError(`模型 ${config.id} 网络错误: ${err?.message ?? String(err)}`, { modelId: config.id });
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onExternalAbort);
		}
	}
};
/**
* 宽松 JSON 解析：剥离 Markdown 代码块包裹，截取首个完整 JSON 片段
* @param text 模型原始输出
* @returns 解析结果，失败返回 undefined
*/
function parseJSONLoose(text) {
	if (!text) return void 0;
	let candidate = text.trim();
	const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidate = fence[1].trim();
	try {
		return JSON.parse(candidate);
	} catch {}
	for (const [open, close] of [["{", "}"], ["[", "]"]]) {
		const start = candidate.indexOf(open);
		if (start < 0) continue;
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < candidate.length; i += 1) {
			const ch = candidate[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === "\"") inString = false;
				continue;
			}
			if (ch === "\"") inString = true;
			else if (ch === open) depth += 1;
			else if (ch === close) {
				depth -= 1;
				if (depth === 0) try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
}
/** 拼接 chat/completions 端点 URL */
function buildCompletionsUrl(endpoint) {
	const base = endpoint.replace(/\/+$/, "");
	if (/\/chat\/completions$/.test(base)) return base;
	if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
	return `${base}/v1/chat/completions`;
}
/** 粗略 token 估算（端点未返回 usage 时兜底：约 4 字符/token） */
function estimateTokens(messages, content) {
	const inputChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
	return Math.ceil((inputChars + content.length) / 4);
}
/** 截断字符串用于错误信息 */
function truncate(text, max) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** 可中止的 sleep */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/types.ts
/**
* types.ts — 共享类型层（新架构各组件的公共契约）
*
* 新架构单向数据流：
*   记忆库(Memory) → 优化器(Optimizer) → 模型调度(ModelScheduler)/任务执行(TaskExecutor) → 反思器(Reflector) → 记忆更新(Memory)
*
* 本文件承载数据流各组件共享的领域类型，避免组件间相互依赖：
* - 计划结构：PlanNode / ExecutionPlan（优化器产出、任务执行消费）
* - 执行结果：NodeResult / PlanExecutionResult（任务执行产出、反思器消费）
* - 注入点：NodeRunner / CascadeHandler（测试离线模拟 / 级联回注哨兵）
* - 错误：ExecutionError
*/
/** 计划执行失败 */
var ExecutionError = class extends AppError {
	constructor(message, details) {
		super(message, "EXECUTION_ERROR", details);
	}
};
//#endregion
//#region src/policy/policy-types.ts
/** 单策略最大规则数（防规则爆炸） */
const MAX_POLICY_RULES = 4;
/** 规则增量幅度边界 */
const POLICY_RULE_DELTA_BOUNDS = {
	min: -.3,
	max: .3
};
/** 基因取值边界（变异钳制 + 部署前校验共用） */
const POLICY_GENE_BOUNDS = {
	costWeight: {
		min: 0,
		max: .8
	},
	memoryWeightBase: {
		min: 0,
		max: .5
	},
	memoryWeightGrowth: {
		min: 0,
		max: .1
	},
	memoryWeightCap: {
		min: .3,
		max: .9
	},
	decomposeComplexityThreshold: {
		min: .3,
		max: .95
	},
	decomposeMaxSubtasks: {
		min: 2,
		max: 8,
		integer: true
	},
	ensembleScoreGap: {
		min: .01,
		max: .3
	},
	ensembleMaxModels: {
		min: 2,
		max: 4,
		integer: true
	},
	decomposeEnabled: {
		min: 0,
		max: 1
	},
	ensembleEnabled: {
		min: 0,
		max: 1
	}
};
/**
* 基准策略参数 — 严格复刻 ModelScheduler 第二阶段固定值：
* costWeight=0.2（index.ts 构造注入）、memoryWeight = min(0.6, 0.2 + n×0.02)、
* 分解与集成缺省关闭（第二阶段无此行为）。
*/
const BASELINE_POLICY_PARAMS = {
	costWeight: .2,
	memoryWeightBase: .2,
	memoryWeightGrowth: .02,
	memoryWeightCap: .6,
	decomposeEnabled: false,
	decomposeComplexityThreshold: .75,
	decomposeMaxSubtasks: 4,
	ensembleEnabled: false,
	ensembleScoreGap: .05,
	ensembleMaxModels: 2,
	rules: []
};
/** 钳制到边界 */
function clampGene(value, bounds) {
	const v = Math.max(bounds.min, Math.min(bounds.max, value));
	return bounds.integer ? Math.round(v) : Number(v.toFixed(4));
}
const clampDelta$1 = (v) => Number(Math.max(POLICY_RULE_DELTA_BOUNDS.min, Math.min(POLICY_RULE_DELTA_BOUNDS.max, v)).toFixed(4));
/** 单条规则是否匹配上下文（空条件字段 = 不限制） */
function policyRuleMatches(rule, ctx) {
	const { when } = rule;
	if (when.taskTypes && when.taskTypes.length > 0 && !when.taskTypes.includes(ctx.taskType)) return false;
	if (when.minComplexity !== void 0 && (ctx.complexity ?? .5) < when.minComplexity) return false;
	if (when.maxComplexity !== void 0 && (ctx.complexity ?? .5) > when.maxComplexity) return false;
	if (when.features && when.features.length > 0) {
		const feats = ctx.features ?? [];
		if (!when.features.some((f) => feats.includes(f))) return false;
	}
	return true;
}
/** 规则数组清洗：增量钳制 + 条件域修正 + 去重 + 截断到上限 */
function sanitizeRules(rules) {
	if (!Array.isArray(rules)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const rule of rules) {
		if (!rule || typeof rule.id !== "string" || seen.has(rule.id)) continue;
		seen.add(rule.id);
		out.push({
			id: rule.id,
			when: {
				taskTypes: Array.isArray(rule.when?.taskTypes) ? rule.when.taskTypes.filter(Boolean).slice(0, 8) : void 0,
				minComplexity: rule.when?.minComplexity !== void 0 ? clampGene(rule.when.minComplexity, {
					min: 0,
					max: 1
				}) : void 0,
				maxComplexity: rule.when?.maxComplexity !== void 0 ? clampGene(rule.when.maxComplexity, {
					min: 0,
					max: 1
				}) : void 0,
				features: Array.isArray(rule.when?.features) ? rule.when.features.filter(Boolean).slice(0, 8) : void 0
			},
			action: {
				costWeightDelta: rule.action?.costWeightDelta !== void 0 ? clampDelta$1(rule.action.costWeightDelta) : void 0,
				memoryWeightBaseDelta: rule.action?.memoryWeightBaseDelta !== void 0 ? clampDelta$1(rule.action.memoryWeightBaseDelta) : void 0,
				ensembleForce: rule.action?.ensembleForce,
				decomposeForce: rule.action?.decomposeForce
			},
			priority: Number.isFinite(rule.priority) ? Number(rule.priority) : 0
		});
		if (out.length >= 4) break;
	}
	return out.sort((a, b) => a.priority - b.priority);
}
/**
* 上下文有效参数解析（规则基因组核心）
*
* 以基础标量基因为底，按 priority 升序叠加所有匹配规则的增量与开关覆盖，
* 结果再经边界钳制 → 任意上下文下的有效参数恒在基因边界内（安全不变量）。
* rules 为空或无匹配时与基础参数完全一致（向后兼容）。
*/
function resolveEffectiveParams(params, ctx) {
	const rules = params.rules ?? [];
	if (rules.length === 0) return params;
	let costWeight = params.costWeight;
	let memoryWeightBase = params.memoryWeightBase;
	let ensembleEnabled = params.ensembleEnabled;
	let decomposeEnabled = params.decomposeEnabled;
	for (const rule of rules) {
		if (!policyRuleMatches(rule, ctx)) continue;
		if (rule.action.costWeightDelta !== void 0) costWeight += rule.action.costWeightDelta;
		if (rule.action.memoryWeightBaseDelta !== void 0) memoryWeightBase += rule.action.memoryWeightBaseDelta;
		if (rule.action.ensembleForce !== void 0) ensembleEnabled = rule.action.ensembleForce;
		if (rule.action.decomposeForce !== void 0) decomposeEnabled = rule.action.decomposeForce;
	}
	return {
		...params,
		costWeight: clampGene(costWeight, POLICY_GENE_BOUNDS.costWeight),
		memoryWeightBase: clampGene(memoryWeightBase, POLICY_GENE_BOUNDS.memoryWeightBase),
		ensembleEnabled,
		decomposeEnabled,
		rules
	};
}
/**
* 参数规范化：越界值钳制到边界 + 缺失字段补基准值 + 规则清洗
* （沙盒风险检查与部署热切换前的防御性归一，共用一份逻辑）
*/
function normalizePolicyParams(params) {
	const merged = {
		...BASELINE_POLICY_PARAMS,
		...params
	};
	return {
		costWeight: clampGene(merged.costWeight, POLICY_GENE_BOUNDS.costWeight),
		memoryWeightBase: clampGene(merged.memoryWeightBase, POLICY_GENE_BOUNDS.memoryWeightBase),
		memoryWeightGrowth: clampGene(merged.memoryWeightGrowth, POLICY_GENE_BOUNDS.memoryWeightGrowth),
		memoryWeightCap: clampGene(merged.memoryWeightCap, POLICY_GENE_BOUNDS.memoryWeightCap),
		decomposeEnabled: Boolean(merged.decomposeEnabled),
		decomposeComplexityThreshold: clampGene(merged.decomposeComplexityThreshold, POLICY_GENE_BOUNDS.decomposeComplexityThreshold),
		decomposeMaxSubtasks: clampGene(merged.decomposeMaxSubtasks, POLICY_GENE_BOUNDS.decomposeMaxSubtasks),
		ensembleEnabled: Boolean(merged.ensembleEnabled),
		ensembleScoreGap: clampGene(merged.ensembleScoreGap, POLICY_GENE_BOUNDS.ensembleScoreGap),
		ensembleMaxModels: clampGene(merged.ensembleMaxModels, POLICY_GENE_BOUNDS.ensembleMaxModels),
		rules: sanitizeRules(merged.rules)
	};
}
/** 参数是否全部在边界内（不修改原值的风险检查；含规则数量与增量幅度） */
function policyParamsWithinBounds(params) {
	const keys = Object.keys(POLICY_GENE_BOUNDS);
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "boolean") continue;
		const bounds = POLICY_GENE_BOUNDS[key];
		if (typeof value !== "number" || Number.isNaN(value) || value < bounds.min || value > bounds.max) return false;
	}
	const rules = params.rules ?? [];
	if (rules.length > 4) return false;
	for (const rule of rules) {
		const deltas = [rule.action?.costWeightDelta, rule.action?.memoryWeightBaseDelta];
		for (const d of deltas) if (d !== void 0 && (d < POLICY_RULE_DELTA_BOUNDS.min || d > POLICY_RULE_DELTA_BOUNDS.max)) return false;
	}
	return true;
}
/**
* 策略化模型评分（操作环与沙盒共用）
*
* 公式（与 ModelScheduler 第二阶段实现同构，参数从策略注入）：
*   memoryWeight = calls > 0 ? min(cap, base + calls × growth) : 0
*   qualityScore = taskScore × (1-memoryWeight) + memoryScore × memoryWeight
*   costEfficiency = clamp(avgQuality × (1 - min(1, avgTokens/10000)))
*   score = qualityScore × (1-costWeight) + costEfficiency × costWeight
*
* 当 params = BASELINE_POLICY_PARAMS 时与原固定实现逐位一致。
*/
function scoreModelWithPolicy(params, input) {
	const costWeight = Math.max(0, Math.min(1, params.costWeight));
	const memoryWeight = input.memoryCalls > 0 ? Math.min(params.memoryWeightCap, params.memoryWeightBase + input.memoryCalls * params.memoryWeightGrowth) : 0;
	const qualityScore = input.taskScore * (1 - memoryWeight) + input.memoryScore * memoryWeight;
	let costEfficiency = .5;
	if (input.memoryCalls > 0 && input.avgTokens > 0) costEfficiency = Math.max(0, Math.min(1, input.avgQuality * (1 - Math.min(1, input.avgTokens / 1e4))));
	return qualityScore * (1 - costWeight) + costEfficiency * costWeight;
}
/** 构造基准策略对象（缺省当前策略） */
function createBaselinePolicy(id = "policy-baseline", version = 1) {
	return {
		id,
		version,
		type: "scheduler",
		params: { ...BASELINE_POLICY_PARAMS },
		origin: "baseline",
		generation: 0,
		createdAt: Date.now()
	};
}
//#endregion
//#region src/model-scheduler.ts
/**
* 模型调度器
*
* 被任务执行器（task-executor.ts）持有：节点执行前调用 assignModel 分配模型，
* 重试切换时调用 pickFallbackModel 选择次优模型。
*/
var ModelScheduler = class {
	llm;
	memory;
	config;
	/** 当前生效调度策略（第三阶段：评分函数参数来源；基准 = 原固定行为） */
	currentPolicy;
	/** B 路线：共生经济乘数（modelId → 乘数；缺省空 = 全中性） */
	economicMultipliers = /* @__PURE__ */ new Map();
	/** 6.0：自由能引擎（EFE 调度模式；未挂载/未启用零漂移） */
	freeEnergy;
	constructor(params) {
		this.llm = params.llm;
		this.memory = params.memory;
		this.config = params.config ?? {};
		this.currentPolicy = {
			id: "policy-baseline",
			version: 1,
			type: "scheduler",
			params: {
				...BASELINE_POLICY_PARAMS,
				costWeight: this.config.costWeight ?? BASELINE_POLICY_PARAMS.costWeight
			},
			origin: "baseline",
			generation: 0,
			createdAt: Date.now()
		};
	}
	/** 运行时配置热更新（元认知自调优落地入口） */
	updateConfig(patch) {
		this.config = {
			...this.config,
			...patch
		};
		if (patch.costWeight !== void 0) this.currentPolicy = {
			...this.currentPolicy,
			params: {
				...this.currentPolicy.params,
				costWeight: patch.costWeight
			}
		};
	}
	/**
	* B 路线：注入共生经济乘数（能量反哺调度；宿主心跳桥接调用）。
	*
	* 乘数来自 SymbiosisBridge.economicSignals()（余额 × Wilson 信誉的
	* 复合健康度），仅作用于利用端评分——赚钱的模型升权、持续亏损的
	* 模型降权。注入即生效（对后续 assignModel/pickEnsemble/pickFallback
	* 全路径一致）；信号中缺失的模型回退中性乘数 1。
	* @param signals modelId → 调度乘数（典型范围 0.5~1.5）
	*/
	updateEconomicSignals(signals) {
		const next = /* @__PURE__ */ new Map();
		const entries = signals instanceof Map ? signals : Object.entries(signals);
		for (const [modelId, m] of entries) if (Number.isFinite(m) && m > 0) next.set(modelId, m);
		this.economicMultipliers = next;
	}
	/**
	* 6.0：挂载自由能引擎（幂等；需同时 freeEnergyEnabled=true 才生效）。
	*
	* @param engine 主动推断内核实例（宿主单一实例共享）
	* @param outcomeNode 因果图结果节点（缺省 'task.outcome'；模型选择即
	*   do(use:model) 干预，证据由共生结算侧登记）
	*/
	attachFreeEnergy(engine, outcomeNode = "task.outcome") {
		this.freeEnergy = engine;
		this.efeOutcomeNode = outcomeNode;
	}
	efeOutcomeNode = "task.outcome";
	/** 模型的当前经济乘数（无信号 = 中性 1；economicFeedbackEnabled 关闭时恒为 1） */
	economicMultiplierOf(modelId) {
		if (this.config.economicFeedbackEnabled !== true) return 1;
		return this.economicMultipliers.get(modelId) ?? 1;
	}
	/**
	* 策略热切换（第三阶段：策略进化器部署入口）
	*
	* 由 PolicyEvolver.deployPolicy → onDeploy 回调调用；
	* 替换评分函数参数集，立即对后续 assignModel 生效，无需重启。
	*/
	updatePolicy(policy) {
		this.currentPolicy = {
			...policy,
			params: { ...policy.params }
		};
	}
	/** 当前生效策略（供优化器标注策略版本） */
	getPolicy() {
		return {
			...this.currentPolicy,
			params: { ...this.currentPolicy.params }
		};
	}
	/** 解析上下文有效参数（规则基因组匹配；无规则时即基础参数） */
	effectiveParams(taskType, context) {
		return resolveEffectiveParams(this.currentPolicy.params, {
			taskType,
			complexity: context?.complexity,
			features: context?.features
		});
	}
	/** 单模型评分（2.0：贝叶斯证据装配——Wilson 下界 + 有效样本量 + 质量 EMA） */
	scoreModel(taskType, status, params) {
		const estimate = this.memory.getBayesianEstimate(status.id, taskType);
		return scoreModelWithPolicy(params, {
			taskScore: status.taskScores[taskType] ?? status.taskScores["general"] ?? .5,
			memoryScore: estimate ? estimate.wilsonLower : .5,
			memoryCalls: estimate ? Math.round(estimate.effectiveSamples) : 0,
			avgQuality: estimate?.emaQuality || .5,
			avgTokens: status.totalCalls > 0 ? status.totalTokensUsed / status.totalCalls : 0
		}) * this.economicMultiplierOf(status.id);
	}
	/**
	* 全候选评分（2.0：利用端策略评分 + UCB 探索加成）
	*
	* 探索/利用权衡（解决裸计数调度的两个死局）：
	* - 冷启动死局：新模型 0 样本得中性分 0.5，永远竞争不过平庸但样本多的模型
	* - 埋没死局：模型早期失败后，即使能力已修复也永无翻身机会
	*
	* UCB 加成 = exploreBonus × sqrt(log(1+ΣN) / (1+n_i))：
	* 样本越少加成越大（信息价值高）；仅冷启动期（ΣN < exploreBudget）
	* 生效，且有效样本 ≥ exploreSampleFloor 的模型不加成（纯利用）。
	*/
	scoreCandidates(taskType, context, statuses) {
		const params = this.effectiveParams(taskType, context);
		const scored = statuses.map((status) => {
			const estimate = this.memory.getBayesianEstimate(status.id, taskType);
			const base = this.scoreModel(taskType, status, params);
			return {
				id: status.id,
				base,
				bonus: 0,
				total: base,
				estimate
			};
		});
		if (this.config.freeEnergyEnabled === true && this.freeEnergy) {
			const preference = this.config.freeEnergyPreference ?? .9;
			const actions = scored.map((s) => {
				const est = s.estimate;
				const mean = est ? est.posteriorMean : .5;
				const lower = est ? est.wilsonLower : 0;
				return {
					id: s.id,
					pSuccess: mean,
					lower,
					upper: Math.min(1, mean + Math.max(0, mean - lower)),
					interventionalSamples: est ? est.effectiveSamples : 0,
					observationalSamples: 0
				};
			});
			const evals = this.freeEnergy.evaluateActions(actions, preference);
			const byId = new Map(evals.map((e) => [e.actionId, e]));
			for (const s of scored) {
				const e = byId.get(s.id);
				if (!e) continue;
				s.efe = e;
				s.total = -e.efe;
				s.bonus = e.epistemic;
			}
			return scored;
		}
		const explorationOn = this.config.explorationEnabled !== false;
		const bonusWeight = this.config.exploreBonus ?? .08;
		const sampleFloor = this.config.exploreSampleFloor ?? 5;
		const exploreBudget = this.config.exploreBudget ?? 30;
		if (explorationOn && bonusWeight > 0) {
			const totalN = scored.reduce((sum, s) => sum + (s.estimate?.effectiveSamples ?? 0), 0);
			if (totalN < exploreBudget) for (const s of scored) {
				const n = s.estimate?.effectiveSamples ?? 0;
				if (n >= sampleFloor) continue;
				s.bonus = bonusWeight * Math.sqrt(Math.log(1 + totalN + scored.length) / (1 + n));
				s.total = s.base + s.bonus;
			}
		}
		return scored;
	}
	/** 所选模型的决策洞察（预测置信度 + 探索标记 + 依据说明） */
	insightOf(taskType, chosen, preferredUsed, scored) {
		const estimate = chosen?.estimate;
		if (chosen?.efe && this.config.freeEnergyEnabled === true && this.freeEnergy) {
			const e = chosen.efe;
			const pragmaticRival = (scored ?? []).find((s) => s.efe && s.id !== chosen.id && s.efe.pragmatic <= e.pragmatic + 1e-9);
			const exploration = e.epistemic > .03 && pragmaticRival !== void 0;
			return {
				taskType,
				modelId: chosen.id,
				confidence: estimate ? estimate.posteriorMean : .5,
				exploration,
				effectiveSamples: estimate?.effectiveSamples ?? 0,
				rationale: `主动推断选择 ${chosen.id}（EFE ${e.efe.toFixed(3)} = 务实 ${e.pragmatic.toFixed(3)} − 认知 ${e.epistemic.toFixed(3)} nat；好奇占比 ${Math.round(e.curiosityShare * 100)}%，Boltzmann ${(e.boltzmannProb * 100).toFixed(1)}%）`,
				economicMultiplier: this.economicMultiplierOf(chosen.id)
			};
		}
		const bestBaseId = scored && scored.length > 0 ? scored.reduce((a, b) => b.base > a.base ? b : a).id : void 0;
		const exploration = Boolean(!preferredUsed && chosen && chosen.bonus > 0 && bestBaseId !== void 0 && chosen.id !== bestBaseId);
		return {
			taskType,
			modelId: chosen?.id ?? "",
			confidence: estimate ? estimate.posteriorMean : .5,
			exploration,
			effectiveSamples: estimate?.effectiveSamples ?? 0,
			rationale: preferredUsed ? `优先采用推荐模型 ${chosen?.id}（优化器经验推荐，贝叶斯置信度 ${estimate ? estimate.posteriorMean.toFixed(2) : "0.50"}）` : exploration ? `探索性选择 ${chosen?.id}（利用分 ${chosen.base.toFixed(3)} + UCB 加成 ${chosen.bonus.toFixed(3)}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? "0"} < ${this.config.exploreSampleFloor ?? 5}，收集证据中）` : `利用端最优 ${chosen?.id}（策略评分 ${chosen?.base.toFixed(3)}，贝叶斯下界 ${estimate ? estimate.wilsonLower.toFixed(2) : "-"}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? "0"}）`,
			economicMultiplier: this.economicMultiplierOf(chosen?.id ?? "")
		};
	}
	/** 所选模型的贝叶斯置信度（重试切换后由执行器刷新洞察用） */
	modelInsight(taskType, modelId) {
		const estimate = this.memory.getBayesianEstimate(modelId, taskType);
		return {
			taskType,
			modelId,
			confidence: estimate ? estimate.posteriorMean : .5,
			exploration: false,
			effectiveSamples: estimate?.effectiveSamples ?? 0,
			rationale: `切换至 ${modelId}（贝叶斯后验 ${estimate ? estimate.posteriorMean.toFixed(2) : "0.50"}，下界 ${estimate ? estimate.wilsonLower.toFixed(2) : "-"}）`
		};
	}
	/**
	* 为任务类型分配最优模型（能力画像 × 贝叶斯记忆画像 × 成本感知 × 探索/利用权衡）
	*
	* 第三阶段：评分核心改用策略参数化的 scoreModelWithPolicy
	* （与安全沙盒共享同一实现，参数 = 基准策略时与原固定公式一致）。
	* 质级升级：传入 context 时按规则基因组解析上下文有效参数。
	* 2.0：记忆证据从裸成功率升级为 Wilson 下界 + 有效样本量 + UCB 探索。
	*
	* @param taskType 任务类型
	* @param preferred 优化器推荐的模型（优先）
	* @param context 任务上下文（复杂度/特征；供规则基因匹配）
	*/
	assignModel(taskType, preferred, context, options) {
		return this.assignModelWithInsight(taskType, preferred, context, options).modelId;
	}
	/**
	* 带洞察的模型分配（2.0：返回预测置信度与探索标记，供反思器校准闭环）
	*
	* 与 assignModel 共享同一评分与选择逻辑；编排层用本方法收集决策洞察，
	* 在复盘时回注反思器计算 Brier 校准误差与反事实遗憾。
	* 4.0：avoidModels 负向约束——经验规避模型（历史超时/能力不足）从候选剔除，
	* 推荐模型被规避时同样降级为动态评分选型（勘察修复：升级前 avoidModels
	* 产出后无人消费，负向经验在调度端断链）。
	*/
	assignModelWithInsight(taskType, preferred, context, options) {
		const avoid = new Set(options?.avoidModels ?? []);
		if (preferred && !avoid.has(preferred) && this.llm.getModel(preferred)) return this.insightOf(taskType, {
			id: preferred,
			base: 0,
			bonus: 0,
			total: 0,
			estimate: this.memory.getBayesianEstimate(preferred, taskType)
		}, true);
		const statuses = this.llm.getModelStatuses().filter((s) => !avoid.has(s.id));
		if (statuses.length === 0) throw new ExecutionError("没有已注册的可用模型");
		const scored = this.scoreCandidates(taskType, context, statuses);
		let best = scored[0];
		for (const s of scored) if (s.total > best.total) best = s;
		return this.insightOf(taskType, best, false, scored);
	}
	/**
	* 多模型集成候选（第三阶段：模型组合逻辑的策略落地）
	*
	* 按当前策略评分降序返回前 N 个模型（供执行侧并行执行 + 融合决策）。
	* 质级升级：传入 context 时按规则基因组解析上下文有效参数
	* （如规则强制 ensembleForce=true 的任务类型稳定给出组合候选）。
	* @param taskType 任务类型
	* @param count 集成模型数（缺省取策略 ensembleMaxModels）
	* @param exclude 排除的模型 id（如重试时排除当前模型）
	* @param context 任务上下文（复杂度/特征；供规则基因匹配）
	*/
	pickEnsemble(taskType, count, exclude = [], context) {
		const statuses = this.llm.getModelStatuses().filter((s) => !exclude.includes(s.id));
		if (statuses.length === 0) return [];
		const params = this.effectiveParams(taskType, context);
		const ranked = statuses.map((status) => ({
			id: status.id,
			score: this.scoreModel(taskType, status, params)
		})).sort((a, b) => b.score - a.score);
		const n = Math.max(1, count ?? params.ensembleMaxModels);
		return ranked.slice(0, n).map((r) => r.id);
	}
	/**
	* 选择次优模型（排除当前模型，按策略评分；context 供规则基因匹配）
	* 4.0：excludeModels 额外排除清单（经验规避模型 / 熔断中模型），向后兼容
	*/
	pickFallbackModel(taskType, excludeModelId, context, excludeModels) {
		const exclude = /* @__PURE__ */ new Set([excludeModelId, ...excludeModels ?? []]);
		const statuses = this.llm.getModelStatuses().filter((s) => !exclude.has(s.id));
		if (statuses.length === 0) return void 0;
		const params = this.effectiveParams(taskType, context);
		let bestId;
		let bestScore = -1;
		for (const status of statuses) {
			const score = this.scoreModel(taskType, status, params);
			if (score > bestScore) {
				bestScore = score;
				bestId = status.id;
			}
		}
		return bestId;
	}
	/**
	* 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
	* （避免同层节点数超过模型并发容量导致全部排队）
	*/
	computeParallelism() {
		const totalConcurrency = this.llm.getModelStatuses().reduce((sum, s) => sum + s.maxConcurrency, 0);
		return Math.max(1, Math.min(16, totalConcurrency || 4));
	}
};
//#endregion
//#region src/task-executor.ts
/**
* task-executor.ts — 任务执行组件（新架构「模型调度 → 任务执行」）
*
* 职责（对应架构图「任务执行（原有）」框）：
* - 计划生成：strategist 输出 DAG 解析 + 离线兜底计划
* - 并行执行：拓扑分层并行执行子任务，全局超时中止，动态并行度分批
* - 质量反思：quality < threshold 自动重试或经模型调度切换模型（最多 maxRetries 次）
* - 级联触发：节点完成且质量达标时触发下游信号
*
* 闭环边界（新架构单向数据流）：
* - 模型分配委托模型调度器（model-scheduler.ts），优化器推荐模型经 recommendedModels 喂入
* - 经验检索 / 快路径召回由优化器（optimizer.ts）负责
* - 执行后反思 / 记忆更新由反思器（reflector.ts）负责，本组件不写记忆
*
* 升级点（相对串行执行的质的提升）：
* 1. 拓扑分层并行：同层节点并发执行，依赖未就绪的节点自动顺延
* 2. 质量反思闭环：重试优先原模型，重试耗尽前尝试切换到次优模型
* 3. nodeRunner 可注入：默认走 LLMClient，冒烟测试可完全离线模拟
* 4. 全链路进度事件广播（plan-start / node-start / node-complete /
*    node-error / node-reflect / cascade-trigger / plan-complete）
*/
/**
* 任务执行器
*
* 被 index.ts 持有：编排层完成战略决策与计划生成后，将计划交给本执行器执行。
*/
var TaskExecutor = class {
	config;
	llm;
	modelScheduler;
	broadcaster;
	nodeRunner;
	cascadeHandler;
	/** 反思引擎（可选，节点级质量反思） */
	reflection;
	/** 4.0：模型级熔断器注册表（circuitFailureThreshold=0 时不启用） */
	breakers;
	/** 2.0：最近一次计划执行的调度决策洞察（校准闭环素材，getAndClearDecisionInsights 取走） */
	decisionInsights = [];
	constructor(params) {
		this.config = params.config;
		this.llm = params.llm;
		this.modelScheduler = params.modelScheduler;
		this.broadcaster = params.broadcaster;
		this.nodeRunner = params.nodeRunner ?? this.defaultNodeRunner.bind(this);
		this.cascadeHandler = params.cascadeHandler;
		this.reflection = params.reflection;
		const threshold = this.config.circuitFailureThreshold ?? 5;
		if (threshold > 0) this.breakers = new CircuitBreakerRegistry({
			failureThreshold: threshold,
			cooldownMs: this.config.circuitCooldownMs ?? 6e4
		});
	}
	/**
	* 运行时配置热更新（元认知自调优落地入口）
	* @param patch 配置补丁（仅覆盖提供的字段）
	*/
	updateConfig(patch) {
		this.config = {
			...this.config,
			...patch
		};
	}
	/**
	* 取走最近一次计划执行的调度决策洞察（2.0：校准闭环桥接）
	*
	* 编排层在 executePlan 返回后调用本方法，将洞察作为
	* reflectOnOutcome({ decisionInsights }) 回注反思器，
	* 完成「调度预测 → 实际结果 → Brier 校准」闭环。
	* 取走即清空（每份洞察只消费一次）。
	*/
	getAndClearDecisionInsights() {
		const insights = this.decisionInsights;
		this.decisionInsights = [];
		return insights;
	}
	/**
	* 计划生成 — 解析 strategist 输出，非法时回退离线计划
	* @param objective 任务目标
	* @param strategistOutput strategist 模型原始输出（可为空）
	* @param taskType 任务类型
	*/
	buildPlan(objective, strategistOutput, taskType) {
		if (strategistOutput) {
			const parsed = parseJSONLoose(strategistOutput);
			const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : null;
			if (nodes && nodes.length > 0 && this.validateDag(nodes)) return {
				objective,
				nodes: nodes.map((n) => this.normalizeNode(n)),
				parallelismStrategy: typeof parsed.parallelismStrategy === "string" ? parsed.parallelismStrategy : "layered",
				source: "strategist"
			};
		}
		return {
			objective,
			nodes: [{
				id: "node-1",
				description: objective,
				type: taskType,
				dependsOn: []
			}],
			parallelismStrategy: "sequential",
			source: "fallback"
		};
	}
	/**
	* 执行完整计划
	*
	* 深度优化：
	* - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
	* - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
	* - 4.0：avoidModels 负向约束贯通——优化器产出的规避模型在调度与重试切换中全局排除
	*
	* @param signal 触发信号
	* @param plan 执行计划
	* @param recommendedModels 优化器产出的按节点类型推荐模型（模型调度优先采纳）
	* @param options 4.0 扩展选项（avoidModels：经验规避模型，调度与重试全程排除）
	* @returns 计划执行结果
	*/
	async executePlan(signal, plan, recommendedModels, options) {
		const planId = `plan-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
		const startedAt = Date.now();
		const nodeResults = [];
		const outputs = /* @__PURE__ */ new Map();
		let effectiveTimeout = this.config.globalTimeout;
		if (signal.deadlineMs && signal.deadlineMs > Date.now()) effectiveTimeout = Math.min(effectiveTimeout, signal.deadlineMs - Date.now());
		this.broadcast({
			type: "plan-start",
			plan: {
				objective: plan.objective,
				nodeCount: plan.nodes.length,
				source: plan.source
			},
			signal: {
				id: signal.id,
				type: signal.type
			},
			effectiveTimeout
		});
		const controller = new AbortController();
		const globalTimer = setTimeout(() => controller.abort(), effectiveTimeout);
		globalTimer.unref?.();
		try {
			const layers = this.topologicalLayers(plan.nodes);
			const parallelism = this.modelScheduler.computeParallelism();
			for (const layer of layers) {
				if (controller.signal.aborted) break;
				for (let i = 0; i < layer.length; i += parallelism) {
					if (controller.signal.aborted) break;
					const chunk = layer.slice(i, i + parallelism);
					const layerResults = await Promise.all(chunk.map((node) => this.executeNode(planId, node, signal, outputs, controller.signal, recommendedModels, options?.avoidModels ?? [])));
					for (const result of layerResults) {
						nodeResults.push(result);
						if (result.success && result.output) outputs.set(result.nodeId, result.output);
					}
				}
			}
		} catch (err) {
			if (controller.signal.aborted) throw new TimeoutError(`计划执行超过全局超时（${effectiveTimeout}ms）`, { planId });
			throw err;
		} finally {
			clearTimeout(globalTimer);
		}
		const successCount = nodeResults.filter((r) => r.success).length;
		const success = successCount === plan.nodes.length && plan.nodes.length > 0;
		const totalTime = Date.now() - startedAt;
		const totalTokens = nodeResults.reduce((sum, r) => sum + r.tokensUsed, 0);
		const successResults = nodeResults.filter((r) => r.success);
		const avgQuality = successResults.length > 0 ? successResults.reduce((s, r) => s + r.quality, 0) / successResults.length : 0;
		this.broadcast({
			type: "plan-complete",
			planId,
			totalTime,
			successCount,
			totalNodes: plan.nodes.length,
			success,
			avgQuality
		});
		return {
			planId,
			success,
			nodeResults,
			totalTime,
			successCount,
			totalTokens,
			avgQuality,
			error: success ? void 0 : nodeResults.find((r) => !r.success)?.error
		};
	}
	/** 模型级熔断快照（运维可观测：哪些模型被熔断、连续失败数） */
	getBreakerSnapshot() {
		return this.breakers?.snapshot() ?? {};
	}
	/** 模型当前是否可执行（无熔断器或熔断器放行；peek 纯读取不占探测名额） */
	modelExecutable(modelId) {
		if (!this.breakers) return true;
		return this.breakers.peek(modelId).allowed;
	}
	/** 选择健康的次优模型：排除当前模型、规避模型与熔断中的模型 */
	pickHealthyFallback(taskType, currentModelId, avoidModels) {
		const excluded = /* @__PURE__ */ new Set([currentModelId, ...avoidModels]);
		const fallback = this.modelScheduler.pickFallbackModel(taskType, currentModelId, void 0, [...excluded]);
		if (fallback && this.modelExecutable(fallback)) return fallback;
		if (fallback && !this.modelExecutable(fallback)) return this.modelScheduler.pickEnsemble(taskType, 8, [...excluded]).find((id) => this.modelExecutable(id));
		return fallback;
	}
	/** 单节点执行（4.0：熔断感知调度 + 错误分型退避重试 + 质量反思切换、级联触发） */
	async executeNode(planId, node, signal, outputs, abortSignal, recommendedModels, avoidModels = []) {
		const context = {};
		for (const dep of node.dependsOn) {
			const depOutput = outputs.get(dep);
			if (depOutput) context[dep] = depOutput;
		}
		const avoidSet = new Set(avoidModels);
		let preferred = recommendedModels?.[node.type];
		if (preferred && (avoidSet.has(preferred) || !this.modelExecutable(preferred))) preferred = void 0;
		let plannedModel = node.modelId;
		if (plannedModel && (avoidSet.has(plannedModel) || !this.modelExecutable(plannedModel))) plannedModel = void 0;
		const assignment = plannedModel ? this.modelScheduler.modelInsight(node.type, plannedModel) : this.modelScheduler.assignModelWithInsight(node.type, preferred, void 0, { avoidModels });
		let modelId = assignment.modelId;
		this.decisionInsights.push({
			nodeId: node.id,
			taskType: node.type,
			modelId,
			predictedConfidence: assignment.confidence,
			exploration: assignment.exploration,
			success: false
		});
		const insightIndex = this.decisionInsights.length - 1;
		const maxAttempts = this.config.maxRetries + 1;
		let lastError;
		const nodeStartedAt = Date.now();
		this.broadcast({
			type: "node-start",
			planId,
			nodeId: node.id,
			modelId,
			taskType: node.type
		});
		for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
			if (abortSignal.aborted) {
				lastError = "全局超时，节点中止";
				break;
			}
			if (!this.modelExecutable(modelId)) {
				const healthy = this.pickHealthyFallback(node.type, modelId, avoidModels);
				if (!healthy) {
					lastError = `模型 ${modelId} 熔断中且无可用替代`;
					this.broadcast({
						type: "node-error",
						planId,
						nodeId: node.id,
						error: lastError,
						attempt
					});
					break;
				}
				this.broadcast({
					type: "node-reflect",
					planId,
					nodeId: node.id,
					verdict: "switch-model",
					reason: `${modelId} 熔断 → ${healthy}`
				});
				modelId = healthy;
				const refreshed = this.modelScheduler.modelInsight(node.type, healthy);
				this.decisionInsights[insightIndex] = {
					nodeId: node.id,
					taskType: node.type,
					modelId: healthy,
					predictedConfidence: refreshed.confidence,
					exploration: false,
					success: false
				};
			}
			if (this.breakers) {
				if (!this.breakers.canExecute(modelId).allowed) continue;
			}
			try {
				const { output, quality, tokensUsed } = await this.runWithTimeout(node, modelId, context, signal, attempt);
				const threshold = this.reflection?.getCurrentThreshold() ?? this.config.qualityThreshold;
				let verdict = {
					quality,
					passed: quality >= threshold,
					retryAdvice: "retry-same",
					reason: ""
				};
				if (this.reflection) {
					const reflected = await this.reflection.reflect({
						node,
						output,
						baseQuality: quality,
						signal
					});
					verdict = {
						quality: reflected.quality,
						passed: reflected.passed,
						retryAdvice: reflected.retryAdvice,
						reason: reflected.reason
					};
				}
				if (verdict.passed) {
					this.breakers?.recordSuccess(modelId);
					this.broadcast({
						type: "node-complete",
						planId,
						nodeId: node.id,
						latency: Date.now() - nodeStartedAt,
						quality: verdict.quality,
						attempt
					});
					this.broadcast({
						type: "node-reflect",
						planId,
						nodeId: node.id,
						verdict: "pass",
						reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} ≥ 阈值 ${threshold.toFixed(2)}`
					});
					this.decisionInsights[insightIndex].success = true;
					this.triggerCascade(node, signal, output);
					return {
						nodeId: node.id,
						modelId,
						success: true,
						output,
						quality: verdict.quality,
						latency: Date.now() - nodeStartedAt,
						attempts: attempt,
						tokensUsed: tokensUsed ?? 0
					};
				}
				this.breakers?.releaseProbe(modelId);
				this.broadcast({
					type: "node-reflect",
					planId,
					nodeId: node.id,
					verdict: "retry",
					reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} < 阈值 ${threshold.toFixed(2)}（第 ${attempt}/${maxAttempts} 次）`
				});
				lastError = `质量不达标: ${verdict.quality.toFixed(2)}`;
				if (attempt < maxAttempts) {
					if (verdict.retryAdvice === "retry-switch" || attempt === maxAttempts - 1) {
						const fallback = this.pickHealthyFallback(node.type, modelId, avoidModels);
						if (fallback) {
							this.broadcast({
								type: "node-reflect",
								planId,
								nodeId: node.id,
								verdict: "switch-model",
								reason: `${modelId} → ${fallback}`
							});
							modelId = fallback;
							const refreshed = this.modelScheduler.modelInsight(node.type, fallback);
							this.decisionInsights[insightIndex] = {
								nodeId: node.id,
								taskType: node.type,
								modelId: fallback,
								predictedConfidence: refreshed.confidence,
								exploration: false,
								success: false
							};
						}
					}
				}
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				this.broadcast({
					type: "node-error",
					planId,
					nodeId: node.id,
					error: lastError,
					attempt
				});
				const classification = classifyError(err);
				if (classification.kind === "timeout" || classification.kind === "network" || classification.kind === "rate-limit" || classification.kind === "server") this.breakers?.recordFailure(modelId);
				else this.breakers?.releaseProbe(modelId);
				if (attempt >= maxAttempts) break;
				if (classification.class === "retryable-backoff") {
					const delay = backoffDelayMs(attempt, {
						baseMs: this.config.retryBackoffBaseMs ?? 0,
						maxMs: this.config.retryBackoffMaxMs ?? 8e3
					});
					if (delay > 0) {
						if (!await abortableSleep(delay, abortSignal)) {
							lastError = "全局超时，退避等待中中止";
							break;
						}
					}
					continue;
				}
				if (classification.class === "retryable-immediate") continue;
				break;
			}
		}
		return {
			nodeId: node.id,
			modelId,
			success: false,
			quality: 0,
			latency: Date.now() - nodeStartedAt,
			attempts: maxAttempts,
			error: lastError ?? "未知错误",
			tokensUsed: 0
		};
	}
	/** 带节点级超时的 nodeRunner 调用 */
	async runWithTimeout(node, modelId, context, signal, attempt) {
		const timeout = node.timeout ?? this.config.nodeTimeout;
		let timer;
		const timeoutPromise = new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new TimeoutError(`节点 ${node.id} 执行超时（${timeout}ms）`, { nodeId: node.id })), timeout);
			timer.unref?.();
		});
		try {
			return await Promise.race([this.nodeRunner({
				node,
				modelId,
				context,
				signal,
				attempt
			}), timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	/** 默认节点执行器：通过 LLMClient 调用分配模型 */
	async defaultNodeRunner(params) {
		const { node, modelId, context, signal } = params;
		const contextText = Object.entries(context).map(([dep, output]) => `【上游 ${dep} 产出】\n${output}`).join("\n\n");
		const response = await this.llm.chat(modelId, [{
			role: "system",
			content: "你是任务执行器。直接输出任务结果，不要输出多余解释。"
		}, {
			role: "user",
			content: [
				`任务目标: ${signal.description}`,
				`当前子任务: ${node.description}`,
				`任务类型: ${node.type}`,
				contextText ? `上游依赖产出:\n${contextText}` : ""
			].filter(Boolean).join("\n")
		}]);
		return {
			output: response.content,
			quality: response.content.trim().length > 0 ? Math.min(1, .75 + Math.min(.2, response.content.length / 1e4)) : 0,
			tokensUsed: response.tokensUsed
		};
	}
	/** 级联触发：节点完成且质量达标时回注下游信号 */
	triggerCascade(node, signal, output) {
		if (!node.cascade || node.cascade.length === 0 || !this.cascadeHandler) return;
		for (const cascade of node.cascade) {
			const newSignal = {
				type: cascade.type,
				description: cascade.description,
				payload: {
					triggeredBy: signal.id,
					nodeId: node.id,
					upstreamOutputPreview: output.slice(0, 500)
				}
			};
			this.broadcast({
				type: "cascade-trigger",
				nodeId: node.id,
				newSignal: {
					type: cascade.type,
					description: cascade.description
				}
			});
			try {
				this.cascadeHandler(newSignal);
			} catch {}
		}
	}
	/** 拓扑分层（Kahn 算法），检测环 */
	topologicalLayers(nodes) {
		const nodeMap = new Map(nodes.map((n) => [n.id, n]));
		const inDegree = /* @__PURE__ */ new Map();
		for (const node of nodes) inDegree.set(node.id, 0);
		for (const node of nodes) for (const dep of node.dependsOn) {
			if (!nodeMap.has(dep)) throw new ExecutionError(`节点 ${node.id} 依赖不存在的节点 ${dep}`);
			inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
		}
		const layers = [];
		let frontier = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
		const visited = /* @__PURE__ */ new Set();
		while (frontier.length > 0) {
			layers.push(frontier);
			const next = [];
			for (const node of frontier) {
				visited.add(node.id);
				for (const other of nodes) {
					if (visited.has(other.id) || frontier.includes(other)) continue;
					if (other.dependsOn.includes(node.id)) {
						const deg = (inDegree.get(other.id) ?? 0) - 1;
						inDegree.set(other.id, deg);
						if (deg === 0) next.push(other);
					}
				}
			}
			frontier = next;
		}
		if (visited.size !== nodes.length) throw new ExecutionError("执行计划存在循环依赖");
		return layers;
	}
	/** DAG 结构校验（节点 id 唯一、依赖存在、无环） */
	validateDag(rawNodes) {
		const ids = /* @__PURE__ */ new Set();
		for (const n of rawNodes) {
			if (typeof n?.id !== "string" || ids.has(n.id)) return false;
			ids.add(n.id);
		}
		for (const n of rawNodes) {
			const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
			for (const dep of deps) if (!ids.has(dep)) return false;
		}
		try {
			this.topologicalLayers(rawNodes.map((n) => this.normalizeNode(n)));
			return true;
		} catch {
			return false;
		}
	}
	/** 归一化 strategist 输出的节点 */
	normalizeNode(raw) {
		return {
			id: String(raw.id),
			description: typeof raw.description === "string" ? raw.description : String(raw.id),
			type: typeof raw.type === "string" ? raw.type : "general",
			dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
			modelId: typeof raw.modelId === "string" ? raw.modelId : void 0,
			timeout: typeof raw.timeout === "number" ? raw.timeout : void 0,
			cascade: Array.isArray(raw.cascade) ? raw.cascade.filter((c) => c && typeof c.type === "string") : void 0
		};
	}
	/** 进度事件广播（enableProgress 关闭时为空操作） */
	broadcast(event) {
		if (!this.config.enableProgress || !this.broadcaster) return;
		this.broadcaster.broadcast({
			type: event.type,
			timestamp: Date.now(),
			...event
		});
	}
};
//#endregion
//#region src/optimizer.ts
/**
* 优化器
*
* 被编排层（index.ts）持有：执行前调用 lookupExperience / recallPlan
* 产出推荐模型与复用计划，喂给执行器（模型调度 + 任务执行）。
*
* 第三阶段升级（策略进化）：
* - 策略版本标注：构造时注入 policyProvider（由编排层桥接到策略进化器或模型
*   调度器），每次经验检索返回 policyVersion，推荐可追溯到具体策略版本
* - 任务分解决策：shouldDecompose 按当前策略的分解规则判断是否拆分任务
*   （沙盒中进化出的分解参数在操作环落地）
* - 未注入 policyProvider 时标注 baseline 策略，行为与第二阶段一致（兼容）
*/
var Optimizer = class {
	memory;
	config;
	broadcaster;
	graph;
	/** 当前调度策略提供器（第三阶段：策略版本标注与分解决策依据） */
	policyProvider;
	/** 7.0：深思内核（冷启动序列推荐 = 规划即推断） */
	deliberation;
	/** 8.0：元推理内核（推荐的双过程仲裁 = 理性元推理） */
	metareasoner;
	constructor(params) {
		this.memory = params.memory;
		this.config = params.config ?? {};
		this.broadcaster = params.broadcaster;
		this.graph = params.graph;
		this.policyProvider = params.policyProvider;
	}
	/** 7.0：挂载深思内核（幂等；挂载后获得冷启动深思推荐能力） */
	attachDeliberation(engine) {
		this.deliberation = engine;
	}
	/** 8.0：挂载元推理内核（幂等；挂载后推荐经双过程仲裁定价） */
	attachMetareasoner(reasoner) {
		this.metareasoner = reasoner;
	}
	/** 运行时配置热更新（元认知自调优落地入口） */
	updateConfig(patch) {
		this.config = {
			...this.config,
			...patch
		};
	}
	/** 当前配置快照（第四阶段：元认知旋钮 read 端；只读） */
	getConfig() {
		return { ...this.config };
	}
	/** 当前策略版本标识（policyId@vN；未注入提供器时为 baseline） */
	currentPolicyVersion() {
		const policy = this.policyProvider?.();
		return policy ? `${policy.id}@v${policy.version}` : "policy-baseline@v1";
	}
	/**
	* 经验检索 — 三层记忆优先级匹配并给出推荐模型组合
	*
	* 第二阶段三层记忆级联（procedural > semantic > episodic > none）：
	* 1. 程序记忆（findProceduralMemory）：按 kind='scheduling' + 条件合取匹配。
	*    命中时从 action 提取 prefer-model 写入 recommendedModels，并返回 suggestedActions
	*    供执行器消费（如 enable-cot / avoid-model / parallelism）。
	* 2. 语义记忆（findSemanticMemory）：跨任务规律匹配。命中时从 conclusion 提取
	*    model-preference 写入 recommendedModels。
	* 3. 情景记忆（findPattern）：既有模糊匹配，回退路径。
	* 4. 全无命中：memoryLayer='none'，返回空推荐（首次任务）。
	*
	* 三层均会查询（不只取首层），但 memoryLayer 标记命中的最高层级，
	* rationale 说明决策依据。程序/语义记忆未命中时仍会回退到情景记忆，
	* 保证既有"模型推荐组合"链路不被破坏。
	*
	* @param taskType 任务类型
	* @param complexity 复杂度 0~1
	* @param features 任务特征标签
	* @param context 程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
	*/
	lookupExperience(taskType, complexity, features = [], context = {}) {
		const matchContext = {
			features,
			complexity,
			length: context.length,
			tokenCost: context.tokenCost
		};
		const proceduralMatches = this.memory.getProceduralMemories(taskType, "scheduling").filter((p) => matchesMemoryConditions(p.conditions, taskType, matchContext));
		const procedural = proceduralMatches[0];
		const semantic = this.memory.findSemanticMemory(taskType, matchContext);
		const pattern = this.memory.findPattern(taskType, complexity, features);
		const recommendedModels = {};
		const suggestedActions = [];
		const avoidModels = [];
		for (const proc of proceduralMatches) {
			suggestedActions.push(proc.action);
			if (proc.action.type === "prefer-model") {
				const model = proc.action.params["model"];
				if (typeof model === "string" && !recommendedModels[taskType]) recommendedModels[taskType] = model;
			} else if (proc.action.type === "avoid-model") {
				const model = proc.action.params["model"];
				if (typeof model === "string" && !avoidModels.includes(model)) avoidModels.push(model);
			}
		}
		if (semantic && Object.keys(recommendedModels).length === 0 && semantic.conclusion.type === "model-preference") {
			const model = semantic.conclusion.value;
			if (typeof model === "string") recommendedModels[taskType] = model;
		}
		if (pattern?.bestModelCombination) {
			const nodeTypeById = /* @__PURE__ */ new Map();
			const bestPlan = pattern.successfulPlans[pattern.successfulPlans.length - 1];
			for (const node of bestPlan?.plan.nodes ?? []) nodeTypeById.set(node.id, node.type);
			for (const [nodeId, modelId] of Object.entries(pattern.bestModelCombination)) {
				const nodeType = nodeTypeById.get(nodeId);
				if (nodeType && !recommendedModels[nodeType]) recommendedModels[nodeType] = modelId;
			}
			if (Object.keys(recommendedModels).length === 0) Object.assign(recommendedModels, pattern.bestModelCombination);
		}
		let historicalSuccessRate = 0;
		let avgExecutionTime = 0;
		if (pattern) {
			const successes = pattern.successfulPlans.length;
			const failures = pattern.failureRecords.length;
			historicalSuccessRate = successes + failures > 0 ? successes / (successes + failures) : 0;
			avgExecutionTime = pattern.avgExecutionTime;
		}
		const memoryLayer = procedural ? "procedural" : semantic ? "semantic" : pattern ? "episodic" : "none";
		const rationale = this.buildRationale(memoryLayer, proceduralMatches, avoidModels, semantic, pattern);
		return {
			pattern,
			recommendedModels,
			historicalSuccessRate,
			avgExecutionTime,
			memoryLayer,
			rationale,
			matchedProceduralId: procedural?.id,
			matchedSemanticId: semantic?.id,
			suggestedActions: suggestedActions.length > 0 ? suggestedActions : void 0,
			avoidModels,
			matchedProceduralIds: proceduralMatches.length > 0 ? proceduralMatches.map((p) => p.id) : void 0,
			policyVersion: this.currentPolicyVersion()
		};
	}
	/**
	* 任务分解决策（第三阶段：策略进化中「任务分解规则」的操作环落地）
	*
	* 按当前策略判定：分解启用且复杂度 ≥ 阈值时建议将任务拆分为子任务。
	* 编排层在兜底单节点计划时消费该建议（decomposePlan）。
	* 质级升级：传入 taskType/features 时按规则基因组解析上下文有效参数
	* （规则可对特定任务类型/复杂度段强制开/关分解）。
	* @param complexity 任务复杂度 0~1
	* @param taskType 任务类型（供规则基因匹配）
	* @param features 特征标签（供规则基因匹配）
	*/
	shouldDecompose(complexity, taskType, features) {
		const policy = this.policyProvider?.();
		if (!policy) return false;
		const params = taskType !== void 0 ? resolveEffectiveParams(policy.params, {
			taskType,
			complexity,
			features
		}) : policy.params;
		if (!params.decomposeEnabled) return false;
		return complexity >= params.decomposeComplexityThreshold;
	}
	/**
	* 构建决策依据说明（人类可读，供广播与可观测性）
	*
	* 第二阶段升级：程序记忆层说明全部命中规则数与正负向动作概览，
	* 让"使用了哪一层记忆、为什么"完全可追溯。
	*/
	buildRationale(layer, proceduralMatches, avoidModels, semantic, pattern) {
		switch (layer) {
			case "procedural": {
				const parts = proceduralMatches.map((p) => `${p.name}（${p.action.type}，置信度 ${p.confidence.toFixed(2)}）`);
				const avoidNote = avoidModels.length > 0 ? `；规避模型：${avoidModels.join("/")}` : "";
				return `程序记忆命中 ${proceduralMatches.length} 条规则：${parts.join("；")}${avoidNote}`;
			}
			case "semantic": return `语义记忆命中：${semantic.statement}（置信度 ${semantic.confidence.toFixed(2)}）`;
			case "episodic": return `情景记忆命中：${pattern.taskSummary}（置信度 ${pattern.confidence.toFixed(2)}）`;
			default: return "无记忆命中（首次任务，走常规规划）";
		}
	}
	/**
	* 经验快路径：命中高置信度模式时，直接复用历史最优成功计划，
	* 跳过 strategist LLM 重新规划——越用越快、越稳、越省 token。
	*
	* 复用条件（全部满足才返回计划，否则返回 undefined 走常规规划）：
	* 1. 模式置信度 ≥ memoryFastPathThreshold（缺省 0.9）
	* 2. 存在至少一条成功计划记录
	*
	* 选取策略：取平均质量最高的成功记录；其节点模型分配经 recommendedModels
	* （按节点类型）在执行时优先采用，保持"记忆驱动选型"的一致性。
	*
	* @param lookup 经验检索结果
	* @param objective 当前任务目标（写入计划）
	* @returns 复用的计划（source='memory'），不满足条件时 undefined
	*/
	recallPlan(lookup, objective) {
		const threshold = this.config.memoryFastPathThreshold ?? .9;
		const pattern = lookup.pattern;
		if (!pattern || pattern.confidence < threshold) return void 0;
		if (pattern.successfulPlans.length === 0) return void 0;
		let best = pattern.successfulPlans[0];
		let bestQuality = -1;
		for (const record of pattern.successfulPlans) {
			const qualities = Object.values(record.qualityScores);
			const avg = qualities.length > 0 ? qualities.reduce((s, v) => s + v, 0) / qualities.length : 0;
			if (avg > bestQuality) {
				bestQuality = avg;
				best = record;
			}
		}
		const nodes = best.plan.nodes.map((n) => ({
			id: n.id,
			description: n.description,
			type: n.type,
			dependsOn: [...n.dependsOn]
		}));
		this.broadcast({
			type: "plan-recalled",
			fingerprint: pattern.fingerprint,
			confidence: pattern.confidence,
			nodeCount: nodes.length,
			historicalQuality: Number(bestQuality.toFixed(3))
		});
		return {
			objective,
			nodes,
			parallelismStrategy: best.plan.parallelismStrategy || "layered",
			source: "memory"
		};
	}
	/**
	* 7.0：深思推荐 —— 规划即推断的冷启动序列建议。
	*
	* 与经验检索的本质区别：lookupExperience 回答「历史上类似任务
	* 用过什么」（没有历史就没有答案）；本方法回答「按我脑内的世界
	* 演练，怎样的一串选择全程自由能最低」——**零情景记忆也能给出
	* 计划级建议**（转移模型无证据时诚实返回无知区间，搜索以认知
	* 价值驱动试探序）。
	*
	* 消费方：编排层在 memoryLayer='none'（冷启动）时以序列建议辅助
	* 逐节点选型；有记忆命中时经验优先（深思只补充，不越权）。
	*
	* @param taskType 任务类型（构造状态键 `${taskType}#s${i}`）
	* @param candidateActions 每阶段的候选行动（如模型 id 列表）
	* @param stages 计划阶段数（搜索深度）
	*/
	deliberativeRecommendation(taskType, candidateActions, stages, opts) {
		if (!this.deliberation || candidateActions.length === 0 || stages < 1) return void 0;
		return this.deliberation.search(`${taskType}#s0`, candidateActions, {
			depth: stages,
			breadth: opts?.breadth,
			preference: opts?.preference,
			advance: ({ step }) => `${taskType}#s${step + 1}`
		});
	}
	/**
	* 8.0：元认知推荐 —— 理性元推理的冷启动序列建议。
	*
	* 与 7.0 深思推荐的区别：deliberativeRecommendation **每次都全深度
	* 搜索**（想不想要深思是配置，不是决策）；本方法把「想多深」本身
	* 变成决策——双过程仲裁：
	*   habit       深思已摊销为习惯（查表直答，成本 ≈ 0）
	*   reactive    证据充分且优劣悬殊（VOC ≈ 0，直接反应一步）
	*   deliberative 任意时搜索（首行动稳定即停，思考按 nat 计价）
	*
	* 结算闭环：上游执行后调 metareasoner.settleDecision(decisionId, 成败)
	* → 反应失手收紧门槛、深思成功晋升习惯（元学习）。
	*/
	metacognitiveRecommendation(taskType, candidateActions, stages, opts) {
		if (!this.metareasoner || candidateActions.length === 0 || stages < 1) return void 0;
		return this.metareasoner.decide(`${taskType}#s0`, candidateActions, { preference: opts?.preference });
	}
	/**
	* 混合检索（自主学习建议 1：sqlite-vec + FTS5 + jieba 分词管道）
	*
	* 四路召回合并去重（按 refId 取最高分）：
	* 1. 模糊匹配（findPattern：taskType/complexity/features 相似度）
	* 2. FTS5 全文（trigram 子串级 + jieba 式 token 级，中文友好）
	* 3. 向量（sqlite-vec 可用时宿主扩展；缺省稀疏词频向量余弦）
	* 4. 图联想（记忆网络相邻节点，权重折半计入）
	*/
	hybridSearch(query, taskType, complexity, limit = 5) {
		const merged = /* @__PURE__ */ new Map();
		const consider = (hit, factor = 1) => {
			const score = hit.score * factor;
			const prev = merged.get(hit.refId);
			if (!prev || prev.score < score) merged.set(hit.refId, {
				...hit,
				score
			});
		};
		const fuzzy = this.memory.findPattern(taskType, complexity);
		if (fuzzy) consider({
			kind: "pattern",
			refId: fuzzy.fingerprint,
			score: 1
		});
		for (const hit of this.memory.fullTextSearch?.(query, limit) ?? []) consider(hit);
		for (const hit of this.memory.vectorSearch?.(query, limit) ?? []) consider(hit, .9);
		if (this.graph) for (const hit of [...merged.values()]) for (const related of this.graph.related(hit.refId, 3)) consider({
			kind: "pattern",
			refId: related,
			score: hit.score
		}, .5);
		return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
	}
	/** 进度事件广播（broadcaster 缺省时为空操作） */
	broadcast(event) {
		if (!this.broadcaster) return;
		this.broadcaster.broadcast({
			type: event.type,
			timestamp: Date.now(),
			...event
		});
	}
};
//#endregion
//#region src/reflector.ts
/**
* reflector.ts — 反思器组件（新架构「任务执行 → 反思器 → 记忆更新」）
*
* 职责（对应架构图 Reflector 框）：
* - 执行后复盘：消费执行结果，驱动反思引擎（质量趋势 / 阈值自校准 / 教训提取）
* - 记忆更新：成功方案沉淀（任务模式 + 模型画像）/ 失败记录写入记忆库
* - 策略反馈：蒸馏策略应用结果回写，反向校准策略置信度
* - 经验蒸馏：成功沉淀达到阈值时提炼可复用策略
*
* 边界：只写记忆库 + 复盘，不做调度决策。
* 与优化器（optimizer.ts）构成单向数据流的两端：
*   记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新 → 记忆库
*/
/**
* 反思器
*
* 被编排层（index.ts）持有：执行器完成计划后调用 reflectOnOutcome()，
* 一次性完成「复盘 → 记忆更新 → 策略反馈 → 蒸馏」全链路学习。
*/
var Reflector = class {
	memory;
	reflection;
	config;
	broadcaster;
	graph;
	/** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
	onMemoryChange;
	/** 蒸馏进行中标志（阈值自动触发的防抖，避免并发重复蒸馏） */
	distilling = false;
	/** 2.0：校准滑动窗口（Brier 残差滚动统计） */
	calibrationWindow = [];
	constructor(params) {
		this.memory = params.memory;
		this.reflection = params.reflection;
		this.config = params.config ?? {};
		this.broadcaster = params.broadcaster;
		this.graph = params.graph;
		this.onMemoryChange = params.onMemoryChange;
	}
	/**
	* 运行时配置热更新（第四阶段：元认知控制器调参落地入口）
	*
	* 元认知层经此调整反思触发频率与蒸馏门槛（autoDistillThreshold /
	* distillMinConfidence 等），立即对后续复盘生效，无需重启。
	* 回调类字段（onLesson/onDistilled/...）仅显式传入时覆盖。
	*/
	updateConfig(patch) {
		this.config = {
			...this.config,
			...patch
		};
	}
	/** 当前配置快照（元认知旋钮 read 端；只读） */
	getConfig() {
		return { ...this.config };
	}
	/**
	* 执行后反思与记忆更新（闭环学习入口）
	*
	* 步骤：
	* 1. 质量趋势记录（反思引擎阈值自校准）
	* 2. 经验沉淀：成功 → 任务模式 + 模型画像；失败 → 失败记录 + 教训提取
	* 3. 策略反馈：本次应用的蒸馏策略按结果回写，校准置信度
	* 3.5 记忆反馈（第二阶段升级）：本次命中的语义/程序记忆按结果回写——
	*    有效规律越用越强，无效规律被应用成功率反向衰减，同时刷新 lastAppliedAt
	*    （否则遗忘曲线会以 distilledAt 为基准误杀从未被"应用"过的高级记忆）
	* 4. 经验蒸馏：成功时尝试提炼新策略
	* 4.6 阈值自动蒸馏（第二阶段升级）：新增情景事件达阈值时后台触发知识蒸馏
	*
	* @param signal 触发信号
	* @param plan 执行的计划
	* @param result 计划执行结果
	* @param appliedStrategies 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环）
	* @param appliedMemoryIds 本次经验检索命中的语义/程序记忆 id（记忆反馈闭环）
	*/
	reflectOnOutcome(params) {
		const { signal, plan, result } = params;
		const taskType = plan.nodes[0]?.type ?? signal.type;
		this.reflection.recordExecution(taskType, result.avgQuality, result.success);
		this.settleExperience(signal, plan, result);
		if (params.decisionInsights && params.decisionInsights.length > 0) this.updateCalibration(params.decisionInsights);
		this.analyzeCounterfactualRegret(signal, plan, result);
		for (const strategyId of params.appliedStrategies ?? []) this.memory.recordStrategyOutcome(strategyId, result.success);
		for (const semanticId of params.appliedMemoryIds?.semantic ?? []) this.memory.recordSemanticOutcome(semanticId, result.success);
		for (const proceduralId of params.appliedMemoryIds?.procedural ?? []) this.memory.recordProceduralOutcome(proceduralId, result.success);
		if (this.graph && result.success) {
			const fingerprint = buildPatternFingerprint(taskType, Math.min(1, plan.nodes.length / 5), [...new Set(plan.nodes.map((n) => n.type))]);
			this.graph.ensureNode(fingerprint, "pattern", signal.description);
			this.graph.attachTopic(fingerprint, taskType);
			for (const strategyId of params.appliedStrategies ?? []) {
				this.graph.ensureNode(strategyId, "strategy", strategyId);
				this.graph.link(fingerprint, strategyId);
			}
		}
		if (!result.success) this.reflection.extractLesson({
			signal,
			taskType,
			result,
			plan
		}).then((lesson) => {
			if (lesson) {
				this.broadcast({
					type: "lesson-extracted",
					lessonId: lesson.id,
					rootCause: lesson.rootCause,
					lesson: lesson.lesson
				});
				this.config.onLesson?.(lesson);
			}
		});
		else {
			const fresh = this.memory.distillExperience();
			if (fresh.length > 0) {
				this.broadcast({
					type: "experience-distilled",
					strategies: fresh.map((s) => ({
						id: s.id,
						description: s.description,
						confidence: s.confidence
					}))
				});
				this.config.onDistilled?.(fresh);
			}
		}
		const autoThreshold = this.config.autoDistillThreshold ?? 5;
		if (autoThreshold > 0 && !this.distilling) {
			const progress = this.memory.getDistillationProgress?.();
			if (progress && progress.pendingSinceLastDistillation >= autoThreshold) this.distillKnowledge().catch(() => {});
		}
	}
	/**
	* 校准更新（2.0：预测置信度 vs 实际结果的滚动统计）
	*
	* Brier 分 = mean((predicted - actual)²)——概率预测质量金标准：
	* 调度器说「90% 能成」的实际成了 → 无惩罚；说 90% 却连续失败 → 重罚。
	* 这是「系统知道自己有多准」的自知之明，过自信/欠自信方向可诊断。
	*/
	updateCalibration(insights) {
		const windowSize = this.config.calibrationWindowSize ?? 50;
		for (const insight of insights) this.calibrationWindow.push({
			predicted: insight.predictedConfidence,
			actual: insight.success ? 1 : 0
		});
		if (this.calibrationWindow.length > windowSize) this.calibrationWindow.splice(0, this.calibrationWindow.length - windowSize);
		const status = this.getCalibration();
		this.broadcast({
			type: "calibration-updated",
			brierScore: Number(status.brierScore.toFixed(4)),
			residualMean: Number(status.residualMean.toFixed(4)),
			samples: status.samples,
			direction: status.direction,
			correction: status.correction
		});
	}
	/** 校准状态查询（2.0：调度预测质量的持续自知；3.0：附带自修正量） */
	getCalibration() {
		const windowSize = this.config.calibrationWindowSize ?? 50;
		const n = this.calibrationWindow.length;
		if (n === 0) return {
			brierScore: 0,
			residualMean: 0,
			samples: 0,
			direction: "insufficient",
			windowSize,
			correction: 0
		};
		const brier = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual) ** 2, 0) / n;
		const residual = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual), 0) / n;
		const direction = n < 10 ? "insufficient" : residual > .1 ? "overconfident" : residual < -.1 ? "underconfident" : "calibrated";
		const correction = n >= 20 && Math.abs(residual) > .1 ? Math.max(-.15, Math.min(.15, -residual * .5)) : 0;
		return {
			brierScore: Number(brier.toFixed(6)),
			residualMean: Number(residual.toFixed(6)),
			samples: n,
			direction,
			windowSize,
			correction: Number(correction.toFixed(6))
		};
	}
	/**
	* 校准自修正（3.0）：对调度预测置信度施加校准偏移
	*
	* 过自信系统（如预测 0.9 实际 0.7）→ 收缩预测使其贴近真实成功率；
	* 欠自信系统 → 适度放大。样本不足或已校准时为恒等映射（零风险旁路）。
	*/
	correctConfidence(predicted) {
		const { correction, samples } = this.getCalibration();
		if (correction === 0 || samples < 20) return predicted;
		return Number(Math.max(0, Math.min(1, predicted + correction)).toFixed(6));
	}
	/**
	* 自知之明报告（3.0：系统对自己记忆与预测质量的一次性全景自检）
	*
	* 汇聚两路自知信号：
	* - calibration：调度预测校准（Brier / 残差 / 方向 / 自修正量）
	* - census：全层证据普查（各记忆层证据覆盖度 + 有效样本量 + 证据枯竭 +
	*   模型能力漂移）——记忆库未实现 evidenceCensus 时静默省略（旧实现兼容）
	*/
	getSelfKnowledge() {
		const calibration = this.getCalibration();
		const memoryWithCensus = this.memory;
		const census = typeof memoryWithCensus.evidenceCensus === "function" ? memoryWithCensus.evidenceCensus() : void 0;
		return {
			generatedAt: Date.now(),
			calibration,
			census
		};
	}
	/**
	* 反事实遗憾分析（2.0：「当时是否有更优选择」的结构化复盘）
	*
	* 对每个节点实际使用的模型，检索全部模型画像中该任务类型的贝叶斯估计：
	* 若存在替代者满足（威尔逊下界 > 所用模型后验均值 + margin 且有效样本充足），
	* 则生成反事实教训写入决策反馈——不依赖 LLM 的可机器验证归因，
	* 让「本可以更优」的选择失误成为可检索的记忆而非事后遗忘。
	*
	* 证据门槛（margin / minSamples 可配）杜绝小样本噪声触发误报。
	*/
	analyzeCounterfactualRegret(signal, plan, result) {
		if (!this.memory.getBayesianEstimate) return;
		const margin = this.config.counterfactualMargin ?? .1;
		const minSamples = this.config.counterfactualMinSamples ?? 3;
		const nodeTypeById = new Map(plan.nodes.map((n) => [n.id, n.type]));
		for (const node of result.nodeResults) {
			const taskType = nodeTypeById.get(node.nodeId);
			if (!taskType) continue;
			const usedEstimate = this.memory.getBayesianEstimate(node.modelId, taskType);
			if (!usedEstimate || usedEstimate.effectiveSamples < minSamples) continue;
			let bestAlternative;
			for (const profile of this.memory.getAllModelProfiles()) {
				if (profile.id === node.modelId) continue;
				const est = this.memory.getBayesianEstimate(profile.id, taskType);
				if (!est || est.effectiveSamples < minSamples) continue;
				if (est.wilsonLower > usedEstimate.posteriorMean + margin && (!bestAlternative || est.wilsonLower > bestAlternative.wilsonLower)) bestAlternative = {
					modelId: profile.id,
					wilsonLower: est.wilsonLower,
					samples: est.effectiveSamples
				};
			}
			if (!bestAlternative) continue;
			const lesson = `[反事实] ${taskType} 节点 ${node.nodeId} 使用 ${node.modelId}（贝叶斯后验 ${usedEstimate.posteriorMean.toFixed(2)}，本次${node.success ? "成功" : "失败"}），但 ${bestAlternative.modelId} 的威尔逊下界 ${bestAlternative.wilsonLower.toFixed(2)}（有效样本 ${bestAlternative.samples.toFixed(0)}）显著更优——下次同类任务优先考虑`;
			this.memory.appendFeedback({
				id: `cf-${node.nodeId}-${node.modelId}-${Date.now()}`,
				timestamp: Date.now(),
				signalType: taskType,
				signalDescription: signal.description,
				decision: `model:${node.modelId}`,
				outcome: node.success ? "acceptable" : "poor",
				outcomeReason: "counterfactual-regret-analysis",
				lesson,
				chosenModelId: node.modelId,
				predictedConfidence: usedEstimate.posteriorMean
			});
			this.broadcast({
				type: "counterfactual-regret",
				nodeId: node.nodeId,
				taskType,
				usedModel: node.modelId,
				usedPosterior: usedEstimate.posteriorMean,
				betterModel: bestAlternative.modelId,
				betterWilsonLower: bestAlternative.wilsonLower
			});
		}
	}
	/**
	* 知识蒸馏（第二阶段）：从累积的情景记忆中蒸馏出语义记忆与程序记忆
	*
	* 蒸馏来源：
	* 1. 情景记忆（TaskPatternMemory）：高置信度 + 多次成功的模式
	* 2. 反思教训（Lesson）：失败根因 → 反思规则（程序记忆 kind='reflection'）
	* 3. 既有 distillExperience：兼容产出 DistilledStrategy（不变）
	*
	* 蒸馏产物：
	* - 语义记忆（SemanticMemory）：
	*   * model-affinity：某模型在某任务类型的多条模式中占比 ≥ 阈值 → 跨任务规律
	*   * complexity-pattern：高复杂度任务的成功模型偏好
	* - 程序记忆（ProceduralMemory）：
	*   * scheduling：feature='code' 且复杂度高 → prefer-model + enable-cot
	*   * reflection：rootCause='timeout'/'model-capability' → avoid-model 规则
	*
	* 第二阶段升级：
	* - 幂等性升级：蒸馏产物使用内容寻址稳定 id（同一规律跨次蒸馏 id 不变），
	*   重复蒸馏不再丢弃证据，而是合并增强（supportCount 累加、置信度加权），
	*   冲突规律由证据竞争淘汰（详见 upsertSemanticMemory / upsertProceduralMemory）
	* - 水位门控：options.force 未设且新增情景事件 < autoDistillThreshold 且
	*   已有蒸馏知识时跳过全量蒸馏（返回 skipped 报告），避免无效计算
	* - 水位检查点：蒸馏成功后刷新水位（noteDistillationCheckpoint）
	*
	* @param options.force 强制蒸馏（Tool 按需调用 / 首次蒸馏时使用）
	* @returns 蒸馏报告（含本次产出的语义/程序记忆与兼容策略）
	*/
	async distillKnowledge(options) {
		const now = Date.now();
		const minConfidence = this.config.distillMinConfidence ?? .6;
		const minSuccesses = this.config.distillMinSuccesses ?? 3;
		const affinityThreshold = this.config.distillModelAffinityThreshold ?? .6;
		const autoThreshold = this.config.autoDistillThreshold ?? 5;
		if (!options?.force && !this.distilling) {
			const progress = this.memory.getDistillationProgress?.();
			const hasDistilledKnowledge = this.memory.getAllSemanticMemories().length > 0 || this.memory.getAllProceduralMemories().length > 0;
			if (progress && hasDistilledKnowledge && progress.pendingSinceLastDistillation < Math.max(1, autoThreshold)) return {
				distilledAt: now,
				sourceEpisodicCount: 0,
				semanticMemories: [],
				proceduralMemories: [],
				strategies: [],
				summary: `跳过蒸馏：新增情景事件 ${progress.pendingSinceLastDistillation} 未达阈值 ${Math.max(1, autoThreshold)}，既有知识无需刷新`,
				skipped: true,
				skipReason: "below-threshold"
			};
		}
		if (this.distilling) return {
			distilledAt: now,
			sourceEpisodicCount: 0,
			semanticMemories: [],
			proceduralMemories: [],
			strategies: [],
			summary: "跳过蒸馏：已有蒸馏任务进行中",
			skipped: true,
			skipReason: "in-flight"
		};
		this.distilling = true;
		try {
			const qualifiedPatterns = this.memory.getAllTaskPatterns().filter((p) => p.confidence >= minConfidence && p.successfulPlans.length >= minSuccesses);
			const sourceEpisodicCount = qualifiedPatterns.length;
			const strategies = this.memory.distillExperience(minConfidence);
			const semanticMemories = [];
			semanticMemories.push(...this.distillModelAffinity(qualifiedPatterns, affinityThreshold, now));
			semanticMemories.push(...this.distillComplexityPatterns(qualifiedPatterns, now));
			const proceduralMemories = [];
			proceduralMemories.push(...this.distillSchedulingRules(qualifiedPatterns, now));
			proceduralMemories.push(...this.distillReflectionRules(now));
			let mergedSemanticCount = 0;
			let mergedProceduralCount = 0;
			let supersededCount = 0;
			const writtenSemantic = [];
			for (const mem of semanticMemories) {
				const result = this.memory.upsertSemanticMemory(mem);
				if (result === "merged") {
					mergedSemanticCount += 1;
					writtenSemantic.push(this.memory.getAllSemanticMemories().find((m) => m.id === mem.id) ?? mem);
				} else if (result === "superseded") {
					supersededCount += 1;
					writtenSemantic.push(mem);
				} else if (result !== "duplicate") writtenSemantic.push(mem);
			}
			const writtenProcedural = [];
			for (const proc of proceduralMemories) {
				const result = this.memory.upsertProceduralMemory(proc);
				if (result === "merged") {
					mergedProceduralCount += 1;
					writtenProcedural.push(this.memory.getAllProceduralMemories().find((p) => p.id === proc.id) ?? proc);
				} else if (result === "superseded") {
					supersededCount += 1;
					writtenProcedural.push(proc);
				} else if (result !== "duplicate") writtenProcedural.push(proc);
			}
			if (this.graph) {
				for (const mem of writtenSemantic) {
					this.graph.ensureNode(mem.id, "semantic", mem.statement);
					for (const fp of mem.sourceFingerprints) {
						this.graph.ensureNode(fp, "pattern", fp);
						this.graph.link(fp, mem.id);
					}
				}
				for (const proc of writtenProcedural) {
					this.graph.ensureNode(proc.id, "procedural", proc.name);
					for (const fp of proc.sourceFingerprints) {
						this.graph.ensureNode(fp, "pattern", fp);
						this.graph.link(fp, proc.id);
					}
				}
			}
			const summary = this.buildDistillationSummary(sourceEpisodicCount, writtenSemantic, writtenProcedural, strategies);
			const summaryWithMerge = mergedSemanticCount + mergedProceduralCount + supersededCount > 0 ? `${summary}\n证据合并：语义 ${mergedSemanticCount} 条 / 程序 ${mergedProceduralCount} 条；冲突取代 ${supersededCount} 条` : summary;
			this.memory.noteDistillationCheckpoint?.();
			this.broadcast({
				type: "knowledge-distilled",
				sourceEpisodicCount,
				semanticCount: writtenSemantic.length,
				proceduralCount: writtenProcedural.length,
				strategyCount: strategies.length,
				mergedSemanticCount,
				mergedProceduralCount,
				supersededCount
			});
			const report = {
				distilledAt: now,
				sourceEpisodicCount,
				semanticMemories: writtenSemantic,
				proceduralMemories: writtenProcedural,
				strategies,
				summary: summaryWithMerge,
				mergedSemanticCount,
				mergedProceduralCount,
				supersededCount
			};
			this.config.onKnowledgeDistilled?.(report);
			return report;
		} finally {
			this.distilling = false;
		}
	}
	/**
	* 内容寻址稳定 id（第二阶段升级）
	*
	* 同一规律（相同组成要素）跨次蒸馏生成相同 id，使 upsert 的证据合并
	* 能命中既有记录，而非每次插入新 id 后靠 statement 判重丢弃证据。
	*/
	stableId(prefix, ...parts) {
		return `${prefix}-${crypto.createHash("sha256").update(parts.join("::")).digest("hex").slice(0, 12)}`;
	}
	/**
	* 蒸馏模型亲和规律（语义记忆 domain='model-affinity'）
	*
	* 按 taskType 聚合所有合格模式中的模型分配，若某模型占比 ≥ affinityThreshold
	* 且支撑模式数 ≥ 2，则产出跨任务规律："X 类任务适合模型 Y"。
	*/
	distillModelAffinity(patterns, affinityThreshold, now) {
		const result = [];
		const byTaskType = /* @__PURE__ */ new Map();
		for (const pattern of patterns) {
			const taskType = this.extractTaskType(pattern);
			const bucket = byTaskType.get(taskType) ?? {
				patterns: [],
				modelWins: /* @__PURE__ */ new Map(),
				total: 0
			};
			bucket.patterns.push(pattern);
			for (const plan of pattern.successfulPlans) for (const modelId of Object.values(plan.modelAssignments)) {
				bucket.modelWins.set(modelId, (bucket.modelWins.get(modelId) ?? 0) + 1);
				bucket.total += 1;
			}
			byTaskType.set(taskType, bucket);
		}
		for (const [taskType, bucket] of byTaskType) {
			if (bucket.patterns.length < 2 || bucket.total === 0) continue;
			for (const [modelId, wins] of bucket.modelWins) {
				const ratio = wins / bucket.total;
				if (ratio >= affinityThreshold) {
					const statement = `${taskType} 类任务适合模型 ${modelId}（跨 ${bucket.patterns.length} 个模式占比 ${(ratio * 100).toFixed(0)}%）`;
					const conditions = [{
						dimension: "task-type",
						operator: "eq",
						value: taskType
					}];
					const conclusion = {
						type: "model-preference",
						value: modelId,
						rationale: `在 ${bucket.patterns.length} 个高置信度模式中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${bucket.total} 次成功分配）`
					};
					result.push({
						id: this.stableId("sem-ma", taskType, modelId),
						domain: "model-affinity",
						statement,
						taskTypes: [taskType],
						conditions,
						conclusion,
						confidence: Math.min(.95, ratio * .9 + .1),
						supportCount: wins,
						sourceFingerprints: bucket.patterns.map((p) => p.fingerprint),
						distilledAt: now,
						appliedTotal: 0,
						appliedSuccesses: 0
					});
				}
			}
		}
		return result;
	}
	/**
	* 蒸馏复杂度模式（语义记忆 domain='complexity-pattern'）
	*
	* 高复杂度（complexity ≥ 0.7）任务的成功模型偏好。
	*/
	distillComplexityPatterns(patterns, now) {
		const result = [];
		const highComplexity = patterns.filter((p) => {
			return Number(p.fingerprint.split("::")[1] ?? 0) >= .7;
		});
		if (highComplexity.length < 2) return result;
		const modelWins = /* @__PURE__ */ new Map();
		let total = 0;
		for (const pattern of highComplexity) for (const plan of pattern.successfulPlans) for (const modelId of Object.values(plan.modelAssignments)) {
			modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
			total += 1;
		}
		if (total === 0) return result;
		for (const [modelId, wins] of modelWins) {
			const ratio = wins / total;
			if (ratio >= .6) {
				const statement = `高复杂度任务适合模型 ${modelId}（${highComplexity.length} 个高复杂度模式占比 ${(ratio * 100).toFixed(0)}%）`;
				result.push({
					id: this.stableId("sem-cp", modelId),
					domain: "complexity-pattern",
					statement,
					taskTypes: [],
					conditions: [{
						dimension: "complexity",
						operator: "gte",
						value: .7
					}],
					conclusion: {
						type: "model-preference",
						value: modelId,
						rationale: `高复杂度（≥0.7）任务中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${total}）`
					},
					confidence: Math.min(.9, ratio * .85),
					supportCount: wins,
					sourceFingerprints: highComplexity.map((p) => p.fingerprint),
					distilledAt: now,
					appliedTotal: 0,
					appliedSuccesses: 0
				});
			}
		}
		return result;
	}
	/**
	* 蒸馏调度规则（程序记忆 kind='scheduling'）
	*
	* 规则：feature='code' 且 complexity ≥ 0.7 的任务 → prefer-model + enable-cot
	* 支撑：该任务类型的成功方案中存在模型偏好。
	*/
	distillSchedulingRules(patterns, now) {
		const result = [];
		for (const pattern of patterns) {
			const features = (pattern.fingerprint.split("::")[2] ?? "").split(",").filter(Boolean);
			const complexity = Number(pattern.fingerprint.split("::")[1] ?? 0);
			const taskType = this.extractTaskType(pattern);
			if (!features.includes("code") || complexity < .7) continue;
			const modelWins = /* @__PURE__ */ new Map();
			for (const plan of pattern.successfulPlans) for (const modelId of Object.values(plan.modelAssignments)) modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
			let bestModel = "";
			let bestWins = 0;
			for (const [modelId, wins] of modelWins) if (wins > bestWins) {
				bestWins = wins;
				bestModel = modelId;
			}
			if (!bestModel || bestWins < 2) continue;
			const conditions = [
				{
					dimension: "task-type",
					operator: "eq",
					value: taskType
				},
				{
					dimension: "feature",
					operator: "contains",
					value: "code"
				},
				{
					dimension: "complexity",
					operator: "gte",
					value: .7
				}
			];
			const action = {
				type: "prefer-model",
				params: {
					model: bestModel,
					cot: true
				},
				rationale: `长代码任务在 ${bestModel} + CoT 下成功率更高（${bestWins}/${pattern.successfulPlans.length} 次成功）`
			};
			result.push({
				id: this.stableId("proc-sched", taskType, "prefer", bestModel),
				kind: "scheduling",
				name: `${taskType} 长代码任务偏好模型 ${bestModel}`,
				taskTypes: [taskType],
				conditions,
				action,
				confidence: Math.min(.9, pattern.confidence * .95),
				supportCount: bestWins,
				sourceFingerprints: [pattern.fingerprint],
				distilledAt: now,
				appliedTotal: 0,
				appliedSuccesses: 0
			});
			result.push({
				id: this.stableId("proc-sched", taskType, "cot"),
				kind: "scheduling",
				name: `${taskType} 长代码任务启用思维链`,
				taskTypes: [taskType],
				conditions,
				action: {
					type: "enable-cot",
					params: { model: bestModel },
					rationale: `长代码任务启用 CoT 可提升结构化输出质量`
				},
				confidence: Math.min(.85, pattern.confidence * .9),
				supportCount: bestWins,
				sourceFingerprints: [pattern.fingerprint],
				distilledAt: now,
				appliedTotal: 0,
				appliedSuccesses: 0
			});
		}
		return result;
	}
	/**
	* 蒸馏反思规则（程序记忆 kind='reflection'）
	*
	* 从反思教训中提炼：rootCause='timeout' → avoid-model + escalate
	* rootCause='model-capability' → avoid-model + retry-switch
	*/
	distillReflectionRules(now) {
		const result = [];
		const lessons = this.reflection.getAllLessons();
		const byKey = /* @__PURE__ */ new Map();
		for (const lesson of lessons) {
			const key = `${lesson.taskType}::${lesson.rootCause}`;
			const bucket = byKey.get(key) ?? {
				taskType: lesson.taskType,
				rootCause: lesson.rootCause,
				modelIds: /* @__PURE__ */ new Set(),
				count: 0
			};
			bucket.count += 1;
			const modelMatch = lesson.lesson.match(/模型\s+(\S+)/);
			if (modelMatch) bucket.modelIds.add(modelMatch[1]);
			byKey.set(key, bucket);
		}
		for (const [, bucket] of byKey) {
			if (bucket.count < 2) continue;
			for (const modelId of bucket.modelIds) {
				const conditions = [{
					dimension: "task-type",
					operator: "eq",
					value: bucket.taskType
				}, {
					dimension: "root-cause",
					operator: "eq",
					value: bucket.rootCause
				}];
				const avoidAction = bucket.rootCause === "timeout" ? {
					type: "avoid-model",
					params: { model: modelId },
					rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次超时，应规避`
				} : {
					type: "avoid-model",
					params: { model: modelId },
					rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次能力不足，应换模型`
				};
				result.push({
					id: this.stableId("proc-refl", bucket.taskType, bucket.rootCause, modelId),
					kind: "reflection",
					name: `${bucket.taskType} ${bucket.rootCause} 时规避模型 ${modelId}`,
					taskTypes: [bucket.taskType],
					conditions,
					action: avoidAction,
					confidence: Math.min(.85, .5 + bucket.count * .1),
					supportCount: bucket.count,
					sourceFingerprints: [],
					distilledAt: now,
					appliedTotal: 0,
					appliedSuccesses: 0
				});
			}
		}
		return result;
	}
	/** 从模式指纹提取 taskType（首段，去除 [失败] 前缀） */
	extractTaskType(pattern) {
		return pattern.fingerprint.split("::")[0]?.replace(/^\[失败\]\s*/, "") || "general";
	}
	/** 构建蒸馏报告摘要 */
	buildDistillationSummary(sourceCount, semantic, procedural, strategies) {
		return [
			`知识蒸馏完成：来源情景记忆 ${sourceCount} 条`,
			`产出语义记忆 ${semantic.length} 条${semantic.length > 0 ? `（${semantic.map((m) => m.statement).join("；")}）` : ""}`,
			`产出程序记忆 ${procedural.length} 条${procedural.length > 0 ? `（${procedural.map((p) => p.name).join("；")}）` : ""}`,
			`产出蒸馏策略 ${strategies.length} 条（兼容）`
		].join("\n");
	}
	/** 经验沉淀：成功方案 / 失败记录写入记忆库并登记同步变更 */
	settleExperience(signal, plan, result) {
		const taskType = plan.nodes[0]?.type ?? signal.type;
		const complexity = Math.min(1, plan.nodes.length / 5);
		const features = [...new Set(plan.nodes.map((n) => n.type))];
		const taskSummary = signal.description;
		if (result.success) {
			const modelAssignments = {};
			const qualityScores = {};
			for (const nodeResult of result.nodeResults) {
				modelAssignments[nodeResult.nodeId] = nodeResult.modelId;
				qualityScores[nodeResult.nodeId] = nodeResult.quality;
			}
			this.memory.recordSuccess({
				taskType,
				complexity,
				features,
				taskSummary,
				plan: {
					objective: plan.objective,
					nodes: plan.nodes.map((n) => ({
						id: n.id,
						description: n.description,
						type: n.type,
						dependsOn: n.dependsOn
					})),
					parallelismStrategy: plan.parallelismStrategy
				},
				modelAssignments,
				totalLatency: result.totalTime,
				qualityScores,
				tokenCost: result.totalTokens
			});
			this.onMemoryChange?.("pattern-updated", fingerprintOf$1(taskType, complexity), {
				taskType,
				complexity,
				outcome: "success"
			});
		} else {
			const failed = result.nodeResults.find((r) => !r.success);
			this.memory.recordFailure({
				taskType,
				complexity,
				features,
				reason: failed?.error ?? "计划执行失败",
				failedNodeId: failed?.nodeId ?? "unknown",
				failedModelId: failed?.modelId ?? "unknown",
				errorMessage: failed?.error ?? "unknown"
			});
			this.onMemoryChange?.("pattern-updated", fingerprintOf$1(taskType, complexity), {
				taskType,
				complexity,
				outcome: "failure"
			});
		}
	}
	/** 进度事件广播（enableProgress 关闭或 broadcaster 缺省时为空操作） */
	broadcast(event) {
		if (this.config.enableProgress === false || !this.broadcaster) return;
		this.broadcaster.broadcast({
			type: event.type,
			timestamp: Date.now(),
			...event
		});
	}
};
/** 任务指纹（taskType + complexity 分档，同步变更登记的稳定键） */
function fingerprintOf$1(taskType, complexity) {
	return crypto.createHash("sha256").update(`${taskType}:${Math.round(complexity * 10)}`).digest("hex").slice(0, 16);
}
//#endregion
//#region src/dashboard/index.ts
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
/**
* 将仪表盘挂载到进度广播器的 HTTP 端口
* @param broadcaster 已创建的进度广播器（须在 start() 之前或之后调用均可）
* @param getModelStatuses 模型状态提供函数（通常绑定 LLMClient.getModelStatuses）
* @returns 卸载函数（恢复默认健康检查响应）
*/
function attachDashboard(broadcaster, getModelStatuses) {
	const html = loadDashboardHtml();
	broadcaster.setHttpHandler((req, res) => {
		const url = (req.url ?? "/").split("?")[0];
		if (req.method === "GET" && (url === "/" || url === "/index.html")) {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-cache"
			});
			res.end(html);
			return true;
		}
		if (req.method === "GET" && url === "/api/model-status") {
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Cache-Control": "no-cache"
			});
			res.end(JSON.stringify(getModelStatuses()));
			return true;
		}
		return false;
	});
	return () => broadcaster.setHttpHandler(null);
}
/** 读取仪表盘页面（优先 dist 打包路径，回退 src 源码路径） */
function loadDashboardHtml() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(here, "index.html"),
		path.join(here, "..", "..", "src", "dashboard", "index.html"),
		path.join(here, "..", "src", "dashboard", "index.html")
	];
	for (const candidate of candidates) try {
		if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
	} catch {}
	return "<html><body><h1>dashboard 页面未找到</h1></body></html>";
}
//#endregion
//#region src/decision-engine.ts
/**
* decision-engine.ts — 战略决策引擎（闭环"决策"环节深度优化）
*
* 职责：在 strategist LLM 决策之上构建四级决策流水线，
* 让高频/已知信号以近零成本、近零延迟获得决策，LLM 只处理真正的新信号。
*
* 四级流水线（命中即返回，逐级下沉）：
* 1. 规则快速路径（rule）：确定性强的高置信规则
*    - 重复抑制：同指纹信号在抑制窗口内已成功执行 → dismiss（避免重复劳动）
*    - 失败升级：同类型连续失败 ≥ N 次 → ask-user（止损，防止无效重试循环）
*    - 突发提权：occurrences 突发放大 → 提升 urgency
* 2. 决策缓存（cache）：同指纹信号的历史决策复用（TTL + 结果反馈修正置信度）
* 3. strategist 模型（strategist）：新信号交给 LLM 决策（注入历史统计上下文）
* 4. 启发式兜底（heuristic）：strategist 失败时的保守决策
*
* 升级点（相对裸 LLM 决策的质的提升）：
* 1. 成本/影响估算：基于长期记忆的 avgExecutionTime / tokenCost 预估执行成本，
*    高成本 + 低紧急度 → 自动 defer，把算力留给关键任务
* 2. 置信度评分：每个决策携带 confidence，低于阈值自动升级为 ask-user
* 3. 结果反馈闭环：recordOutcome 依据实际结果修正缓存置信度与规则计数器，
*    决策系统随运行时间自我校准
* 4. 决策审计：保留最近决策记录，可追溯每个决策的来源与理由
*/
/** 默认配置 */
const DEFAULT_DECISION_ENGINE_CONFIG = {
	cacheTtlMs: 6e5,
	cacheMaxSize: 512,
	suppressionWindowMs: 3e5,
	failureEscalationThreshold: 3,
	lowConfidenceThreshold: .4,
	costDeferRatio: 3,
	burstOccurrences: 5
};
/** outcome → 决策质量数值 */
const OUTCOME_VALUE = {
	excellent: 1,
	good: .8,
	acceptable: .6,
	poor: .3,
	failed: 0
};
/**
* 战略决策引擎
*
* 被 index.ts 编排层持有：processBatch 的第 3~4 步由本引擎完成。
*/
var DecisionEngine = class {
	config;
	cache = /* @__PURE__ */ new Map();
	/** 类型 → 连续失败计数 */
	consecutiveFailures = /* @__PURE__ */ new Map();
	/** 指纹 → 最近成功执行时间（重复抑制用） */
	recentSuccess = /* @__PURE__ */ new Map();
	/** 决策审计环形缓冲 */
	audit = [];
	stats = {
		total: 0,
		ruleHits: 0,
		cacheHits: 0,
		strategistCalls: 0,
		heuristicFallbacks: 0
	};
	constructor(config) {
		this.config = {
			...DEFAULT_DECISION_ENGINE_CONFIG,
			...config
		};
	}
	/**
	* 对一批信号做决策（四级流水线）
	* @param signals 聚合后的信号批次
	* @param history 每类信号的历史统计（长期记忆提供）
	* @returns signalId → Decision
	*/
	async decide(signals, history) {
		const results = /* @__PURE__ */ new Map();
		const needStrategist = [];
		for (const signal of signals) {
			const fingerprint = fingerprintOf(signal);
			const ruleDecision = this.applyRules(signal, fingerprint, history.get(signal.type));
			if (ruleDecision) {
				this.stats.ruleHits += 1;
				results.set(signal.id, ruleDecision);
				this.auditDecision(signal, fingerprint, ruleDecision);
				continue;
			}
			const cached = this.lookupCache(fingerprint);
			if (cached) {
				this.stats.cacheHits += 1;
				results.set(signal.id, cached);
				this.auditDecision(signal, fingerprint, cached);
				continue;
			}
			needStrategist.push(signal);
		}
		if (needStrategist.length > 0) {
			this.stats.strategistCalls += 1;
			let verdicts = /* @__PURE__ */ new Map();
			if (this.config.strategist) try {
				verdicts = await this.config.strategist(needStrategist, history);
			} catch {}
			for (const signal of needStrategist) {
				const fingerprint = fingerprintOf(signal);
				const verdict = verdicts.get(signal.id);
				const stats = history.get(signal.type);
				const decision = verdict ? this.fromStrategist(signal, verdict, stats) : this.heuristic(signal, stats);
				if (!verdict) this.stats.heuristicFallbacks += 1;
				this.storeCache(fingerprint, decision);
				results.set(signal.id, decision);
				this.auditDecision(signal, fingerprint, decision);
			}
		}
		this.stats.total += signals.length;
		return results;
	}
	/**
	* 结果反馈闭环：依据执行结果修正缓存置信度与规则计数器
	* @param signalType 信号类型
	* @param fingerprint 信号指纹（缺省按 type+description 计算需提供 description）
	* @param outcome 执行结果
	*/
	recordOutcome(signalType, fingerprint, outcome) {
		if (outcome === "failed" || outcome === "poor") this.consecutiveFailures.set(signalType, (this.consecutiveFailures.get(signalType) ?? 0) + 1);
		else this.consecutiveFailures.set(signalType, 0);
		if (outcome === "excellent" || outcome === "good") {
			this.recentSuccess.set(fingerprint, Date.now());
			this.trimRecentSuccess();
		}
		const entry = this.cache.get(fingerprint);
		if (entry) {
			const value = OUTCOME_VALUE[outcome ?? "acceptable"] ?? .6;
			entry.adjustedConfidence = entry.adjustedConfidence * .7 + value * .3;
			entry.decision.confidence = entry.adjustedConfidence;
			if (entry.adjustedConfidence < .2) this.cache.delete(fingerprint);
		}
		for (let i = this.audit.length - 1; i >= 0; i -= 1) if (this.audit[i].fingerprint === fingerprint && !this.audit[i].outcome) {
			this.audit[i].outcome = outcome;
			break;
		}
	}
	/** 计算信号指纹（对外暴露，供编排层沉淀反馈时使用） */
	fingerprint(signal) {
		return fingerprintOf(signal);
	}
	/**
	* 运行时配置热更新（策略进化引擎的基因组落地入口）
	* @param patch 配置补丁（仅覆盖提供的字段，strategist 回调不可经此修改）
	*/
	updateConfig(patch) {
		this.config = {
			...this.config,
			...patch
		};
	}
	/** 当前配置快照（不含 strategist 回调） */
	getConfig() {
		const { strategist: _strategist, ...rest } = this.config;
		return { ...rest };
	}
	/** 决策引擎运行统计 */
	getStats() {
		return {
			...this.stats,
			cacheSize: this.cache.size,
			cacheHitRate: this.stats.total > 0 ? this.stats.cacheHits / this.stats.total : 0,
			ruleHitRate: this.stats.total > 0 ? this.stats.ruleHits / this.stats.total : 0,
			consecutiveFailures: Object.fromEntries(this.consecutiveFailures)
		};
	}
	/** 最近决策审计记录 */
	getAudit(limit = 20) {
		return this.audit.slice(-limit);
	}
	/** 清空缓存与计数器（测试/重置用） */
	reset() {
		this.cache.clear();
		this.consecutiveFailures.clear();
		this.recentSuccess.clear();
		this.audit = [];
	}
	/** 第 1 级：规则快速路径 */
	applyRules(signal, fingerprint, stats) {
		const now = Date.now();
		const lastSuccess = this.recentSuccess.get(fingerprint);
		if (lastSuccess && now - lastSuccess < this.config.suppressionWindowMs) return {
			action: "dismiss",
			urgency: .1,
			confidence: .9,
			reason: `重复抑制：${Math.round((now - lastSuccess) / 1e3)}s 前同指纹任务已成功执行`,
			source: "rule",
			decidedAt: now
		};
		const failures = this.consecutiveFailures.get(signal.type) ?? 0;
		if (failures >= this.config.failureEscalationThreshold) return {
			action: "ask-user",
			urgency: .7,
			confidence: .85,
			reason: `类型 ${signal.type} 已连续失败 ${failures} 次，升级人工介入`,
			source: "rule",
			decidedAt: now
		};
		if (stats && stats.avgTokenCost > 0 && signal.urgency !== void 0) {
			const estimatedCost = stats.avgTokenCost;
			if (signal.urgency < .3 && estimatedCost > 5e3) return {
				action: "defer",
				urgency: signal.urgency,
				confidence: .7,
				reason: `高成本任务（约 ${estimatedCost} tokens）且紧急度低，延迟到空闲期`,
				source: "rule",
				deferMs: 3e5,
				estimatedCost,
				decidedAt: now
			};
		}
		return null;
	}
	/** 第 2 级：缓存查询（校验 TTL 与置信度） */
	lookupCache(fingerprint) {
		const entry = this.cache.get(fingerprint);
		if (!entry) return null;
		if (Date.now() - entry.decision.decidedAt > this.config.cacheTtlMs) {
			this.cache.delete(fingerprint);
			return null;
		}
		if (entry.adjustedConfidence < this.config.lowConfidenceThreshold) return null;
		entry.hits += 1;
		return {
			...entry.decision,
			source: "cache",
			confidence: entry.adjustedConfidence,
			decidedAt: Date.now()
		};
	}
	/** 缓存写入（LRU 淘汰） */
	storeCache(fingerprint, decision) {
		if (this.cache.size >= this.config.cacheMaxSize) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== void 0) this.cache.delete(oldest);
		}
		this.cache.set(fingerprint, {
			decision,
			hits: 0,
			adjustedConfidence: decision.confidence
		});
	}
	/** 第 3 级：strategist 裁定 → Decision（含置信度与低置信升级） */
	fromStrategist(signal, verdict, stats) {
		let confidence = .65 + (stats ? Math.min(.2, stats.totalDecisions * .02) : 0);
		let action = verdict.decision;
		let urgency = Math.max(0, Math.min(1, verdict.urgency));
		if (signal.occurrences >= this.config.burstOccurrences) urgency = Math.min(1, urgency + .2);
		const estimatedCost = stats?.avgTokenCost;
		if (confidence < this.config.lowConfidenceThreshold && action === "execute") action = "ask-user";
		return {
			action,
			urgency,
			confidence,
			reason: verdict.reason ?? "strategist 决策",
			source: "strategist",
			deferMs: verdict.deferMs,
			estimatedCost,
			decidedAt: Date.now()
		};
	}
	/** 第 4 级：启发式兜底（保守执行） */
	heuristic(signal, stats) {
		return {
			action: "execute",
			urgency: Math.min(1, .5 + signal.occurrences * .1),
			confidence: .5,
			reason: "strategist 不可用，启发式兜底",
			source: "heuristic",
			estimatedCost: stats?.avgTokenCost,
			decidedAt: Date.now()
		};
	}
	/** 审计记录（环形缓冲上限 200） */
	auditDecision(signal, fingerprint, decision) {
		this.audit.push({
			signalId: signal.id,
			fingerprint,
			decision
		});
		if (this.audit.length > 200) this.audit.shift();
	}
	/** 清理过期的重复抑制记录 */
	trimRecentSuccess() {
		const cutoff = Date.now() - this.config.suppressionWindowMs;
		for (const [key, ts] of this.recentSuccess) if (ts < cutoff) this.recentSuccess.delete(key);
	}
};
/** 信号指纹：type + 归一化描述 */
function fingerprintOf(signal) {
	const normalized = signal.description.toLowerCase().replace(/\s+/g, " ").trim();
	return crypto.createHash("sha256").update(`${signal.type}:${normalized}`).digest("hex").slice(0, 16);
}
//#endregion
//#region src/reflection-engine.ts
/** 默认配置 */
const DEFAULT_REFLECTION_CONFIG = {
	qualityThreshold: .7,
	calibrationMinSamples: 10,
	calibrationStep: .02,
	thresholdRange: [.5, .95],
	trendWindowSize: 20,
	declineAlertCount: 3
};
/**
* 质量反思引擎
*
* 被 index.ts 持有：executor 执行完成后调用 reflect() 进行深度反思，
* 失败时调用 extractLesson() 沉淀教训，阈值通过 getCurrentThreshold() 动态获取。
*/
var ReflectionEngine = class {
	config;
	lessons = [];
	trendWindow = [];
	/** 各任务类型的质量历史（用于自校准；带时间戳支持衰减均值） */
	qualityHistory = /* @__PURE__ */ new Map();
	/** 当前动态阈值 */
	currentThreshold;
	/** 告警回调（由 index.ts 桥接到进度广播） */
	onAlert;
	lessonCounter = 0;
	/** 5.0：因果内核（挂载后失败反思自动触发反事实分析） */
	causal;
	constructor(config) {
		this.config = {
			...DEFAULT_REFLECTION_CONFIG,
			...config
		};
		this.currentThreshold = this.config.qualityThreshold;
	}
	/** 设置告警回调 */
	setAlertHandler(handler) {
		this.onAlert = handler;
	}
	/** 5.0：挂载因果内核（幂等） */
	attachCausalKernel(kernel) {
		this.causal = kernel;
	}
	/**
	* 5.0：反事实分析 —— 失败后的「若选 B」推理。
	*
	* 对每个候选替代模型查询因果内核：do(use:B) → task.outcome 的
	* 后验成功概率（黄金口径：仅干预证据 ≥ 3 时采信，观测证据降权），
	* 返回最优替代与可读结论。
	*
	* 质变点：教训从「A 超时了」升级为「A 超时了；若当时用 B，
	* 成功概率 0.78 [0.62, 0.91]（12 次干预证据）」——
	* 下次调度的切换决策第一次有了反事实依据。
	*
	* @param outcomeNode 因果图的结果节点（默认 'task.outcome'）
	*/
	reflectCounterfactual(params) {
		if (!this.causal || params.alternativeModelIds.length === 0) return null;
		const outcome = params.outcomeNode ?? "task.outcome";
		let best = null;
		for (const alt of params.alternativeModelIds) {
			if (alt === params.failedModelId) continue;
			const cf = this.causal.counterfactual(outcome, params.failedModelId, alt, params.actualSuccess);
			if (!best || cf.estimatedProb > best.estimatedProb) best = {
				actualModel: params.failedModelId,
				bestAlternative: alt,
				estimatedProb: cf.estimatedProb,
				lower: cf.lower,
				upper: cf.upper,
				verdict: cf.verdict,
				evidenceSamples: cf.evidenceSamples
			};
		}
		return best;
	}
	/**
	* 对单个节点输出做深度反思
	* @param params 节点输出与上下文
	* @returns 反思结论
	*/
	async reflect(params) {
		let quality = params.baseQuality;
		let dimensions;
		if (this.config.judge) try {
			const judged = await this.config.judge({
				taskDescription: params.node.description,
				output: params.output,
				taskType: params.node.type
			});
			quality = judged.score * .7 + params.baseQuality * .3;
			dimensions = {
				completeness: judged.completeness,
				correctness: judged.correctness,
				maintainability: judged.maintainability,
				comment: judged.comment
			};
		} catch {}
		const passed = quality >= this.currentThreshold;
		const retryAdvice = this.adviseRetry(params.node.type, quality, passed);
		return {
			quality,
			passed,
			retryAdvice,
			reason: passed ? `质量 ${quality.toFixed(2)} ≥ 动态阈值 ${this.currentThreshold.toFixed(2)}` : `质量 ${quality.toFixed(2)} < 动态阈值 ${this.currentThreshold.toFixed(2)}，建议 ${retryAdvice}`,
			dimensions
		};
	}
	/**
	* 从失败执行中提取教训（异步，失败不阻塞主流程）
	* @param params 失败上下文
	* @returns 提取的教训
	*/
	async extractLesson(params) {
		const failed = params.result.nodeResults.find((r) => !r.success);
		if (!failed) return null;
		let rootCause = "unknown";
		let lesson = "";
		let suggestion = "";
		if (this.config.lessonExtractor) try {
			const extracted = await this.config.lessonExtractor({
				signalDescription: params.signal.description,
				taskType: params.taskType,
				errorMessage: failed.error ?? "",
				failedNodeId: failed.nodeId,
				failedModelId: failed.modelId
			});
			rootCause = extracted.rootCause;
			lesson = extracted.lesson;
			suggestion = extracted.suggestion;
		} catch {}
		if (!lesson) {
			const err = (failed.error ?? "").toLowerCase();
			if (err.includes("超时") || err.includes("timeout")) {
				rootCause = "timeout";
				lesson = `任务类型 ${params.taskType} 在模型 ${failed.modelId} 上超时`;
				suggestion = "增大节点超时或拆分任务粒度";
			} else if (err.includes("质量不达标")) {
				rootCause = "model-capability";
				lesson = `模型 ${failed.modelId} 对 ${params.taskType} 类任务质量不足（重试 ${failed.attempts} 次未达标）`;
				suggestion = "切换到该任务类型能力更强的模型";
			} else if (err.includes("依赖")) {
				rootCause = "dependency";
				lesson = `上游依赖产出异常导致节点 ${failed.nodeId} 失败`;
				suggestion = "检查上游节点质量或增加依赖校验";
			} else {
				rootCause = "transient";
				lesson = `节点 ${failed.nodeId} 执行失败: ${failed.error ?? "未知"}`;
				suggestion = "重试或检查瞬时故障";
			}
		}
		const record = {
			id: `lesson-${++this.lessonCounter}`,
			timestamp: Date.now(),
			taskType: params.taskType,
			rootCause,
			lesson,
			suggestion,
			signalDescription: params.signal.description
		};
		if (this.causal && rootCause === "model-capability") {
			const alternatives = [...new Set(params.result.nodeResults.map((r) => r.modelId).filter(Boolean))].filter((m) => m && m !== failed.modelId);
			const cf = this.reflectCounterfactual({
				failedModelId: failed.modelId ?? "",
				alternativeModelIds: alternatives,
				actualSuccess: false
			});
			if (cf) {
				record.counterfactual = cf;
				if (cf.evidenceSamples >= 4 && cf.estimatedProb >= .6) record.suggestion = `反事实证据：切换到 ${cf.bestAlternative}（估计成功概率 ${cf.estimatedProb.toFixed(2)}，区间 [${cf.lower.toFixed(2)}, ${cf.upper.toFixed(2)}]，${cf.evidenceSamples} 证据样本）`;
				else record.suggestion = `${record.suggestion}；反事实证据不足（${cf.evidenceSamples} 样本），建议对 ${cf.bestAlternative} 安排因果实验`;
			}
		}
		this.lessons.push(record);
		if (this.lessons.length > 100) this.lessons.shift();
		return record;
	}
	/**
	* 记录一次执行结果到趋势窗口并触发自校准
	* @param taskType 任务类型
	* @param quality 平均质量分
	* @param success 是否成功
	*/
	recordExecution(taskType, quality, success) {
		this.trendWindow.push({
			timestamp: Date.now(),
			taskType,
			avgQuality: quality,
			success
		});
		if (this.trendWindow.length > this.config.trendWindowSize) this.trendWindow.shift();
		const history = this.qualityHistory.get(taskType) ?? [];
		history.push({
			quality,
			at: Date.now()
		});
		if (history.length > 50) history.shift();
		this.qualityHistory.set(taskType, history);
		this.checkDeclineAlert(taskType, history);
		this.calibrateThreshold(taskType, history);
	}
	/** 当前动态质量阈值 */
	getCurrentThreshold() {
		return this.currentThreshold;
	}
	/** 设置质量阈值（元认知自调优落地入口，限制在允许范围内） */
	setQualityThreshold(value) {
		const [min, max] = this.config.thresholdRange;
		this.currentThreshold = Math.max(min, Math.min(max, value));
	}
	/** 获取指定任务类型的相关教训（供计划生成引用） */
	getLessons(taskType, limit = 5) {
		return this.lessons.filter((l) => l.taskType === taskType).slice(-limit);
	}
	/** 全部教训 */
	getAllLessons() {
		return [...this.lessons];
	}
	/**
	* 直接追加一条结构化教训（轻量入口，无需完整 PlanExecutionResult）。
	* 供宿主融合层等外部观测面在宿主工具连续失败时沉淀经验。
	* @param params 教训字段（id / timestamp 自动补齐）
	* @returns 追加的 Lesson
	*/
	addLesson(params) {
		const record = {
			id: `lesson-${++this.lessonCounter}`,
			timestamp: Date.now(),
			taskType: params.taskType,
			rootCause: params.rootCause,
			lesson: params.lesson,
			suggestion: params.suggestion,
			signalDescription: params.signalDescription
		};
		this.lessons.push(record);
		if (this.lessons.length > 100) this.lessons.shift();
		return record;
	}
	/** 质量趋势摘要 */
	getTrendSummary() {
		const byType = /* @__PURE__ */ new Map();
		for (const point of this.trendWindow) {
			const list = byType.get(point.taskType) ?? [];
			list.push(point);
			byType.set(point.taskType, list);
		}
		const summary = {};
		for (const [type, points] of byType) {
			const qualities = points.map((p) => p.avgQuality);
			summary[type] = {
				samples: points.length,
				avgQuality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
				successRate: points.filter((p) => p.success).length / points.length,
				trending: this.trendDirection(qualities)
			};
		}
		return {
			threshold: this.currentThreshold,
			windowSize: this.trendWindow.length,
			byType: summary
		};
	}
	/** 重试建议：依据教训库与根因判断 */
	adviseRetry(taskType, quality, passed) {
		if (passed) return "no-retry";
		if (quality < this.currentThreshold * .6) return "retry-switch";
		if (this.lessons.some((l) => l.taskType === taskType && l.rootCause === "model-capability")) return "retry-switch";
		return "retry-same";
	}
	/** 质量下滑告警检测 */
	checkDeclineAlert(taskType, history) {
		if (history.length < this.config.declineAlertCount + 1) return;
		const recent = history.slice(-this.config.declineAlertCount).map((h) => h.quality);
		let declining = true;
		for (let i = 1; i < recent.length; i += 1) if (recent[i] >= recent[i - 1]) {
			declining = false;
			break;
		}
		if (declining && this.onAlert) this.onAlert({
			type: "quality-decline",
			message: `任务类型 ${taskType} 质量连续 ${this.config.declineAlertCount} 次下滑（${recent.map((q) => q.toFixed(2)).join(" → ")}）`,
			taskType
		});
	}
	/**
	* 阈值自校准（4.0 证据化：时间衰减均值）
	*
	* 校准基准从裸算术均值升级为半衰期 30 天的时间加权均值——旧的
	* 质量分布（模型更强/更弱时期）自然让位，阈值始终锚定「当前能力」：
	* 分布整体偏高 → 收紧；偏低 → 放宽。
	*/
	calibrateThreshold(taskType, history) {
		if (history.length < this.config.calibrationMinSamples) return;
		const now = Date.now();
		let weighted = 0;
		let totalWeight = 0;
		for (const point of history) {
			const weight = decayFactor(Math.max(0, now - point.at));
			weighted += point.quality * weight;
			totalWeight += weight;
		}
		const avg = totalWeight > 0 ? weighted / totalWeight : .5;
		const [min, max] = this.config.thresholdRange;
		if (avg > this.currentThreshold + .15) this.currentThreshold = Math.min(max, this.currentThreshold + this.config.calibrationStep);
		else if (avg < this.currentThreshold - .15) this.currentThreshold = Math.max(min, this.currentThreshold - this.config.calibrationStep);
	}
	/** 趋势方向判断 */
	trendDirection(qualities) {
		if (qualities.length < 3) return "stable";
		const half = Math.floor(qualities.length / 2);
		const firstAvg = qualities.slice(0, half).reduce((a, b) => a + b, 0) / half;
		const secondAvg = qualities.slice(half).reduce((a, b) => a + b, 0) / (qualities.length - half);
		if (secondAvg - firstAvg > .05) return "rising";
		if (firstAvg - secondAvg > .05) return "falling";
		return "stable";
	}
};
//#endregion
//#region src/goal-engine.ts
/** 默认配置 */
const DEFAULT_GOAL_ENGINE_CONFIG = {
	minInsightSeverity: .4,
	maxActiveGoals: 5,
	maxSubtaskAttempts: 2,
	dedupeEnabled: true
};
/**
* 自主目标引擎
*
* 被 index.ts 持有：autonomy-loop 每轮心跳调用 generateGoalsFromInsights
* 产出目标，再将分解后的子任务注入哨兵执行，执行结果经
* recordSubtaskOutcome 回写进度，形成"洞察 → 目标 → 行动 → 达成"闭环。
*/
var GoalEngine = class {
	config;
	goals = /* @__PURE__ */ new Map();
	goalCounter = 0;
	subtaskCounter = 0;
	constructor(config) {
		this.config = {
			...DEFAULT_GOAL_ENGINE_CONFIG,
			...config
		};
	}
	/**
	* 从洞察批量生成目标（自主目标生成的核心入口）
	* @param insights 来自反思/元认知/记忆的洞察列表
	* @returns 新生成的目标（去重后）
	*/
	generateGoalsFromInsights(insights) {
		const created = [];
		const sorted = [...insights].filter((i) => i.severity >= this.config.minInsightSeverity).sort((a, b) => b.severity - a.severity);
		for (const insight of sorted) {
			if (this.activeGoalCount() >= this.config.maxActiveGoals) break;
			const title = this.titleFromInsight(insight);
			if (this.config.dedupeEnabled && this.isDuplicate(title)) continue;
			const impact = Math.min(1, .3 + insight.severity * .7);
			const confidence = insight.suggestion.length > 0 ? .7 : .4;
			const estimatedCost = 1;
			const goal = {
				id: `goal-${++this.goalCounter}`,
				title,
				description: `${insight.message}。改进方向：${insight.suggestion}`,
				origin: insight.source,
				insightRef: insight.message,
				status: "proposed",
				valueScore: this.computeValue(impact, confidence, estimatedCost),
				impact,
				confidence,
				estimatedCost,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				taskType: insight.taskType,
				subtasks: []
			};
			this.goals.set(goal.id, goal);
			created.push(goal);
		}
		return created;
	}
	/**
	* 分解目标为子任务（LLM 分解 + 规则兜底）
	* @param goalId 目标 id
	* @returns 分解出的子任务列表
	*/
	async decompose(goalId) {
		const goal = this.goals.get(goalId);
		if (!goal) return [];
		let steps = [];
		if (this.config.decomposer) try {
			steps = await this.config.decomposer(goal);
		} catch {}
		if (!Array.isArray(steps) || steps.length === 0) steps = [{
			description: goal.description,
			taskType: goal.taskType ?? "self-improvement"
		}];
		goal.subtasks = steps.slice(0, 8).map((step) => ({
			id: `subtask-${++this.subtaskCounter}`,
			description: step.description,
			taskType: step.taskType || goal.taskType || "self-improvement",
			status: "pending",
			attempts: 0
		}));
		goal.estimatedCost = goal.subtasks.length;
		goal.valueScore = this.computeValue(goal.impact, goal.confidence, goal.estimatedCost);
		goal.status = "active";
		goal.updatedAt = Date.now();
		return goal.subtasks;
	}
	/**
	* 选取下一个待执行子任务（价值最高目标优先，FIFO 次序）
	* @returns 目标与子任务，无待执行项时返回 null
	*/
	pickNextSubtask() {
		const activeGoals = [...this.goals.values()].filter((g) => (g.status === "active" || g.status === "in-progress") && g.subtasks.some((s) => s.status === "pending")).sort((a, b) => b.valueScore - a.valueScore);
		for (const goal of activeGoals) {
			const subtask = goal.subtasks.find((s) => s.status === "pending");
			if (subtask) return {
				goal,
				subtask
			};
		}
		return null;
	}
	/**
	* 标记子任务已派发（绑定执行信号）
	*/
	markDispatched(goalId, subtaskId, signalId) {
		const subtask = this.findSubtask(goalId, subtaskId);
		if (!subtask) return;
		subtask.status = "dispatched";
		subtask.signalId = signalId;
		subtask.attempts += 1;
		const goal = this.goals.get(goalId);
		if (goal) {
			goal.status = "in-progress";
			goal.updatedAt = Date.now();
		}
	}
	/**
	* 回写子任务执行结果（由编排层在信号执行完成后调用）
	* @returns 目标状态变化（completed / abandoned / null）
	*/
	recordSubtaskOutcome(goalId, subtaskId, success, result) {
		const goal = this.goals.get(goalId);
		const subtask = this.findSubtask(goalId, subtaskId);
		if (!goal || !subtask) return null;
		if (success) {
			subtask.status = "done";
			subtask.result = result;
		} else if (subtask.attempts >= this.config.maxSubtaskAttempts) {
			subtask.status = "failed";
			subtask.result = result ?? "重试耗尽";
		} else {
			subtask.status = "pending";
			subtask.signalId = void 0;
		}
		goal.updatedAt = Date.now();
		const allDone = goal.subtasks.every((s) => s.status === "done");
		const anyFailed = goal.subtasks.some((s) => s.status === "failed");
		if (allDone && goal.subtasks.length > 0) {
			goal.status = "completed";
			return "completed";
		}
		if (anyFailed && !goal.subtasks.some((s) => s.status === "pending" || s.status === "dispatched")) {
			goal.status = "abandoned";
			return "abandoned";
		}
		return null;
	}
	/** 通过信号 id 查找绑定的目标与子任务（执行完成回写用） */
	findBySignal(signalId) {
		for (const goal of this.goals.values()) {
			const subtask = goal.subtasks.find((s) => s.signalId === signalId);
			if (subtask) return {
				goal,
				subtask
			};
		}
		return null;
	}
	/** 活跃目标数（proposed / active / in-progress） */
	activeGoalCount() {
		return [...this.goals.values()].filter((g) => g.status === "proposed" || g.status === "active" || g.status === "in-progress").length;
	}
	/** 获取目标 */
	getGoal(goalId) {
		return this.goals.get(goalId);
	}
	/** 全部目标（按价值降序） */
	getAllGoals() {
		return [...this.goals.values()].sort((a, b) => b.valueScore - a.valueScore);
	}
	/** 目标进度摘要 */
	getSummary() {
		const goals = this.getAllGoals();
		return {
			total: goals.length,
			byStatus: goals.reduce((acc, g) => {
				acc[g.status] = (acc[g.status] ?? 0) + 1;
				return acc;
			}, {}),
			activeGoals: goals.filter((g) => g.status === "active" || g.status === "in-progress").map((g) => ({
				id: g.id,
				title: g.title,
				valueScore: Number(g.valueScore.toFixed(3)),
				progress: this.progressOf(g),
				subtasks: g.subtasks.map((s) => ({
					id: s.id,
					status: s.status,
					description: s.description
				}))
			}))
		};
	}
	/** 序列化（随长期记忆持久化） */
	serialize() {
		return this.getAllGoals();
	}
	/** 反序列化（恢复跨会话目标追求） */
	deserialize(goals) {
		this.goals.clear();
		let maxGoal = 0;
		let maxSubtask = 0;
		for (const goal of goals) {
			this.goals.set(goal.id, goal);
			const goalNum = Number(goal.id.split("-")[1] ?? 0);
			if (goalNum > maxGoal) maxGoal = goalNum;
			for (const subtask of goal.subtasks) {
				const subNum = Number(subtask.id.split("-")[1] ?? 0);
				if (subNum > maxSubtask) maxSubtask = subNum;
			}
		}
		this.goalCounter = maxGoal;
		this.subtaskCounter = maxSubtask;
	}
	/** 价值评估：impact × confidence / cost（成本至少为 1） */
	computeValue(impact, confidence, cost) {
		return impact * confidence / Math.max(1, cost);
	}
	/** 从洞察提炼目标标题 */
	titleFromInsight(insight) {
		return `${insight.taskType ? `[${insight.taskType}] ` : ""}${insight.suggestion}`.slice(0, 120);
	}
	/** 目标去重：归一化标题的包含关系判定 */
	isDuplicate(title) {
		const normalized = title.toLowerCase().trim();
		for (const goal of this.goals.values()) {
			if (goal.status === "completed" || goal.status === "abandoned") continue;
			const existing = goal.title.toLowerCase().trim();
			if (existing === normalized || existing.includes(normalized) || normalized.includes(existing)) return true;
		}
		return false;
	}
	/** 目标进度 0~1 */
	progressOf(goal) {
		if (goal.subtasks.length === 0) return 0;
		return goal.subtasks.filter((s) => s.status === "done").length / goal.subtasks.length;
	}
	/** 查找子任务 */
	findSubtask(goalId, subtaskId) {
		return this.goals.get(goalId)?.subtasks.find((s) => s.id === subtaskId);
	}
};
/** 从反思教训构建洞察（目标引擎与反思引擎的桥接） */
function lessonsToInsights(lessons) {
	return lessons.map((lesson) => ({
		source: "reflection",
		category: lesson.rootCause,
		taskType: lesson.taskType,
		severity: lesson.rootCause === "model-capability" || lesson.rootCause === "timeout" ? .7 : .5,
		message: lesson.lesson,
		suggestion: lesson.suggestion
	}));
}
//#endregion
//#region src/meta-cognition.ts
/** 默认配置 */
const DEFAULT_META_COGNITION_CONFIG = {
	windowSize: 20,
	zScoreThreshold: 2,
	successRateTarget: .8,
	qualityTarget: .7,
	degradeStreakThreshold: 3,
	modelHealthThreshold: .4,
	tuningCooldownMs: 3e4
};
/**
* 元认知监控引擎
*
* 被 index.ts 持有：autonomy-loop 每轮心跳采集 KPI 快照并调用 observe()，
* 引擎自动完成异常检测、参数调优与自愈洞察产出。
*/
var MetaCognitionEngine = class {
	config;
	history = [];
	anomalies = [];
	tuningHistory = [];
	/** 各 KPI 连续低于目标线的次数 */
	degradeStreaks = /* @__PURE__ */ new Map();
	lastTuningAt = 0;
	/** 5.0：因果内核（挂载后旋钮推荐按因果效应排序） */
	causal;
	/** 待结算的调参干预（动作 → 下一批 KPI 快照对账） */
	pendingTuningInterventions = [];
	constructor(config) {
		this.config = {
			...DEFAULT_META_COGNITION_CONFIG,
			...config
		};
	}
	/** 5.0：挂载因果内核（幂等） */
	attachCausalKernel(kernel) {
		this.causal = kernel;
	}
	/** 6.0：挂载自由能引擎（幂等；健康报告开始携带统一自由能 KPI） */
	attachFreeEnergyEngine(engine) {
		this.freeEnergyEngine = engine;
	}
	/** 7.0：挂载深思内核（梦校准 KPI 数据源；幂等） */
	attachDeliberationEngine(engine) {
		this.deliberationEngine = engine;
	}
	/** 8.0：挂载元推理内核（认知经济 KPI 数据源；幂等） */
	attachMetareasoner(reasoner) {
		this.metareasoner = reasoner;
	}
	/** 9.0：挂载抽象内核（抽象统计 KPI 数据源；幂等） */
	attachAbstractionEngine(engine) {
		this.abstractionEngine = engine;
	}
	/** 10.0：挂载科学家内核（知识前沿 KPI 数据源；幂等） */
	attachScientistMind(mind) {
		this.scientistMind = mind;
	}
	/** 11.0：挂载理论内核（理论前沿 KPI 数据源；幂等） */
	attachTheoristEngine(engine) {
		this.theoristEngine = engine;
	}
	freeEnergyEngine;
	theoristEngine;
	deliberationEngine;
	metareasoner;
	abstractionEngine;
	scientistMind;
	/**
	* 5.0：因果旋钮排序 —— 哪个旋钮真正导致了目标 KPI 的改善。
	*
	* 质变点：旧版 tryTune 是「if KPI 退化 then 固定规则调某旋钮」——
	* 规则命中顺序即优先级，与旋钮真实效果无关。挂载因果内核后，
	* 旋钮推荐改按 do-干预效应下界 × 置信度排序：调过且被实验证实
	* 有效的旋钮优先，混杂严重（观测相关但实验无效）的旋钮沉底。
	*
	* @param targetKpi 退化中的 KPI（如 'successRate'）
	*/
	rankTuningKnobs(targetKpi) {
		if (!this.causal) return [];
		return this.causal.rankCauses(`kpi:${targetKpi}`).filter((e) => e.from.startsWith("knob:"));
	}
	/**
	* 5.0：调参干预对账 —— 上次调参后 KPI 是否真的改善。
	*
	* 在 observe() 每批快照后自动调用：基线 → 干预后首个快照的比较
	* 结果作为 do-干预的 observedY 写回因果图（黄金证据闭环：
	* 调参 = 干预，下批 KPI = 实验结果，图更新 = 学习）。
	*/
	settleTuningInterventions(snapshot) {
		if (!this.causal || this.pendingTuningInterventions.length === 0) return;
		for (const pending of this.pendingTuningInterventions) {
			const current = snapshot[pending.kpi];
			if (!Number.isFinite(current)) continue;
			const improved = current >= pending.baseline;
			this.causal.intervene(`knob:${pending.action.parameter}`, `kpi:${pending.kpi}`, true, improved, "meta-cognition", `调参实验：${pending.action.parameter} ${pending.action.from} → ${pending.action.to}，观察 ${pending.kpi}`);
		}
		this.pendingTuningInterventions = [];
	}
	/** 登记待对账的调参干预（内部：动作落地后基线快照） */
	registerTuningIntervention(action, kpi, baseline) {
		this.pendingTuningInterventions.push({
			action,
			kpi,
			baseline
		});
		if (this.pendingTuningInterventions.length > 8) this.pendingTuningInterventions.shift();
	}
	/**
	* 观察一次 KPI 快照（元认知主入口）
	* @returns 本轮产出的自愈洞察（交给目标引擎）
	*/
	observe(snapshot) {
		this.history.push(snapshot);
		if (this.history.length > this.config.windowSize) this.history.shift();
		const insights = [];
		this.settleTuningInterventions(snapshot);
		if (this.history.length >= 5) {
			for (const kpi of [
				"successRate",
				"avgQuality",
				"cacheHitRate"
			]) {
				const anomaly = this.detectAnomaly(kpi, snapshot[kpi]);
				if (anomaly) this.anomalies.push(anomaly);
			}
			if (this.anomalies.length > 100) this.anomalies.splice(0, this.anomalies.length - 100);
		}
		insights.push(...this.checkDegradation(snapshot));
		insights.push(...this.checkModelHealth(snapshot));
		return insights;
	}
	/** 最近一次健康报告 */
	getHealthReport() {
		const latest = this.history[this.history.length - 1];
		if (!latest) return {
			healthy: true,
			score: 1,
			message: "暂无 KPI 数据",
			kpis: {}
		};
		const successScore = Math.min(1, latest.successRate / this.config.successRateTarget);
		const qualityScore = Math.min(1, latest.avgQuality / this.config.qualityTarget);
		const cacheScore = Math.min(1, latest.cacheHitRate / .3);
		const score = successScore * .5 + qualityScore * .35 + cacheScore * .15;
		return {
			healthy: score >= .7,
			score: Number(score.toFixed(3)),
			samples: this.history.length,
			kpis: {
				successRate: latest.successRate,
				avgQuality: latest.avgQuality,
				avgLatency: latest.avgLatency,
				cacheHitRate: latest.cacheHitRate
			},
			degradeStreaks: Object.fromEntries(this.degradeStreaks),
			recentAnomalies: this.anomalies.slice(-5),
			recentTuning: this.tuningHistory.slice(-5),
			freeEnergy: this.freeEnergyEngine ? (() => {
				const s = this.freeEnergyEngine.currentSurprisal();
				const interpretation = s < .35 ? "预测握力强：世界行为基本符合模型预期" : s < .7 ? "预测握力中等：部分结果出乎意料，模型在局部过时" : "预测握力弱：世界已漂移（惊讶持续偏高），建议触发世界模型重构或因果实验";
				return {
					surprisalEma: Number(s.toFixed(3)),
					samples: this.history.length,
					interpretation
				};
			})() : void 0,
			imagination: this.deliberationEngine ? (() => {
				const cal = this.deliberationEngine.currentCalibration() ?? 0;
				const settled = this.deliberationEngine.settledCount();
				const skills = this.deliberationEngine.allSkills().length;
				const interpretation = settled === 0 ? "尚未对账：想象力未经现实检验" : cal < .15 ? "梦境即现实：计划排练可信，深思搜索结论可靠" : cal < .3 ? "梦有偏差：想象部分失真，规划结论需保留怀疑" : "梦已失灵：想象与现实验重背离，先修转移模型再规划";
				return {
					calibrationEma: Number(cal.toFixed(3)),
					plansSettled: settled,
					skills,
					interpretation
				};
			})() : void 0,
			cognitiveEconomy: this.metareasoner ? this.metareasoner.cognitiveEconomy() : void 0,
			abstraction: this.abstractionEngine ? this.abstractionEngine.stats() : void 0,
			knowledgeFrontier: this.scientistMind ? this.scientistMind.knowledgeFrontier() : void 0,
			theoryFrontier: this.theoristEngine ? this.theoristEngine.frontier() : void 0
		};
	}
	/** 调优历史 */
	getTuningHistory() {
		return [...this.tuningHistory];
	}
	/** 异常历史 */
	getAnomalies() {
		return [...this.anomalies];
	}
	/** KPI 历史（只读快照） */
	getHistory() {
		return [...this.history];
	}
	/** z-score 异常检测 */
	detectAnomaly(kpi, value) {
		const series = this.history.slice(0, -1).map((s) => s[kpi]);
		if (series.length < 4) return null;
		const mean = series.reduce((a, b) => a + b, 0) / series.length;
		const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
		const std = Math.sqrt(variance);
		if (std < 1e-6) return null;
		const z = (value - mean) / std;
		if (Math.abs(z) < this.config.zScoreThreshold) return null;
		return {
			kpi,
			value,
			baseline: mean,
			zScore: Number(z.toFixed(2)),
			direction: z < 0 ? "degraded" : "improved",
			timestamp: Date.now()
		};
	}
	/** 退化检测：连续低于目标线 → 参数自调优 + 自愈洞察 */
	checkDegradation(snapshot) {
		const insights = [];
		const checks = [{
			kpi: "successRate",
			value: snapshot.successRate,
			target: this.config.successRateTarget
		}, {
			kpi: "avgQuality",
			value: snapshot.avgQuality,
			target: this.config.qualityTarget
		}];
		for (const check of checks) {
			const streak = check.value < check.target ? (this.degradeStreaks.get(check.kpi) ?? 0) + 1 : 0;
			this.degradeStreaks.set(check.kpi, streak);
			if (streak < this.config.degradeStreakThreshold) continue;
			const tuned = this.tryTune(check.kpi, check.value, check.target);
			if (tuned) {
				this.tuningHistory.push(tuned);
				this.config.applier?.(tuned);
				this.degradeStreaks.set(check.kpi, 0);
			} else insights.push({
				source: "meta-cognition",
				category: "kpi-degradation",
				severity: Math.min(1, .5 + streak * .1),
				message: `KPI ${check.kpi} 连续 ${streak} 次低于目标线（当前 ${check.value.toFixed(2)}，目标 ${check.target}）`,
				suggestion: check.kpi === "successRate" ? "排查高频失败任务类型并优化其执行策略" : "复盘低质量任务的计划生成与模型分配"
			});
		}
		return insights;
	}
	/**
	* 参数自调优策略
	*
	* 5.0 质变：挂载因果内核后，旋钮选择按因果证据而非规则命中顺序——
	* 1. rankTuningKnobs(kpi) 查询已确立的正因果旋钮（实验证实调它有效），
	*    有效应下界最高者优先，动作携带 causalBasis；
	* 2. 无因果证据时回退既有规则（零行为漂移）；
	* 3. 每次落地动作登记为待对账干预：下批 KPI 快照 = 实验读数，
	*    成败自动写回因果图（元认知从「调参」升级为「做实验」）。
	*/
	tryTune(kpi, value, target) {
		if (Date.now() - this.lastTuningAt < this.config.tuningCooldownMs) return null;
		let action = null;
		if (this.causal) {
			const bestKnob = this.rankTuningKnobs(kpi).find((e) => e.established && e.direction === "positive" && e.interventionalSamples >= 3);
			if (bestKnob) {
				const parameter = bestKnob.from.replace("knob:", "");
				action = {
					parameter,
					from: target,
					to: Number((target + (parameter === "maxRetries" ? 1 : .05)).toFixed(2)),
					reason: `因果证据优先：${parameter} 对 ${kpi} 的干预效应 ${bestKnob.ate.toFixed(2)} [${bestKnob.lower.toFixed(2)}, ${bestKnob.upper.toFixed(2)}]（${bestKnob.interventionalSamples} 次实验）`,
					timestamp: Date.now(),
					causalBasis: {
						ate: bestKnob.ate,
						lower: bestKnob.lower,
						confidence: bestKnob.confidence,
						interventionalSamples: bestKnob.interventionalSamples
					}
				};
			}
		}
		if (!action) {
			if (kpi === "successRate") {
				const relaxed = Math.max(.5, target - .05);
				if (relaxed < target) action = {
					parameter: "qualityThreshold",
					from: target,
					to: relaxed,
					reason: `成功率 ${value.toFixed(2)} 低于目标 ${target}，放宽质量阈值减少重试风暴`,
					timestamp: Date.now()
				};
			} else if (kpi === "avgQuality") action = {
				parameter: "maxRetries",
				from: 2,
				to: 3,
				reason: `平均质量 ${value.toFixed(2)} 低于目标 ${target}，增加重试次数`,
				timestamp: Date.now()
			};
		}
		if (action) {
			this.lastTuningAt = Date.now();
			this.registerTuningIntervention(action, kpi, value);
		}
		return action;
	}
	/** 模型健康度检查：单模型成功率过低 → 自愈洞察 */
	checkModelHealth(snapshot) {
		const insights = [];
		for (const [modelId, rate] of Object.entries(snapshot.modelSuccessRates)) {
			if (rate >= this.config.modelHealthThreshold) continue;
			insights.push({
				source: "meta-cognition",
				category: "model-unhealthy",
				severity: .8,
				message: `模型 ${modelId} 成功率仅 ${(rate * 100).toFixed(0)}%，低于健康线 ${(this.config.modelHealthThreshold * 100).toFixed(0)}%`,
				suggestion: `降低模型 ${modelId} 的任务分配权重，将其任务迁移至更健康的模型`
			});
		}
		return insights;
	}
};
//#endregion
//#region src/strategy-evolution.ts
/** 默认配置 */
const DEFAULT_STRATEGY_EVOLUTION_CONFIG = {
	populationSize: 6,
	explorationConstant: 1.4,
	mutationRate: .5,
	mutationStrength: .2,
	eliteCount: 2,
	minApplicationsBetweenEvolutions: 12,
	minApplicationsForElite: 3
};
/** 基因取值边界 */
const GENE_BOUNDS = {
	suppressionWindowMs: {
		min: 3e4,
		max: 9e5,
		integer: true
	},
	failureEscalationThreshold: {
		min: 1,
		max: 8,
		integer: true
	},
	lowConfidenceThreshold: {
		min: .2,
		max: .7,
		integer: false
	},
	costDeferRatio: {
		min: 1,
		max: 10,
		integer: false
	},
	burstOccurrences: {
		min: 2,
		max: 12,
		integer: true
	}
};
/** 基准基因组（决策引擎默认配置） */
const BASELINE_GENES = {
	suppressionWindowMs: 3e5,
	failureEscalationThreshold: 3,
	lowConfidenceThreshold: .4,
	costDeferRatio: 3,
	burstOccurrences: 5
};
/** outcome → 收益映射 */
const OUTCOME_REWARD = {
	excellent: 1,
	good: .8,
	acceptable: .6,
	poor: .3,
	failed: 0
};
/**
* 决策策略在线进化引擎
*
* 被 index.ts 持有：决策引擎每次决策前通过 selectGenome() 获取当前基因组
* （其基因作为决策引擎运行时参数），决策结果经 recordOutcome() 回写适应度，
* autonomy-loop 定期调用 evolve() 驱动种群进化。
*/
var StrategyEvolutionEngine = class {
	config;
	population = [];
	genomeCounter = 0;
	generation = 0;
	applicationsSinceEvolution = 0;
	evolutionHistory = [];
	rng;
	constructor(config) {
		this.config = {
			...DEFAULT_STRATEGY_EVOLUTION_CONFIG,
			...config
		};
		this.rng = this.config.rng ?? Math.random;
		this.seedPopulation();
	}
	/**
	* UCB1 选择当前基因组（探索-利用平衡；4.0 利用项 = 证据化适应度）
	*
	* 利用项与适应度同源（Wilson 下界 × 置信折扣），探索项保持 UCB1
	* 对数置信宽度——探索与利用在同一证据口径下平衡。
	* @returns 选中的基因组
	*/
	selectGenome() {
		const totalApplications = this.population.reduce((sum, g) => sum + g.applications, 0);
		let best = this.population[0];
		let bestScore = -Infinity;
		for (const genome of this.population) {
			if (genome.applications === 0) return genome;
			const score = this.fitness(genome) + this.config.explorationConstant * Math.sqrt(Math.log(totalApplications + 1) / genome.applications);
			if (score > bestScore) {
				bestScore = score;
				best = genome;
			}
		}
		return best;
	}
	/**
	* 回写决策结果（适应度反馈）
	* @param genomeId 基因组 id
	* @param outcome 决策执行后的实际结果
	*/
	recordOutcome(genomeId, outcome) {
		const genome = this.population.find((g) => g.id === genomeId);
		if (!genome) return;
		const reward = OUTCOME_REWARD[outcome] ?? .5;
		genome.applications += 1;
		genome.totalReward += reward;
		genome.meanReward = genome.totalReward / genome.applications;
		const now = Date.now();
		if (!genome.evidence) genome.evidence = initEvidence(0, 0, now);
		observeWeightedEvidence(genome.evidence, reward, now);
		this.applicationsSinceEvolution += 1;
	}
	/**
	* 触发一轮进化（精英保留 + 锦标赛选择 + 高斯变异）
	* @param force 强制进化（忽略最小应用次数门槛）
	* @returns 进化报告；未达门槛时返回 null
	*/
	evolve(force = false) {
		if (!force && this.applicationsSinceEvolution < this.config.minApplicationsBetweenEvolutions) return null;
		this.generation += 1;
		const ranked = [...this.population].sort((a, b) => this.fitness(b) - this.fitness(a));
		const elites = ranked.filter((g) => g.applications >= this.config.minApplicationsForElite).slice(0, this.config.eliteCount);
		const report = {
			generation: this.generation,
			elites: elites.map((g) => g.id),
			born: [],
			eliminated: [],
			bestMeanReward: ranked[0]?.meanReward ?? 0,
			populationMeanReward: this.populationMeanReward()
		};
		const survivors = ranked.filter((g) => !elites.includes(g));
		const eliminateCount = Math.max(1, this.config.populationSize - Math.max(elites.length, 1) - Math.floor(this.config.populationSize / 2));
		const eliminated = survivors.slice(-eliminateCount);
		report.eliminated = eliminated.map((g) => g.id);
		for (const dead of eliminated) {
			const parent = this.tournamentSelect(elites.length > 0 ? elites : ranked);
			const child = this.mutate(parent);
			const index = this.population.indexOf(dead);
			if (index >= 0) this.population[index] = child;
			else this.population.push(child);
			report.born.push(child.id);
		}
		while (this.population.length > this.config.populationSize) this.population.pop();
		this.applicationsSinceEvolution = 0;
		this.evolutionHistory.push(report);
		if (this.evolutionHistory.length > 50) this.evolutionHistory.shift();
		return report;
	}
	/** 最优基因组（应用次数达标者中平均收益最高） */
	bestGenome() {
		const eligible = this.population.filter((g) => g.applications >= this.config.minApplicationsForElite);
		return [...eligible.length > 0 ? eligible : this.population].sort((a, b) => this.fitness(b) - this.fitness(a))[0];
	}
	/** 最优基因组 → 决策引擎配置片段（进化产物落地） */
	bestGenesAsConfig() {
		return { ...this.bestGenome().genes };
	}
	/** 种群报告 */
	getReport() {
		return {
			generation: this.generation,
			populationSize: this.population.length,
			applicationsSinceEvolution: this.applicationsSinceEvolution,
			populationMeanReward: Number(this.populationMeanReward().toFixed(3)),
			genomes: [...this.population].sort((a, b) => this.fitness(b) - this.fitness(a)).map((g) => ({
				id: g.id,
				generation: g.generation,
				applications: g.applications,
				meanReward: Number(g.meanReward.toFixed(3)),
				genes: g.genes
			})),
			bestGenome: this.bestGenome().id,
			recentEvolutions: this.evolutionHistory.slice(-5)
		};
	}
	/** 进化历史 */
	getEvolutionHistory() {
		return [...this.evolutionHistory];
	}
	/** 初始种群：基准基因组 + 扰动变体 */
	seedPopulation() {
		this.population = [];
		this.population.push(this.createGenome({ ...BASELINE_GENES }, 0));
		for (let i = 1; i < this.config.populationSize; i += 1) {
			const baseline = this.createGenome({ ...BASELINE_GENES }, 0);
			this.population.push(this.mutate(baseline));
		}
	}
	/** 创建新基因组 */
	createGenome(genes, generation) {
		return {
			id: `genome-${++this.genomeCounter}`,
			genes,
			applications: 0,
			totalReward: 0,
			meanReward: 0,
			generation,
			createdAt: Date.now()
		};
	}
	/**
	* 适应度（4.0 证据化）：证据后验 Wilson 置信下界 × 小样本置信折扣
	*
	* 有时间加权证据的基因组用 Wilson 下界（小样本保守、防侥幸、旧结果
	* 自然衰减）；无证据（未观测/旧数据）回退 meanReward × 折扣。
	*/
	fitness(genome) {
		if (genome.applications === 0) return 0;
		const confidenceFactor = Math.min(1, genome.applications / this.config.minApplicationsForElite);
		if (genome.evidence) return wilsonLowerBound(genome.evidence.weightedSuccesses, genome.evidence.weightedFailures) * confidenceFactor;
		return genome.meanReward * confidenceFactor;
	}
	/** 锦标赛选择（3 选 1） */
	tournamentSelect(pool) {
		let winner = pool[Math.floor(this.rng() * pool.length)];
		for (let i = 0; i < 2; i += 1) {
			const challenger = pool[Math.floor(this.rng() * pool.length)];
			if (this.fitness(challenger) > this.fitness(winner)) winner = challenger;
		}
		return winner;
	}
	/** 高斯变异：按变异概率逐基因扰动 */
	mutate(parent) {
		const genes = { ...parent.genes };
		for (const key of Object.keys(GENE_BOUNDS)) {
			if (this.rng() > this.config.mutationRate) continue;
			const bounds = GENE_BOUNDS[key];
			const range = bounds.max - bounds.min;
			const noise = (this.rng() + this.rng() - 1) * this.config.mutationStrength * range;
			let value = genes[key] + noise;
			value = Math.max(bounds.min, Math.min(bounds.max, value));
			genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
		}
		return this.createGenome(genes, this.generation);
	}
	/** 种群平均收益 */
	populationMeanReward() {
		const applied = this.population.filter((g) => g.applications > 0);
		if (applied.length === 0) return 0;
		return applied.reduce((sum, g) => sum + g.meanReward, 0) / applied.length;
	}
};
//#endregion
//#region src/autonomy-loop.ts
/** 默认配置 */
const DEFAULT_AUTONOMY_LOOP_CONFIG = {
	heartbeatMs: 3e4,
	maxDispatchPerTick: 2,
	maintenanceEveryTicks: 10,
	metaCognitionEveryTicks: 7,
	maxGoalsPerTick: 3,
	enableStrategyEvolution: true,
	enableExploration: true,
	predictionHorizonMs: 3e5
};
/**
* 自主心跳循环
*
* 被 index.ts 持有：插件启动时 start()，fiber 卸载时 stop()。
* 测试可绕过定时器直接调用 tick() 驱动单轮心跳。
*/
var AutonomyLoop = class {
	config;
	goalEngine;
	metaCognition;
	evolution;
	collectKpi;
	dispatchSubtask;
	maintainer;
	lessonProvider;
	strategyApplier;
	/** 第三阶段：调度策略进化桥接（可选注入） */
	policyEvolution;
	/** 第四阶段：元认知环桥接（可选注入） */
	metaCognitionBridge;
	/** 第五阶段 Phase 2.5：共生进化桥接（可选注入，缺省不启用） */
	symbiosis;
	worldModel;
	curiosity;
	governor;
	dispatchExploration;
	timer = null;
	/** 重入保护：上一轮 tick 未完成时跳过新 tick */
	ticking = false;
	running = false;
	tickCount = 0;
	reports = [];
	/** 已消化过的教训 id（避免重复生成目标） */
	consumedLessons = /* @__PURE__ */ new Set();
	constructor(params) {
		this.config = {
			...DEFAULT_AUTONOMY_LOOP_CONFIG,
			...params.config
		};
		this.goalEngine = params.goalEngine;
		this.metaCognition = params.metaCognition;
		this.evolution = params.evolution;
		this.collectKpi = params.collectKpi;
		this.dispatchSubtask = params.dispatchSubtask;
		this.maintainer = params.maintainer;
		this.lessonProvider = params.lessonProvider;
		this.strategyApplier = params.strategyApplier;
		this.policyEvolution = params.policyEvolution;
		this.metaCognitionBridge = params.metaCognitionBridge;
		this.symbiosis = params.symbiosis;
		this.worldModel = params.worldModel;
		this.curiosity = params.curiosity;
		this.governor = params.governor;
		this.dispatchExploration = params.dispatchExploration;
	}
	/** 启动心跳定时器 */
	start() {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => {
			this.tick().catch(() => {});
		}, this.config.heartbeatMs);
		this.timer.unref?.();
	}
	/** 停止心跳 */
	stop() {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	/** 是否运行中 */
	isRunning() {
		return this.running;
	}
	/**
	* 执行一轮心跳（自主智能的核心节拍）
	*
	* 重入保护：心跳是异步长链路（目标分解 / 沙盒进化 / 元认知环都可能
	* 慢于 heartbeatMs），interval 触发的新 tick 与滞留中的旧 tick 并发
	* 会双重派发目标与探索、双重触发维护与进化——上一轮未完成时本轮
	* 直接跳过（返回空摘要，不推进计数）
	* @returns 本轮摘要
	*/
	async tick() {
		if (this.ticking) return {
			tick: this.tickCount,
			timestamp: Date.now(),
			insightsCollected: 0,
			goalsCreated: 0,
			subtasksDispatched: 0,
			explorationsDispatched: 0,
			governanceBlocked: 0,
			risingTrends: [],
			evolved: false,
			healthScore: 1
		};
		this.ticking = true;
		try {
			return await this.runTick();
		} finally {
			this.ticking = false;
		}
	}
	async runTick() {
		this.tickCount += 1;
		const report = {
			tick: this.tickCount,
			timestamp: Date.now(),
			insightsCollected: 0,
			goalsCreated: 0,
			subtasksDispatched: 0,
			explorationsDispatched: 0,
			governanceBlocked: 0,
			risingTrends: [],
			evolved: false,
			healthScore: 1
		};
		let insights = [];
		let kpiSnapshot;
		try {
			kpiSnapshot = this.collectKpi();
			insights = this.metaCognition.observe(kpiSnapshot);
			report.healthScore = this.metaCognition.getHealthReport().score ?? 1;
		} catch {}
		try {
			if (this.symbiosis && kpiSnapshot) {
				const driftInsights = await this.symbiosis.runSymbiosisTick(kpiSnapshot);
				insights.push(...driftInsights);
			}
		} catch {}
		try {
			if (this.worldModel) {
				const trends = this.worldModel.detectTrends();
				for (const trend of trends) {
					if (trend.trend !== "rising") continue;
					report.risingTrends.push(trend.type);
					insights.push({
						source: "meta-cognition",
						category: "load-forecast",
						taskType: trend.type,
						severity: .5,
						message: `世界模型预测「${trend.type}」信号到达率上升（斜率 ${trend.slopePerMin}/min²）`,
						suggestion: `为「${trend.type}」预留执行容量并优化其处理链路`
					});
				}
				this.worldModel.settleCalibrations();
			}
		} catch {}
		try {
			const lessons = this.lessonProvider();
			for (const lesson of lessons) {
				if (this.consumedLessons.has(lesson.id)) continue;
				this.consumedLessons.add(lesson.id);
				insights.push({
					source: "reflection",
					category: lesson.rootCause,
					taskType: lesson.taskType,
					severity: lesson.rootCause === "model-capability" || lesson.rootCause === "timeout" ? .7 : .5,
					message: lesson.lesson,
					suggestion: lesson.suggestion
				});
			}
		} catch {}
		report.insightsCollected = insights.length;
		try {
			const created = this.goalEngine.generateGoalsFromInsights(insights).slice(0, this.config.maxGoalsPerTick);
			report.goalsCreated = created.length;
			for (const goal of created) await this.goalEngine.decompose(goal.id);
		} catch {}
		try {
			for (let i = 0; i < this.config.maxDispatchPerTick; i += 1) {
				const picked = this.goalEngine.pickNextSubtask();
				if (!picked) break;
				if (this.governor) {
					if (!this.governor.govern("goal-dispatch", picked.goal.confidence).allowed) {
						report.governanceBlocked += 1;
						break;
					}
				}
				const signalId = this.dispatchSubtask(picked.subtask, picked.goal);
				this.goalEngine.markDispatched(picked.goal.id, picked.subtask.id, signalId);
				report.subtasksDispatched += 1;
			}
		} catch {}
		if (this.config.enableExploration && this.curiosity && this.dispatchExploration) try {
			const remainingSlots = Math.max(0, this.config.maxDispatchPerTick - report.subtasksDispatched);
			const proposals = this.curiosity.proposeExplorations(remainingSlots + 1, report.healthScore);
			for (const proposal of proposals) {
				if (this.governor) {
					if (!this.governor.govern("exploration", 1).allowed) {
						report.governanceBlocked += 1;
						break;
					}
				}
				this.dispatchExploration(proposal);
				report.explorationsDispatched += 1;
			}
		} catch {}
		if (this.config.enableStrategyEvolution) try {
			if (this.evolution.evolve()) {
				report.evolved = true;
				this.strategyApplier?.(this.evolution.bestGenesAsConfig());
			}
		} catch {}
		if (this.policyEvolution) try {
			await this.policyEvolution.runEvolutionCycle();
		} catch {}
		if (this.metaCognitionBridge && this.tickCount % this.config.metaCognitionEveryTicks === 0) try {
			await this.metaCognitionBridge.runMetaCycle();
		} catch {}
		if (this.tickCount % this.config.maintenanceEveryTicks === 0) try {
			const distilled = this.maintainer.distillExperience();
			const forgetting = this.maintainer.applyForgettingCurve();
			report.maintenance = {
				distilled,
				decayed: forgetting.decayed,
				forgotten: forgetting.forgotten
			};
			if (this.maintainer.distillKnowledge) try {
				const knowledge = await this.maintainer.distillKnowledge();
				report.maintenance.semanticDistilled = knowledge.semantic;
				report.maintenance.proceduralDistilled = knowledge.procedural;
			} catch {}
		} catch {}
		this.reports.push(report);
		if (this.reports.length > 100) this.reports.shift();
		return report;
	}
	/** 心跳历史 */
	getReports() {
		return [...this.reports];
	}
	/** 最近一轮摘要 */
	getLatestReport() {
		return this.reports[this.reports.length - 1];
	}
	/**
	* 自省报告（自主智能的全景自我认知）
	* 汇总心跳状态、健康度、目标进度、探索收获、治理状态、世界模型预测
	*/
	introspect() {
		return {
			loop: this.getStatus(),
			health: this.metaCognition.getHealthReport(),
			goals: this.goalEngine.getSummary(),
			exploration: this.curiosity?.getSummary() ?? null,
			governance: this.governor?.getStatus() ?? null,
			worldModel: this.worldModel?.getSummary() ?? null,
			evolution: this.evolution.getReport()
		};
	}
	/** 运行状态 */
	getStatus() {
		return {
			running: this.running,
			heartbeatMs: this.config.heartbeatMs,
			tickCount: this.tickCount,
			latest: this.getLatestReport()
		};
	}
};
//#endregion
//#region src/policy/policy-evolver.ts
/**
* policy-evolver.ts — 策略进化器（第三阶段质级升级：种群进化 + 金丝雀部署）
*
* 进化循环（变异/交叉 → 选择 → 保留）：
* 1. 变异与交叉 generateCandidates：以当前策略与种群精英（Hall of Fame）为
*    亲代，产出混合候选——高斯变异（自适应步长）、双亲交叉（标量均匀 + 
*    规则子集合并）、规则基因变异（增/删/改）、边界内探索者
* 2. 选择 evaluateCandidate + selectBest：每个候选经沙盒多种子统计评估
*    （历史回放 + 对抗任务），产出收益/风险/回归/LCB 四段式报告；
*    仅 deployable（gainLCB ≥ minGain 且零风险零回归）的候选可胜出
* 3. 保留 deployPolicy：胜出变体热切换到操作环（onDeploy 回调落地到
*    ModelScheduler / Optimizer，无需重启）；劣于当前策略的变体自然淘汰，
*    但精英进种群存档（优秀基因不因单轮失利丢失）
*
* 质级升级点：
* 1. 种群进化（1+λ + HoF）：从单亲盲变异升级为种群精英交叉——进化在
*    「当前最优」与「历史优秀基因库」之间重组，跳出局部最优
* 2. 自适应步长（1/5 法则）：近 10 轮部署成功率 > 20% 时放大变异强度
*    （×1.25 探索），否则收缩（×0.85 收敛），无需人工调参
* 3. 规则基因组变异：规则的增加/删除/修改三类变异 + 交叉合并，
*    策略空间从标量微调扩展为可组合调度程序
* 4. 金丝雀部署：新策略上线后进入观察窗，操作环真实结果回报
*    （reportOperationalOutcome）；成功率/质量劣化超阈自动回滚前一策略，
*    样本充足且无劣化则晋升正式——「沙盒通过」不再等于「永久上线」
*
* 可追溯性：每个策略携带 id / version / generation / parentId（交叉含
* secondaryParentId）/ origin / fitness；评估报告、部署历史、种群、金丝雀
* 状态全量持久化（JSON），支持任意时点审计进化链。
*/
const geneRecord = (params) => params;
/** 全部标量基因键 */
const SCALAR_GENE_KEYS = Object.keys(POLICY_GENE_BOUNDS);
/** 种群多样性半径：基因距离小于此值的个体视为近重复（适应度共享近似） */
const POLICY_DIVERSITY_RADIUS = .06;
/**
* 策略进化器（implements IPolicyEvolver）
*
* 被 index.ts 持有：autonomy-loop 进化段定期触发 runEvolutionCycle()，
* 或外部经 evolve_policy Tool 手动触发；deployPolicy 经 onDeploy 回调
* 热切换操作环（ModelScheduler.updatePolicy 等），金丝雀观察窗内由
* reportOperationalOutcome 持续接收操作环真实结果。
*/
var PolicyEvolver = class {
	config;
	current;
	/** 部署回滚栈：金丝雀失败时恢复 */
	previousPolicy;
	deployedHistory = [];
	/** 种群精英存档（Hall of Fame，按 fitness.score 降序） */
	population = [];
	evaluatedReports = /* @__PURE__ */ new Map();
	cycleReports = [];
	policyCounter = 0;
	totalCandidatesEvaluated = 0;
	totalCycles = 0;
	/** 自适应步长系数（1/5 法则驱动） */
	sigmaScale = 1;
	/** 近 10 轮部署成败窗口（自适应步长依据） */
	selectionWindow = [];
	/** 金丝雀观察窗（无活跃金丝雀为空） */
	canary;
	rng;
	evolving = false;
	constructor(config, baseline) {
		const { onDeploy, onCanaryDecision, onCycle, persistPath, rng, knownTaskTypes, ...rest } = config ?? {};
		this.config = {
			candidateCount: 6,
			mutationRate: .6,
			mutationStrength: .25,
			booleanFlipRate: .25,
			minGain: .02,
			populationSize: 6,
			crossoverRate: .34,
			ruleMutationRate: .3,
			explorerRate: .17,
			canaryMinSamples: 5,
			canaryPromoteSamples: 15,
			canarySuccessTolerance: .1,
			canaryQualityTolerance: .05,
			...rest,
			onDeploy,
			onCanaryDecision,
			onCycle,
			persistPath,
			rng,
			knownTaskTypes
		};
		this.rng = this.config.rng ?? Math.random;
		this.current = baseline ?? createBaselinePolicy();
		this.deployedHistory.push({
			...this.current,
			deployedAt: this.current.createdAt
		});
		this.loadPersisted();
		this.seedPopulation();
	}
	/** 当前生效策略（操作环据此调度） */
	getCurrentPolicy() {
		return {
			...this.current,
			params: cloneParams(this.current.params)
		};
	}
	/** 进化器状态报告 */
	getStatus() {
		return {
			currentPolicy: this.getCurrentPolicy(),
			deployedHistory: this.deployedHistory.map((p) => ({
				id: p.id,
				version: p.version,
				generation: p.generation,
				origin: p.origin,
				gain: p.gain,
				deployedAt: p.deployedAt ?? p.createdAt,
				rolledBackAt: p.rolledBackAt
			})),
			population: this.population.map((p) => ({
				id: p.id,
				origin: p.origin,
				generation: p.generation,
				fitnessScore: p.fitness?.score
			})),
			sigmaScale: Number(this.sigmaScale.toFixed(3)),
			canary: this.canary ? { ...this.canary } : void 0,
			totalCandidatesEvaluated: this.totalCandidatesEvaluated,
			totalCycles: this.totalCycles,
			lastCycle: this.cycleReports[this.cycleReports.length - 1]
		};
	}
	/** 种群精英（只读快照） */
	getPopulation() {
		return this.population.map((p) => ({
			...p,
			params: cloneParams(p.params)
		}));
	}
	/** 策略评估历史（policyId → 最近一次评估报告） */
	getEvaluationHistory() {
		return [...this.evaluatedReports.values()].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
	}
	/**
	* 运行时调参入口（第四阶段：元认知控制器调节进化机制本身）
	*
	* 仅接受数值类进化参数（mutationRate / minGain / candidateCount 等），
	* 回调与持久化路径不可经此变更；下一进化周期即按新参数运行。
	*/
	updateConfig(patch) {
		for (const key of [
			"candidateCount",
			"mutationRate",
			"mutationStrength",
			"booleanFlipRate",
			"minGain",
			"populationSize",
			"crossoverRate",
			"ruleMutationRate",
			"explorerRate",
			"canaryMinSamples",
			"canaryPromoteSamples",
			"canarySuccessTolerance",
			"canaryQualityTolerance"
		]) {
			const value = patch[key];
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				const target = this.config;
				target[key] = key === "populationSize" || key === "candidateCount" || key === "canaryMinSamples" || key === "canaryPromoteSamples" ? Math.max(1, Math.round(value)) : value;
			}
		}
		if (Array.isArray(patch.knownTaskTypes)) this.config.knownTaskTypes = patch.knownTaskTypes;
	}
	/** 数值进化参数快照（元认知旋钮 read 端；只读） */
	getTunableParams() {
		return {
			candidateCount: this.config.candidateCount,
			mutationRate: this.config.mutationRate,
			mutationStrength: this.config.mutationStrength,
			booleanFlipRate: this.config.booleanFlipRate,
			minGain: this.config.minGain,
			populationSize: this.config.populationSize,
			crossoverRate: this.config.crossoverRate,
			ruleMutationRate: this.config.ruleMutationRate,
			explorerRate: this.config.explorerRate,
			canaryMinSamples: this.config.canaryMinSamples,
			canaryPromoteSamples: this.config.canaryPromoteSamples,
			canarySuccessTolerance: this.config.canarySuccessTolerance,
			canaryQualityTolerance: this.config.canaryQualityTolerance
		};
	}
	/**
	* 变异与交叉：产出混合候选（质级升级）
	*
	* 候选构成（candidateCount 个）：
	* - ⌈candidateCount × crossoverRate⌉ 个交叉候选（种群 ≥2 时；标量均匀交叉 +
	*   规则子集合并，双亲谱系可追溯）
	* - ⌊candidateCount × explorerRate⌋ 个探索者（边界内随机，注入多样性）
	* - 其余为当前策略/种群精英的高斯变异（sigmaScale 自适应）+ 规则变异
	*/
	async generateCandidates(currentPolicy) {
		const total = Math.max(1, this.config.candidateCount);
		const crossoverCount = this.population.length >= 2 ? Math.ceil(total * this.config.crossoverRate) : 0;
		const explorerCount = Math.floor(total * this.config.explorerRate);
		const mutationCount = Math.max(1, total - crossoverCount - explorerCount);
		const candidates = [];
		for (let i = 0; i < crossoverCount; i += 1) {
			const child = this.crossoverRandom();
			if (child) candidates.push(child);
		}
		for (let i = 0; i < explorerCount; i += 1) candidates.push(this.explorerPolicy(currentPolicy));
		for (let i = 0; i < mutationCount; i += 1) {
			const parent = i % 2 === 0 || this.population.length === 0 ? currentPolicy : this.population[Math.floor(this.rng() * this.population.length)];
			candidates.push(this.mutatePolicy(parent));
		}
		return candidates.slice(0, Math.max(total, candidates.length));
	}
	/** 选择（评估）：在沙盒中隔离评估候选（与当前策略对比，多种子统计） */
	async evaluateCandidate(policy, sandbox) {
		const report = await sandbox.evaluate(policy, this.current);
		this.evaluatedReports.set(policy.id, report);
		this.totalCandidatesEvaluated += 1;
		return report;
	}
	/**
	* 保留（择优）：deployable 且 gainLCB 最高且 ≥ minGain 的候选胜出
	*
	* 报告中 deployable 已含「零风险 + 零回归 + gainLCB ≥ 0」统计门禁，
	* 此处再叠加进化器级 minGain 阈值（双保险）；胜出者回填适应度并入种群。
	*/
	async selectBest(candidates, reports) {
		const reportByPolicy = new Map(reports.map((r) => [r.policyId, r]));
		let best = null;
		let bestScore = this.config.minGain;
		for (const candidate of candidates) {
			const report = reportByPolicy.get(candidate.id);
			if (!report || !report.deployable) continue;
			const score = report.gainLCB ?? report.gain;
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}
		if (best) {
			const report = reportByPolicy.get(best.id);
			best.fitness = {
				score: report.reward,
				successRate: report.metrics.successRate,
				avgQuality: report.metrics.avgQuality,
				avgLatencyMs: report.metrics.avgLatencyMs,
				totalTokens: report.metrics.totalTokens,
				evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
				evaluatedAt: report.evaluatedAt
			};
		}
		this.updatePopulation(candidates);
		return best;
	}
	/**
	* 部署：胜出策略热切换到操作环并进入金丝雀观察窗
	*
	* 经 onDeploy 回调落地（无需重启）；部署记录写入可追溯历史并持久化；
	* 金丝雀基线取沙盒评估期望，观察窗内 reportOperationalOutcome 持续校验。
	*/
	async deployPolicy(policy) {
		const deployedAt = Date.now();
		const normalized = {
			...policy,
			params: normalizePolicyParams(policy.params),
			deployedAt
		};
		const report = this.evaluatedReports.get(policy.id);
		const previous = this.current;
		this.current = normalized;
		this.previousPolicy = {
			...previous,
			params: cloneParams(previous.params)
		};
		this.deployedHistory.push({
			...normalized,
			gain: report?.gain
		});
		this.canary = {
			policyId: normalized.id,
			deployedAt,
			status: "active",
			expectedSuccessRate: report?.metrics.successRate ?? 1,
			expectedAvgQuality: report?.metrics.avgQuality ?? 1,
			samples: 0,
			successes: 0,
			qualitySum: 0
		};
		this.persist();
		try {
			this.config.onDeploy?.(normalized);
		} catch {
			this.current = previous;
			this.previousPolicy = void 0;
			this.deployedHistory.pop();
			this.canary = void 0;
			this.persist();
			throw new Error(`策略 ${policy.id} 部署回调失败，已回滚至 ${previous.id}`);
		}
	}
	/**
	* 操作环真实结果回报（金丝雀观察窗，4.0 Wilson 统计判定）
	*
	* 单侧噪声不回滚：仅当成功率 Wilson 上界（乐观边界）也跌破
	* 期望 − 容忍 时才统计确认劣化 → 回滚（如 7/10 = 0.7 的 UB ≈ 0.89
	* 高于底线 → 继续观察；0/5 的 UB ≈ 0.43 → 立即回滚）。
	* 晋升：样本达 canaryPromoteSamples 且未确认劣化、点估计不破底线，
	* 且 Wilson 下界（保守边界）亦不破底线 → 统计达标晋升；下界未达标
	* 则继续累积样本（宁可多观察，不冒进上线）。
	* @returns 金丝雀状态（无活跃金丝雀返回 undefined）
	*/
	reportOperationalOutcome(outcome) {
		if (!this.canary || this.canary.status !== "active") return this.canary;
		this.canary.samples += 1;
		if (outcome.success) this.canary.successes += 1;
		if (typeof outcome.quality === "number" && outcome.quality > 0) this.canary.qualitySum += outcome.quality;
		if (this.canary.samples >= this.config.canaryMinSamples) {
			const failures = this.canary.samples - this.canary.successes;
			const successRate = this.canary.successes / this.canary.samples;
			const successUB = wilsonUpperBound(this.canary.successes, failures);
			const successLB = wilsonLowerBound(this.canary.successes, failures);
			const successFloor = this.canary.expectedSuccessRate - this.config.canarySuccessTolerance;
			const avgQuality = this.canary.qualitySum / Math.max(1, this.canary.samples);
			const successDegrade = successUB < successFloor;
			const qualityDegrade = this.canary.qualitySum > 0 && this.canary.expectedAvgQuality - avgQuality > this.config.canaryQualityTolerance;
			if (successDegrade || qualityDegrade) {
				const reason = successDegrade ? `成功率 Wilson 上界 ${successUB.toFixed(3)}（点估计 ${successRate.toFixed(3)}，n=${this.canary.samples}）仍低于底线 ${successFloor.toFixed(3)}（期望 ${this.canary.expectedSuccessRate.toFixed(3)} − 容忍 ${this.config.canarySuccessTolerance}），统计确认劣化` : `质量 ${avgQuality.toFixed(3)} 低于沙盒期望 ${this.canary.expectedAvgQuality.toFixed(3)} 超过容忍 ${this.config.canaryQualityTolerance}`;
				return this.rollbackCanary(reason);
			}
			if (this.canary.samples >= this.config.canaryPromoteSamples) {
				if (successRate < successFloor || successLB < successFloor) return { ...this.canary };
				this.canary.status = "promoted";
				this.canary.reason = `金丝雀观察 ${this.canary.samples} 个样本：成功率 ${successRate.toFixed(3)}（Wilson 区间 [${successLB.toFixed(3)}, ${successUB.toFixed(3)}]）达标底线 ${successFloor.toFixed(3)}，质量 ${avgQuality.toFixed(3)} 无劣化，晋升正式`;
				const decision = {
					action: "promoted",
					policyId: this.canary.policyId,
					reason: this.canary.reason
				};
				this.persist();
				this.config.onCanaryDecision?.(decision);
				return { ...this.canary };
			}
		}
		return { ...this.canary };
	}
	/** 金丝雀自动回滚：恢复前一策略并热切换（操作环安全兜底） */
	rollbackCanary(reason) {
		const canary = this.canary;
		canary.status = "rolled-back";
		canary.reason = reason;
		if (this.previousPolicy) {
			const rollbackTarget = this.previousPolicy;
			this.current = {
				...rollbackTarget,
				params: cloneParams(rollbackTarget.params)
			};
			this.previousPolicy = void 0;
			const lastEntry = this.deployedHistory[this.deployedHistory.length - 1];
			if (lastEntry && lastEntry.id === canary.policyId) lastEntry.rolledBackAt = Date.now();
			this.persist();
			try {
				this.config.onDeploy?.(this.getCurrentPolicy());
			} catch {}
			this.config.onCanaryDecision?.({
				action: "rolled-back",
				policyId: canary.policyId,
				reason
			});
		}
		return { ...canary };
	}
	/** 运维手动回滚（金丝雀外强制恢复前一策略） */
	rollbackLastDeployment() {
		if (!this.previousPolicy) return false;
		return Boolean(this.rollbackCanary("运维手动回滚"));
	}
	/**
	* 运行一轮完整进化周期（变异/交叉 → 沙盒评估 → 择优 → 部署）
	*
	* 自主循环定期调用 / 外部 Tool 手动触发；进化中重复调用返回进行中报告。
	* 周期尾部按 1/5 法则自适应调整变异步长。沙盒全程离线，不阻塞操作环。
	*/
	async runEvolutionCycle(sandbox) {
		if (this.evolving) return {
			generation: this.current.generation,
			parentPolicyId: this.current.id,
			candidateOrigins: {},
			candidates: [],
			summary: "跳过：已有进化周期进行中"
		};
		this.evolving = true;
		try {
			const parent = this.getCurrentPolicy();
			const candidates = await this.generateCandidates(parent);
			const reports = [];
			for (const candidate of candidates) reports.push(await this.evaluateCandidate(candidate, sandbox));
			const best = await this.selectBest(candidates, reports);
			if (best) await this.deployPolicy(best);
			this.selectionWindow.push(Boolean(best));
			if (this.selectionWindow.length > 10) this.selectionWindow.shift();
			if (this.selectionWindow.length >= 5) {
				const successRate = this.selectionWindow.filter(Boolean).length / this.selectionWindow.length;
				this.sigmaScale = Math.max(.25, Math.min(3, this.sigmaScale * (successRate > .2 ? 1.25 : .85)));
			}
			this.totalCycles += 1;
			const bestReport = best ? reports.find((r) => r.policyId === best.id) : void 0;
			const cycle = {
				generation: parent.generation + 1,
				parentPolicyId: parent.id,
				candidateOrigins: candidates.reduce((acc, c) => {
					const key = c.origin === "mutation" && (c.params.rules?.length ?? 0) > 0 ? "rule-mutation" : c.origin;
					acc[key] = (acc[key] ?? 0) + 1;
					return acc;
				}, {}),
				candidates: candidates.map((c) => {
					const r = reports.find((x) => x.policyId === c.id);
					return {
						policyId: c.id,
						reward: r?.reward ?? 0,
						gain: r?.gain ?? 0,
						gainLCB: r?.gainLCB,
						deployable: r?.deployable ?? false,
						risks: r?.risks.length ?? 0,
						regressions: r?.regressions.length ?? 0
					};
				}),
				deployedPolicyId: best?.id,
				summary: best ? `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个（${Object.entries(candidates.reduce((acc, c) => (acc[c.origin] = (acc[c.origin] ?? 0) + 1, acc), {})).map(([k, v]) => `${k}×${v}`).join(" + ")}），胜出 ${best.id}（gainLCB ${(bestReport?.gainLCB ?? bestReport?.gain ?? 0).toFixed(3)}），已热切换进入金丝雀观察` : `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个均未达部署门禁（minGain=${this.config.minGain}，LCB 统计），当前策略保持不变（σ×${this.sigmaScale.toFixed(2)}）`
			};
			this.cycleReports.push(cycle);
			if (this.cycleReports.length > 50) this.cycleReports.shift();
			this.persist();
			this.config.onCycle?.(cycle);
			return cycle;
		} finally {
			this.evolving = false;
		}
	}
	/** 高斯变异：数值基因按概率扰动（×sigmaScale）+ 钳制边界；布尔基因按概率翻转；规则基因增/删/改 */
	mutatePolicy(parent) {
		const genes = {
			...parent.params,
			rules: [...parent.params.rules ?? []]
		};
		const record = geneRecord(genes);
		for (const key of SCALAR_GENE_KEYS) {
			const value = record[key];
			if (typeof value === "boolean") {
				if (this.rng() < this.config.booleanFlipRate) record[key] = !value;
				continue;
			}
			if (this.rng() > this.config.mutationRate) continue;
			const bounds = POLICY_GENE_BOUNDS[key];
			const range = bounds.max - bounds.min;
			const noise = (this.rng() + this.rng() - 1) * this.config.mutationStrength * this.sigmaScale * range;
			let mutated = Number(value) + noise;
			mutated = Math.max(bounds.min, Math.min(bounds.max, mutated));
			record[key] = bounds.integer ? Math.round(mutated) : Number(mutated.toFixed(4));
		}
		if (this.rng() < this.config.ruleMutationRate) this.mutateRules(genes);
		return {
			id: `policy-${++this.policyCounter}`,
			version: parent.version + 1,
			type: "scheduler",
			params: genes,
			origin: "mutation",
			generation: parent.generation + 1,
			parentId: parent.id,
			createdAt: Date.now()
		};
	}
	/** 规则变异：无规则→增加；有规则→随机改一条或删一条 */
	mutateRules(genes) {
		const rules = genes.rules ?? [];
		if (rules.length === 0) {
			genes.rules = [this.randomRule()];
			return;
		}
		const roll = this.rng();
		if (roll < .4 && rules.length < 4) genes.rules = [...rules, this.randomRule()];
		else if (roll < .7) genes.rules = rules.slice(0, rules.length - 1);
		else {
			const idx = Math.floor(this.rng() * rules.length);
			const rule = {
				...rules[idx],
				action: { ...rules[idx].action }
			};
			if (rule.action.costWeightDelta !== void 0 || rule.action.ensembleForce !== void 0) rule.action.costWeightDelta = clampDelta((rule.action.costWeightDelta ?? 0) + (this.rng() - .5) * .2);
			else rule.action.memoryWeightBaseDelta = clampDelta((rule.action.memoryWeightBaseDelta ?? 0) + (this.rng() - .5) * .2);
			genes.rules = rules.map((r, i) => i === idx ? rule : r);
		}
	}
	/** 随机合成一条规则（复杂度/特征/任务类型条件 + 随机动作） */
	randomRule() {
		const min = Number((this.rng() * .8).toFixed(2));
		const taskTypes = this.config.knownTaskTypes && this.config.knownTaskTypes.length > 0 && this.rng() < .6 ? [this.config.knownTaskTypes[Math.floor(this.rng() * this.config.knownTaskTypes.length)]] : void 0;
		const roll = this.rng();
		return {
			id: `rule-${++this.policyCounter}-${Math.floor(this.rng() * 1e4)}`,
			when: {
				taskTypes,
				minComplexity: min,
				maxComplexity: Number(Math.min(1, min + .2 + this.rng() * .3).toFixed(2))
			},
			action: roll < .4 ? { costWeightDelta: clampDelta((this.rng() - .5) * 2 * POLICY_RULE_DELTA_BOUNDS.max) } : roll < .7 ? { ensembleForce: this.rng() < .7 } : { decomposeForce: this.rng() < .5 },
			priority: Math.floor(this.rng() * 10)
		};
	}
	/** 种群内随机双亲交叉（种群 <2 返回 null） */
	crossoverRandom() {
		if (this.population.length < 2) return null;
		const i = Math.floor(this.rng() * this.population.length);
		let j = Math.floor(this.rng() * this.population.length);
		if (j === i) j = (j + 1) % this.population.length;
		return this.crossoverPolicies(this.population[i], this.population[j]);
	}
	/** 双亲交叉：标量基因逐位均匀选取 + 规则子集合并（双亲谱系可追溯） */
	crossoverPolicies(a, b) {
		const childParams = {
			...a.params,
			rules: [...a.params.rules ?? []]
		};
		const childRecord = geneRecord(childParams);
		const aRecord = geneRecord(a.params);
		const bRecord = geneRecord(b.params);
		for (const key of SCALAR_GENE_KEYS) childRecord[key] = this.rng() < .5 ? aRecord[key] : bRecord[key];
		for (const key of [
			"costWeight",
			"memoryWeightBase",
			"memoryWeightCap",
			"ensembleScoreGap"
		]) if (this.rng() < .5) {
			const va = Number(aRecord[key]);
			const vb = Number(bRecord[key]);
			childRecord[key] = Number(((va + vb) / 2).toFixed(4));
		}
		const mergedRules = [...a.params.rules ?? [], ...b.params.rules ?? []];
		const seen = /* @__PURE__ */ new Set();
		childParams.rules = mergedRules.filter((r) => seen.has(r.id) ? false : (seen.add(r.id), true)).slice(0, 4);
		return {
			id: `policy-${++this.policyCounter}`,
			version: Math.max(a.version, b.version) + 1,
			type: "scheduler",
			params: childParams,
			origin: "crossover",
			generation: Math.max(a.generation, b.generation) + 1,
			parentId: a.id,
			secondaryParentId: b.id,
			createdAt: Date.now()
		};
	}
	/** 探索者：全基因边界内随机（注入种群多样性，跳出局部最优；origin 专属标记，谱系不误导为变异） */
	explorerPolicy(parent) {
		const params = {
			...parent.params,
			rules: []
		};
		const record = geneRecord(params);
		for (const key of SCALAR_GENE_KEYS) {
			const bounds = POLICY_GENE_BOUNDS[key];
			const value = bounds.min + this.rng() * (bounds.max - bounds.min);
			record[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(4));
		}
		params.decomposeEnabled = this.rng() < .5;
		params.ensembleEnabled = this.rng() < .6;
		params.rules = this.rng() < .3 ? [this.randomRule()] : [];
		return {
			id: `policy-${++this.policyCounter}`,
			version: parent.version + 1,
			type: "scheduler",
			params,
			origin: "explorer",
			generation: parent.generation + 1,
			createdAt: Date.now()
		};
	}
	/** 启动时确保种群含当前策略 */
	seedPopulation() {
		if (this.population.length === 0) this.population = [this.getCurrentPolicy()];
	}
	/**
	* 种群更新（4.0 多样性保持：拥挤去重选择）
	*
	* 候选按适应度竞争入种群，但与已入选个体基因距离 < DIVERSITY_RADIUS 的
	* 近重复个体被跳过（适应度共享的贪婪近似）——种群由「高适应度且彼此
	* 基因相异」的个体构成，避免单一基因型霸占种群导致交叉退化自交。
	* 池内相异个体不足容量时回填近重复（保持容量的降级策略）。
	*/
	updatePopulation(candidates) {
		const pool = [...this.population];
		for (const candidate of candidates) {
			const report = this.evaluatedReports.get(candidate.id);
			if (!report) continue;
			const fitness = {
				score: report.reward,
				successRate: report.metrics.successRate,
				avgQuality: report.metrics.avgQuality,
				avgLatencyMs: report.metrics.avgLatencyMs,
				totalTokens: report.metrics.totalTokens,
				evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
				evaluatedAt: report.evaluatedAt
			};
			pool.push({
				...candidate,
				fitness
			});
		}
		const ranked = [...new Map(pool.map((p) => [p.id, p])).values()].sort((a, b) => (b.fitness?.score ?? -1) - (a.fitness?.score ?? -1));
		const capacity = Math.max(2, this.config.populationSize);
		const selected = [];
		for (const p of ranked) {
			if (selected.length >= capacity) break;
			if (!selected.some((s) => this.geneDistance(s.params, p.params) < POLICY_DIVERSITY_RADIUS)) selected.push(p);
		}
		for (const p of ranked) {
			if (selected.length >= capacity) break;
			if (!selected.includes(p)) selected.push(p);
		}
		this.population = selected;
	}
	/**
	* 基因距离（0~1）：标量基因归一化绝对距离 + 布尔差异 + 规则集合
	* Jaccard 距离的等权平均——衡量两个策略在基因空间的相异度。
	*/
	geneDistance(a, b) {
		let total = 0;
		let count = 0;
		for (const key of SCALAR_GENE_KEYS) {
			const bounds = POLICY_GENE_BOUNDS[key];
			const va = a[key];
			const vb = b[key];
			if (typeof va === "boolean" || typeof vb === "boolean") total += va === vb ? 0 : 1;
			else {
				const range = Math.max(1e-9, bounds.max - bounds.min);
				total += Math.min(1, Math.abs(Number(va) - Number(vb)) / range);
			}
			count += 1;
		}
		const ra = new Set((a.rules ?? []).map((r) => r.id));
		const rb = new Set((b.rules ?? []).map((r) => r.id));
		if (ra.size > 0 || rb.size > 0) {
			let inter = 0;
			for (const id of ra) if (rb.has(id)) inter += 1;
			const union = (/* @__PURE__ */ new Set([...ra, ...rb])).size;
			total += 1 - inter / union;
			count += 1;
		}
		return count === 0 ? 0 : total / count;
	}
	/** 持久化进化状态（原子写；失败不阻断进化流程） */
	persist() {
		const persistPath = this.config.persistPath;
		if (!persistPath) return;
		try {
			fs.mkdirSync(path.dirname(persistPath), { recursive: true });
			const payload = {
				version: 2,
				currentPolicy: this.current,
				previousPolicy: this.previousPolicy,
				deployedHistory: this.deployedHistory.map((p) => ({
					...p,
					params: cloneParams(p.params)
				})),
				population: this.population.map((p) => ({
					...p,
					params: cloneParams(p.params)
				})),
				sigmaScale: this.sigmaScale,
				canary: this.canary,
				totalCandidatesEvaluated: this.totalCandidatesEvaluated,
				totalCycles: this.totalCycles,
				cycleReports: this.cycleReports.slice(-20),
				savedAt: Date.now()
			};
			const tmp = `${persistPath}.tmp.${process.pid}`;
			fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
			fs.renameSync(tmp, persistPath);
		} catch {}
	}
	/** 启动时恢复上次部署策略与种群（无持久化文件或损坏时保持基准） */
	loadPersisted() {
		const persistPath = this.config.persistPath;
		if (!persistPath || !fs.existsSync(persistPath)) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
			if (parsed.currentPolicy?.params) {
				this.current = {
					...parsed.currentPolicy,
					params: normalizePolicyParams(parsed.currentPolicy.params)
				};
				this.deployedHistory = parsed.deployedHistory ?? [this.current];
				this.population = (parsed.population ?? []).filter((p) => p?.params).map((p) => ({
					...p,
					params: normalizePolicyParams(p.params)
				}));
				this.previousPolicy = parsed.previousPolicy ? {
					...parsed.previousPolicy,
					params: normalizePolicyParams(parsed.previousPolicy.params)
				} : void 0;
				this.sigmaScale = typeof parsed.sigmaScale === "number" ? Math.max(.25, Math.min(3, parsed.sigmaScale)) : 1;
				this.canary = parsed.canary?.status === "active" ? parsed.canary : void 0;
				this.totalCandidatesEvaluated = parsed.totalCandidatesEvaluated ?? 0;
				this.totalCycles = parsed.totalCycles ?? 0;
				this.config.onDeploy?.(this.getCurrentPolicy());
			}
		} catch {}
	}
};
function clampDelta(v) {
	return Number(Math.max(POLICY_RULE_DELTA_BOUNDS.min, Math.min(POLICY_RULE_DELTA_BOUNDS.max, v)).toFixed(4));
}
function cloneParams(params) {
	return {
		...params,
		rules: (params.rules ?? []).map((r) => ({
			...r,
			when: { ...r.when },
			action: { ...r.action }
		}))
	};
}
//#endregion
//#region src/policy/sandbox.ts
/** 启用校准锚定所需的最小历史样本数 */
const MIN_CALIBRATION_SAMPLES = 3;
/**
* 从长期记忆构建校准表（index.ts 注入沙盒；进化周期之间可刷新）
*
* 3.0 贝叶斯化：在保留裸口径（observedAvgQuality/samples）的同时，
* 从 getBayesianEstimate 附带时间加权证据视图——
* - posteriorQuality = (n·emaQuality + 1·0.5) / (n+1)：近期敏感 + 小样本收缩
* - effectiveSamples：30 天半衰期衰减后的等效观测数（校准权重依据）
* - drift：能力漂移让沙盒感知「模型变了」（配合 calibratedFit 漂移倾斜）
*/
function buildCalibrationFromMemory(memory) {
	const calibration = {};
	for (const profile of memory.getAllModelProfiles()) {
		const perTask = {};
		for (const [taskType, history] of Object.entries(profile.taskHistory)) if (history.totalCalls >= 3 && history.avgQualityScore > 0) {
			const entry = {
				observedAvgQuality: history.avgQualityScore,
				samples: history.totalCalls
			};
			const est = memory.getBayesianEstimate(profile.id, taskType);
			if (est) {
				const n = Math.max(0, est.effectiveSamples);
				entry.posteriorQuality = Number(((n * est.emaQuality + .5) / (n + 1)).toFixed(6));
				entry.effectiveSamples = Number(n.toFixed(6));
				entry.drift = est.drift;
			}
			perTask[taskType] = entry;
		}
		if (Object.keys(perTask).length > 0) calibration[profile.id] = perTask;
	}
	return calibration;
}
const DEFAULT_SANDBOX_CONFIG = {
	successWeight: .35,
	qualityWeight: .35,
	costWeight: .2,
	costNormTokens: 4e3,
	latencyNormMs: 5e3,
	successQualityThreshold: .55,
	regressionSuccessTolerance: .05,
	regressionQualityTolerance: .03,
	regressionCostTolerance: 1.5,
	evaluationSeeds: 3,
	calibration: {}
};
/**
* 策略模拟执行器
*
* 给定策略参数 + 任务 + 模型快照，模拟「上下文规则解析 → 评分 → 分解决策 →
* 选模型 → 组合决策 → 产出」：
* - 有效参数：resolveEffectiveParams(params, task) —— 规则基因在此承受选择压力
* - 产出质量 = 校准后能力适配 − 复杂度惩罚 + 稳定噪声（ensemble 取均值 + 多样性增益）
* - 分解降低单节点复杂度（子复杂度 = c / n^0.7），但增加协调开销（延迟 +15%、token +10%）
* - 评分调用与操作环共享 scoreModelWithPolicy → 沙盒保真
*/
var PolicySimulator = class {
	models;
	config;
	modelIndex;
	constructor(models, config) {
		this.models = [...models];
		this.config = {
			...DEFAULT_SANDBOX_CONFIG,
			...config
		};
		this.modelIndex = new Map(this.models.map((m) => [m.id, m]));
	}
	/** 模型快照（只读） */
	getModels() {
		return [...this.models];
	}
	/**
	* 校准后的能力适配分：真实历史锚定合成画像
	*
	* 3.0 贝叶斯口径（条目携带证据字段时）：
	* - 权重 w = min(0.6, effectiveSamples/50)：时间衰减后的等效样本——
	*   旧证据自动让位，长期不用的模型不再被陈旧历史过度锚定
	* - 锚定值 = posteriorQuality：近期敏感 EMA + 小样本向先验收缩
	* - 漂移倾斜：|drift| 大的模型按近期能力变化微调（±0.05 钳制），
	*   「模型修好了 / 模型退化了」在沙盒中被真实感知
	*
	* 兼容：旧格式条目（无证据字段）走 legacy 口径，行为与升级前逐位一致。
	*/
	calibratedFit(modelId, taskType, syntheticFit) {
		const entry = this.config.calibration[modelId]?.[taskType];
		if (!entry) return syntheticFit;
		const n = entry.effectiveSamples ?? entry.samples;
		const w = Math.min(.6, n / 50);
		const anchor = entry.posteriorQuality ?? entry.observedAvgQuality;
		const blended = syntheticFit * (1 - w) + anchor * w;
		const driftTilt = Math.max(-.05, Math.min(.05, (entry.drift ?? 0) * .25));
		return Number((blended + driftTilt).toFixed(6));
	}
	/**
	* 稳定噪声（FNV-1a 哈希 → [-0.05, 0.05)）
	*
	* 同一「任务×模型×种子」组合恒定同一噪声：策略变体与 baseline 在同一任务上
	* 的随机扰动完全一致，评估差异纯粹来自策略本身（选择压力不失真）。
	*/
	stableNoise(seed, salt) {
		let h = 2166136261 ^ salt;
		for (let i = 0; i < seed.length; i += 1) {
			h ^= seed.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return ((h >>> 0) % 1e4 / 1e4 - .5) * .1;
	}
	/** 按策略给全部候选模型评分（降序；使用上下文有效参数） */
	rankModels(params, task) {
		const effective = resolveEffectiveParams(params, {
			taskType: task.taskType,
			complexity: task.complexity,
			features: task.features
		});
		return this.models.map((m) => ({
			id: m.id,
			score: scoreModelWithPolicy(effective, {
				taskScore: m.taskScores[task.taskType] ?? m.taskScores["general"] ?? .5,
				memoryScore: .5,
				memoryCalls: 0,
				avgQuality: .5,
				avgTokens: m.avgTokens
			})
		})).sort((a, b) => b.score - a.score);
	}
	/** 模拟执行单个任务（seedSalt 区分多种子轮次） */
	simulate(params, task, seedSalt = 0) {
		const ranked = this.rankModels(params, task);
		if (ranked.length === 0) throw new Error("沙盒内无可用模型");
		const effective = resolveEffectiveParams(params, {
			taskType: task.taskType,
			complexity: task.complexity,
			features: task.features
		});
		const decomposed = effective.decomposeEnabled && task.complexity >= effective.decomposeComplexityThreshold;
		const subtaskCount = decomposed ? Math.max(1, Math.min(effective.decomposeMaxSubtasks, Math.ceil(task.complexity * effective.decomposeMaxSubtasks))) : 1;
		const subComplexity = task.complexity / Math.pow(subtaskCount, .7);
		const ensembleUsed = effective.ensembleEnabled && ranked.length >= 2 && ranked[0].score - ranked[1].score < effective.ensembleScoreGap;
		const ensembleSize = ensembleUsed ? Math.min(effective.ensembleMaxModels, ranked.length) : 1;
		const chosen = ranked.slice(0, ensembleSize).map((r) => r.id);
		let qualitySum = 0;
		let latencyMax = 0;
		let tokensTotal = 0;
		for (const modelId of chosen) {
			const model = this.modelIndex.get(modelId);
			if (!model) throw new Error(`策略选中了沙盒外的模型: ${modelId}`);
			const syntheticFit = model.taskScores[task.taskType] ?? model.taskScores["general"] ?? .5;
			const baseFit = this.calibratedFit(modelId, task.taskType, syntheticFit);
			const noise = this.stableNoise(`${task.taskType}|${task.complexity}|${task.length}|${modelId}`, seedSalt);
			const quality = Math.max(0, Math.min(1, baseFit - subComplexity * (1 - baseFit) * .5 + noise));
			qualitySum += quality;
			latencyMax = Math.max(latencyMax, model.avgLatencyMs * (1 + subComplexity));
			tokensTotal += model.avgTokens * (1 + subComplexity * .5) * (1 + task.length / 5e4);
		}
		let quality = qualitySum / ensembleSize;
		if (ensembleUsed) quality = Math.min(1, quality + .05);
		const success = quality >= this.config.successQualityThreshold;
		const latency = latencyMax * (decomposed ? 1.15 : 1);
		const tokens = tokensTotal * subtaskCount * (decomposed ? 1.1 : 1);
		return {
			success,
			quality,
			latencyMs: latency,
			tokens: Math.round(tokens),
			decomposed,
			ensembleUsed,
			chosenModels: chosen
		};
	}
};
/**
* 生成合成对抗任务（测鲁棒性）
*
* 四类压力模式：
* 1. 极端复杂：高复杂度 + 多特征 + 超长文本（压测分解与集成决策、规则条件匹配）
* 2. 冷启动：从未见过的任务类型（压测评分函数的缺省路径）
* 3. 特征密集：特征标签爆炸（压测规则特征条件匹配）
* 4. 极简任务：低复杂度短文本（压测过度调度/过度分解）
*/
function generateAdversarialTasks(knownTaskTypes = [], rng = Math.random) {
	const types = knownTaskTypes.length > 0 ? knownTaskTypes : ["code-generation"];
	const pick = (arr) => arr[Math.floor(rng() * arr.length)];
	return [
		{
			taskType: pick(types),
			complexity: .95 + rng() * .05,
			features: [
				"code",
				"review",
				"test",
				"documentation"
			],
			length: 8e4,
			source: "adversarial",
			label: "极端复杂任务"
		},
		{
			taskType: `unseen-${Math.floor(rng() * 1e6)}`,
			complexity: .5 + rng() * .3,
			features: [],
			length: 2e3,
			source: "adversarial",
			label: "冷启动任务"
		},
		{
			taskType: pick(types),
			complexity: .7 + rng() * .2,
			features: [
				"code",
				"review",
				"test",
				"analysis",
				"translation",
				"documentation"
			],
			length: 3e4,
			source: "adversarial",
			label: "特征密集任务"
		},
		{
			taskType: pick(types),
			complexity: .05 + rng() * .1,
			features: [],
			length: 120,
			source: "adversarial",
			label: "极简任务"
		}
	];
}
/**
* 从长期记忆提取历史任务集（回放评估的数据来源）
*
* 每个任务模式（含成功与失败记录）至少产出 1 个回放任务；
* 模式指纹 `taskType::complexity::features` 解析回任务上下文。
*/
function extractReplayTasks(memory) {
	const tasks = [];
	for (const pattern of memory.getAllTaskPatterns()) {
		const [taskType, complexityRaw, featuresRaw] = pattern.fingerprint.split("::");
		if (!taskType) continue;
		const complexity = Number(complexityRaw ?? .5);
		const features = (featuresRaw ?? "").split(",").filter(Boolean);
		const records = Math.max(1, pattern.successfulPlans.length + pattern.failureRecords.length);
		for (let i = 0; i < records; i += 1) tasks.push({
			taskType,
			complexity,
			features,
			length: Math.max(100, Math.round(complexity * 2e4)),
			source: "replay",
			label: pattern.taskSummary
		});
	}
	return tasks;
}
/**
* 安全沙盒（implements ISandbox）
*
* 被 PolicyEvolver 调用：evaluate(policy, baseline) 在隔离环境重放任务集，
* 产出收益/风险/回归三段式评估报告（多种子统计门禁）。全程离线，不阻塞操作环调度。
*/
var Sandbox = class {
	simulator;
	tasks;
	config;
	constructor(params) {
		this.simulator = new PolicySimulator(params.models, params.config);
		this.tasks = [...params.tasks];
		this.config = {
			...DEFAULT_SANDBOX_CONFIG,
			...params.config
		};
	}
	/** 当前任务集（可观测） */
	getTaskSet() {
		return [...this.tasks];
	}
	/** 替换任务集（进化周期之间可刷新历史回放集） */
	setTaskSet(tasks) {
		this.tasks = [...tasks];
	}
	/** 刷新校准表（操作环真实结果持续锚定模拟器） */
	setCalibration(calibration) {
		this.config = {
			...this.config,
			calibration
		};
		this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
	}
	/**
	* 运行时调参入口（第四阶段：元认知控制器调节验证严格度）
	*
	* 经此调整多种子统计门禁（evaluationSeeds：种子越多 LCB 越严格）、
	* 回归容忍（regression*）与 reward 权重；下次评估即生效。
	* calibration 字段不可经此变更（走 setCalibration）。
	*/
	updateConfig(patch) {
		const { calibration: _ignored, ...rest } = patch;
		this.config = {
			...this.config,
			...rest
		};
		this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
	}
	/** 当前评估配置快照（元认知旋钮 read 端；只读） */
	getConfig() {
		return {
			...this.config,
			calibration: this.config.calibration
		};
	}
	/**
	* 评估策略（可选与 baseline 对比；多种子统计）
	*
	* 流程：参数边界风险检查 → 多种子全任务集模拟（逐种子聚合求均值）→
	* reward/gain 均值与标准差 → 置信下界 LCB → 回归检测 → 部署门禁
	* （gainLCB ≥ 0：97.5% 置信下界上收益仍非负，防单种子过拟合）
	*/
	async evaluate(policy, baseline) {
		const evaluatedAt = Date.now();
		const replayed = this.tasks.filter((t) => t.source === "replay").length;
		const adversarial = this.tasks.filter((t) => t.source === "adversarial").length;
		const seeds = Math.max(1, Math.floor(this.config.evaluationSeeds));
		const risks = [];
		if (!policyParamsWithinBounds(policy.params)) risks.push("策略参数越界（超出 POLICY_GENE_BOUNDS）");
		const policyRuns = this.runAllSeeds(policy.params, seeds, risks);
		const metrics = averageMetrics(policyRuns.map((r) => r.metrics));
		const reward = policyRuns.reduce((s, r) => s + r.reward, 0) / policyRuns.length;
		let baselineMetrics;
		let baselineReward;
		let gainStdDev = 0;
		let gainLCB;
		const regressions = [];
		if (baseline) {
			const baselineRuns = this.runAllSeeds(baseline.params, seeds, []);
			baselineMetrics = averageMetrics(baselineRuns.map((r) => r.metrics));
			baselineReward = baselineRuns.reduce((s, r) => s + r.reward, 0) / baselineRuns.length;
			const gains = policyRuns.map((r, i) => r.reward - (baselineRuns[i]?.reward ?? r.reward));
			const meanGain = gains.reduce((s, g) => s + g, 0) / gains.length;
			gainStdDev = gains.length > 1 ? Math.sqrt(gains.reduce((s, g) => s + (g - meanGain) ** 2, 0) / (gains.length - 1)) : 0;
			gainLCB = meanGain - 1.96 * gainStdDev / Math.sqrt(gains.length);
			if (metrics.successRate < baselineMetrics.successRate - this.config.regressionSuccessTolerance) regressions.push(`成功率回归：${baselineMetrics.successRate.toFixed(3)} → ${metrics.successRate.toFixed(3)}`);
			if (metrics.avgQuality < baselineMetrics.avgQuality - this.config.regressionQualityTolerance) regressions.push(`质量回归：${baselineMetrics.avgQuality.toFixed(3)} → ${metrics.avgQuality.toFixed(3)}`);
			if (baselineMetrics.totalTokens > 0 && metrics.totalTokens > baselineMetrics.totalTokens * this.config.regressionCostTolerance) regressions.push(`成本回归：token ${baselineMetrics.totalTokens} → ${metrics.totalTokens}（超出 ${(this.config.regressionCostTolerance - 1) * 100}%）`);
		}
		const gain = baselineReward !== void 0 ? reward - baselineReward : 0;
		const deployable = risks.length === 0 && regressions.length === 0 && baselineReward !== void 0 && (gainLCB ?? gain) >= 0 && this.tasks.length > 0;
		return {
			policyId: policy.id,
			baselinePolicyId: baseline?.id,
			metrics,
			baselineMetrics,
			reward,
			baselineReward,
			gain,
			gainStdDev: seeds > 1 ? gainStdDev : void 0,
			gainLCB: seeds > 1 ? gainLCB : void 0,
			seeds,
			risks,
			regressions,
			deployable,
			taskStats: {
				replayed,
				adversarial
			},
			evaluatedAt
		};
	}
	/** 在全部种子上模拟执行（每种子完整跑一遍任务集） */
	runAllSeeds(params, seeds, risks) {
		const runs = [];
		for (let salt = 0; salt < seeds; salt += 1) {
			const metrics = this.simulateAll(params, salt, risks);
			runs.push({
				metrics,
				reward: this.computeReward(metrics)
			});
		}
		return runs;
	}
	/** 单种子模拟执行全任务集并聚合指标（单个任务异常记为风险 + 失败样本） */
	simulateAll(params, seedSalt, risks) {
		let successCount = 0;
		let qualitySum = 0;
		let latencySum = 0;
		let tokensTotal = 0;
		let decomposeCount = 0;
		let ensembleCount = 0;
		let evaluated = 0;
		for (const task of this.tasks) try {
			const sim = this.simulator.simulate(params, task, seedSalt);
			evaluated += 1;
			if (sim.success) successCount += 1;
			qualitySum += sim.quality;
			latencySum += sim.latencyMs;
			tokensTotal += sim.tokens;
			if (sim.decomposed) decomposeCount += 1;
			if (sim.ensembleUsed) ensembleCount += 1;
		} catch (err) {
			risks.push(`任务 ${task.taskType}(${task.label ?? ""}) 模拟异常: ${err instanceof Error ? err.message : String(err)}`);
		}
		const total = Math.max(evaluated, 1);
		return {
			successRate: successCount / total,
			avgQuality: qualitySum / total,
			avgLatencyMs: latencySum / total,
			totalTokens: Math.round(tokensTotal),
			decompositionRate: decomposeCount / total,
			ensembleRate: ensembleCount / total
		};
	}
	/** 综合收益：成功率 + 质量 + 成本效率 + 延迟效率 加权（归一化到 0~1） */
	computeReward(metrics) {
		const perTaskTokens = metrics.totalTokens / Math.max(1, this.tasks.length);
		const costEfficiency = 1 - Math.min(1, perTaskTokens / this.config.costNormTokens);
		const latencyEfficiency = 1 - Math.min(1, metrics.avgLatencyMs / this.config.latencyNormMs);
		const { successWeight, qualityWeight, costWeight } = this.config;
		const latencyWeight = Math.max(0, 1 - successWeight - qualityWeight - costWeight);
		return successWeight * metrics.successRate + qualityWeight * metrics.avgQuality + costWeight * costEfficiency + latencyWeight * latencyEfficiency;
	}
};
/** 多种子指标平均（token 取均值以保持与单任务口径一致） */
function averageMetrics(list) {
	if (list.length === 0) return {
		successRate: 0,
		avgQuality: 0,
		avgLatencyMs: 0,
		totalTokens: 0,
		decompositionRate: 0,
		ensembleRate: 0
	};
	const avg = (pick) => list.reduce((s, m) => s + pick(m), 0) / list.length;
	return {
		successRate: avg((m) => m.successRate),
		avgQuality: avg((m) => m.avgQuality),
		avgLatencyMs: avg((m) => m.avgLatencyMs),
		totalTokens: Math.round(avg((m) => m.totalTokens)),
		decompositionRate: avg((m) => m.decompositionRate),
		ensembleRate: avg((m) => m.ensembleRate)
	};
}
//#endregion
//#region src/meta/self-model.ts
/**
* self-model.ts — 自我建模引擎（第四阶段「元认知层」核心 1/2，implements ISelfModel）
*
* 职责：持续观察操作环（任务执行）与进化环（策略进化）的运行状态，
* 产出结构化「心智报告」——系统对自身决策质量、记忆健康、进化效率、
* 稳定性风险的周期性自我认知。
*
* 心智报告四视图：
* 1. strategyPerformance：当前策略的优势（高成功率任务类型）与盲点
*    （低成功率类型）+ 按策略版本归因的表现（版本升级收益证据基础）
* 2. memoryQuality：三层记忆的增长/平稳/退化趋势 + 蒸馏水位
* 3. evolverEfficiency：新策略发现速率与存活率（劣化会被金丝雀回滚）
* 4. systemStability：综合稳定分 + 风险点清单 + token 趋势
*
* 自我改进证据（improvementEvidence）：与上一份报告的机器可验证对比——
* 策略版本升级的成功率变化、程序记忆条数增长、发现间隔缩短、
* 操作环成功率提升，全部携带 before/after 数值。
*
* 推荐调整（recommendedAdjustments）：规则化诊断 → 旋钮 id + 方向 + 优先级，
* 交由元认知控制器保守执行（本引擎只诊断不开药方剂量）。
*
* 报告历史持久化（JSON）：重启后恢复，趋势分析与效果判定跨重启连续。
*/
/** outcome → 质量分映射（与金丝雀喂数一致的近似） */
const QUALITY_BY_OUTCOME = {
	excellent: .95,
	good: .8,
	acceptable: .65,
	poor: .4,
	failed: .1
};
const SUCCESS_OUTCOMES = /* @__PURE__ */ new Set([
	"excellent",
	"good",
	"acceptable"
]);
/** 前瞻风险 → 建议旋钮映射（预测越限时的提前干预手段） */
const PROACTIVE_SUGGESTIONS = {
	operationalSuccessRate: {
		knob: "evolver.mutationRate",
		direction: "up"
	},
	discoveryRate: {
		knob: "evolver.minGain",
		direction: "down"
	},
	survivalRate: {
		knob: "sandbox.evaluationSeeds",
		direction: "up"
	},
	pendingDistillation: {
		knob: "reflector.autoDistillThreshold",
		direction: "down"
	},
	stabilityScore: {
		knob: "sandbox.evaluationSeeds",
		direction: "up"
	}
};
/**
* 稳态偏离计算（self-model 报告与 meta-controller 步长自适应共用）
*
* 返回归一化偏离：带内为 0（含近缘 near-edge），带外按带宽归一（可 >1）。
* 控制器据此量化步长倍率：1 + floor(deviation × 2)，上限 maxStepMultiplier。
*/
function computeHomeostasis(band, current) {
	const width = band.max - band.min;
	if (current < band.min) return {
		deviation: width > 0 ? (band.min - current) / width : 1,
		state: "out-of-band"
	};
	if (current > band.max) return {
		deviation: width > 0 ? (current - band.max) / width : 1,
		state: "out-of-band"
	};
	const edgeDistance = Math.min(current - band.min, band.max - current);
	return {
		deviation: 0,
		state: (width > 0 ? edgeDistance / width <= .15 : false) ? "near-edge" : "in-band"
	};
}
/**
* 自我建模引擎（implements ISelfModel）
*
* 被编排层持有：元认知控制器每轮 evaluateAndAdjust 先调用
* generateMentalReport 采集最新自我认知；也可经 mental_report Tool
* 手动触发（人类审查入口）。
*/
var SelfModel = class {
	config;
	collectors;
	/** 报告历史（升序；趋势分析与改进证据的对比基线） */
	history = [];
	/** 上一报告窗口的单次执行平均 token（趋势检测基线） */
	lastTokensPerExecution;
	constructor(params) {
		this.config = {
			reportHistoryLimit: 50,
			minSamplesPerTaskType: 3,
			feedbackWindow: 100,
			forecastHorizon: 3,
			minForecastHistory: 3,
			anomalyZThreshold: 2.5,
			homeostasisBands: {},
			...params.config
		};
		this.collectors = params.collectors;
		this.restore();
	}
	/** 采集系统指标快照（心智报告的原始素材） */
	async getSystemMetrics() {
		const feedback = this.collectors.getRecentFeedback(this.config.feedbackWindow);
		const dbStats = this.collectors.getMemoryStats();
		const global = this.collectors.getGlobalStats();
		const evolverStatus = this.collectors.getEvolverStatus();
		const operational = this.buildOperationalMetrics(feedback);
		const deployedAll = evolverStatus.deployedHistory;
		const deployments = deployedAll.slice(1);
		const rolledBack = deployments.filter((d) => d.rolledBackAt !== void 0);
		const gains = deployments.map((d) => d.gain).filter((g) => typeof g === "number");
		const evolver = {
			currentPolicyId: evolverStatus.currentPolicy.id,
			currentPolicyVersion: evolverStatus.currentPolicy.version,
			currentPolicyGeneration: evolverStatus.currentPolicy.generation,
			currentPolicyOrigin: evolverStatus.currentPolicy.origin,
			totalCycles: evolverStatus.totalCycles,
			totalCandidatesEvaluated: evolverStatus.totalCandidatesEvaluated,
			deployedCount: deployments.length,
			rolledBackCount: rolledBack.length,
			survivalRate: deployments.length > 0 ? (deployments.length - rolledBack.length) / deployments.length : 1,
			discoveryRate: evolverStatus.totalCycles > 0 ? deployments.length / evolverStatus.totalCycles : 0,
			avgDiscoveryIntervalMs: this.avgDiscoveryInterval(deployedAll),
			avgDeployedGain: gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / gains.length : 0,
			sigmaScale: evolverStatus.sigmaScale,
			populationSize: evolverStatus.population.length,
			canaryStatus: evolverStatus.canary?.status ?? "none",
			deployedHistory: deployedAll.map((d) => ({
				id: d.id,
				version: d.version,
				generation: d.generation,
				deployedAt: d.deployedAt,
				rolledBackAt: d.rolledBackAt
			}))
		};
		return {
			collectedAt: Date.now(),
			operational,
			memory: {
				counts: {
					episodic: dbStats.patterns,
					semantic: dbStats.semantic,
					procedural: dbStats.procedural,
					strategies: dbStats.strategies,
					modelProfiles: dbStats.profiles,
					feedback: dbStats.feedback
				},
				pendingSinceLastDistillation: this.collectors.getDistillationProgress?.()?.pendingSinceLastDistillation ?? 0,
				totalExecutions: global.totalExecutions,
				totalSuccesses: global.totalSuccesses,
				totalFailures: global.totalFailures,
				totalTokensUsed: global.totalTokensUsed,
				averageQualityScore: global.averageQualityScore,
				averageExecutionTime: global.averageExecutionTime
			},
			evolver
		};
	}
	/** 生成心智报告（持续进程：历史累积 → 趋势与改进证据） */
	async generateMentalReport() {
		const metrics = await this.getSystemMetrics();
		const previous = this.history[this.history.length - 1];
		const reportIndex = (previous?.reportIndex ?? 0) + 1;
		const strategyPerformance = this.buildStrategyPerformance(metrics, previous);
		const memoryQuality = this.buildMemoryQuality(metrics, previous);
		const evolverEfficiency = this.buildEvolverEfficiency(metrics);
		const systemStability = this.buildStability(metrics, memoryQuality, evolverEfficiency, previous);
		const improvementEvidence = this.buildEvidence(metrics, previous, strategyPerformance);
		const recommendedAdjustments = this.recommend(metrics, strategyPerformance, memoryQuality, evolverEfficiency);
		const forecasts = this.buildForecasts(metrics, systemStability);
		const proactiveRisks = this.buildProactiveRisks(forecasts);
		this.detectAnomalies(metrics, systemStability);
		const metaLayer = this.collectors.getMetaLayerState?.();
		let metaStability;
		if (metaLayer?.metaStability) metaStability = {
			...metaLayer.metaStability,
			homeostasis: this.buildHomeostasis(metrics, systemStability)
		};
		const report = {
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			reportIndex,
			generatedAt: metrics.collectedAt,
			strategyPerformance,
			memoryQuality,
			evolverEfficiency,
			systemStability,
			improvementEvidence,
			recommendedAdjustments,
			forecasts,
			proactiveRisks,
			knobEffectiveness: metaLayer?.knobEffectiveness,
			metaStability
		};
		this.history.push(report);
		if (this.history.length > this.config.reportHistoryLimit) this.history.shift();
		this.persist();
		return structuredClone(report);
	}
	/** 报告历史（升序；趋势分析素材） */
	getReportHistory() {
		return this.history.map((r) => structuredClone(r));
	}
	/** 最近一份报告 */
	getLatestReport() {
		return this.history.length > 0 ? structuredClone(this.history[this.history.length - 1]) : void 0;
	}
	/** 趋势数据（关键指标序列，供图表渲染） */
	getTrendSeries() {
		return {
			reportIndex: this.history.map((r) => r.reportIndex),
			operationalSuccessRate: this.history.map((r) => r.strategyPerformance.operational.successRate),
			proceduralCount: this.history.map((r) => r.memoryQuality.counts.procedural),
			semanticCount: this.history.map((r) => r.memoryQuality.counts.semantic),
			discoveryRate: this.history.map((r) => r.evolverEfficiency.discoveryRate),
			stabilityScore: this.history.map((r) => r.systemStability.stabilityScore)
		};
	}
	/** 人类可读报告（mental_report Tool 输出 / 审查日志） */
	formatReport(report) {
		const lines = [];
		const pct = (v) => `${(v * 100).toFixed(1)}%`;
		lines.push(`╔═ 心智报告 #${report.reportIndex}（${report.timestamp}）═`);
		lines.push("║ [策略表现]");
		lines.push(`║   当前策略 ${report.strategyPerformance.currentPolicyId}@v${report.strategyPerformance.currentPolicyVersion}（第 ${report.strategyPerformance.currentPolicyGeneration} 代，来源 ${report.strategyPerformance.currentPolicyOrigin}）`);
		lines.push(`║   操作环: 成功率 ${pct(report.strategyPerformance.operational.successRate)} / 质量 ${report.strategyPerformance.operational.avgQuality.toFixed(3)}（样本 ${report.strategyPerformance.operational.sampleCount}）`);
		if (report.strategyPerformance.perVersion.length > 0) lines.push(`║   版本归因: ${report.strategyPerformance.perVersion.map((v) => `v${v.version}=${pct(v.successRate)}(${v.samples}样本)`).join("，")}`);
		if (report.strategyPerformance.strengths.length > 0) lines.push(`║   优势: ${report.strategyPerformance.strengths.map((s) => `${s.taskType} ${pct(s.successRate)}`).join("、")}`);
		if (report.strategyPerformance.blindSpots.length > 0) lines.push(`║   盲点: ${report.strategyPerformance.blindSpots.map((s) => `${s.taskType} ${pct(s.successRate)}`).join("、")}`);
		lines.push("║ [记忆体系]");
		lines.push(`║   情景 ${report.memoryQuality.counts.episodic} 条（+${report.memoryQuality.growth.episodic}）/ 语义 ${report.memoryQuality.counts.semantic} 条（+${report.memoryQuality.growth.semantic}）/ 程序 ${report.memoryQuality.counts.procedural} 条（+${report.memoryQuality.growth.procedural}）/ 策略 ${report.memoryQuality.counts.strategies} 条`);
		lines.push(`║   层趋势: ${report.memoryQuality.layers.map((l) => `${l.layer}=${l.trend}`).join("，")}；蒸馏积压 ${report.memoryQuality.distillation.pendingSinceLastDistillation}`);
		lines.push("║ [进化器效率]");
		lines.push(`║   ${report.evolverEfficiency.totalCycles} 轮评估 ${report.evolverEfficiency.totalCandidatesEvaluated} 候选，部署 ${report.evolverEfficiency.deployedCount} 次（存活率 ${pct(report.evolverEfficiency.survivalRate)}，回滚 ${report.evolverEfficiency.rolledBackCount}）`);
		lines.push(`║   发现速率 ${report.evolverEfficiency.discoveryRate.toFixed(3)}/轮，平均间隔 ${this.formatDuration(report.evolverEfficiency.avgDiscoveryIntervalMs)}，平均收益 +${report.evolverEfficiency.avgDeployedGain.toFixed(4)}（σ×${report.evolverEfficiency.sigmaScale}）`);
		lines.push("║ [系统稳定性]");
		lines.push(`║   稳定分 ${report.systemStability.stabilityScore.toFixed(3)}，token 趋势 ${report.systemStability.tokenUsageTrend}，金丝雀 ${report.systemStability.canaryActive ? "观察中" : "无"}`);
		for (const risk of report.systemStability.riskPoints) lines.push(`║   风险[${risk.severity}] ${risk.area}: ${risk.description}`);
		if (report.improvementEvidence.length > 0) {
			lines.push("║ [自我改进证据]");
			for (const e of report.improvementEvidence) lines.push(`║   ✓ ${e.description}`);
		} else lines.push("║ [自我改进证据] 暂无（首份报告或暂无正向变化）");
		if (report.forecasts && report.forecasts.length > 0) {
			lines.push("║ [趋势预测]");
			const METRIC_LABELS = {
				operationalSuccessRate: "操作环成功率",
				discoveryRate: "发现速率",
				pendingDistillation: "蒸馏积压",
				survivalRate: "新策略存活率",
				stabilityScore: "综合稳定分"
			};
			for (const f of report.forecasts) {
				const label = METRIC_LABELS[f.metric] ?? f.metric;
				const cross = f.crossesRiskThreshold ? ` ⚠ 预计 ${f.crossesRiskThreshold.withinReports} 期后越限（${f.crossesRiskThreshold.direction === "below" ? "<" : ">"} ${f.crossesRiskThreshold.threshold}）` : "";
				lines.push(`║   ${label}: ${f.slopePerReport >= 0 ? "+" : ""}${f.slopePerReport.toFixed(4)}/期 → ${f.horizon} 期后 ${f.predictedValue}（R²=${f.r2.toFixed(2)}，置信 ${f.confidence}）${cross}`);
			}
		}
		if (report.proactiveRisks && report.proactiveRisks.length > 0) {
			lines.push("║ [前瞻风险]");
			for (const r of report.proactiveRisks) lines.push(`║   ⚠ ${r.description} → 建议 ${r.suggestedKnob} ${r.suggestedDirection === "up" ? "↑" : "↓"}（紧迫度 ${r.urgency}）`);
		}
		if (report.knobEffectiveness && report.knobEffectiveness.length > 0) {
			lines.push("║ [调参策略学习]");
			for (const k of report.knobEffectiveness) lines.push(`║   ${k.knob} ${k.direction === "up" ? "↑" : "↓"}: ${k.trials} 试 / ${k.commits} 成（${(k.successRate * 100).toFixed(0)}%），均效 ${k.avgEffectDelta >= 0 ? "+" : ""}${k.avgEffectDelta.toFixed(4)}，评分 ${k.effectivenessScore.toFixed(3)}`);
		}
		if (report.metaStability) {
			lines.push("║ [元认知自察]");
			const ms = report.metaStability;
			const tripped = ms.circuitBreakers.filter((b) => b.tripped);
			lines.push(`║   熔断器: ${tripped.length > 0 ? tripped.map((b) => `${b.knob}（连续回滚 ${b.consecutiveRollbacks}）`).join("、") : "全部正常"}${ms.frozenByBreaker ? "；⚠ 全局熔断中" : ""}${ms.globalFrozen ? "；手动冻结中" : ""}`);
			const learned = ms.safeEnvelopes.filter((e) => e.source === "learned");
			lines.push(`║   安全包络: ${learned.length > 0 ? learned.map((e) => `${e.knob}∈[${e.min}, ${e.max}]（${e.sampleCount} 样本${e.knownBadValues.length > 0 ? `，排除 ${e.knownBadValues.join("/")}` : ""}）`).join("；") : "全部为默认边界"}`);
			lines.push(`║   学习器: ${ms.learner.totalTrials} 次试验 / ${ms.learner.arms} 臂，平均置信权重 ${ms.learner.explorationWeight.toFixed(2)}`);
			const outOfBand = ms.homeostasis.filter((h) => h.state === "out-of-band");
			if (outOfBand.length > 0) lines.push(`║   稳态带: ⚠ 越带 ${outOfBand.map((h) => `${h.metric}=${h.current}（带 [${h.band.min}, ${h.band.max}]，偏离 ${h.deviation}）`).join("、")}`);
			else if (ms.homeostasis.length > 0) lines.push("║   稳态带: 全部指标处于目标带内");
		}
		if (report.recommendedAdjustments.length > 0) {
			lines.push("║ [推荐调整]");
			for (const r of report.recommendedAdjustments) lines.push(`║   → ${r.label} ${r.direction === "up" ? "↑" : "↓"}（优先级 ${r.priority.toFixed(2)}）：${r.reason}`);
		}
		lines.push("╚════════════════════════════");
		return lines.join("\n");
	}
	/** 操作环指标：反馈窗口聚合 + 按任务类型分组 */
	buildOperationalMetrics(feedback) {
		const byType = /* @__PURE__ */ new Map();
		let successes = 0;
		let qualitySum = 0;
		for (const f of feedback) {
			const success = SUCCESS_OUTCOMES.has(f.outcome);
			const quality = QUALITY_BY_OUTCOME[f.outcome] ?? .5;
			if (success) successes += 1;
			qualitySum += quality;
			const entry = byType.get(f.signalType) ?? {
				total: 0,
				successes: 0,
				qualitySum: 0
			};
			entry.total += 1;
			if (success) entry.successes += 1;
			entry.qualitySum += quality;
			byType.set(f.signalType, entry);
		}
		const n = feedback.length;
		return {
			successRate: n > 0 ? successes / n : 1,
			avgQuality: n > 0 ? qualitySum / n : 1,
			sampleCount: n,
			perTaskType: [...byType.entries()].map(([taskType, e]) => ({
				taskType,
				total: e.total,
				successes: e.successes,
				successRate: e.successes / e.total,
				avgQuality: e.qualitySum / e.total
			})).sort((a, b) => b.total - a.total)
		};
	}
	/** 平均发现间隔：相邻部署 deployedAt 差均值（wall-clock） */
	avgDiscoveryInterval(deployedAll) {
		const times = deployedAll.map((d) => d.deployedAt).sort((a, b) => a - b);
		if (times.length < 2) return 0;
		let sum = 0;
		for (let i = 1; i < times.length; i += 1) sum += times[i] - times[i - 1];
		return sum / (times.length - 1);
	}
	/** 策略表现：版本归因（按 deployedAt 时间窗分配反馈）+ 优势/盲点 */
	buildStrategyPerformance(metrics, previous) {
		const { evolver, operational } = metrics;
		const feedback = this.collectors.getRecentFeedback(this.config.feedbackWindow);
		const perVersion = [];
		if (evolver.deployedHistory.length > 0) {
			const sortedDeployments = [...evolver.deployedHistory].sort((a, b) => a.deployedAt - b.deployedAt);
			const acc = sortedDeployments.map((d) => ({
				policyId: d.id,
				version: d.version,
				samples: 0,
				successes: 0,
				qualitySum: 0
			}));
			for (const f of feedback) {
				let owner = 0;
				for (let i = 0; i < sortedDeployments.length; i += 1) if (sortedDeployments[i].deployedAt <= f.timestamp) owner = i;
				const entry = acc[owner];
				if (!entry) continue;
				entry.samples += 1;
				if (SUCCESS_OUTCOMES.has(f.outcome)) entry.successes += 1;
				entry.qualitySum += QUALITY_BY_OUTCOME[f.outcome] ?? .5;
			}
			for (const e of acc) {
				if (e.samples === 0) continue;
				perVersion.push({
					policyId: e.policyId,
					version: e.version,
					successRate: e.successes / e.samples,
					avgQuality: e.qualitySum / e.samples,
					samples: e.samples
				});
			}
		}
		const minSamples = this.config.minSamplesPerTaskType;
		const sortedByRate = [...operational.perTaskType.filter((t) => t.total >= minSamples)].sort((a, b) => a.successRate - b.successRate);
		const blindSpots = sortedByRate.filter((t) => t.successRate < .6).slice(0, 3).map((t) => ({
			taskType: t.taskType,
			successRate: t.successRate,
			samples: t.total
		}));
		const strengths = [...sortedByRate].reverse().filter((t) => t.successRate >= .75).slice(0, 3).map((t) => ({
			taskType: t.taskType,
			successRate: t.successRate,
			samples: t.total
		}));
		return {
			currentPolicyId: evolver.currentPolicyId,
			currentPolicyVersion: evolver.currentPolicyVersion,
			currentPolicyGeneration: evolver.currentPolicyGeneration,
			currentPolicyOrigin: evolver.currentPolicyOrigin,
			operational: {
				successRate: operational.successRate,
				avgQuality: operational.avgQuality,
				sampleCount: operational.sampleCount
			},
			perVersion,
			strengths,
			blindSpots,
			sandboxFitness: previous?.strategyPerformance.sandboxFitness
		};
	}
	/** 记忆质量：三层增长趋势 + 蒸馏水位 */
	buildMemoryQuality(metrics, previous) {
		const { counts } = metrics.memory;
		const growth = previous ? {
			episodic: counts.episodic - previous.memoryQuality.counts.episodic,
			semantic: counts.semantic - previous.memoryQuality.counts.semantic,
			procedural: counts.procedural - previous.memoryQuality.counts.procedural,
			strategies: counts.strategies - previous.memoryQuality.counts.strategies
		} : {
			episodic: 0,
			semantic: 0,
			procedural: 0,
			strategies: 0
		};
		const layerTrend = (delta) => delta > 0 ? "growing" : delta < 0 ? "degrading" : "stable";
		const layers = [
			{
				layer: "episodic",
				trend: layerTrend(growth.episodic),
				detail: `任务模式 ${counts.episodic} 条（较上期 ${growth.episodic >= 0 ? "+" : ""}${growth.episodic}）`
			},
			{
				layer: "semantic",
				trend: layerTrend(growth.semantic),
				detail: `语义记忆 ${counts.semantic} 条（较上期 ${growth.semantic >= 0 ? "+" : ""}${growth.semantic}）`
			},
			{
				layer: "procedural",
				trend: layerTrend(growth.procedural),
				detail: `程序记忆 ${counts.procedural} 条（较上期 ${growth.procedural >= 0 ? "+" : ""}${growth.procedural}）`
			}
		];
		return {
			counts,
			growth,
			distillation: { pendingSinceLastDistillation: metrics.memory.pendingSinceLastDistillation },
			layers,
			totalExecutions: metrics.memory.totalExecutions,
			averageQualityScore: metrics.memory.averageQualityScore
		};
	}
	/** 进化器效率 */
	buildEvolverEfficiency(metrics) {
		const e = metrics.evolver;
		return {
			totalCycles: e.totalCycles,
			totalCandidatesEvaluated: e.totalCandidatesEvaluated,
			deployedCount: e.deployedCount,
			survivalRate: e.survivalRate,
			rolledBackCount: e.rolledBackCount,
			discoveryRate: e.discoveryRate,
			avgDiscoveryIntervalMs: e.avgDiscoveryIntervalMs,
			avgDeployedGain: e.avgDeployedGain,
			sigmaScale: e.sigmaScale,
			populationSize: e.populationSize,
			canaryStatus: e.canaryStatus
		};
	}
	/** 稳定性：综合分 + 风险点 */
	buildStability(metrics, memory, evolver, previous) {
		const riskPoints = [];
		const operational = metrics.operational;
		if (operational.sampleCount >= 5 && operational.successRate < .7) riskPoints.push({
			severity: operational.successRate < .5 ? "high" : "medium",
			area: "operations",
			description: `操作环成功率 ${(operational.successRate * 100).toFixed(1)}% 低于 70% 健康线`
		});
		if (evolver.deployedCount >= 2 && evolver.survivalRate < .6) riskPoints.push({
			severity: "high",
			area: "evolver",
			description: `新策略存活率仅 ${(evolver.survivalRate * 100).toFixed(0)}%（${evolver.rolledBackCount}/${evolver.deployedCount} 被回滚），沙盒门禁与真实表现脱钩`
		});
		if (evolver.totalCycles >= 5 && evolver.discoveryRate === 0) riskPoints.push({
			severity: "medium",
			area: "evolver",
			description: `连续 ${evolver.totalCycles} 轮进化未发现可部署策略（探索不足或门禁过严）`
		});
		if (memory.distillation.pendingSinceLastDistillation >= 10) riskPoints.push({
			severity: "low",
			area: "memory",
			description: `蒸馏积压 ${memory.distillation.pendingSinceLastDistillation} 条情景事件未沉淀为高级记忆`
		});
		for (const layer of memory.layers) if (layer.trend === "degrading") riskPoints.push({
			severity: "low",
			area: "memory",
			description: `${layer.layer} 记忆层退化：${layer.detail}`
		});
		if (metrics.memory.totalExecutions > 0 && metrics.memory.totalFailures / Math.max(1, metrics.memory.totalExecutions) > .4) riskPoints.push({
			severity: "medium",
			area: "operations",
			description: `历史累计失败率 ${(metrics.memory.totalFailures / metrics.memory.totalExecutions * 100).toFixed(0)}% 偏高`
		});
		const stabilityScore = Math.max(0, Math.min(1, operational.successRate * .4 + evolver.survivalRate * .3 + (1 - Math.min(1, memory.distillation.pendingSinceLastDistillation / 30)) * .1 + (memory.layers.every((l) => l.trend !== "degrading") ? .2 : .1)));
		const tokensPerExecution = metrics.memory.totalExecutions > 0 ? metrics.memory.totalTokensUsed / metrics.memory.totalExecutions : 0;
		let tokenUsageTrend = "unknown";
		if (this.lastTokensPerExecution !== void 0 && this.lastTokensPerExecution > 0 && tokensPerExecution > 0) {
			const change = (tokensPerExecution - this.lastTokensPerExecution) / this.lastTokensPerExecution;
			tokenUsageTrend = change > .1 ? "rising" : change < -.1 ? "falling" : "stable";
		}
		if (tokensPerExecution > 0) this.lastTokensPerExecution = tokensPerExecution;
		return {
			stabilityScore: Number(stabilityScore.toFixed(3)),
			riskPoints,
			recentRollbacks: evolver.rolledBackCount,
			canaryActive: evolver.canaryStatus === "active",
			tokenUsageTrend
		};
	}
	/** 自我改进证据：与上份报告的机器可验证对比 */
	buildEvidence(metrics, previous, strategy) {
		const evidence = [];
		if (!previous) return evidence;
		const now = metrics.collectedAt;
		if (strategy.currentPolicyVersion > previous.strategyPerformance.currentPolicyVersion) {
			const beforeVer = previous.strategyPerformance.perVersion.find((v) => v.version === previous.strategyPerformance.currentPolicyVersion);
			const afterVer = strategy.perVersion.find((v) => v.version === strategy.currentPolicyVersion);
			const pp = (delta) => `${delta * 100 >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`;
			let description = `策略 v${previous.strategyPerformance.currentPolicyVersion} 升级到 v${strategy.currentPolicyVersion}（第 ${strategy.currentPolicyGeneration} 代，来源 ${strategy.currentPolicyOrigin}）`;
			if (beforeVer && afterVer && beforeVer.samples >= 3 && afterVer.samples >= 3) {
				const delta = afterVer.successRate - beforeVer.successRate;
				description += `，平均任务成功率 ${(beforeVer.successRate * 100).toFixed(1)}% → ${(afterVer.successRate * 100).toFixed(1)}%（${pp(delta)}）`;
				evidence.push({
					kind: "policy-upgrade",
					description,
					before: Number(beforeVer.successRate.toFixed(4)),
					after: Number(afterVer.successRate.toFixed(4)),
					unit: "ratio",
					measuredAt: now
				});
			} else evidence.push({
				kind: "policy-upgrade",
				description,
				measuredAt: now
			});
		}
		const procDelta = metrics.memory.counts.procedural - previous.memoryQuality.counts.procedural;
		if (procDelta > 0) evidence.push({
			kind: "memory-growth",
			description: `蒸馏出的程序记忆从 ${previous.memoryQuality.counts.procedural} 条增加到 ${metrics.memory.counts.procedural} 条（+${procDelta}）`,
			before: previous.memoryQuality.counts.procedural,
			after: metrics.memory.counts.procedural,
			unit: "条",
			measuredAt: now
		});
		const semDelta = metrics.memory.counts.semantic - previous.memoryQuality.counts.semantic;
		if (semDelta > 0) evidence.push({
			kind: "memory-growth",
			description: `语义记忆从 ${previous.memoryQuality.counts.semantic} 条增加到 ${metrics.memory.counts.semantic} 条（+${semDelta}）`,
			before: previous.memoryQuality.counts.semantic,
			after: metrics.memory.counts.semantic,
			unit: "条",
			measuredAt: now
		});
		const prevInterval = previous.evolverEfficiency.avgDiscoveryIntervalMs;
		const nowInterval = metrics.evolver.avgDiscoveryIntervalMs;
		if (prevInterval > 0 && nowInterval > 0 && nowInterval <= prevInterval * .9) evidence.push({
			kind: "evolver-efficiency",
			description: `进化器发现新策略的平均时间从 ${this.formatDuration(prevInterval)} 缩短到 ${this.formatDuration(nowInterval)}`,
			before: prevInterval,
			after: nowInterval,
			unit: "ms",
			measuredAt: now
		});
		const prevRate = previous.strategyPerformance.operational.successRate;
		const curRate = strategy.operational.successRate;
		if (previous.strategyPerformance.operational.sampleCount >= 5 && strategy.operational.sampleCount >= 5 && curRate - prevRate >= .02) evidence.push({
			kind: "quality-gain",
			description: `平均任务成功率从 ${(prevRate * 100).toFixed(1)}% 提升到 ${(curRate * 100).toFixed(1)}%（+${((curRate - prevRate) * 100).toFixed(1)}pp）`,
			before: Number(prevRate.toFixed(4)),
			after: Number(curRate.toFixed(4)),
			unit: "ratio",
			measuredAt: now
		});
		return evidence;
	}
	/** 规则化诊断 → 推荐调整（仅诊断方向，剂量由元认知控制器保守决定） */
	recommend(metrics, strategy, memory, evolver) {
		const recs = [];
		const KNOB_LABELS = {
			"evolver.mutationRate": "进化器变异率",
			"evolver.minGain": "进化器部署门禁（选择压力）",
			"sandbox.evaluationSeeds": "沙盒多种子评估严格度",
			"reflector.autoDistillThreshold": "反思器自动蒸馏阈值",
			"reflector.distillMinConfidence": "知识蒸馏写入置信度门槛",
			"optimizer.memoryFastPathThreshold": "记忆快路径复用门槛"
		};
		if (evolver.deployedCount >= 2 && evolver.survivalRate < .6) {
			recs.push({
				knob: "evolver.minGain",
				label: KNOB_LABELS["evolver.minGain"],
				direction: "up",
				reason: `新策略存活率 ${(evolver.survivalRate * 100).toFixed(0)}%，沙盒放行的劣质策略过多，需提高部署门禁`,
				priority: .9
			});
			recs.push({
				knob: "sandbox.evaluationSeeds",
				label: KNOB_LABELS["sandbox.evaluationSeeds"],
				direction: "up",
				reason: "提高多种子统计门禁严格度，降低沙盒与操作环脱钩风险",
				priority: .85
			});
		}
		if (strategy.blindSpots.length > 0) recs.push({
			knob: "evolver.mutationRate",
			label: KNOB_LABELS["evolver.mutationRate"],
			direction: "up",
			reason: `存在盲点任务类型（${strategy.blindSpots.map((b) => b.taskType).join("、")}），增强变异探索以发现针对性策略基因`,
			priority: .8
		});
		if (evolver.totalCycles >= 5 && evolver.discoveryRate === 0 && evolver.deployedCount < 2) recs.push({
			knob: "evolver.minGain",
			label: KNOB_LABELS["evolver.minGain"],
			direction: "down",
			reason: `连续 ${evolver.totalCycles} 轮进化零部署，选择压力过强抑制了增量改进`,
			priority: .75
		});
		if (memory.distillation.pendingSinceLastDistillation >= 8) recs.push({
			knob: "reflector.autoDistillThreshold",
			label: KNOB_LABELS["reflector.autoDistillThreshold"],
			direction: "down",
			reason: `蒸馏积压 ${memory.distillation.pendingSinceLastDistillation} 条情景事件，应更早触发知识蒸馏`,
			priority: .7
		});
		if (memory.growth.episodic >= 2 && memory.growth.semantic + memory.growth.procedural === 0) recs.push({
			knob: "reflector.distillMinConfidence",
			label: KNOB_LABELS["reflector.distillMinConfidence"],
			direction: "down",
			reason: "情景记忆持续累积但语义/程序记忆零增长，蒸馏写入门槛可能过高",
			priority: .6
		});
		if (strategy.operational.sampleCount >= 10 && strategy.operational.successRate >= .85) recs.push({
			knob: "optimizer.memoryFastPathThreshold",
			label: KNOB_LABELS["optimizer.memoryFastPathThreshold"],
			direction: "down",
			reason: `操作环成功率 ${(strategy.operational.successRate * 100).toFixed(0)}% 稳定优质，可放宽复用门槛加速经验快路径`,
			priority: .4
		});
		return recs.sort((a, b) => b.priority - a.priority);
	}
	formatDuration(ms) {
		if (ms <= 0) return "—";
		if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
		if (ms < 36e5) return `${(ms / 6e4).toFixed(1)}min`;
		return `${(ms / 36e5).toFixed(1)}h`;
	}
	/** 从报告提取趋势指标取值 */
	metricValueOf(report, metric) {
		switch (metric) {
			case "operationalSuccessRate": return report.strategyPerformance.operational.successRate;
			case "discoveryRate": return report.evolverEfficiency.discoveryRate;
			case "proceduralGrowth": return report.memoryQuality.counts.procedural;
			case "pendingDistillation": return report.memoryQuality.distillation.pendingSinceLastDistillation;
			case "survivalRate": return report.evolverEfficiency.survivalRate;
			case "stabilityScore": return report.systemStability.stabilityScore;
		}
	}
	/**
	* 趋势外推：关键指标最小二乘拟合 → horizon 期预测 + 越限检测
	*
	* 从被动描述（当前值 + 增量）升级为主动预测：指标按当前轨迹
	* 将在 horizon 内穿越风险阈值时产出 crossesRiskThreshold——
	* 前瞻性调整的触发基础（风险发生前行动，而非发生后补救）。
	*/
	buildForecasts(metrics, stability) {
		const horizon = this.config.forecastHorizon;
		const currentValueOf = (metric) => {
			switch (metric) {
				case "operationalSuccessRate": return metrics.operational.successRate;
				case "discoveryRate": return metrics.evolver.discoveryRate;
				case "proceduralGrowth": return metrics.memory.counts.procedural;
				case "pendingDistillation": return metrics.memory.pendingSinceLastDistillation;
				case "survivalRate": return metrics.evolver.survivalRate;
				case "stabilityScore": return stability.stabilityScore;
			}
		};
		/** 风险阈值（预测越限检测；与反应式规则的已发生阈值互补） */
		const RISK_THRESHOLDS = {
			operationalSuccessRate: {
				value: .7,
				direction: "below"
			},
			discoveryRate: {
				value: .05,
				direction: "below"
			},
			pendingDistillation: {
				value: 25,
				direction: "above"
			},
			survivalRate: {
				value: .6,
				direction: "below"
			},
			stabilityScore: {
				value: .6,
				direction: "below"
			}
		};
		const forecasts = [];
		for (const metric of Object.keys(RISK_THRESHOLDS)) {
			const points = this.history.map((r) => this.metricValueOf(r, metric));
			points.push(currentValueOf(metric));
			if (points.length < this.config.minForecastHistory) continue;
			const fit = this.linearFit(points.slice(-8));
			const predicted = fit.intercept + fit.slope * (fit.n - 1 + horizon);
			const confidence = fit.n >= 4 && fit.r2 >= .8 ? "high" : fit.n >= 3 && fit.r2 >= .3 ? "medium" : "low";
			const threshold = RISK_THRESHOLDS[metric];
			const current = points[points.length - 1];
			let crosses;
			if (threshold.direction === "below" && fit.slope < 0 && current > threshold.value) {
				const within = Math.ceil((current - threshold.value) / -fit.slope);
				if (within <= horizon) crosses = {
					threshold: threshold.value,
					direction: "below",
					withinReports: within
				};
			} else if (threshold.direction === "above" && fit.slope > 0 && current < threshold.value) {
				const within = Math.ceil((threshold.value - current) / fit.slope);
				if (within <= horizon) crosses = {
					threshold: threshold.value,
					direction: "above",
					withinReports: within
				};
			}
			forecasts.push({
				metric,
				slopePerReport: Number(fit.slope.toFixed(6)),
				currentValue: current,
				horizon,
				predictedValue: Number(predicted.toFixed(6)),
				r2: Number(fit.r2.toFixed(4)),
				confidence,
				crossesRiskThreshold: crosses
			});
		}
		return forecasts;
	}
	/** 最小二乘拟合（返回斜率/截距/R²） */
	linearFit(values) {
		const n = values.length;
		const xMean = (n - 1) / 2;
		const yMean = values.reduce((s, v) => s + v, 0) / n;
		let sxx = 0;
		let sxy = 0;
		for (let i = 0; i < n; i += 1) {
			sxx += (i - xMean) ** 2;
			sxy += (i - xMean) * (values[i] - yMean);
		}
		const slope = sxx > 0 ? sxy / sxx : 0;
		const intercept = yMean - slope * xMean;
		let ssTot = 0;
		let ssRes = 0;
		for (let i = 0; i < n; i += 1) {
			ssTot += (values[i] - yMean) ** 2;
			ssRes += (values[i] - (intercept + slope * i)) ** 2;
		}
		return {
			slope,
			intercept,
			r2: ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 1,
			n
		};
	}
	/** 前瞻性风险：预测越限 → 紧迫度 + 建议旋钮（元认知控制器提前行动） */
	buildProactiveRisks(forecasts) {
		const risks = [];
		const METRIC_LABELS = {
			operationalSuccessRate: "操作环成功率",
			discoveryRate: "进化发现速率",
			pendingDistillation: "蒸馏积压水位",
			survivalRate: "新策略存活率",
			stabilityScore: "综合稳定分"
		};
		for (const f of forecasts) {
			if (!f.crossesRiskThreshold) continue;
			const suggestion = PROACTIVE_SUGGESTIONS[f.metric];
			if (!suggestion) continue;
			const urgency = Number(Math.max(.6, Math.min(1, .6 + .4 * (1 - f.crossesRiskThreshold.withinReports / f.horizon))).toFixed(2));
			risks.push({
				metric: f.metric,
				description: `按当前趋势（每期 ${f.slopePerReport >= 0 ? "+" : ""}${f.slopePerReport.toFixed(4)}），${METRIC_LABELS[f.metric] ?? f.metric} 预计 ${f.crossesRiskThreshold.withinReports} 期后越限（阈值 ${f.crossesRiskThreshold.direction === "below" ? "<" : ">"} ${f.crossesRiskThreshold.threshold}），当前值 ${f.currentValue} 仍健康`,
				forecast: f,
				urgency,
				suggestedKnob: suggestion.knob,
				suggestedDirection: suggestion.direction
			});
		}
		return risks.sort((a, b) => b.urgency - a.urgency);
	}
	/** 异常检测：关键指标对自身历史的 z 分数突变（稳定系统的自体噪声基线） */
	detectAnomalies(metrics, stability) {
		if (this.history.length < 4) return;
		const current = {
			operationalSuccessRate: metrics.operational.successRate,
			discoveryRate: metrics.evolver.discoveryRate,
			proceduralGrowth: metrics.memory.counts.procedural,
			pendingDistillation: metrics.memory.pendingSinceLastDistillation,
			survivalRate: metrics.evolver.survivalRate,
			stabilityScore: stability.stabilityScore
		};
		const LABELS = {
			operationalSuccessRate: "操作环成功率",
			discoveryRate: "进化发现速率",
			proceduralGrowth: "程序记忆累积量",
			pendingDistillation: "蒸馏积压水位",
			survivalRate: "新策略存活率",
			stabilityScore: "综合稳定分"
		};
		for (const [metric, value] of Object.entries(current)) {
			const prior = this.history.slice(-8).map((r) => this.metricValueOf(r, metric));
			if (prior.length < 4) continue;
			const mean = prior.reduce((s, v) => s + v, 0) / prior.length;
			const std = Math.sqrt(prior.reduce((s, v) => s + (v - mean) ** 2, 0) / prior.length);
			const z = std > 1e-9 ? Math.abs((value - mean) / std) : value !== mean ? Infinity : 0;
			if (z >= this.config.anomalyZThreshold) stability.riskPoints.push({
				severity: "high",
				area: "meta",
				description: `指标突变：${LABELS[metric] ?? metric} 当前 ${value} 偏离近均值 ${mean.toFixed(4)} 达 ${Number.isFinite(z) ? `${z.toFixed(1)}σ` : "∞σ"}（异常波动，非趋势性劣化）`
			});
		}
	}
	/** 稳态目标带评估（偏离越远 → 元认知控制器步长越大） */
	buildHomeostasis(metrics, stability) {
		const bands = this.config.homeostasisBands;
		if (!bands || Object.keys(bands).length === 0) return [];
		const current = {
			operationalSuccessRate: metrics.operational.successRate,
			discoveryRate: metrics.evolver.discoveryRate,
			proceduralGrowth: metrics.memory.counts.procedural,
			pendingDistillation: metrics.memory.pendingSinceLastDistillation,
			survivalRate: metrics.evolver.survivalRate
		};
		const statuses = [];
		for (const [metric, band] of Object.entries(bands)) {
			const value = current[metric];
			if (value === void 0) continue;
			const { deviation, state } = computeHomeostasis(band, value);
			statuses.push({
				metric,
				band,
				current: value,
				deviation: Number(deviation.toFixed(4)),
				state
			});
		}
		return statuses;
	}
	persist() {
		if (!this.config.persistPath) return;
		try {
			fs.writeFileSync(this.config.persistPath, JSON.stringify({
				history: this.history,
				savedAt: Date.now()
			}), "utf-8");
		} catch {}
	}
	restore() {
		if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.config.persistPath, "utf-8"));
			if (Array.isArray(parsed.history)) this.history = parsed.history;
		} catch {}
	}
};
//#endregion
//#region src/meta/meta-controller.ts
/**
* meta-controller.ts — 元认知控制器（第四阶段「元认知层」核心 2/2，implements IMetaCognitiveController）
*
* 职责：基于自我建模产出心智报告，自动调整操作环与进化环的运行参数——
* 系统不仅进化策略（第三阶段内环），还进化「进化机制本身」（第四阶段外环），
* 完成双环自治进化架构。
*
* 可调旋钮（与真实组件联动，经 read/write 回调落地）：
* - reflector.autoDistillThreshold / distillMinConfidence：反思触发频率与蒸馏门槛
* - evolver.mutationRate / minGain：进化器变异率与选择压力
* - sandbox.evaluationSeeds：沙盒验证严格度（多种子统计门禁）
* - optimizer.memoryFastPathThreshold：记忆层读取复用门槛
*
* 保守原则（安全内建，不依赖调用方自觉）：
* 1. 每轮至多应用 maxAdjustmentsPerRound（缺省 1）个调整
* 2. 每次只移动一个 step（旋钮自定义的小步长），绝不跳变
* 3. 调整后进入观察窗（observationReports 份心智报告），期间不应用新调整
* 4. 观察期满按 judgeMetric 判定：劣化超容忍 → 自动回滚；否则保留生效
* 5. 手动接管优先：setManualOverride 的旋钮与全局 freeze 期间不做自动调整
*
* ── 2.0 质级升级：从「规则诊断 + 固定步长」到「学习型稳态控制」──
* 1. 调参策略学习（AdjustmentLearner，乐观先验 Bandit）：每个「旋钮×方向」
*    是一个学习臂，从 commit/rollback 历史估计各臂有效性并参与候选排序
*    （权重随试验数增长）——元认知器进化自己的调参策略本身
* 2. 综合判定护栏：任何调整若伴随操作环成功率显著劣化（超容忍），无论
*    目标指标改善与否一律判失败——单指标优化不得以整体劣化为代价
* 3. 稳态自适应步长：判定指标配置目标带（homeostasisBands）后，偏离带
*    越远步长倍率越大（1~maxStepMultiplier 量化档位）；带内保持标准步长
* 4. 经验安全包络：从 commit 取值学习安全区间（好值 ± 一步长），自动回滚
*    发生过的取值记为已知劣化值——后续调整自动排除（prevention > rollback）
* 5. 熔断器：单旋钮连续 breakerThreshold 次自动回滚 → 熔断该旋钮；
*    全局连续 globalBreakerThreshold 次 → 全局熔断；reArmBreaker 手动复位
* 6. 前瞻性调整：心智报告的前瞻风险（预测越限）注入候选——指标仍健康
*    时提前行动（proactive），与反应式规则（reactive）互补
*
* 审计与可追溯：全部 adjust/commit/rollback/manual-override/skip/circuit-breaker
* 动作全量写入审计日志并持久化（JSON）；rollbackLastAdjustment 支持手动回滚
* 最近一次调整（无论观察中还是已提交）。
*/
/** 乐观先验（Beta 平滑）：冷启动臂保持探索吸引力 */
const ARM_PRIOR_MEAN = .7;
const ARM_PRIOR_WEIGHT = 2;
/**
* 调参策略学习器
*
* 每个调整臂（旋钮×方向）维护 trials/commits/rollbacks/effectSum；
* 选择评分 = (1−w)·规则优先级 + w·贝叶斯平滑成功率，其中
* w = trials/(trials+2)——试验越多越信任学习结果，冷启动完全
* 遵循规则优先级（行为向后兼容），随经验积累逐步接管排序。
*/
var AdjustmentLearner = class {
	arms = /* @__PURE__ */ new Map();
	totalTrials = 0;
	key(knob, direction) {
		return `${knob}:${direction}`;
	}
	ensure(knob, direction, judgeMetric) {
		const k = this.key(knob, direction);
		let arm = this.arms.get(k);
		if (!arm) {
			arm = {
				knob,
				direction,
				judgeMetric,
				trials: 0,
				commits: 0,
				rollbacks: 0,
				effectSum: 0
			};
			this.arms.set(k, arm);
		}
		return arm;
	}
	/** 候选选择评分（规则优先级与学习有效性的加权融合） */
	selectionScore(rulePriority, knob, direction, judgeMetric) {
		const arm = this.arms.get(this.key(knob, direction));
		if (!arm || arm.trials === 0) return rulePriority;
		const w = arm.trials / (arm.trials + 2);
		const learned = (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
		return (1 - w) * rulePriority + w * learned;
	}
	/** 记录一次判定结果 */
	record(knob, direction, judgeMetric, committed, effectDelta) {
		const arm = this.ensure(knob, direction, judgeMetric);
		arm.trials += 1;
		arm.effectSum += effectDelta;
		if (committed) arm.commits += 1;
		else arm.rollbacks += 1;
		this.totalTrials += 1;
	}
	/** 有效性快照（试验过的臂；供心智报告与状态面板） */
	effectiveness() {
		return [...this.arms.values()].filter((a) => a.trials > 0).map((a) => ({
			knob: a.knob,
			direction: a.direction,
			judgeMetric: a.judgeMetric,
			trials: a.trials,
			commits: a.commits,
			rollbacks: a.rollbacks,
			successRate: a.commits / a.trials,
			avgEffectDelta: a.effectSum / a.trials,
			effectivenessScore: (a.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (a.trials + ARM_PRIOR_WEIGHT)
		}));
	}
	/** 平均学习置信权重（心智报告 explorationWeight） */
	averageConfidenceWeight() {
		const tried = [...this.arms.values()].filter((a) => a.trials > 0);
		if (tried.length === 0) return 0;
		return tried.reduce((s, a) => s + a.trials / (a.trials + 2), 0) / tried.length;
	}
	/** 手动探测某臂评分（测试/可观测） */
	peekScore(knob, direction) {
		const arm = this.arms.get(this.key(knob, direction));
		if (!arm || arm.trials === 0) return void 0;
		return (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
	}
	dump() {
		const arms = {};
		for (const [k, a] of this.arms) arms[k] = {
			trials: a.trials,
			commits: a.commits,
			rollbacks: a.rollbacks,
			effectSum: a.effectSum
		};
		return {
			arms,
			totalTrials: this.totalTrials
		};
	}
	load(data, judgeMetricOf) {
		if (!data || typeof data.arms !== "object") return;
		for (const [k, stats] of Object.entries(data.arms)) {
			const [knob, direction] = k.split(":");
			if (!knob || direction !== "up" && direction !== "down") continue;
			const arm = this.ensure(knob, direction, judgeMetricOf(knob));
			arm.trials = stats.trials ?? 0;
			arm.commits = stats.commits ?? 0;
			arm.rollbacks = stats.rollbacks ?? 0;
			arm.effectSum = stats.effectSum ?? 0;
		}
		this.totalTrials = typeof data.totalTrials === "number" ? data.totalTrials : 0;
	}
};
/**
* 元认知控制器（implements IMetaCognitiveController）
*
* 被编排层持有：autonomy-loop 低频触发 evaluateAndAdjust（每 N 轮心跳），
* 也可经 meta_cognition_* Tool 手动触发/审查/接管。
*/
var MetaCognitiveController = class {
	config;
	selfModel;
	knobs = /* @__PURE__ */ new Map();
	audit = [];
	pending;
	frozen = false;
	manuallyFrozenKnobs = /* @__PURE__ */ new Set();
	/** 已被回滚过的 adjust 审计 id（手动回滚去重） */
	rolledBackAdjustIds = /* @__PURE__ */ new Set();
	counters = {
		adjustments: 0,
		rollbacks: 0,
		commits: 0
	};
	auditSeq = 0;
	/** 调参策略学习器（乐观先验 Bandit） */
	learner = new AdjustmentLearner();
	/** 安全包络：各旋钮的已验证好取值 / 已知劣化取值 */
	envelopeGood = /* @__PURE__ */ new Map();
	envelopeBad = /* @__PURE__ */ new Map();
	/** 熔断器：单旋钮连续自动回滚计数与已熔断旋钮 */
	breakerCounters = /* @__PURE__ */ new Map();
	trippedBreakers = /* @__PURE__ */ new Set();
	/** 全局连续自动回滚计数（跨旋钮） */
	globalRollbackStreak = 0;
	/** 全局熔断标记（区别于手动 frozen） */
	frozenByBreaker = false;
	constructor(params) {
		this.config = {
			maxAdjustmentsPerRound: 1,
			observationReports: 2,
			degradationTolerance: .02,
			auditLimit: 200,
			homeostasisBands: {},
			maxStepMultiplier: 3,
			breakerThreshold: 2,
			globalBreakerThreshold: 3,
			proactiveEnabled: true,
			...params.config
		};
		this.selfModel = params.selfModel;
		for (const knob of params.knobs) this.knobs.set(knob.id, knob);
		this.restore();
	}
	/**
	* 评估并调整（外环主入口；状态机单步推进）
	*
	* 每次调用 = 一份新心智报告 + 至多一个状态转移：
	* 观察窗满 → 判定（commit / rollback）；空闲 → 应用一个保守调整；
	* 观察中 → 仅累计进度；冻结 → no-op。
	*
	* 2.0：判定带护栏综合评判（学习器/包络/熔断器同步更新）；
	* 候选 = 反应式推荐 ∪ 前瞻风险建议，经学习器排序后保守应用
	* （稳态自适应步长 + 安全包络钳制 + 已知劣化值排除）。
	*/
	async evaluateAndAdjust() {
		const report = await this.selfModel.generateMentalReport();
		if (this.pending) {
			this.pending.reportsSeen += 1;
			if (this.pending.reportsSeen < this.pending.reportsNeeded) return this.buildReport("observing", report, { observation: {
				knob: this.pending.knob,
				reportsSeen: this.pending.reportsSeen,
				reportsNeeded: this.pending.reportsNeeded
			} });
			const verdict = this.judge(this.pending, report);
			const knob = this.knobs.get(this.pending.knob);
			const direction = this.pending.direction ?? "up";
			const source = this.pending.source;
			if (verdict.good || !knob) {
				const entry = this.appendAudit({
					type: "commit",
					knob: this.pending.knob,
					from: this.pending.from,
					to: this.pending.to,
					reason: `观察 ${this.pending.reportsNeeded} 份报告：${verdict.detail}，调整保留生效`,
					effect: verdict.effect,
					guardrail: verdict.guardrail,
					source,
					reportIndex: report.reportIndex
				});
				this.counters.commits += 1;
				this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, true, verdict.effect.delta);
				this.recordGoodValue(this.pending.knob, this.pending.to);
				this.onJudgedCommit(this.pending.knob);
				this.config.onCommit?.(entry);
				const result = this.buildReport("committed", report, { committed: {
					knob: this.pending.knob,
					effect: verdict.effect
				} });
				this.pending = void 0;
				this.persist();
				return result;
			}
			let rolledBackTo = this.pending.to;
			try {
				knob.write(this.pending.from);
				rolledBackTo = this.pending.from;
			} catch {}
			const entry = this.appendAudit({
				type: "rollback",
				knob: this.pending.knob,
				from: this.pending.to,
				to: rolledBackTo,
				reason: `观察期判定劣化（${verdict.detail}），自动回滚参数`,
				effect: verdict.effect,
				guardrail: verdict.guardrail,
				source,
				reportIndex: report.reportIndex
			});
			this.counters.rollbacks += 1;
			this.rolledBackAdjustIds.add(this.pending.adjustAuditId ?? "");
			this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, false, verdict.effect.delta);
			this.recordBadValue(this.pending.knob, this.pending.to);
			this.onJudgedRollback(this.pending.knob);
			this.config.onRollback?.(entry);
			const result = this.buildReport("rolled-back", report, { rolledBack: {
				knob: this.pending.knob,
				from: this.pending.to,
				to: rolledBackTo,
				reason: entry.reason,
				effect: verdict.effect
			} });
			this.pending = void 0;
			this.persist();
			return result;
		}
		if (this.frozen) return this.buildReport("frozen", report, { skippedReason: "自动调整已被手动冻结（setFrozen）" });
		if (this.frozenByBreaker) return this.buildReport("frozen", report, { skippedReason: `连续 ${this.config.globalBreakerThreshold} 次自动回滚触发全局熔断（reArmBreaker 可复位）` });
		const candidates = report.recommendedAdjustments.filter((r) => this.knobs.has(r.knob) && !this.manuallyFrozenKnobs.has(r.knob) && !this.trippedBreakers.has(r.knob)).map((r) => ({
			...r,
			source: "reactive"
		}));
		if (this.config.proactiveEnabled && report.proactiveRisks) for (const risk of report.proactiveRisks) {
			const knob = this.knobs.get(risk.suggestedKnob);
			if (!knob) continue;
			if (this.manuallyFrozenKnobs.has(knob.id) || this.trippedBreakers.has(knob.id)) continue;
			if (candidates.some((c) => c.knob === knob.id && c.direction === risk.suggestedDirection)) continue;
			candidates.push({
				knob: knob.id,
				label: knob.label,
				direction: risk.suggestedDirection,
				reason: `[前瞻] ${risk.description}，在指标仍健康时提前调整`,
				priority: risk.urgency,
				source: "proactive"
			});
		}
		if (candidates.length === 0) {
			const tripped = [...this.trippedBreakers];
			return this.buildReport("no-op", report, { skippedReason: tripped.length > 0 ? `无可用候选（推荐旋钮被手动接管或已熔断：${tripped.join("、")}）` : "无匹配旋钮或全部被手动接管" });
		}
		candidates.sort((a, b) => this.learner.selectionScore(b.priority, b.knob, b.direction, this.knobs.get(b.knob).judgeMetric) - this.learner.selectionScore(a.priority, a.knob, a.direction, this.knobs.get(a.knob).judgeMetric));
		const applied = [];
		for (const rec of candidates) {
			if (applied.length >= this.config.maxAdjustmentsPerRound) break;
			const knob = this.knobs.get(rec.knob);
			const current = knob.read();
			const direction = rec.direction === "up" ? 1 : -1;
			const stepMultiplier = this.stepMultiplierFor(knob, report);
			let next = current + direction * knob.step * stepMultiplier;
			next = knob.integer ? Math.round(next) : Number(next.toFixed(6));
			const envelope = this.envelopeOf(knob);
			next = Math.max(envelope.min, Math.min(envelope.max, next));
			if (knob.integer) next = Math.round(next);
			if (next === current) continue;
			if (this.isKnownBadValue(knob, next)) continue;
			try {
				knob.write(next);
			} catch {
				continue;
			}
			const entry = this.appendAudit({
				type: "adjust",
				knob: knob.id,
				from: current,
				to: next,
				reason: rec.reason,
				source: rec.source,
				reportIndex: report.reportIndex
			});
			this.counters.adjustments += 1;
			this.config.onAdjust?.(entry);
			applied.push({
				knob: knob.id,
				label: knob.label,
				from: current,
				to: next,
				reason: rec.reason,
				source: rec.source
			});
			this.pending = {
				knob: knob.id,
				from: current,
				to: next,
				reason: rec.reason,
				reportsSeen: 0,
				reportsNeeded: this.config.observationReports,
				judgeMetric: knob.judgeMetric,
				higherIsBetter: knob.higherIsBetter,
				baselineMetricValue: this.extractMetric(report, knob.judgeMetric),
				baselineMetrics: this.snapshotAllMetrics(report),
				direction: rec.direction,
				source: rec.source,
				appliedAt: Date.now(),
				adjustAuditId: entry.id
			};
			break;
		}
		if (applied.length === 0) return this.buildReport("no-op", report, { skippedReason: "推荐旋钮均已到达边界或命中已知劣化值，无可应用调整" });
		this.persist();
		return this.buildReport("adjusted", report, {
			applied,
			observation: {
				knob: this.pending.knob,
				reportsSeen: 0,
				reportsNeeded: this.pending.reportsNeeded
			}
		});
	}
	/**
	* 手动回滚最近一次调整
	*
	* 优先回滚观察窗中的调整；无观察中调整时回滚最近一次已提交
	* （未被回滚过）的调整。全部审计留痕。
	*/
	async rollbackLastAdjustment() {
		if (this.pending) {
			const knob = this.knobs.get(this.pending.knob);
			const { knob: knobId, from, to, reason } = this.pending;
			if (!knob) {
				this.pending = void 0;
				return {
					success: false,
					reason: "旋钮未注册",
					message: `旋钮 ${knobId} 未注册，仅清除观察状态`
				};
			}
			try {
				knob.write(from);
			} catch (error) {
				return {
					success: false,
					knob: knobId,
					reason: "写回失败",
					message: `回滚写回失败：${error.message}`
				};
			}
			const entry = this.appendAudit({
				type: "rollback",
				knob: knobId,
				from: to,
				to: from,
				reason: `手动回滚观察中的调整（原调整理由：${reason}）`
			});
			this.counters.rollbacks += 1;
			if (this.pending.adjustAuditId) this.rolledBackAdjustIds.add(this.pending.adjustAuditId);
			this.pending = void 0;
			this.persist();
			this.config.onRollback?.(entry);
			return {
				success: true,
				knob: knobId,
				from: to,
				to: from,
				reason: "手动回滚观察中的调整",
				message: `旋钮 ${knobId} 已从 ${to} 回滚到 ${from}`
			};
		}
		for (let i = this.audit.length - 1; i >= 0; i -= 1) {
			const entry = this.audit[i];
			if (entry.type !== "adjust" && entry.type !== "commit") continue;
			if (entry.type === "commit") continue;
			if (entry.knob === void 0 || entry.to === void 0 || entry.from === void 0) continue;
			if (this.rolledBackAdjustIds.has(entry.id)) continue;
			const knob = this.knobs.get(entry.knob);
			if (!knob) continue;
			try {
				knob.write(entry.from);
			} catch (error) {
				return {
					success: false,
					knob: entry.knob,
					reason: "写回失败",
					message: `回滚写回失败：${error.message}`
				};
			}
			this.rolledBackAdjustIds.add(entry.id);
			const rollbackEntry = this.appendAudit({
				type: "rollback",
				knob: entry.knob,
				from: entry.to,
				to: entry.from,
				reason: `手动回滚已提交的调整（原调整理由：${entry.reason}）`
			});
			this.counters.rollbacks += 1;
			this.persist();
			this.config.onRollback?.(rollbackEntry);
			return {
				success: true,
				knob: entry.knob,
				from: entry.to,
				to: entry.from,
				reason: "手动回滚已提交的调整",
				message: `旋钮 ${entry.knob} 已从 ${entry.to} 回滚到 ${entry.from}`
			};
		}
		return {
			success: false,
			reason: "无可回滚的调整",
			message: "审计日志中不存在未回滚的调整记录"
		};
	}
	/** 手动覆盖旋钮值：写入后该旋钮冻结自动调整（人工优先） */
	setManualOverride(knobId, value) {
		const knob = this.knobs.get(knobId);
		if (!knob) return {
			success: false,
			reason: "旋钮未注册",
			message: `旋钮 ${knobId} 不存在`
		};
		const from = knob.read();
		const clamped = Math.max(knob.min, Math.min(knob.max, knob.integer ? Math.round(value) : value));
		try {
			knob.write(clamped);
		} catch (error) {
			return {
				success: false,
				knob: knobId,
				reason: "写入失败",
				message: `手动覆盖失败：${error.message}`
			};
		}
		this.manuallyFrozenKnobs.add(knobId);
		if (this.pending?.knob === knobId) this.pending = void 0;
		this.appendAudit({
			type: "manual-override",
			knob: knobId,
			from,
			to: clamped,
			reason: `手动覆盖取值（自动调整已对该旋钮冻结）`
		});
		this.persist();
		return {
			success: true,
			knob: knobId,
			from,
			to: clamped,
			reason: "手动覆盖",
			message: `旋钮 ${knobId} 已手动设为 ${clamped}（原值 ${from}），该旋钮自动调整已冻结`
		};
	}
	/** 解除旋钮的手动接管（恢复自动调整资格） */
	clearManualOverride(knobId) {
		const removed = this.manuallyFrozenKnobs.delete(knobId);
		if (removed) {
			this.appendAudit({
				type: "freeze",
				knob: knobId,
				reason: "解除手动接管，恢复自动调整"
			});
			this.persist();
		}
		return removed;
	}
	/** 全局冻结 / 解冻自动调整 */
	setFrozen(frozen) {
		this.frozen = frozen;
		if (frozen && this.pending) {}
		this.appendAudit({
			type: "freeze",
			reason: frozen ? "全局冻结自动调整（手动接管）" : "解除全局冻结"
		});
		this.persist();
	}
	/** 运行状态（meta_cognition_status Tool / 审查入口） */
	getState() {
		const effectiveness = this.learner.effectiveness();
		return {
			frozen: this.frozen,
			manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
			circuitBreakers: this.breakerPanel(),
			frozenByBreaker: this.frozenByBreaker,
			learner: {
				totalTrials: this.learner.totalTrials,
				arms: effectiveness.length,
				explorationWeight: this.learner.averageConfidenceWeight(),
				effectiveness
			},
			safeEnvelopes: [...this.knobs.values()].map((k) => this.envelopeOf(k)),
			pending: this.pending ? {
				knob: this.pending.knob,
				from: this.pending.from,
				to: this.pending.to,
				reason: this.pending.reason,
				reportsSeen: this.pending.reportsSeen,
				reportsNeeded: this.pending.reportsNeeded,
				judgeMetric: this.pending.judgeMetric,
				baselineMetricValue: this.pending.baselineMetricValue
			} : void 0,
			knobs: [...this.knobs.values()].map((k) => ({
				id: k.id,
				label: k.label,
				category: k.category,
				current: k.read(),
				min: k.min,
				max: k.max,
				step: k.step,
				manuallyFrozen: this.manuallyFrozenKnobs.has(k.id),
				breakerTripped: this.trippedBreakers.has(k.id)
			})),
			auditTrail: [...this.audit],
			totalAdjustments: this.counters.adjustments,
			totalRollbacks: this.counters.rollbacks,
			totalCommits: this.counters.commits
		};
	}
	/** 审计日志（全量，升序） */
	getAuditTrail() {
		return [...this.audit];
	}
	/**
	* 观察期满判定：劣化超容忍 → 回滚
	*
	* 2.0 综合判定护栏：目标指标未劣化但操作环成功率显著下滑 → 一律判失败。
	* 单指标优化不得以整体劣化为代价（guardrail violated → rollback）。
	*/
	judge(pending, report) {
		const after = this.extractMetric(report, pending.judgeMetric);
		const before = pending.baselineMetricValue;
		const delta = after - before;
		const progress = pending.higherIsBetter ? delta : -delta;
		let good = progress >= -this.config.degradationTolerance;
		let detail = `${JUDGE_METRIC_LABELS[pending.judgeMetric]} ${before.toFixed(4)} → ${after.toFixed(4)}（${progress >= 0 ? "改善" : "劣化"} ${Math.abs(progress).toFixed(4)}，容忍 ${this.config.degradationTolerance}）`;
		let guardrail;
		if (pending.baselineMetrics && pending.judgeMetric !== "operationalSuccessRate") {
			const grBefore = pending.baselineMetrics.operationalSuccessRate;
			const grAfter = this.extractMetric(report, "operationalSuccessRate");
			const violated = grAfter < grBefore - this.config.degradationTolerance;
			guardrail = {
				metric: "operationalSuccessRate",
				before: grBefore,
				after: grAfter,
				delta: grAfter - grBefore,
				violated
			};
			if (violated) {
				good = false;
				detail += `；护栏违规：操作环成功率 ${grBefore.toFixed(4)} → ${grAfter.toFixed(4)}（劣化 ${(grBefore - grAfter).toFixed(4)}）`;
			}
		}
		return {
			good,
			effect: {
				metric: pending.judgeMetric,
				before,
				after,
				delta,
				good
			},
			guardrail,
			detail
		};
	}
	/** 全指标基线快照（护栏综合判定的 before 数据） */
	snapshotAllMetrics(report) {
		return {
			operationalSuccessRate: this.extractMetric(report, "operationalSuccessRate"),
			discoveryRate: this.extractMetric(report, "discoveryRate"),
			proceduralGrowth: this.extractMetric(report, "proceduralGrowth"),
			pendingDistillation: this.extractMetric(report, "pendingDistillation"),
			survivalRate: this.extractMetric(report, "survivalRate")
		};
	}
	/**
	* 稳态步长倍率（1~maxStepMultiplier）：
	* 判定指标配置了目标带 → 偏离带越远倍率越大（比例控制，量化档位）；
	* 未配置目标带 → 1（行为与 1.0 固定步长一致）。
	*/
	stepMultiplierFor(knob, report) {
		const band = this.config.homeostasisBands[knob.judgeMetric];
		if (!band) return 1;
		const { deviation } = computeHomeostasis(band, this.extractMetric(report, knob.judgeMetric));
		if (deviation <= 0) return 1;
		const raw = 1 + deviation * 2;
		return Math.max(1, Math.min(Math.ceil(raw), this.config.maxStepMultiplier));
	}
	/** 旋钮当前安全包络：有 commit 好值 → 好值区间 ± 一步长；否则旋钮原始边界 */
	envelopeOf(knob) {
		const good = this.envelopeGood.get(knob.id) ?? [];
		const bad = this.envelopeBad.get(knob.id) ?? [];
		if (good.length === 0) return {
			knob: knob.id,
			min: knob.min,
			max: knob.max,
			source: "default",
			sampleCount: 0,
			knownBadValues: bad
		};
		const learnedMin = Math.max(knob.min, Number((Math.min(...good) - knob.step).toFixed(6)));
		const learnedMax = Math.min(knob.max, Number((Math.max(...good) + knob.step).toFixed(6)));
		return {
			knob: knob.id,
			min: learnedMin,
			max: learnedMax,
			source: "learned",
			sampleCount: good.length,
			knownBadValues: bad
		};
	}
	/** 已知劣化值判定（数值直接相等，或整数旋钮按四舍五入相等） */
	isKnownBadValue(knob, value) {
		const bad = this.envelopeBad.get(knob.id);
		if (!bad || bad.length === 0) return false;
		return bad.some((b) => knob.integer ? Math.round(b) === Math.round(value) : b === value);
	}
	/** commit 判定后收录好值（安全包络的「已验证安全」样本） */
	recordGoodValue(knobId, value) {
		const values = this.envelopeGood.get(knobId) ?? [];
		if (!values.includes(value)) values.push(value);
		if (values.length > 8) values.shift();
		this.envelopeGood.set(knobId, values);
	}
	/** 自动回滚后标记劣化值（后续调整预防性排除） */
	recordBadValue(knobId, value) {
		const values = this.envelopeBad.get(knobId) ?? [];
		if (!values.includes(value)) values.push(value);
		if (values.length > 8) values.shift();
		this.envelopeBad.set(knobId, values);
	}
	/** 单次判定保留：该旋钮连续回滚清零、全局连续回滚清零 */
	onJudgedCommit(knobId) {
		this.breakerCounters.set(knobId, 0);
		this.globalRollbackStreak = 0;
	}
	/** 单次判定回滚：推进单旋钮与全局连续回滚计数，达阈值触发熔断 */
	onJudgedRollback(knobId) {
		const knobStreak = (this.breakerCounters.get(knobId) ?? 0) + 1;
		this.breakerCounters.set(knobId, knobStreak);
		if (knobStreak >= this.config.breakerThreshold && !this.trippedBreakers.has(knobId)) {
			this.trippedBreakers.add(knobId);
			this.appendAudit({
				type: "circuit-breaker",
				knob: knobId,
				reason: `旋钮连续 ${knobStreak} 次自动回滚，熔断其自动调整（reArmBreaker 可复位）`
			});
		}
		this.globalRollbackStreak += 1;
		if (this.globalRollbackStreak >= this.config.globalBreakerThreshold && !this.frozenByBreaker) {
			this.frozenByBreaker = true;
			this.appendAudit({
				type: "circuit-breaker",
				reason: `全局连续 ${this.globalRollbackStreak} 次自动回滚，触发全局熔断（reArmBreaker 可复位）`
			});
		}
	}
	/** 熔断器面板（getState / 心智报告共享） */
	breakerPanel() {
		return [...this.knobs.values()].map((k) => {
			const streak = this.breakerCounters.get(k.id) ?? 0;
			const tripped = this.trippedBreakers.has(k.id);
			return {
				knob: k.id,
				consecutiveRollbacks: streak,
				tripped,
				reason: tripped ? `连续 ${streak} 次自动回滚熔断` : void 0
			};
		});
	}
	/**
	* 熔断器手动复位（公共 API）
	*
	* - 指定 knobId：复位该旋钮熔断（清零计数 + 解除熔断）
	* - 不指定：复位全局熔断 + 全部旋钮熔断与计数
	* 返回是否发生了实际复位动作。
	*/
	reArmBreaker(knobId) {
		if (knobId) {
			const had = this.trippedBreakers.delete(knobId);
			const streak = this.breakerCounters.get(knobId) ?? 0;
			this.breakerCounters.set(knobId, 0);
			if (had || streak > 0) {
				this.appendAudit({
					type: "circuit-breaker",
					knob: knobId,
					reason: "手动复位旋钮熔断器，恢复自动调整"
				});
				this.persist();
				return true;
			}
			return false;
		}
		const anyTripped = this.frozenByBreaker || this.trippedBreakers.size > 0;
		this.frozenByBreaker = false;
		this.trippedBreakers.clear();
		this.breakerCounters.clear();
		this.globalRollbackStreak = 0;
		if (anyTripped) {
			this.appendAudit({
				type: "circuit-breaker",
				reason: "手动复位全局与全部旋钮熔断器，恢复自动调整"
			});
			this.persist();
		}
		return anyTripped;
	}
	/** 从心智报告提取判定指标 */
	extractMetric(report, metric) {
		switch (metric) {
			case "operationalSuccessRate": return report.strategyPerformance.operational.successRate;
			case "discoveryRate": return report.evolverEfficiency.discoveryRate;
			case "proceduralGrowth": return report.memoryQuality.counts.procedural;
			case "pendingDistillation": return report.memoryQuality.distillation.pendingSinceLastDistillation;
			case "survivalRate": return report.evolverEfficiency.survivalRate;
		}
	}
	appendAudit(entry) {
		this.auditSeq += 1;
		const full = {
			id: `audit-${this.auditSeq}`,
			timestamp: Date.now(),
			type: entry.type,
			knob: entry.knob,
			from: entry.from,
			to: entry.to,
			reason: entry.reason,
			effect: entry.effect,
			guardrail: entry.guardrail,
			source: entry.source,
			reportIndex: entry.reportIndex
		};
		this.audit.push(full);
		if (this.audit.length > this.config.auditLimit) this.audit.shift();
		return full;
	}
	buildReport(status, mentalReport, extra = {}) {
		return {
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			reportIndex: mentalReport.reportIndex,
			status,
			applied: extra.applied ?? [],
			rolledBack: extra.rolledBack,
			committed: extra.committed,
			observation: extra.observation,
			skippedReason: extra.skippedReason,
			mentalReport
		};
	}
	persist() {
		if (!this.config.persistPath) return;
		try {
			const payload = {
				audit: this.audit,
				pending: this.pending,
				frozen: this.frozen,
				manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
				rolledBackAdjustIds: [...this.rolledBackAdjustIds],
				counters: this.counters,
				auditSeq: this.auditSeq,
				learner: this.learner.dump(),
				envelopeGood: Object.fromEntries(this.envelopeGood),
				envelopeBad: Object.fromEntries(this.envelopeBad),
				breakerCounters: Object.fromEntries(this.breakerCounters),
				trippedBreakers: [...this.trippedBreakers],
				globalRollbackStreak: this.globalRollbackStreak,
				frozenByBreaker: this.frozenByBreaker
			};
			fs.writeFileSync(this.config.persistPath, JSON.stringify(payload), "utf-8");
		} catch {}
	}
	restore() {
		if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.config.persistPath, "utf-8"));
			if (Array.isArray(parsed.audit)) this.audit = parsed.audit;
			this.pending = parsed.pending;
			this.frozen = parsed.frozen === true;
			this.manuallyFrozenKnobs = new Set(parsed.manuallyFrozenKnobs ?? []);
			this.rolledBackAdjustIds = new Set(parsed.rolledBackAdjustIds ?? []);
			if (parsed.counters) this.counters = parsed.counters;
			if (typeof parsed.auditSeq === "number") this.auditSeq = parsed.auditSeq;
			this.learner.load(parsed.learner, (knob) => this.knobs.get(knob)?.judgeMetric ?? "operationalSuccessRate");
			this.envelopeGood = new Map(Object.entries(parsed.envelopeGood ?? {}).map(([k, v]) => [k, [...v]]));
			this.envelopeBad = new Map(Object.entries(parsed.envelopeBad ?? {}).map(([k, v]) => [k, [...v]]));
			this.breakerCounters = new Map(Object.entries(parsed.breakerCounters ?? {}));
			this.trippedBreakers = new Set(parsed.trippedBreakers ?? []);
			this.globalRollbackStreak = parsed.globalRollbackStreak ?? 0;
			this.frozenByBreaker = parsed.frozenByBreaker === true;
		} catch {}
	}
};
/** 判定指标人类可读标签 */
const JUDGE_METRIC_LABELS = {
	operationalSuccessRate: "操作环成功率",
	discoveryRate: "进化发现速率",
	proceduralGrowth: "程序记忆累积量",
	pendingDistillation: "蒸馏积压水位",
	survivalRate: "新策略存活率"
};
//#endregion
//#region src/world-model.ts
/** 默认配置 */
const DEFAULT_WORLD_MODEL_CONFIG = {
	maxTimestampsPerType: 500,
	coOccurrenceWindowMs: 6e4,
	minSamplesForTrend: 6,
	risingSlopeThreshold: .05,
	calibrationErrorThreshold: 2
};
/**
* 世界模型
*
* 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
* 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
*
* 5.0 质变（因果升级）：挂载 CausalKernel 后，本模型从「相关性预测器」
* 升级为「因果预见器」——predictInterventionEffect(action, kpi) 直接回答
* 「若我对系统实施 do(action)，目标 KPI 期望变化几何（含不确定性区间）」。
* 相关矩阵负责「看见规律」，因果图负责「预见干预后果」——
* 二者的显著背离（混杂指纹）在 getSummary() 中显式曝光。
*/
var WorldModel = class {
	config;
	stats = /* @__PURE__ */ new Map();
	calibrations = [];
	/** 待校准的预测（type → 预测值，窗口结束后对账） */
	pendingPredictions = /* @__PURE__ */ new Map();
	/** 5.0：因果内核（可选挂载） */
	causal;
	constructor(config) {
		this.config = {
			...DEFAULT_WORLD_MODEL_CONFIG,
			...config
		};
	}
	/**
	* 5.0：挂载因果内核（幂等）。
	*
	* 挂载后：
	* - 类型共现自动作为观测证据写入因果图（银级证据）；
	* - predictInterventionEffect 提供因果预见（黄金口径）。
	*/
	attachCausalKernel(kernel) {
		this.causal = kernel;
		for (const corr of this.getCorrelations(.05)) for (let k = 0; k < Math.min(corr.coOccurrences, 20); k += 1) kernel.observe(`signal:${corr.typeA}`, `signal:${corr.typeB}`, true, true);
	}
	/**
	* 5.0：因果预见 ——「若实施 do(action)，目标指标期望如何变化」。
	*
	* 与 predictArrivals 的本质区别：那是「世界自己会怎样」（外推），
	* 这是「我们主动干预后世界会怎样」（因果阶梯第二层）。
	* 无因果证据时诚实返回 null，而非伪装成知道。
	*/
	predictInterventionEffect(action, targetKpi) {
		if (!this.causal) return null;
		const eff = this.causal.effect(action, targetKpi);
		if (eff.interventionalSamples + eff.observationalSamples === 0) return null;
		return eff;
	}
	/** 5.0：登记一次真实干预（A/B 切换 / 参数实验的黄金证据） */
	recordIntervention(action, targetKpi, setTo, observedY, actor, hypothesis) {
		this.causal?.intervene(action, targetKpi, setTo, observedY, actor, hypothesis);
	}
	/**
	* 观察一次信号到达（增量学习入口）
	* @param type 信号类型
	* @param timestamp 到达时间戳（缺省当前时间）
	*/
	observeArrival(type, timestamp = Date.now()) {
		let entry = this.stats.get(type);
		if (!entry) {
			entry = {
				type,
				timestamps: [],
				hourHistogram: new Array(24).fill(0),
				totalCount: 0,
				firstSeenAt: timestamp,
				lastSeenAt: timestamp
			};
			this.stats.set(type, entry);
		}
		entry.timestamps.push(timestamp);
		if (entry.timestamps.length > this.config.maxTimestampsPerType) entry.timestamps.splice(0, entry.timestamps.length - this.config.maxTimestampsPerType);
		entry.hourHistogram[new Date(timestamp).getHours()] += 1;
		entry.totalCount += 1;
		entry.lastSeenAt = timestamp;
	}
	/**
	* 预测未来窗口内各类型信号的到达数
	* @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
	* @returns 各类型的到达预测（按期望到达数降序）
	*/
	predictArrivals(horizonMs = 3e5) {
		const now = Date.now();
		const predictions = [];
		for (const [type, entry] of this.stats) {
			const ratePerMs = this.recentRate(entry, now);
			const trend = this.trendOf(entry, now);
			const trendFactor = trend === "rising" ? 1.25 : trend === "falling" ? .75 : 1;
			const adjusted = ratePerMs * horizonMs * trendFactor * this.hourFactor(entry, now + horizonMs / 2);
			const spread = Math.sqrt(Math.max(adjusted, .5));
			const confidence = this.calibrationConfidence(type);
			predictions.push({
				type,
				expectedCount: Number(adjusted.toFixed(2)),
				lowerBound: Math.max(0, Number((adjusted - spread).toFixed(2))),
				upperBound: Number((adjusted + spread).toFixed(2)),
				confidence,
				trend
			});
			this.pendingPredictions.set(type, {
				predicted: adjusted,
				windowEnd: now + horizonMs
			});
		}
		return predictions.sort((a, b) => b.expectedCount - a.expectedCount);
	}
	/**
	* 对账预测与实际到达（校准）
	* @returns 本轮新增的校准记录
	*/
	settleCalibrations(now = Date.now()) {
		const settled = [];
		for (const [type, pending] of this.pendingPredictions) {
			if (pending.windowEnd > now) continue;
			const entry = this.stats.get(type);
			const windowStart = pending.windowEnd - this.lastHorizonMs;
			const actualCount = entry ? entry.timestamps.filter((t) => t > windowStart && t <= pending.windowEnd).length : 0;
			const record = {
				type,
				predicted: Number(pending.predicted.toFixed(2)),
				actual: actualCount,
				error: Number(Math.abs(pending.predicted - actualCount).toFixed(2)),
				timestamp: now
			};
			this.calibrations.push(record);
			settled.push(record);
			this.pendingPredictions.delete(type);
		}
		if (this.calibrations.length > 200) this.calibrations.splice(0, this.calibrations.length - 200);
		return settled;
	}
	/**
	* 类型关联矩阵（共现强度）
	* @param minStrength 最低关联强度过滤
	* @returns 类型对关联列表（按强度降序）
	*/
	getCorrelations(minStrength = .1) {
		const types = [...this.stats.keys()];
		const correlations = [];
		for (let i = 0; i < types.length; i += 1) for (let j = i + 1; j < types.length; j += 1) {
			const a = this.stats.get(types[i]);
			const b = this.stats.get(types[j]);
			const coOccurrences = this.countCoOccurrences(a.timestamps, b.timestamps);
			if (coOccurrences === 0) continue;
			const strength = coOccurrences / Math.max(1, Math.min(a.totalCount, b.totalCount));
			if (strength >= minStrength) correlations.push({
				typeA: types[i],
				typeB: types[j],
				coOccurrences,
				strength: Number(strength.toFixed(3))
			});
		}
		return correlations.sort((x, y) => y.strength - x.strength);
	}
	/**
	* 趋势检测：识别到达率上升的类型（负载预警）
	* @returns 上升趋势的类型列表（含斜率）
	*/
	detectTrends() {
		const now = Date.now();
		const results = [];
		for (const [type, entry] of this.stats) {
			const slope = this.slopeOf(entry, now);
			const trend = slope > this.config.risingSlopeThreshold ? "rising" : slope < -this.config.risingSlopeThreshold ? "falling" : "stable";
			results.push({
				type,
				trend,
				slopePerMin: Number(slope.toFixed(4))
			});
		}
		return results.sort((a, b) => b.slopePerMin - a.slopePerMin);
	}
	/** 世界模型摘要 */
	getSummary() {
		const types = [...this.stats.keys()];
		return {
			trackedTypes: types.length,
			totalArrivals: types.reduce((sum, t) => sum + this.stats.get(t).totalCount, 0),
			types: types.map((t) => {
				const entry = this.stats.get(t);
				return {
					type: t,
					totalCount: entry.totalCount,
					lastSeenAt: entry.lastSeenAt,
					recentRatePerMin: Number((this.recentRate(entry, Date.now()) * 6e4).toFixed(3))
				};
			}),
			correlations: this.getCorrelations().slice(0, 10),
			trends: this.detectTrends().filter((t) => t.trend !== "stable"),
			calibrationError: this.meanCalibrationError(),
			confoundedPairs: this.causal ? this.causal.detectConfounding().filter((e) => e.from.startsWith("signal:") && e.to.startsWith("signal:")).slice(0, 5).map((e) => ({
				typeA: e.from.replace("signal:", ""),
				typeB: e.to.replace("signal:", ""),
				observationalStrength: e.observationalAssociation,
				causalEffect: e.ate,
				divergence: e.divergence
			})) : void 0
		};
	}
	/** 平均校准误差（MAE） */
	meanCalibrationError() {
		if (this.calibrations.length === 0) return 0;
		return Number((this.calibrations.reduce((sum, c) => sum + c.error, 0) / this.calibrations.length).toFixed(3));
	}
	/** 序列化 */
	serialize() {
		return {
			stats: [...this.stats.values()],
			calibrations: [...this.calibrations]
		};
	}
	/** 反序列化 */
	deserialize(data) {
		this.stats.clear();
		for (const entry of data.stats) this.stats.set(entry.type, entry);
		this.calibrations = [...data.calibrations];
	}
	/** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
	recentRate(entry, now) {
		const windowMs = 3e5;
		const recent = entry.timestamps.filter((t) => t >= now - windowMs);
		if (recent.length === 0) return 0;
		return recent.length / windowMs;
	}
	/** 时段热度因子：目标时段计数 / 全天均值 */
	hourFactor(entry, targetTimestamp) {
		const total = entry.hourHistogram.reduce((a, b) => a + b, 0);
		if (total === 0) return 1;
		const hour = new Date(targetTimestamp).getHours();
		const mean = total / 24;
		if (mean === 0) return 1;
		return Math.max(.5, Math.min(2, entry.hourHistogram[hour] / mean));
	}
	/** 趋势方向（由斜率判定） */
	trendOf(entry, now) {
		const slope = this.slopeOf(entry, now);
		if (slope > this.config.risingSlopeThreshold) return "rising";
		if (slope < -this.config.risingSlopeThreshold) return "falling";
		return "stable";
	}
	/** 到达率线性回归斜率（每分钟到达数 / 分钟） */
	slopeOf(entry, now) {
		const windowMs = 6e5;
		const recent = entry.timestamps.filter((t) => t >= now - windowMs);
		if (recent.length < this.config.minSamplesForTrend) return 0;
		const mid = now - windowMs / 2;
		const firstHalf = recent.filter((t) => t < mid).length;
		const secondHalf = recent.filter((t) => t >= mid).length;
		const halfMinutes = windowMs / 2 / 6e4;
		return (secondHalf - firstHalf) / halfMinutes / halfMinutes;
	}
	/** 共现计数：两序列中时间邻近的配对数 */
	countCoOccurrences(a, b) {
		let count = 0;
		let j = 0;
		for (let i = 0; i < a.length; i += 1) {
			while (j < b.length && b[j] < a[i] - this.config.coOccurrenceWindowMs) j += 1;
			for (let k = j; k < b.length && b[k] <= a[i] + this.config.coOccurrenceWindowMs; k += 1) count += 1;
		}
		return count;
	}
	/** 预测置信度（由该类型历史校准误差驱动） */
	calibrationConfidence(type) {
		const records = this.calibrations.filter((c) => c.type === type);
		if (records.length === 0) return .5;
		const mae = records.reduce((sum, c) => sum + c.error, 0) / records.length;
		if (mae > this.config.calibrationErrorThreshold) return .3;
		return Math.max(.4, Math.min(.95, 1 - mae / (this.config.calibrationErrorThreshold * 2)));
	}
	/** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
	get lastHorizonMs() {
		return 3e5;
	}
};
//#endregion
//#region src/core/causal-kernel.ts
/**
* causal-kernel.ts — 因果内核（项目 5.0「从相关到因果」的质变基座）
*
* 升级前的根本局限（全模块通病）：
* - 证据内核（evidence.ts）回答的是 P(成功 | 特征) —— 这是相关性；
*   系统据此排序/调度/分红，但从未回答「正是这个因素导致了结果吗？」
* - 相关 ≠ 因果的典型陷阱：健康模型总被派发简单任务 → 观测成功率虚高
*   （任务难度是混杂因子）；某策略与成功共现 → 可能只是都发生在低峰期。
* - 一切「调参 / 换模型 / 进化」的决策依据都停留在 observational 层。
*
* 本内核引入 Pearl 因果阶梯的第二层 —— do-干预：
* 1. 双流证据：每条因果边同时维护「干预证据」（do(X=x) 后观测 Y，
*    如 A/B 实验真实切换）与「观测证据」（被动共现）——两层统计口径
*    显式分离，永不混账。
* 2. 干预效应估计：ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0))，
*    每臂独立 Beta 后验 + Wilson 风格保守下界 —— 小样本实验不虚报因果。
* 3. 混杂检测：观测关联与干预效应的显著背离 = 混杂因子的指纹。
*    「冰淇淋销量 ↔ 溺水」类伪因果在此被自动标记（observationalOnly
*    边的因果置信度被结构性折扣）。
* 4. 反事实查询：actualOutcome 与 alternativeAction 的效应对比 ——
*    「若当时选 B，成功概率几何」从哲学问题变为区间估计。
* 5. 实验设计（好奇心接口）：不确定性最高（Beta 区间最宽）× 重要性
*    最高（关联目标 KPI）的边优先做 do-实验 —— 假设驱动的好奇心。
*
* 与证据内核的关系：causal-kernel 建立在 evidence.ts 的同一套统计语言
* （Beta 后验 / Wilson 下界 / 30 天时间衰减）之上，但回答的问题升了一层：
* evidence.ts 问「它表现如何」，causal-kernel 问「是不是它造成的」。
*
* 审计性：全部干预记录（谁、何时、do 了什么、结果）保留链式日志，
* 因果结论可追溯到每一次实验 —— 因果断言可被审计、可被证伪。
*/
const DEFAULT_CAUSAL_CONFIG = {
	confoundingThreshold: .2,
	establishedConfidence: .5,
	maxInterventionLog: 2e3,
	experimentMinUncertainty: .4
};
/**
* 因果内核：全系统共享的因果图 + do-干预登记处。
*
* 消费方：
* - symbiosis/runtime：Shapley 分红用因果效应（而非线性权重）定价贡献
* - world-model：do-干预效应预测（预见「若我这样做，世界会怎样」）
* - reflection-engine：反事实反思（失败 → 「若选 B」教训）
* - meta-cognition：旋钮推荐按因果效应排序（而非规则命中顺序）
* - curiosity-engine：假设驱动实验设计（不确定性边 → do-实验 → 图更新）
*/
var CausalKernel = class {
	config;
	nodeMap = /* @__PURE__ */ new Map();
	/** 边键 `${from}→${to}` */
	edgeMap = /* @__PURE__ */ new Map();
	/** 干预审计链（seq 单调递增） */
	interventionLog = [];
	seq = 0;
	constructor(config) {
		this.config = {
			...DEFAULT_CAUSAL_CONFIG,
			...config
		};
	}
	/** 登记因果节点（幂等；重复登记仅更新元信息） */
	addNode(node) {
		this.nodeMap.set(node.id, {
			...node,
			label: node.label ?? node.id
		});
	}
	/** 便捷登记：模型动作节点（from 形如 `use:model-x`） */
	ensureNodes(from, to, fromKind, toKind) {
		if (!this.nodeMap.has(from)) this.addNode({
			id: from,
			kind: fromKind
		});
		if (!this.nodeMap.has(to)) this.addNode({
			id: to,
			kind: toKind
		});
		const key = `${from}→${to}`;
		let edge = this.edgeMap.get(key);
		if (!edge) {
			const now = Date.now();
			edge = {
				from,
				to,
				evidence: {
					doXSuccess: 0,
					doXFailure: 0,
					doNotXSuccess: 0,
					doNotXFailure: 0,
					obsBoth: 0,
					obsXOnly: 0,
					obsYOnly: 0,
					obsNeither: 0,
					lastDecayedAt: now
				},
				createdAt: now,
				lastTouchedAt: now
			};
			this.edgeMap.set(key, edge);
		}
		return edge;
	}
	/**
	* 被动观测（银级证据）：X 与 Y 的共现 —— 不做任何设定，只是看到。
	*
	* 观测证据只影响 observationalAssociation 与混杂度计算；
	* 无干预证据时作为 ATE 的降权回退估计。
	*/
	observe(from, to, x, y, now = Date.now()) {
		const edge = this.ensureNodes(from, to, "action", "kpi");
		this.decayEdge(edge, now);
		if (x && y) edge.evidence.obsBoth += 1;
		else if (x) edge.evidence.obsXOnly += 1;
		else if (y) edge.evidence.obsYOnly += 1;
		else edge.evidence.obsNeither += 1;
		edge.lastTouchedAt = now;
	}
	/**
	* do-干预（黄金证据）：主动把 X 设为 setTo，观测结果 Y。
	*
	* 这是因果阶梯第二层的唯一入口 —— 每次真实 A/B 切换、每次参数实验、
	* 每次沙盒部署对照都应经此登记。审计链保留完整因果断言来源。
	*
	* @param actor 干预发起方（审计用）
	* @param hypothesis 实验假设（如「切换 model-b 可提升翻译成功率」）
	*/
	intervene(from, to, setTo, observedY, actor, hypothesis, now = Date.now()) {
		const edge = this.ensureNodes(from, to, "action", "kpi");
		this.decayEdge(edge, now);
		if (setTo) {
			if (observedY) edge.evidence.doXSuccess += 1;
			else edge.evidence.doXFailure += 1;
		} else if (observedY) edge.evidence.doNotXSuccess += 1;
		else edge.evidence.doNotXFailure += 1;
		edge.lastTouchedAt = now;
		this.seq += 1;
		const record = {
			seq: this.seq,
			timestamp: now,
			from,
			to,
			setTo,
			observedY,
			actor,
			hypothesis
		};
		this.interventionLog.push(record);
		if (this.interventionLog.length > this.config.maxInterventionLog) this.interventionLog.splice(0, this.interventionLog.length - this.config.maxInterventionLog);
		return record;
	}
	/**
	* 估计因果效应 ATE（对一条边的完整因果问答）。
	*
	* 口径优先级：
	* 1. 双臂干预证据齐全 → 纯干预 ATE（黄金口径）
	* 2. 仅处理臂 → 对照臂回退观测基线 P(Y=1|X=0)，混杂折扣已含在 confidence
	* 3. 无任何干预 → ATE = 观测关联 × 0.5（结构性折扣：未经实验的关联
	*    只值一半信任），confidence 上限 0.4（永不 established）
	*/
	effect(from, to, now = Date.now()) {
		const key = `${from}→${to}`;
		const edge = this.edgeMap.get(key);
		if (!edge) return {
			from,
			to,
			ate: 0,
			lower: 0,
			upper: 0,
			pDo: .5,
			pDoNot: .5,
			interventionalSamples: 0,
			observationalSamples: 0,
			observationalAssociation: 0,
			confounding: 0,
			confidence: 0,
			direction: "none",
			established: false
		};
		const ev = this.decayedView(edge, now);
		const doN = ev.doXSuccess + ev.doXFailure;
		const doNotN = ev.doNotXSuccess + ev.doNotXFailure;
		const obsX1 = ev.obsBoth + ev.obsXOnly;
		const obsX0 = ev.obsYOnly + ev.obsNeither;
		const obsAll = obsX1 + obsX0;
		const pDo = doN > 0 ? (ev.doXSuccess + 1) / (doN + 2) : obsX1 > 0 ? (ev.obsBoth + 1) / (obsX1 + 2) : .5;
		const pDoNot = doNotN > 0 ? (ev.doNotXSuccess + 1) / (doNotN + 2) : obsX0 > 0 ? (ev.obsYOnly + 1) / (obsX0 + 2) : .5;
		const obsAssociation = obsX1 > 0 && obsX0 > 0 ? ev.obsBoth / obsX1 - ev.obsYOnly / obsX0 : 0;
		const usedDo = doN > 0 || doNotN > 0;
		const ate = pDo - pDoNot;
		const [doLower, doUpper] = doN >= 1 ? [wilsonLowerBound(ev.doXSuccess, ev.doXFailure), wilsonUpperBound(ev.doXSuccess, ev.doXFailure)] : obsX1 >= 1 ? [wilsonLowerBound(ev.obsBoth, ev.obsXOnly), wilsonUpperBound(ev.obsBoth, ev.obsXOnly)] : [0, 1];
		const [doNotLower, doNotUpper] = doNotN >= 1 ? [wilsonLowerBound(ev.doNotXSuccess, ev.doNotXFailure), wilsonUpperBound(ev.doNotXSuccess, ev.doNotXFailure)] : obsX0 >= 1 ? [wilsonLowerBound(ev.obsYOnly, ev.obsNeither), wilsonUpperBound(ev.obsYOnly, ev.obsNeither)] : [0, 1];
		const conservativeLower = Math.max(-1, doLower - doNotUpper);
		const conservativeUpper = Math.min(1, doUpper - doNotLower);
		const divergence = usedDo && obsX1 >= 1 && obsX0 >= 1 && obsAll >= 4 ? Math.abs(obsAssociation - ate) : 0;
		const confounding = Math.min(1, divergence / Math.max(.5, Math.abs(obsAssociation) + Math.abs(ate)));
		const interventionalSamples = doN + doNotN;
		const evidenceStrength = Math.min(1, interventionalSamples / 10);
		const obsOnlyCap = .4;
		const freshness = decayFactor(now - edge.lastTouchedAt, 30);
		let confidence = evidenceStrength * (1 - .5 * confounding) * Math.max(.5, freshness);
		if (!usedDo) confidence = Math.min(confidence, obsOnlyCap * Math.min(1, obsAll / 10));
		const direction = ate > .02 ? "positive" : ate < -.02 ? "negative" : "none";
		const established = usedDo && confidence >= this.config.establishedConfidence && (conservativeLower > 0 || conservativeUpper < 0);
		return {
			from,
			to,
			ate: round$6(ate),
			lower: round$6(Math.max(-1, conservativeLower)),
			upper: round$6(Math.min(1, conservativeUpper)),
			pDo: round$6(pDo),
			pDoNot: round$6(pDoNot),
			interventionalSamples,
			observationalSamples: obsAll,
			observationalAssociation: round$6(obsAssociation),
			confounding: round$6(confounding),
			confidence: round$6(confidence),
			direction,
			established
		};
	}
	/**
	* 因果排序：谁真正导致了 target（按效应下界降序）。
	*
	* 质变点：传统排序 = 相关性命中；本排序 = 已确立因果 > 高置信正效应 >
	* 待验证正效应。混杂严重的边即使观测关联再强也排不上来。
	*/
	rankCauses(target, now = Date.now()) {
		const effects = [];
		for (const edge of this.edgeMap.values()) {
			if (edge.to !== target) continue;
			effects.push(this.effect(edge.from, edge.to, now));
		}
		return effects.sort((a, b) => {
			if (a.established !== b.established) return a.established ? -1 : 1;
			return b.lower * b.confidence - a.lower * a.confidence;
		});
	}
	/**
	* 混杂指纹检测：观测关联强但干预效应弱（或方向相反）的边。
	*
	* 返回的每条边都是一次「我们曾以为的因果」的证伪现场 ——
	* 调度器/优化器依赖这些边做的历史决策值得复查。
	*/
	detectConfounding(now = Date.now()) {
		const flagged = [];
		for (const edge of this.edgeMap.values()) {
			const eff = this.effect(edge.from, edge.to, now);
			if (eff.interventionalSamples < 3 || eff.observationalSamples < 4) continue;
			if (eff.confounding <= 0) continue;
			const divergence = Math.abs(eff.observationalAssociation - eff.ate);
			if (divergence >= this.config.confoundingThreshold) flagged.push({
				...eff,
				divergence: round$6(divergence)
			});
		}
		return flagged.sort((a, b) => b.divergence - a.divergence);
	}
	/**
	* 6.0：因果中介分析 —— 效应「经由什么机制」发生。
	*
	* X → M → Y 链上的效应分解（线性链近似，效应尺度用 ATE）：
	* - 总效应 total = effect(X→Y)
	* - 间接效应（经中介）indirect = effect(X→M) × effect(M→Y)
	* - 直接效应（绕过中介）direct = total − indirect
	* - 中介占比 share = indirect / |total|
	*
	* 质变点：此前系统只知道「模型 A 有效」，不知道「为什么有效」。
	* 中介分解回答机制问题：「model-fast 之所以提升成功率，80% 是
	* 因为它降低了延迟（latency），20% 是质量本身」——知识第一次
	* 拥有内部结构，机制理解支撑更精准的迁移决策。
	*
	* @param from 处理 X（如 model-fast）
	* @param mediator 中介 M（如 kpi:latency-improved）
	* @param to 结果 Y（如 task.outcome）
	*/
	mediation(from, mediator, to, now = Date.now()) {
		const xm = this.effect(from, mediator, now);
		const my = this.effect(mediator, to, now);
		const xy = this.effect(from, to, now);
		const total = round$6(xy.ate);
		const indirect = xm.ate * my.ate;
		const direct = total - indirect;
		const share = Math.abs(total) > .05 ? Math.min(1, Math.abs(indirect) / Math.abs(total)) : 0;
		let mechanism;
		if (xy.interventionalSamples < 3) mechanism = `总效应证据不足（${xy.interventionalSamples} 干预样本），机制分解暂不可靠`;
		else if (share >= .6) mechanism = `${from} 对 ${to} 的效应 ${Math.round(share * 100)}% 经由 ${mediator} 传导（${from}→${mediator} ${xm.ate.toFixed(2)} × ${mediator}→${to} ${my.ate.toFixed(2)}）——机制主导型效应`;
		else if (share <= .2) mechanism = `${from} 对 ${to} 的效应主要不走 ${mediator}（中介占比 ${Math.round(share * 100)}%，直接效应 ${direct.toFixed(2)}）——直接主导型效应`;
		else mechanism = `${from} 对 ${to} 的效应混合传导：中介 ${Math.round(share * 100)}% + 直接 ${direct.toFixed(2)}——双通道机制`;
		return {
			from,
			mediator,
			to,
			total,
			indirect,
			direct,
			share: round$6(share),
			path: {
				xm,
				my,
				xy
			},
			mechanism
		};
	}
	/**
	* 反事实查询：给定实际发生了 actionActual 且结果为 actualY，
	* 「若当时做 actionAlternative」成功概率几何。
	*
	* 实现：两动作 → 同一结果的因果边后验对比（无证据时返回先验 0.5
	* 并以宽区间表达无知 —— 诚实的不确定性，而非假装知道）。
	*/
	counterfactual(outcome, actionActual, actionAlternative, actualY, now = Date.now()) {
		const altEffect = this.effect(actionAlternative, outcome, now);
		const actualEffect = this.effect(actionActual, outcome, now);
		const actualProb = actualY ? Math.max(actualEffect.pDo, .5) : Math.min(actualEffect.pDo, .5);
		const samples = altEffect.interventionalSamples + altEffect.observationalSamples;
		const margin = samples >= 10 ? .1 : samples >= 4 ? .2 : .5;
		const estimatedProb = altEffect.pDo;
		let verdict;
		if (samples < 4) verdict = `证据不足（${samples} 样本）：「若选 ${actionAlternative}」暂无法可靠回答，建议登记为因果实验`;
		else if (actualY && estimatedProb - actualProb > .1) verdict = `反事实遗憾：${actionAlternative} 的估计成功概率（${round$6(estimatedProb)}）高于实际路径（${round$6(actualProb)}）`;
		else if (!actualY && estimatedProb > .6) verdict = `反事实教训：失败路径下 ${actionAlternative} 估计成功概率 ${round$6(estimatedProb)}，下次优先`;
		else verdict = `实际选择已接近最优（${actionAlternative} 估计 ${round$6(estimatedProb)} vs 实际 ${round$6(actualProb)}）`;
		return {
			alternative: actionAlternative,
			estimatedProb: round$6(estimatedProb),
			lower: round$6(Math.max(0, estimatedProb - margin)),
			upper: round$6(Math.min(1, estimatedProb + margin)),
			actualProb: round$6(actualProb),
			evidenceSamples: samples,
			verdict
		};
	}
	/**
	* 假设驱动实验建议：不确定性最高 × 关联 target 的边优先做 do-实验。
	*
	* 信息增益 = Beta 区间宽度（不确定性）× max(观测关联, 已见干预效应)（重要性）。
	* 每条建议自带可读假设陈述 —— 好奇心从「随机探索」升级为
	* 「提出假设 → 设计实验 → do-干预 → 图更新」的科学循环。
	*/
	suggestExperiments(target, budget = 3, now = Date.now()) {
		const candidates = [];
		for (const edge of this.edgeMap.values()) {
			if (edge.to !== target) continue;
			const eff = this.effect(edge.from, edge.to, now);
			const uncertainty = Math.min(1, eff.upper - eff.lower);
			if (uncertainty < this.config.experimentMinUncertainty) continue;
			const infoGain = uncertainty * Math.max(Math.abs(eff.observationalAssociation), Math.abs(eff.ate), .05);
			candidates.push({
				from: edge.from,
				to: edge.to,
				suggestedArm: eff.ate >= 0 || eff.observationalAssociation >= 0,
				infoGain: round$6(infoGain),
				hypothesis: `假设：对 ${edge.from} 实施 do=${eff.ate >= 0 || eff.observationalAssociation >= 0 ? "启用" : "停用"} 将使 ${edge.to} ${eff.ate >= 0 || eff.observationalAssociation >= 0 ? "提升" : "下降"}（当前不确定区间 [${round$6(eff.lower)}, ${round$6(eff.upper)}]）`,
				uncertainty: round$6(uncertainty)
			});
		}
		return candidates.sort((a, b) => b.infoGain - a.infoGain).slice(0, budget);
	}
	/**
	* 10.0：单边证据明细（科学家内核的实验设计原料）。
	*
	* 暴露每条边两臂的原始成败计数与观测四格（含衰减口径），
	* 供外部按 Beta(1+s, 1+f) 精确重构臂后验并计算期望信息增益。
	* 只读快照，不暴露内部结构。
	*/
	armEvidence(from, to, now = Date.now()) {
		const edge = this.edgeMap.get(`${from}→${to}`);
		if (!edge) return void 0;
		return { ...this.decayedView(edge, now) };
	}
	/**
	* 11.0：全边衰减证据枚举（理论内核的归纳原料）。
	* 返回每条边的 (from, to, 衰减后双流证据)——理论内核据此分组归纳定律。
	*/
	allEdgesEvidence(now = Date.now()) {
		return [...this.edgeMap.values()].map((e) => ({
			from: e.from,
			to: e.to,
			...this.decayedView(e, now)
		}));
	}
	/** 图快照（节点 + 边效应摘要） */
	snapshot(now = Date.now()) {
		const all = [...this.edgeMap.values()].map((e) => this.effect(e.from, e.to, now));
		return {
			nodes: [...this.nodeMap.values()],
			edgeCount: all.length,
			establishedEdges: all.filter((e) => e.established).sort((a, b) => b.lower - a.lower),
			confoundedEdges: this.detectConfounding(now),
			interventions: this.interventionLog.length,
			topEdges: [...all].sort((a, b) => b.lower * b.confidence - a.lower * a.confidence).slice(0, 10)
		};
	}
	/** 干预审计链（只读拷贝） */
	interventions() {
		return [...this.interventionLog];
	}
	/** 序列化（持久化格式 = JSON） */
	serialize() {
		return {
			nodes: [...this.nodeMap.values()],
			edges: [...this.edgeMap.values()],
			interventions: [...this.interventionLog],
			seq: this.seq
		};
	}
	/** 反序列化 */
	deserialize(data) {
		this.nodeMap.clear();
		this.edgeMap.clear();
		for (const n of data.nodes) this.nodeMap.set(n.id, n);
		for (const e of data.edges) this.edgeMap.set(`${e.from}→${e.to}`, e);
		this.interventionLog = [...data.interventions];
		this.seq = data.seq ?? this.interventionLog.length;
	}
	/** 惰性衰减（写入路径，与 MemoryEvidence 同一语义） */
	decayEdge(edge, now) {
		const decay = decayFactor(Math.max(0, now - edge.evidence.lastDecayedAt));
		const e = edge.evidence;
		e.doXSuccess *= decay;
		e.doXFailure *= decay;
		e.doNotXSuccess *= decay;
		e.doNotXFailure *= decay;
		e.obsBoth *= decay;
		e.obsXOnly *= decay;
		e.obsYOnly *= decay;
		e.obsNeither *= decay;
		e.lastDecayedAt = now;
	}
	/** 读取式衰减视图（不回写） */
	decayedView(edge, now) {
		const decay = decayFactor(Math.max(0, now - edge.evidence.lastDecayedAt));
		const e = edge.evidence;
		return {
			doXSuccess: e.doXSuccess * decay,
			doXFailure: e.doXFailure * decay,
			doNotXSuccess: e.doNotXSuccess * decay,
			doNotXFailure: e.doNotXFailure * decay,
			obsBoth: e.obsBoth * decay,
			obsXOnly: e.obsXOnly * decay,
			obsYOnly: e.obsYOnly * decay,
			obsNeither: e.obsNeither * decay,
			lastDecayedAt: now
		};
	}
};
/**
* noisy-OR 联盟价值：v(S) = 1 − Π_{i∈S}(1 − p_i)
*
* 语义：每个贡献者独立地「有机会」把任务做成功；任务成功只要
* 至少一条路径走通。这是多模型协同（任一模型产出可用即成功）的
* 忠实抽象，且让 Shapley 值有精确的子集枚举解。
*/
function coalitionValue(members) {
	let failAll = 1;
	for (const m of members) failAll *= Math.max(0, 1 - m.prob);
	return 1 - failAll;
}
/**
* 精确 Shapley 值（子集枚举，n ≤ 16 时精确；更大时按权重截断）。
*
* φ_i = Σ_{S ⊆ N∖{i}} [|S|! (n−|S|−1)! / n!] · [v(S ∪ {i}) − v(S)]
*
* 质变点：分红不再按「表现分的线性份额」（搭便车者只要有正分就
* 永远分钱），而按「边际反事实贡献」——拔掉你，任务成功率掉多少，
* 你就分多少。两个都干了活的智能体平分；只挂名不出力的边际贡献
* ≈ 0，自然饿死（能量经济的真公平）。
*/
function shapleyValues(contributors) {
	const n = contributors.length;
	const result = /* @__PURE__ */ new Map();
	if (n === 0) return result;
	if (n === 1) {
		result.set(contributors[0].agentId, coalitionValue(contributors));
		return result;
	}
	const cache = /* @__PURE__ */ new Map();
	const valueOf = (mask) => {
		let v = cache.get(mask);
		if (v !== void 0) return v;
		const members = [];
		for (let i = 0; i < n; i += 1) if (mask & 1 << i) members.push(contributors[i]);
		v = coalitionValue(members);
		cache.set(mask, v);
		return v;
	};
	const factorials = [1];
	for (let i = 1; i <= n; i += 1) factorials[i] = factorials[i - 1] * i;
	for (let i = 0; i < n; i += 1) {
		let phi = 0;
		const others = n - 1;
		for (let subset = 0; subset < 1 << others; subset += 1) {
			let sMask = 0;
			let bit = 0;
			for (let j = 0; j < n; j += 1) {
				if (j === i) continue;
				if (subset & 1 << bit) sMask |= 1 << j;
				bit += 1;
			}
			const sSize = popcount(sMask);
			const weight = factorials[sSize] * factorials[n - sSize - 1] / factorials[n];
			phi += weight * (valueOf(sMask | 1 << i) - valueOf(sMask));
		}
		result.set(contributors[i].agentId, phi);
	}
	return result;
}
function popcount(x) {
	let c = 0;
	while (x) {
		x &= x - 1;
		c += 1;
	}
	return c;
}
function round$6(x) {
	return Number(x.toFixed(4));
}
//#endregion
//#region src/core/free-energy.ts
/**
* free-energy.ts — 主动推断内核（项目 6.0「自由能最小化心智」质变基座）
*
* 升级前的根本分裂（全模块通病）：
* 系统有四套独立的「好坏」判据——调度器用策略评分（利用端），
* 探索用 UCB 加成（手设预算），好奇心用盲区扫描（接触频率），
* 元认知用 KPI 逐项阈值（规则命中）。四套判据彼此不通约：
* 什么时候该探索、探索多少、知识与收益如何换算——全是拍脑袋常数。
*
* 本内核引入 Karl Friston 自由能原理（Active Inference）：
* 智能体唯一目标是 minimize expected free energy——
*
*   G(a) = E_q[−ln P(goal | do(a))]  （务实价值：期望惊奇，越低越好）
*        − E[info gain(a)]           （认知价值：期望信息增益，越高越好）
*
* 一个公式同时统一了四大启发式：
* 1. 利用（务实价值）：预测成功率越接近偏好，惊奇越低 → 替代策略评分
* 2. 探索（认知价值）：不确定性高的动作信息增益大 → 替代 UCB 加成，
*    且探索预算不再是常数——不确定性耗尽，认知价值自动归零
* 3. 好奇心（认知价值）：实验设计 = argmax info gain → 与探索同源，
*    「想知道」与「想得分」在同一量纲（nat）下权衡
* 4. 精度控制：温度 γ = f(系统平均不确定性)——世界模型越不可信，
*    策略越随机（多探索）；越可信越贪婪（多利用）——自适应探索温度
*
* 变分自由能（感知侧）：F = KL(q‖p)（信念分布 ‖ 生成模型预测）——
* 信念市场价与因果后验的背离第一次有了信息论度量（nat），
* 模型漂移 = 自由能上升 = 系统对世界的「预测握力」松动。
*
* 与因果内核的关系：causal-kernel 提供生成模型 P(Y|do(X))，
* 本内核提供基于该模型的行动选择定理。因果阶梯（第二层）回答
* 「干预会怎样」，主动推断回答「因此该干预什么」——两者合成
* 完整的感知-决策-学习闭环。
*
* 审计性：EFE 分解（务实/认知）逐动作输出，每个选择都能回答
* 「为什么选它」——多少因为有用，多少因为想弄清。可解释、可追溯。
*/
/** Lanczos 逼近系数（g=7, n=9，双精度全域 |ε| < 1e-15） */
const LANCZOS = [
	.9999999999998099,
	676.5203681218851,
	-1259.1392167224028,
	771.3234287776531,
	-176.6150291621406,
	12.507343278686905,
	-.13857109526572012,
	9984369578019572e-21,
	1.5056327351493116e-7
];
/** ln Γ(x)（Lanczos 逼近；x>0） */
function lnGamma(x) {
	if (x < .5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
	x -= 1;
	let a = LANCZOS[0];
	const t = x + 7.5;
	for (let i = 1; i < LANCZOS.length; i += 1) a += LANCZOS[i] / (x + i);
	return .5 * Math.log(2 * Math.PI) + (x + .5) * Math.log(t) - t + Math.log(a);
}
/** ψ(x) = d/dx ln Γ(x)（递推 + 渐近级数；x>0） */
function digamma(x) {
	let r = 0;
	while (x < 6) {
		r -= 1 / x;
		x += 1;
	}
	const inv = 1 / x;
	const inv2 = inv * inv;
	r += Math.log(x) - .5 * inv - inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 / 252));
	return r;
}
/** Beta 分布微分熵（nat）：H = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β) + (α+β−2)ψ(α+β) */
function betaEntropy(alpha, beta) {
	return lnGamma(alpha) + lnGamma(beta) - lnGamma(alpha + beta) - (alpha - 1) * digamma(alpha) - (beta - 1) * digamma(beta) + (alpha + beta - 2) * digamma(alpha + beta);
}
/** KL(q‖p)（伯努利分布，nat）；概率裁剪防 log(0) */
function bernoulliKL(q, p) {
	const qc = Math.min(1 - 1e-12, Math.max(1e-12, q));
	const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
	return qc * Math.log(qc / pc) + (1 - qc) * Math.log((1 - qc) / (1 - pc));
}
const DEFAULT_FREE_ENERGY_CONFIG = {
	epistemicWeight: 1,
	minTemperature: .05,
	temperatureSensitivity: .3,
	driftThreshold: .25,
	probEpsilon: 1e-6
};
/**
* 主动推断内核：期望自由能决策 + 变分漂移监测 + 精度控制。
*
* 消费方：
* - model-scheduler：EFE 模式下行动选择 = argmin G(a)（探索/利用统一）
* - symbiosis/runtime：行动提案按 EFE 排序（认知经济的注意力分配）
* - meta-cognition：总自由能作为统一健康度（预测握力）
* - curiosity-engine：实验目标 = argmax epistemic（与探索同源的定理化好奇心）
* - world-model / 信念对账：KL 漂移监测（变分自由能）
*/
var FreeEnergyEngine = class {
	config;
	/** 感知侧：最近观测惊奇（EMA，自由能代理） */
	surprisalEma;
	surprisalCount = 0;
	constructor(config) {
		this.config = {
			...DEFAULT_FREE_ENERGY_CONFIG,
			...config
		};
	}
	/**
	* 单动作期望自由能分解。
	*
	* 务实价值（期望惊奇）：
	*   G_prag = −[ω·ln p̂ + (1−ω)·ln(1−p̂)]
	*   ω = 对成功的偏好强度（goal weight）；p̂ = P(Y=1|do(a))。
	*   p̂ 越贴近 ω 惊奇越低；p̂ 与 ω 同侧时交叉熵单调。
	*
	* 认知价值（期望信息增益，一步前瞻）：
	*   IG = H(Beta(α,β)) − [p̂·H(α+1,β) + (1−p̂)·H(α,β+1)]
	*   做这个动作（无论成败）后该边后验熵的期望收缩量。
	*   样本充足 → 微分熵收缩趋零 → 认知价值自动归零（探索自我终结）。
	*/
	evaluateAction(action, preference, temperature = this.config.minTemperature) {
		const eps = this.config.probEpsilon;
		const p = Math.min(1 - eps, Math.max(eps, action.pSuccess));
		const omega = Math.min(1, Math.max(0, preference));
		const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));
		const strength = action.interventionalSamples + .5 * action.observationalSamples;
		const alpha = Math.max(1e-9, p * strength + 1);
		const beta = Math.max(1e-9, (1 - p) * strength + 1);
		const h0 = betaEntropy(alpha, beta);
		const hYes = betaEntropy(alpha + 1, beta);
		const hNo = betaEntropy(alpha, beta + 1);
		const epistemic = Math.max(0, h0 - (p * hYes + (1 - p) * hNo));
		const efe = pragmatic - this.config.epistemicWeight * epistemic;
		return {
			actionId: action.id,
			pragmatic: round$5(pragmatic),
			epistemic: round$5(epistemic),
			efe: round$5(efe),
			alpha: round$5(alpha),
			beta: round$5(beta),
			boltzmannProb: 0,
			curiosityShare: round$5(pragmatic + epistemic > 1e-9 ? epistemic / (pragmatic + epistemic) : 0),
			expectedUncertaintyReduction: round$5(epistemic / Math.max(1e-9, h0))
		};
	}
	/**
	* 全候选 EFE 评估 + Boltzmann 策略。
	*
	* P(a) ∝ exp(−G(a)/T)：温度由系统不确定性控制（precisionControl）。
	* 高不确定性 → 高温度 → 均匀探索；低不确定性 → 低温 → 贪婪利用。
	* 这是主动推断的规范策略形式：策略 = 对自由能的 softmax。
	*/
	evaluateActions(actions, preference, temperature) {
		if (actions.length === 0) return [];
		const T = Math.max(this.config.minTemperature, temperature ?? this.minTemperatureFromActions(actions));
		const evals = actions.map((a) => this.evaluateAction(a, preference, T));
		const minG = Math.min(...evals.map((e) => e.efe));
		const weights = evals.map((e) => Math.exp(-(e.efe - minG) / T));
		const sum = weights.reduce((a, b) => a + b, 0);
		evals.forEach((e, i) => {
			e.boltzmannProb = round$5(weights[i] / sum);
		});
		return evals.sort((a, b) => a.efe - b.efe);
	}
	/**
	* Thompson 采样：θ_a ~ Beta(α_a, β_a)，选 argmax θ。
	*
	* EFE 最优的随机化实现（Bernoulli bandit 的规范探索策略）：
	* 后验越宽采样越散 → 自动探索；后验越尖采样越稳 → 自动利用。
	* 与 Boltzmann 的区别：不依赖温度标定，探索幅度由证据量内生决定。
	*/
	thompsonSelect(actions) {
		const samples = {};
		let winner = actions[0]?.id ?? "";
		let best = -Infinity;
		for (const a of actions) {
			const eps = this.config.probEpsilon;
			const p = Math.min(1 - eps, Math.max(eps, a.pSuccess));
			const strength = a.interventionalSamples + .5 * a.observationalSamples;
			const theta = sampleBeta(p * strength + 1, (1 - p) * strength + 1);
			samples[a.id] = round$5(theta);
			if (theta > best) {
				best = theta;
				winner = a.id;
			}
		}
		return {
			winner,
			samples
		};
	}
	/**
	* 精度控制：候选集平均不确定性 → 探索温度。
	*
	* T = minTemperature + sensitivity × avgWidth。
	* 世界的未知程度直接决定策略的随机程度——不确定时多试，
	* 胸有成竹时果断。探索率第一次由认识论内生推导，而非超参数。
	*/
	minTemperatureFromActions(actions) {
		if (actions.length === 0) return this.config.minTemperature;
		const avgWidth = actions.reduce((s, a) => s + Math.max(0, a.upper - a.lower), 0) / actions.length;
		return this.config.minTemperature + this.config.temperatureSensitivity * avgWidth;
	}
	/**
	* 感知：登记一次「预测-结果」惊奇（自由能的在线代理）。
	*
	* surprisal = −ln P(实际结果 | 预测概率)。EMA 平滑为系统级
	* 「预测握力」——元认知的总自由能 KPI 数据来源：
	* 预测越准惊奇越低；世界突变（漂移）时惊奇陡升。
	* @returns 本次的惊奇值（nat）
	*/
	observeSurprisal(predictedProb, actualSuccess) {
		const eps = this.config.probEpsilon;
		const p = Math.min(1 - eps, Math.max(eps, predictedProb));
		const surprisal = -Math.log(actualSuccess ? p : 1 - p);
		this.surprisalEma = this.surprisalEma === void 0 ? surprisal : .9 * this.surprisalEma + .1 * surprisal;
		this.surprisalCount += 1;
		return surprisal;
	}
	/** 感知侧自由能（EMA 惊奇；无观测时 0） */
	currentSurprisal() {
		return this.surprisalEma ?? 0;
	}
	/**
	* 变分自由能：信念分布 vs 生成模型的 KL 总和（感知漂移监测）。
	*
	* 典型用法：信念市场隐含概率（q）vs 因果内核后验（p）。
	* F 上升 = 「市场以为的」与「模型知道的」裂开 = 模型漂移指纹——
	* 为既有 gap 判断提供信息论度量（nat）与归因（worst）。
	*/
	variationalFreeEnergy(beliefs, modelProbs) {
		const perBelief = [];
		let total = 0;
		for (const b of beliefs) {
			const p = modelProbs[b.id];
			if (!Number.isFinite(p)) continue;
			const kl = bernoulliKL(b.beliefProb, p);
			total += kl;
			perBelief.push({
				id: b.id,
				beliefProb: round$5(b.beliefProb),
				modelProb: round$5(p),
				kl: round$5(kl)
			});
		}
		const worstEntry = [...perBelief].sort((a, b) => b.kl - a.kl)[0];
		return {
			totalFreeEnergy: round$5(total),
			perBelief: perBelief.sort((a, b) => b.kl - a.kl),
			driftDetected: total >= this.config.driftThreshold,
			worst: worstEntry ? {
				id: worstEntry.id,
				kl: worstEntry.kl
			} : void 0
		};
	}
};
/** Beta(α,β) 精确采样：Gamma 采样比（Marsaglia-Tsang） */
function sampleBeta(alpha, beta) {
	const x = sampleGamma(alpha);
	return x / (x + sampleGamma(beta));
}
/** Gamma(shape=k, scale=1) 采样（Marsaglia-Tsang，k>0） */
function sampleGamma(k) {
	if (k < 1) return sampleGamma(k + 1) * Math.pow(Math.random(), 1 / k);
	const d = k - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x = 0;
		let v = 0;
		do {
			x = gaussian();
			v = 1 + c * x;
		} while (v <= 0);
		v = v * v * v;
		const u = Math.random();
		if (u < 1 - .0331 * x * x * x * x) return d * v;
		if (Math.log(u) < .5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}
/** Box-Muller 标准正态 */
function gaussian() {
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function round$5(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/core/deliberation.ts
/**
* deliberation.ts — 深思内核（项目 7.0「深思心智」质变基座：规划即推断）
*
* 升级前的根本局限（6.0 自由能心智的天花板）：
* EFE 是**一步前瞻**的 bandit——每个动作只问「做它之后世界会怎样」，
* 从不问「做完它之后，我还能做什么」。系统因此是**短视的**：
* 能选出当下最优的一步，看不见两步之后的死路，更不会为第 N 步
* 的收获放弃第 1 步的诱惑。所有「规划」都退化为贪心序列。
*
* 本内核引入 Planning as Inference（Friston 层级生成模型 /
* Dreamer 想象规划 / MuZero 树搜索的主动推断统一）：
*
* 1. **转移模型**（生成模型的时间维）：Beta 后验 P(Y=1 | state, action)
*    + 后继状态分布——从真实执行中增量学习，无证据时诚实返回
*    Beta(1,1)（完全无知），绝不伪装成知道。
*
* 2. **想象推演**（梦境）：imagine(start, [a1..an]) 在转移模型里把
*    整条计划 rollout 一遍——不求世界一次给出答案，而是自己在
*    脑内预演每一步的成败分布。轨迹级产出：
*    - 折扣累计 G = Σ γ^t·G_t（深度期望自由能，与 6.0 单步 EFE 同量纲）
*    - 全程成功概率 Π p_t 与首败风险分布（在第几步翻车、概率几何）
*    - 逐步务实/认知价值分解（审计：哪一步是收益、哪一步是学费）
*
* 3. **想象证据坍缩**（认知价值的时间衰减）：同一条边在一条轨迹里
*    被第 2 次想象时，认知价值严格下降——想象本身就消耗不确定性。
*    「做一次实验就能学到的东西，不需要做梦一百遍。」
*
* 4. **前瞻搜索**（beam search × 技能宏）：beam 在轨迹空间按累计 G
*    剪枝；技能库把验证过的行动序列作为**宏动作**（时间抽象）注入
*    beam 种子——深思不必从原语动作重新发明轮子。
*
* 5. **技能库**（options / 时间抽象）：整体成功的计划蒸馏为技能
*    （触发态 + 行动序列 + 价值 + 可靠性），复用强化、失手衰减、
*    超额淘汰——「怎么做」的知识第一次有了与「是什么」(语义)、
*    「有多好」(情景) 并列的程序形态。
*
* 6. **梦实现对账**（想象的可问责性）：计划执行后逐步对账
*    「梦里的预测 vs 现实的结果」——每一步的惊奇与误差回流：
*    转移模型（学习）、自由能引擎（感知惊奇）、校准 EMA
*    （梦可靠性 KPI：系统对自己想象力的诚实度量）。
*
* 与 6.0 的关系：free-energy 提供单动作 EFE 定理，本内核把它沿
* 时间维展开——从「选最好的一步」到「选最好的余生」。
* 深思心智 = 自由能心智 × 时间。
*/
const DEFAULT_DELIBERATION_CONFIG = {
	gamma: .95,
	beamBreadth: 6,
	maxDepth: 4,
	imaginaryEvidenceRate: .5,
	epistemicWeight: 1,
	probEpsilon: 1e-6,
	skillValueThreshold: .5,
	skillMaxCount: 64,
	calibrationAlpha: .3
};
/**
* 深思内核：转移模型 + 想象推演 + 前瞻搜索 + 技能库 + 梦实现对账。
*
* 消费方：
* - optimizer：冷启动序列推荐（零情景记忆也能按想象给出计划级建议）
* - meta-cognition：梦校准 KPI（想象可靠性的诚实度量）
* - symbiosis/runtime：多步行动提案按轨迹 G 排序
* - 宿主/执行器：计划执行后 settle 对账（学习 + 惊奇回流 + 技能蒸馏）
*/
var DeliberationEngine = class {
	config;
	edges = /* @__PURE__ */ new Map();
	skills = [];
	skillCounter = 0;
	calibrationEma;
	plansSettled = 0;
	freeEnergy;
	/** 9.0：抽象内核（可选挂载；分层先验 + 后继继承 + 抽象技能） */
	abstraction;
	constructor(config, freeEnergy) {
		this.config = {
			...DEFAULT_DELIBERATION_CONFIG,
			...config
		};
		this.freeEnergy = freeEnergy;
	}
	/** 挂载自由能引擎（梦对账的惊奇回流目标；幂等） */
	attachFreeEnergyEngine(engine) {
		this.freeEnergy = engine;
	}
	/**
	* 9.0：挂载抽象内核（幂等）。挂载后：
	* - posterior 经分层先验收缩（L4 均匀层与 Beta(1,1) 严格等价，
	*   零数据时对既有行为零漂移）
	* - 冷叶子继承结构相似域的后继结构（类比规划）
	* - 搜索种子合并跨域抽象技能
	*/
	attachAbstraction(engine) {
		this.abstraction = engine;
	}
	/**
	* 登记一次真实执行证据（执行器/宿主在计划步落定后调用）。
	* @param state 该步所处状态键（如 `${taskType}#s${i}`）
	* @param action 行动（如 modelId）
	* @param success 该步成败
	* @param nextState 成功后的后继状态（缺省停留原态）
	*/
	observe(state, action, success, nextState) {
		const key = edgeKey(state, action);
		let edge = this.edges.get(key);
		if (!edge) {
			edge = {
				successes: 0,
				failures: 0,
				successors: /* @__PURE__ */ new Map()
			};
			this.edges.set(key, edge);
		}
		if (success) {
			edge.successes += 1;
			const next = nextState ?? state;
			edge.successors.set(next, (edge.successors.get(next) ?? 0) + 1);
		} else edge.failures += 1;
		this.abstraction?.observe(state, action, success, nextState);
	}
	/**
	* 转移边后验查询。
	*
	* 未挂载抽象内核：Beta(1,1) 均匀先验（无证据 = 诚实的完全无知）。
	* 挂载后：分层先验收缩——先验 = 类比/域边际/全局借来的知识
	* （strength 伪计数），叶子证据逐条覆盖（经验渐近压倒类比）。
	* 均匀层 strength=2 与 Beta(1,1) 严格等价：零数据时零漂移。
	*/
	posterior(state, action) {
		const edge = this.edges.get(edgeKey(state, action));
		const successes = edge?.successes ?? 0;
		const failures = edge?.failures ?? 0;
		let alpha;
		let beta;
		let abstractInfo;
		if (this.abstraction) {
			const prior = this.abstraction.hierarchicalPrior(state, action);
			alpha = prior.strength * prior.mean + successes;
			beta = prior.strength * (1 - prior.mean) + failures;
			abstractInfo = {
				source: prior.source,
				strength: prior.strength,
				mean: round$4(prior.mean)
			};
		} else {
			alpha = 1 + successes;
			beta = 1 + failures;
		}
		const p = alpha / (alpha + beta);
		const n = alpha + beta;
		const sigma = Math.sqrt(alpha * beta / (n * n * (n + 1)));
		let successor = state;
		let best = 0;
		for (const [candidate, count] of edge?.successors ?? []) if (count > best) {
			best = count;
			successor = candidate;
		}
		if (successor === state && this.abstraction && successes + failures === 0) successor = this.abstraction.inheritedSuccessor(state, action) ?? state;
		return {
			state,
			action,
			pSuccess: round$4(p),
			alpha,
			beta,
			evidence: successes + failures,
			lower: round$4(Math.max(0, p - 1.645 * sigma)),
			upper: round$4(Math.min(1, p + 1.645 * sigma)),
			successor,
			abstract: abstractInfo
		};
	}
	/**
	* 想象推演：在转移模型里 rollout 一条完整计划。
	*
	* 逐步计算（与单步 EFE 同一公式，证据沿轨迹累积）：
	*   α' = 1 + 真实成功 + λk·p̂   （λ = 想象证据折算率，k = 轨迹内已想象次数）
	*   β' = 1 + 真实失败 + λk·(1−p̂)
	*   务实 = −[ω ln p̂ + (1−ω) ln(1−p̂)]
	*   认知 = H(α',β') − [p̂·H(α'+1,β') + (1−p̂)·H(α',β'+1)]
	*   G_t = 务实 − w·认知；总 G = Σ γ^t G_t
	*
	* 关键性质：同一条边被重访时 λk 增大 → 后验熵收缩 → 认知价值单调不增
	* （想象证据坍缩：重复梦见同一件事不再带来新知识）。
	*/
	imagine(startState, actions, preference = .9) {
		const eps = this.config.probEpsilon;
		const omega = Math.min(1, Math.max(0, preference));
		const steps = [];
		const states = [startState];
		const imaginedUses = /* @__PURE__ */ new Map();
		let state = startState;
		let totalEfe = 0;
		let undiscounted = 0;
		let pAll = 1;
		for (let t = 0; t < actions.length; t += 1) {
			const action = actions[t];
			const key = edgeKey(state, action);
			const k = imaginedUses.get(key) ?? 0;
			const post = this.posterior(state, action);
			const p = Math.min(1 - eps, Math.max(eps, post.pSuccess));
			const lambda = this.config.imaginaryEvidenceRate * k;
			const alpha = post.alpha + lambda * p;
			const beta = post.beta + lambda * (1 - p);
			const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));
			const h0 = betaEntropy(alpha, beta);
			const hYes = betaEntropy(alpha + 1, beta);
			const hNo = betaEntropy(alpha, beta + 1);
			const epistemic = Math.max(0, h0 - (p * hYes + (1 - p) * hNo));
			const efe = pragmatic - this.config.epistemicWeight * epistemic;
			const discounted = Math.pow(this.config.gamma, t) * efe;
			steps.push({
				step: t,
				state,
				action,
				nextState: post.successor,
				pStep: round$4(p),
				evidence: round$4(post.evidence + lambda),
				pragmatic: round$4(pragmatic),
				epistemic: round$4(epistemic),
				efe: round$4(efe),
				discounted: round$4(discounted)
			});
			totalEfe += discounted;
			undiscounted += efe;
			pAll *= p;
			states.push(post.successor);
			imaginedUses.set(key, k + 1);
			state = post.successor;
		}
		const riskProfile = steps.map((s) => {
			const before = steps.slice(0, s.step).reduce((prod, x) => prod * x.pStep, 1);
			return {
				step: s.step,
				pFailAt: round$4(before * (1 - s.pStep))
			};
		});
		return {
			startState,
			actions: [...actions],
			states,
			totalEfe: round$4(totalEfe),
			undiscountedEfe: round$4(undiscounted),
			pAllSuccess: round$4(pAll),
			steps,
			riskProfile,
			epistemicMonotone: checkEpistemicMonotone(steps)
		};
	}
	/**
	* 深思搜索：beam search 在轨迹空间按累计 G 剪枝。
	*
	* 与一步贪心（6.0 argmin G(a)）的本质区别：展开的是**轨迹前缀**——
	* 第 1 步的高 G 可以被第 2 步的低 G 补偿（γ 折扣），因此能看见
	* 「先苦后甜」的路，也能避开「第一步诱人、第二步是死路」的陷阱。
	*
	* 技能时间抽象：触发态匹配的技能作为宏动作直接展开整条序列
	* （一个 beam 槽位 = 多个原语步），深思从经验肩膀上起跳。
	*
	* @param startState 起始状态键
	* @param candidates 候选行动（静态清单或按状态动态给出）
	* @param opts 深度/宽度/偏好覆盖
	*/
	search(startState, candidates, opts) {
		const depth = Math.max(1, Math.min(opts?.depth ?? this.config.maxDepth, 12));
		const breadth = Math.max(1, opts?.breadth ?? this.config.beamBreadth);
		const preference = opts?.preference ?? .9;
		const useSkills = opts?.useSkills !== false;
		const actionsAt = (state) => typeof candidates === "function" ? candidates(state) : candidates;
		if (actionsAt(startState).length === 0 && !useSkills) return {
			ranked: [],
			best: void 0,
			expandedNodes: 0,
			skillSeeded: false
		};
		let expandedNodes = 0;
		const finished = [];
		let skillSeeded = false;
		let frontier = [{
			state: startState,
			actions: [],
			states: [startState],
			steps: [],
			totalEfe: 0,
			pSuccess: 1,
			imaginedUses: /* @__PURE__ */ new Map()
		}];
		if (useSkills) for (const skill of this.skillsFor(startState)) {
			if (skill.actions.length === 0) continue;
			const node = this.expandPrefix(startState, skill.actions, preference);
			expandedNodes += skill.actions.length;
			finished.push(node);
			skillSeeded = true;
		}
		for (let level = 0; level < depth; level += 1) {
			const children = [];
			for (const prefix of frontier) for (const action of actionsAt(prefix.state)) {
				const child = this.extendNode(prefix, action, preference, level, opts?.advance);
				expandedNodes += 1;
				children.push(child);
			}
			if (children.length === 0) break;
			children.sort((a, b) => a.totalEfe - b.totalEfe);
			frontier = children.slice(0, breadth);
			for (const node of frontier) if (node.actions.length === depth) finished.push(node);
			if (level === depth - 1) break;
		}
		for (const node of frontier) if (node.actions.length > 0 && node.actions.length < depth) finished.push(node);
		const seen = /* @__PURE__ */ new Set();
		const reports = finished.filter((n) => n.actions.length > 0).map((n) => this.nodeToReport(n)).filter((r) => {
			const sig = r.actions.join("|");
			if (seen.has(sig)) return false;
			seen.add(sig);
			return true;
		}).sort((a, b) => a.totalEfe - b.totalEfe || b.actions.length - a.actions.length).slice(0, Math.max(breadth, 3));
		return {
			ranked: reports,
			best: reports[0],
			expandedNodes,
			skillSeeded
		};
	}
	/**
	* 技能入库/强化：整体成功的计划蒸馏为可复用宏动作。
	* 同一 (触发态, 行动序列) 已存在时按 EMA 强化价值。
	*/
	acquireSkill(initiation, actions, value, reliability) {
		if (actions.length === 0) return void 0;
		const signature = actions.join("|");
		const existing = this.skills.find((s) => s.initiation === initiation && s.actions.join("|") === signature);
		if (existing) {
			existing.usages += 1;
			existing.successes += 1;
			existing.value = round$4(.7 * existing.value + .3 * value);
			existing.reliability = round$4(.7 * existing.reliability + .3 * reliability);
			existing.confidence = Math.min(1, .5 + existing.usages * .1);
			existing.lastUsedAt = Date.now();
			return existing;
		}
		if (value < this.config.skillValueThreshold) return void 0;
		if (this.skills.length >= this.config.skillMaxCount) {
			this.skills.sort((a, b) => b.value * b.confidence - a.value * a.confidence);
			this.skills.pop();
		}
		const skill = {
			id: `skill-${++this.skillCounter}`,
			initiation,
			actions: [...actions],
			value: round$4(value),
			reliability: round$4(reliability),
			confidence: .5,
			usages: 1,
			successes: 1,
			createdAt: Date.now(),
			lastUsedAt: Date.now()
		};
		this.skills.push(skill);
		return skill;
	}
	/** 技能衰减：匹配的技能失手（价值 EMA 下调，可靠性下滑） */
	decaySkill(initiation, actions, penalty = .2) {
		const signature = actions.join("|");
		const existing = this.skills.find((s) => s.initiation === initiation && s.actions.join("|") === signature);
		if (!existing) return;
		existing.usages += 1;
		existing.value = round$4(existing.value - penalty);
		existing.reliability = round$4(Math.max(0, existing.reliability * .8));
		existing.confidence = Math.min(1, .5 + existing.usages * .1);
	}
	/**
	* 检索：触发态匹配的技能（按价值 × 置信度降序）。
	* 9.0：挂载抽象内核时合并跨域抽象技能（同骨架任意域可复用）。
	*/
	skillsFor(state) {
		const concrete = this.skills.filter((s) => s.initiation === state).sort((a, b) => b.value * b.confidence - a.value * a.confidence);
		if (!this.abstraction) return concrete;
		const abstract = this.abstraction.abstractSkillsFor(state).map((a) => ({
			id: a.id,
			initiation: state,
			actions: [...a.actions],
			value: a.value,
			reliability: a.value,
			confidence: .6,
			usages: a.successes,
			successes: a.successes,
			createdAt: 0,
			lastUsedAt: Date.now()
		}));
		return [...concrete, ...abstract];
	}
	/** 全部技能（可观测/审计） */
	allSkills() {
		return [...this.skills].sort((a, b) => b.value * b.confidence - a.value * a.confidence);
	}
	/**
	* 计划落定对账：梦里预测 vs 现实结果。
	*
	* 三重回流：
	* 1. 转移模型学习（真实证据入库）
	* 2. 自由能感知惊奇（−ln P(实际)，挂载引擎时）
	* 3. 梦校准 EMA（|预测 − 结果|：想象可靠性的统一度量）
	*
	* 整体成功 → 计划蒸馏为技能（时间抽象资产）；
	* 整体失败 → 若匹配技能则衰减（梦境失灵的问责）。
	*
	* @param plan 逐步计划（state + action）
	* @param outcomes 逐步真实结果
	*/
	settle(plan, outcomes, preference = .9) {
		const steps = [];
		let surprisalSum = 0;
		let errorSum = 0;
		const predictions = plan.map((p) => this.posterior(p.state, p.action).pSuccess);
		for (let i = 0; i < plan.length; i += 1) {
			const { state, action } = plan[i];
			const actual = outcomes[i] ?? false;
			const predicted = Math.min(1 - this.config.probEpsilon, Math.max(this.config.probEpsilon, predictions[i]));
			const surprisal = -Math.log(actual ? predicted : 1 - predicted);
			const error = Math.abs(predicted - (actual ? 1 : 0));
			this.observe(state, action, actual);
			this.freeEnergy?.observeSurprisal(predicted, actual);
			steps.push({
				step: i,
				state,
				action,
				predicted: round$4(predicted),
				actual,
				surprisal: round$4(surprisal),
				error: round$4(error)
			});
			surprisalSum += surprisal;
			errorSum += error;
		}
		const meanError = plan.length > 0 ? errorSum / plan.length : 0;
		this.calibrationEma = this.calibrationEma === void 0 ? meanError : (1 - this.config.calibrationAlpha) * this.calibrationEma + this.config.calibrationAlpha * meanError;
		this.plansSettled += 1;
		const overallSuccess = outcomes.length > 0 && outcomes.every(Boolean);
		if (plan.length > 0) this.abstraction?.notePlanOutcome(plan[0].state, plan.map((p) => p.action), overallSuccess);
		let skillAction = "none";
		let skillId;
		if (plan.length > 0) {
			const initiation = plan[0].state;
			const actions = plan.map((p) => p.action);
			if (overallSuccess) {
				const after = this.imagine(initiation, actions, preference);
				const skill = this.acquireSkill(initiation, actions, after.pAllSuccess, after.pAllSuccess);
				if (skill) {
					skillAction = skill.usages > 1 ? "reinforced" : "acquired";
					skillId = skill.id;
				}
			} else {
				this.decaySkill(initiation, actions);
				const signature = actions.join("|");
				const hit = this.skills.find((s) => s.initiation === initiation && s.actions.join("|") === signature);
				if (hit) {
					skillAction = "decayed";
					skillId = hit.id;
				}
			}
		}
		return {
			steps,
			overallSuccess,
			meanSurprisal: round$4(plan.length > 0 ? surprisalSum / plan.length : 0),
			calibrationEma: round$4(this.calibrationEma ?? 0),
			skillAction,
			skillId
		};
	}
	/** 梦校准误差（EMA；未对账过时 undefined） */
	currentCalibration() {
		return this.calibrationEma === void 0 ? void 0 : round$4(this.calibrationEma);
	}
	/** 已对账计划数（可观测） */
	settledCount() {
		return this.plansSettled;
	}
	/** 序列化（持久化用；含抽象内核状态） */
	serialize() {
		const edges = [];
		for (const [key, stats] of this.edges) {
			const [state, action] = key.split("\0");
			edges.push({
				state,
				action,
				successes: stats.successes,
				failures: stats.failures,
				successors: [...stats.successors]
			});
		}
		return {
			edges,
			skills: [...this.skills],
			calibrationEma: this.calibrationEma,
			plansSettled: this.plansSettled,
			abstraction: this.abstraction?.serialize()
		};
	}
	/** 反序列化 */
	deserialize(data) {
		this.edges.clear();
		for (const e of data.edges) this.edges.set(edgeKey(e.state, e.action), {
			successes: e.successes,
			failures: e.failures,
			successors: new Map(e.successors)
		});
		this.skills = [...data.skills];
		this.calibrationEma = data.calibrationEma;
		this.plansSettled = data.plansSettled;
		if (data.abstraction && this.abstraction) this.abstraction.deserialize(data.abstraction);
	}
	/** 单步扩展一个 beam 前缀（含想象证据累积；advance 覆盖学习后继） */
	extendNode(prefix, action, preference, level, advance) {
		const eps = this.config.probEpsilon;
		const omega = Math.min(1, Math.max(0, preference));
		const key = edgeKey(prefix.state, action);
		const k = prefix.imaginedUses.get(key) ?? 0;
		const post = this.posterior(prefix.state, action);
		const p = Math.min(1 - eps, Math.max(eps, post.pSuccess));
		const lambda = this.config.imaginaryEvidenceRate * k;
		const alpha = post.alpha + lambda * p;
		const beta = post.beta + lambda * (1 - p);
		const pragmatic = -(omega * Math.log(p) + (1 - omega) * Math.log(1 - p));
		const h0 = betaEntropy(alpha, beta);
		const epistemic = Math.max(0, h0 - (p * betaEntropy(alpha + 1, beta) + (1 - p) * betaEntropy(alpha, beta + 1)));
		const efe = pragmatic - this.config.epistemicWeight * epistemic;
		const discounted = Math.pow(this.config.gamma, level) * efe;
		const imaginedUses = new Map(prefix.imaginedUses);
		imaginedUses.set(key, k + 1);
		const nextState = advance ? advance({
			state: prefix.state,
			action,
			step: level,
			successor: post.successor
		}) : post.successor;
		const step = {
			step: level,
			state: prefix.state,
			action,
			nextState,
			pStep: round$4(p),
			evidence: round$4(post.evidence + lambda),
			pragmatic: round$4(pragmatic),
			epistemic: round$4(epistemic),
			efe: round$4(efe),
			discounted: round$4(discounted)
		};
		return {
			state: nextState,
			actions: [...prefix.actions, action],
			states: [...prefix.states, nextState],
			steps: [...prefix.steps, step],
			totalEfe: round$4(prefix.totalEfe + discounted),
			pSuccess: round$4(prefix.pSuccess * p),
			imaginedUses
		};
	}
	/** 整段序列展开（技能宏：从起始态一次推演完整技能） */
	expandPrefix(startState, actions, preference) {
		const report = this.imagine(startState, actions, preference);
		const imaginedUses = /* @__PURE__ */ new Map();
		let state = startState;
		for (const action of actions) {
			const key = edgeKey(state, action);
			imaginedUses.set(key, (imaginedUses.get(key) ?? 0) + 1);
			state = this.posterior(state, action).successor;
		}
		return {
			state: report.states[report.states.length - 1] ?? startState,
			actions: [...actions],
			states: report.states,
			steps: report.steps,
			totalEfe: report.totalEfe,
			pSuccess: report.pAllSuccess,
			imaginedUses
		};
	}
	/** beam 前缀 → 完整想象报告（复用已算好的步分解，不重算） */
	nodeToReport(node) {
		const before = (i) => node.steps.slice(0, i).reduce((prod, x) => prod * x.pStep, 1);
		return {
			startState: node.states[0] ?? "",
			actions: node.actions,
			states: node.states,
			totalEfe: node.totalEfe,
			undiscountedEfe: round$4(node.steps.reduce((s, x) => s + x.efe, 0)),
			pAllSuccess: node.pSuccess,
			steps: node.steps,
			riskProfile: node.steps.map((s) => ({
				step: s.step,
				pFailAt: round$4(before(s.step) * (1 - s.pStep))
			})),
			epistemicMonotone: checkEpistemicMonotone(node.steps)
		};
	}
};
function edgeKey(state, action) {
	return `${state}\u0000${action}`;
}
/** 认知价值坍缩校验：同一条边重访时认知价值单调不增 */
function checkEpistemicMonotone(steps) {
	const lastEpistemic = /* @__PURE__ */ new Map();
	for (const s of steps) {
		const key = edgeKey(s.state, s.action);
		const prev = lastEpistemic.get(key);
		if (prev !== void 0 && s.epistemic > prev + 1e-9) return false;
		lastEpistemic.set(key, s.epistemic);
	}
	return true;
}
function round$4(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/core/metareasoning.ts
const DEFAULT_METAREASONING_CONFIG = {
	decisivenessGap: .25,
	sufficientEvidence: 8,
	habitPromotionSuccesses: 2,
	maxDepth: 4,
	beamBreadth: 6,
	natPerNode: .01,
	budgetNat: 2,
	reactiveTightening: .8,
	minDecisivenessGap: .08,
	metaAlpha: .3
};
/**
* 元推理内核：双过程仲裁 + 任意时搜索 + 习惯摊销 + 元学习。
*
* 消费方：
* - optimizer：metacognitiveRecommendation（冷启动推荐的元认知版）
* - meta-cognition：认知经济 KPI（思考的价格与价值实测）
* - 宿主：决策执行后 settleDecision 回流（元学习闭环）
*/
var RationalMetareasoner = class {
	config;
	deliberation;
	habits = /* @__PURE__ */ new Map();
	pending = /* @__PURE__ */ new Map();
	decisionCounter = 0;
	modeCounts = {
		habit: 0,
		reactive: 0,
		deliberative: 0
	};
	totalSpendNat = 0;
	totalNodes = 0;
	deliberationDepths = [];
	habitSavingsNat = 0;
	staleHabitRegrets = 0;
	reactiveFailures = 0;
	modeOutcomes = {
		habit: {
			ema: void 0,
			settled: 0
		},
		reactive: {
			ema: void 0,
			settled: 0
		},
		deliberative: {
			ema: void 0,
			settled: 0
		}
	};
	dynamicGap;
	constructor(deliberation, config) {
		this.deliberation = deliberation;
		this.config = {
			...DEFAULT_METAREASONING_CONFIG,
			...config
		};
		this.dynamicGap = this.config.decisivenessGap;
	}
	/**
	* 双过程仲裁：习惯 → 反应 → 深思，逐级升级、逐级定价。
	*
	* 元 EFE 判据（越低越好）：
	*   habit:       直答（查表成本 ≈ 0）——信任摊销经验
	*   reactive:    一步 EFE 差悬殊且证据充分 → VOC ≈ 0，想也不会变
	*   deliberative: 任意时搜索直到首行动稳定或预算耗尽
	*/
	decide(state, candidates, opts) {
		const preference = opts?.preference ?? .9;
		if (candidates.length === 0) throw new Error("metareasoning.decide: 候选行动为空（无决策可仲裁）");
		const habit = this.habits.get(state);
		if (habit) {
			habit.usages += 1;
			habit.lastUsedAt = Date.now();
			const saved = this.estimateDeliberationCost(habit.actions.length);
			this.habitSavingsNat += saved;
			return this.record({
				state,
				mode: "habit",
				actions: [...habit.actions],
				costNat: 0,
				nodesExpanded: 0,
				depthStopped: 0,
				firstActionStable: true,
				reactiveGap: 0,
				rationale: `习惯命中：${habit.actions.join(" → ")}（连续成功 ${habit.consecutiveSuccesses}，省下 ≈${saved.toFixed(2)} nat 搜索）`
			});
		}
		const singles = candidates.map((action) => {
			const report = this.deliberation.imagine(state, [action], preference);
			return {
				action,
				efe: report.totalEfe,
				evidence: report.steps[0]?.evidence ?? 0
			};
		}).sort((a, b) => a.efe - b.efe);
		const best = singles[0];
		const second = singles[1];
		const gap = second ? second.efe - best.efe : Infinity;
		if (singles.length === 1 || gap >= this.dynamicGap && (best?.evidence ?? 0) >= this.config.sufficientEvidence) return this.record({
			state,
			mode: "reactive",
			actions: [best.action],
			costNat: round$3(singles.length * this.config.natPerNode),
			nodesExpanded: singles.length,
			depthStopped: 1,
			firstActionStable: true,
			reactiveGap: round$3(gap === Infinity ? 0 : gap),
			rationale: singles.length === 1 ? `唯一候选 → 直接反应（${best.action}）` : `优劣悬殊（gap ${gap.toFixed(3)} ≥ ${this.dynamicGap.toFixed(3)} nat，证据 ${best.evidence.toFixed(0)}）→ 深思不会改变选择，VOC ≈ 0`
		});
		const search = this.searchAnytime(state, candidates, preference, opts?.useSkills, opts?.advance);
		return this.record({
			state,
			mode: "deliberative",
			actions: search.report.actions,
			report: search.report,
			costNat: round$3(search.nodes * this.config.natPerNode),
			nodesExpanded: search.nodes,
			depthStopped: search.depthStopped,
			firstActionStable: search.stable,
			reactiveGap: round$3(gap === Infinity ? 0 : gap),
			rationale: search.stable ? `深思收敛：首行动 ${search.report.actions[0]} 连续 ${search.stableRounds} 层不变（深度 ${search.depthStopped} 早停，省 ${((this.config.maxDepth - search.depthStopped) * candidates.length).toFixed(0)} 节点）` : `深思预算耗尽（${search.nodes} 节点 / ${this.config.budgetNat} nat），首行动 ${search.report.actions[0]}（未收敛，结果存疑）`
		});
	}
	/**
	* 任意时搜索：逐深度展开，首行动连续 stableRounds 层不变即停。
	*
	* 停机判据的数学含义：beam 在深度 d 与 d+1 给出的最优计划首行动
	* 相同 → 深层补偿已不影响当下选择 → 继续搜索的期望决策增益 < 成本。
	* 这是「思考收敛」的可观测证据，不是拍脑袋的深度上限。
	*/
	searchAnytime(state, candidates, preference, useSkills, advance) {
		let nodes = 0;
		let prevFirst;
		let stableRounds = 0;
		let last;
		let depthStopped = 0;
		let stable = false;
		for (let depth = 1; depth <= this.config.maxDepth; depth += 1) {
			const result = this.deliberation.search(state, candidates, {
				depth,
				breadth: this.config.beamBreadth,
				preference,
				useSkills,
				advance
			});
			nodes += result.expandedNodes;
			last = result.best ?? last;
			depthStopped = depth;
			if (budgetExhausted(nodes, this.config)) break;
			if (!last) break;
			const first = last.actions[0];
			if (first === prevFirst) {
				stableRounds += 1;
				if (stableRounds >= 1) {
					stable = true;
					break;
				}
			} else stableRounds = 0;
			prevFirst = first;
		}
		return {
			report: last ?? {
				actions: [],
				totalEfe: Infinity
			},
			nodes,
			depthStopped,
			stable,
			stableRounds
		};
	}
	/**
	* 决策结算：现实的后果校准元认知。
	*
	* - 习惯失手 → 习惯作废（世界漂移铁证）+ 元遗憾（不该省的思考）
	* - 反应失手 → 门槛收紧（下次更早进入深思）
	* - 深思成功且重复 → 习惯晋升候选（摊销推断）
	* - 各模式成功率 EMA 更新（思考价值的实测）
	*/
	settleDecision(decisionId, overallSuccess, actionsTaken) {
		const decision = this.pending.get(decisionId);
		if (!decision || decision.settled) return;
		decision.settled = true;
		decision.outcome = overallSuccess;
		const stat = this.modeOutcomes[decision.mode];
		stat.ema = stat.ema === void 0 ? overallSuccess ? 1 : 0 : (1 - this.config.metaAlpha) * stat.ema + this.config.metaAlpha * (overallSuccess ? 1 : 0);
		stat.settled += 1;
		if (decision.mode === "habit") {
			const habit = this.habits.get(decision.state);
			if (habit) {
				if (overallSuccess) habit.consecutiveSuccesses += 1;
				else {
					this.habits.delete(decision.state);
					this.staleHabitRegrets += 1;
				}
			}
		} else if (decision.mode === "reactive") {
			if (!overallSuccess) {
				this.reactiveFailures += 1;
				this.dynamicGap = Math.max(this.config.minDecisivenessGap, this.dynamicGap * this.config.reactiveTightening);
			}
		} else if (decision.mode === "deliberative") {
			if (overallSuccess) {
				const taken = actionsTaken ?? decision.actions;
				const draft = this.drafts.get(decision.state);
				if (draft && draft.actions.join("|") === taken.join("|")) draft.successes += 1;
				else this.drafts.set(decision.state, {
					actions: taken,
					successes: 1
				});
				const candidate = this.drafts.get(decision.state);
				if (candidate.successes >= this.config.habitPromotionSuccesses) {
					const reliability = this.deliberation.imagine(decision.state, taken, .9).pAllSuccess;
					this.habits.set(decision.state, {
						state: decision.state,
						actions: [...taken],
						consecutiveSuccesses: candidate.successes,
						usages: 0,
						reliability: round$3(reliability),
						createdAt: Date.now(),
						lastUsedAt: Date.now()
					});
					this.drafts.delete(decision.state);
				}
			} else this.drafts.delete(decision.state);
		}
		this.pending.delete(decisionId);
	}
	/** 未结算决策的只读视图（宿主对账用） */
	pendingDecisions() {
		return [...this.pending.values()];
	}
	/** 当前动态反应门槛（元学习可观测） */
	currentDecisivenessGap() {
		return round$3(this.dynamicGap);
	}
	/** 习惯库只读视图（审计） */
	allHabits() {
		return [...this.habits.values()].sort((a, b) => b.consecutiveSuccesses - a.consecutiveSuccesses);
	}
	/** 手动作废习惯（上游漂移信号，如变分自由能报警时） */
	invalidateHabit(state) {
		return this.habits.delete(state);
	}
	/** 认知经济报告：思考的价格与价值的统一核算 */
	cognitiveEconomy() {
		const decisions = this.modeCounts.habit + this.modeCounts.reactive + this.modeCounts.deliberative;
		const share = (m) => decisions === 0 ? 0 : round$3(this.modeCounts[m] / decisions);
		const avgDepth = this.deliberationDepths.length > 0 ? round$3(this.deliberationDepths.reduce((a, b) => a + b, 0) / this.deliberationDepths.length) : 0;
		const modeSuccessRate = {};
		for (const [mode, stat] of Object.entries(this.modeOutcomes)) if (stat.ema !== void 0) modeSuccessRate[mode] = round$3(stat.ema);
		const interpretation = decisions === 0 ? "尚未决策：元推理待命" : this.staleHabitRegrets > 0 ? `习惯失灵 ${this.staleHabitRegrets} 次：世界在漂移，摊销经验需重建（已自动作废）` : this.habitHitRate(decisions) > .5 ? `认知经济健康：${(this.habitHitRate(decisions) * 100).toFixed(0)}% 决策走习惯直答，累计省 ${this.habitSavingsNat.toFixed(2)} nat` : this.modeCounts.reactive > this.modeCounts.deliberative * 3 ? "反应主导：多数决策证据充分，深思预算集中用在疑难处" : "深思主导：局势不确定，思考是主要开销——观察收敛深度是否下降";
		return {
			decisions,
			modeShare: {
				habit: share("habit"),
				reactive: share("reactive"),
				deliberative: share("deliberative")
			},
			habitSavingsNat: round$3(this.habitSavingsNat),
			totalSpendNat: round$3(this.totalSpendNat),
			totalNodes: this.totalNodes,
			habits: this.habits.size,
			habitHitRate: round$3(this.habitHitRate(decisions)),
			staleHabitRegrets: this.staleHabitRegrets,
			reactiveFailures: this.reactiveFailures,
			modeSuccessRate,
			avgDeliberationDepth: avgDepth,
			interpretation
		};
	}
	habitHitRate(decisions) {
		return decisions === 0 ? 0 : this.modeCounts.habit / decisions;
	}
	/** 同长度深思的成本估算（习惯节省额入账口径） */
	estimateDeliberationCost(steps) {
		return round$3(steps * this.config.beamBreadth * this.config.natPerNode * 2);
	}
	/** 决策入账（pending 登记 + 认知经济计数） */
	record(input) {
		this.decisionCounter += 1;
		const id = this.decisionCounter;
		this.modeCounts[input.mode] += 1;
		this.totalSpendNat += input.costNat;
		this.totalNodes += input.nodesExpanded;
		if (input.mode === "deliberative") this.deliberationDepths.push(input.depthStopped);
		this.pending.set(id, {
			id,
			ts: Date.now(),
			state: input.state,
			mode: input.mode,
			actions: input.actions,
			costNat: input.costNat,
			nodesExpanded: input.nodesExpanded,
			depthStopped: input.depthStopped,
			firstActionStable: input.firstActionStable,
			reactiveGap: input.reactiveGap,
			settled: false
		});
		return {
			mode: input.mode,
			actions: input.actions,
			report: input.report,
			costNat: input.costNat,
			nodesExpanded: input.nodesExpanded,
			decisionId: id,
			reactiveGap: input.reactiveGap,
			depthStopped: input.depthStopped,
			rationale: input.rationale
		};
	}
	/** 晋升草稿（同状态连续同计划成功计数） */
	drafts = /* @__PURE__ */ new Map();
};
function budgetExhausted(nodes, config) {
	return nodes * config.natPerNode >= config.budgetNat;
}
function round$3(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/core/abstraction.ts
const DEFAULT_ABSTRACTION_CONFIG = {
	analogyStrength: 6,
	domainStrength: 4,
	globalStrength: 3,
	minSimilarity: .3,
	abstractSkillDomains: 2,
	maxProfileSize: 4096
};
/** 骨架级键：domain \0 skeleton \0 action（= 叶子键，用于排除自身） */
function skKey(domain, skeleton, action) {
	return `${domain}\u0000${skeleton}\u0000${action}`;
}
/** 域×行动键（域边际层） */
function domKey(domain, action) {
	return `${domain}\u0000${action}`;
}
/** 全局骨架×行动键 */
function globKey(skeleton, action) {
	return `${skeleton}\u0000${action}`;
}
/**
* 抽象内核：状态骨架分解 + 域结构相似度 + 分层先验链 + 后继继承
* + 抽象技能晋升。
*
* 挂载于 DeliberationEngine（attachAbstraction）：observe 喂入证据、
* posterior 经分层先验收缩、冷叶子继承别域后继结构、搜索种子合并
* 抽象技能。未挂载时对既有行为零影响（先验链不参与）。
*/
var AbstractionEngine = class {
	config;
	/** 骨架级证据（域, 骨架, 行动）——L1 目标 + 画像 + 自身排除基数 */
	skeletonEdges = /* @__PURE__ */ new Map();
	/** 域×行动边际（L2） */
	domainAction = /* @__PURE__ */ new Map();
	/** 全局骨架×行动（L3） */
	globalSkeleton = /* @__PURE__ */ new Map();
	/** 域画像（域 → 观测过的 skeleton|action 集合）——相似度原料 */
	profiles = /* @__PURE__ */ new Map();
	/** 抽象技能晋升追踪（骨架||签名 → 跨域成功） */
	skillLadder = /* @__PURE__ */ new Map();
	abstractSkills = [];
	skillCounter = 0;
	zeroShotAnswers = 0;
	analogyTransfers = 0;
	successorInheritances = 0;
	constructor(config) {
		this.config = {
			...DEFAULT_ABSTRACTION_CONFIG,
			...config
		};
	}
	/**
	* 登记一次观测（与 DeliberationEngine.observe 同步调用）。
	* @param nextState 成功时的后继状态（后继继承的原料）
	*/
	observe(state, action, success, nextState) {
		const { domain, skeleton } = decompose(state);
		const key = skKey(domain, skeleton, action);
		let edge = this.skeletonEdges.get(key);
		if (!edge) {
			edge = {
				successes: 0,
				failures: 0,
				successors: /* @__PURE__ */ new Map()
			};
			this.skeletonEdges.set(key, edge);
		}
		const dk = domKey(domain, action);
		const dm = this.domainAction.get(dk) ?? {
			successes: 0,
			failures: 0
		};
		const gk = globKey(skeleton, action);
		const gm = this.globalSkeleton.get(gk) ?? {
			successes: 0,
			failures: 0
		};
		if (success) {
			edge.successes += 1;
			dm.successes += 1;
			gm.successes += 1;
			if (nextState) edge.successors.set(nextState, (edge.successors.get(nextState) ?? 0) + 1);
		} else {
			edge.failures += 1;
			dm.failures += 1;
			gm.failures += 1;
		}
		this.domainAction.set(dk, dm);
		this.globalSkeleton.set(gk, gm);
		let profile = this.profiles.get(domain);
		if (!profile) {
			profile = /* @__PURE__ */ new Set();
			this.profiles.set(domain, profile);
		}
		if (profile.size < this.config.maxProfileSize) profile.add(`${skeleton}|${action}`);
	}
	/**
	* 查询 (state, action) 的分层先验（叶子证据之外的一切）。
	*
	* 优先级：L1 类比（结构相似域同骨架）→ L2 域边际（本域其他骨架）
	* → L3 全局骨架（无权跨域）→ L4 均匀。各层均排除查询叶子自身
	* 的证据（防双计——deliberation 会把叶子证据加回后验）。
	*/
	hierarchicalPrior(state, action) {
		const { domain, skeleton } = decompose(state);
		const own = this.skeletonEdges.get(skKey(domain, skeleton, action));
		const ownS = own?.successes ?? 0;
		const ownF = own?.failures ?? 0;
		const candidates = [];
		for (const [key, edge] of this.skeletonEdges) {
			const [d, sk, a] = key.split("\0");
			if (d === domain || sk !== skeleton || a !== action) continue;
			const sim = this.structuralSimilarity(domain, d, skeleton, action);
			if (sim < this.config.minSimilarity) continue;
			const obs = edge.successes + edge.failures;
			if (obs < 1) continue;
			candidates.push({
				domain: d,
				sim,
				post: (1 + edge.successes) / (2 + obs),
				obs
			});
		}
		if (candidates.length > 0) {
			let wSum = 0;
			let acc = 0;
			let top = candidates[0];
			for (const c of candidates) {
				const w = c.sim * (c.obs / (c.obs + 2));
				acc += w * c.post;
				wSum += w;
				if (c.sim > top.sim) top = c;
			}
			if (wSum > 0) {
				this.analogyTransfers += 1;
				if (ownS + ownF === 0) this.zeroShotAnswers += 1;
				return {
					mean: acc / wSum,
					strength: this.config.analogyStrength,
					source: `analogy(${top.domain})`,
					witnessDomains: [...new Set(candidates.map((c) => c.domain))]
				};
			}
		}
		const dm = this.domainAction.get(domKey(domain, action));
		if (dm) {
			const dmS = dm.successes - ownS;
			const dmF = dm.failures - ownF;
			if (dmS + dmF >= 2) {
				if (ownS + ownF === 0) this.zeroShotAnswers += 1;
				return {
					mean: (1 + dmS) / (2 + dmS + dmF),
					strength: this.config.domainStrength,
					source: "domain-marginal"
				};
			}
		}
		const gm = this.globalSkeleton.get(globKey(skeleton, action));
		if (gm) {
			const gS = gm.successes - ownS;
			const gF = gm.failures - ownF;
			if (gS + gF >= 2) {
				if (ownS + ownF === 0) this.zeroShotAnswers += 1;
				return {
					mean: (1 + gS) / (2 + gS + gF),
					strength: this.config.globalStrength,
					source: "global-skeleton"
				};
			}
		}
		return {
			mean: .5,
			strength: 2,
			source: "uniform"
		};
	}
	/**
	* 冷叶子的后继结构继承：类比域 (骨架, 行动) 的 MAP 后继骨架
	* 映射回本域（trapA#s0 --bait--> trapA#dead ⟹ trapB#s0 --bait--> trapB#dead）。
	* 陷阱的本质在后继结构里——不继承结构就谈不上类比规划。
	* @returns 继承的后继状态；无可继承时 undefined
	*/
	inheritedSuccessor(state, action) {
		const { domain, skeleton } = decompose(state);
		let best;
		for (const [key, edge] of this.skeletonEdges) {
			const [d, sk, a] = key.split("\0");
			if (d === domain || sk !== skeleton || a !== action) continue;
			const sim = this.structuralSimilarity(domain, d, skeleton, action);
			if (sim < this.config.minSimilarity) continue;
			for (const [succ, count] of edge.successors) {
				const score = sim * count;
				if (!best || score > best.score) best = {
					successor: succ,
					score
				};
			}
		}
		if (!best) return void 0;
		const { skeleton: succSkeleton, hasSkeleton } = decompose(best.successor);
		if (!hasSkeleton) return void 0;
		this.successorInheritances += 1;
		return `${domain}#${succSkeleton}`;
	}
	/** 域画像 Jaccard：观测过的 (骨架, 行动) 集合重合度——结构同构可度量 */
	domainSimilarity(d1, d2) {
		if (d1 === d2) return 1;
		const p1 = this.profiles.get(d1);
		const p2 = this.profiles.get(d2);
		if (!p1 || !p2 || p1.size === 0 || p2.size === 0) return 0;
		let inter = 0;
		for (const k of p1) if (p2.has(k)) inter += 1;
		return inter / (p1.size + p2.size - inter);
	}
	/**
	* 查询口径的结构相似度（含冷域首触规则）：
	* - 查询域已有画像：严格 Jaccard（闸门防误迁移；一旦发现域并非
	*   同构，相似度跌破门槛，类比自动停止——错误类比自纠）
	* - 查询域全冷（无任何观测）：对方在**恰好这个结构位置**
	*   (骨架, 行动) 上有经验即为证人（sim=1）——处女域相信任何
	*   走过同一条结构路的前辈；先验强度（6 伪计数）约束借用幅度，
	*   自身证据积累后严格闸门接管
	*/
	structuralSimilarity(domain, other, skeleton, action) {
		const p1 = this.profiles.get(domain);
		if (p1 && p1.size > 0) return this.domainSimilarity(domain, other);
		const p2 = this.profiles.get(other);
		if (!p2) return 0;
		return p2.has(`${skeleton}|${action}`) ? 1 : 0;
	}
	/** 已观测域列表（audit） */
	domains() {
		return [...this.profiles.keys()];
	}
	/**
	* 计划结局入账（与 DeliberationEngine.settle 同步）：
	* 同一骨架同一行动序列在多个域整体成功 → 跨域宏技能晋升。
	*/
	notePlanOutcome(firstState, actions, success) {
		if (actions.length === 0) return;
		const { domain, skeleton } = decompose(firstState);
		const sig = actions.join("|");
		const key = `${skeleton}||${sig}`;
		let entry = this.skillLadder.get(key);
		if (!entry) {
			entry = {
				skeleton,
				actions: [...actions],
				domains: /* @__PURE__ */ new Set(),
				successes: 0
			};
			this.skillLadder.set(key, entry);
		}
		if (success) {
			entry.domains.add(domain);
			entry.successes += 1;
			if (entry.domains.size >= this.config.abstractSkillDomains && !this.abstractSkills.some((s) => s.skeleton === entry.skeleton && s.actions.join("|") === sig)) this.abstractSkills.push({
				id: `abs-skill-${++this.skillCounter}`,
				skeleton: entry.skeleton,
				actions: [...entry.actions],
				domains: entry.domains.size,
				successes: entry.successes,
				value: round$2(entry.successes / (entry.successes + 1))
			});
		} else {
			entry.domains.delete(domain);
			entry.successes = Math.max(0, entry.successes - 1);
		}
	}
	/** 检索：匹配状态骨架的抽象技能（跨域宏动作） */
	abstractSkillsFor(state) {
		const { skeleton } = decompose(state);
		return this.abstractSkills.filter((s) => s.skeleton === skeleton);
	}
	/** 全部抽象技能（audit） */
	allAbstractSkills() {
		return [...this.abstractSkills];
	}
	stats() {
		const zeroShot = this.zeroShotAnswers;
		const interpretation = this.profiles.size === 0 ? "无跨域证据：抽象待命" : this.abstractSkills.length > 0 ? `已晋升 ${this.abstractSkills.length} 个跨域宏技能（举一反三成型）` : this.analogyTransfers > 0 ? `类比迁移 ${this.analogyTransfers} 次、零样本应答 ${zeroShot} 次（经验跨域流动中）` : `${this.profiles.size} 个域已观测，尚无同构结构相遇（相似度 < ${this.config.minSimilarity}）`;
		return {
			domains: this.profiles.size,
			structuralEdges: this.skeletonEdges.size,
			zeroShotAnswers: zeroShot,
			analogyTransfers: this.analogyTransfers,
			successorInheritances: this.successorInheritances,
			abstractSkills: this.abstractSkills.length,
			interpretation
		};
	}
	serialize() {
		const skeletonEdges = [];
		for (const [key, edge] of this.skeletonEdges) {
			const [domain, skeleton, action] = key.split("\0");
			skeletonEdges.push({
				domain,
				skeleton,
				action,
				successes: edge.successes,
				failures: edge.failures,
				successors: [...edge.successors]
			});
		}
		return {
			skeletonEdges,
			domainAction: [...this.domainAction].map(([key, v]) => {
				const [domain, action] = key.split("\0");
				return {
					domain,
					action,
					successes: v.successes,
					failures: v.failures
				};
			}),
			globalSkeleton: [...this.globalSkeleton].map(([key, v]) => {
				const [skeleton, action] = key.split("\0");
				return {
					skeleton,
					action,
					successes: v.successes,
					failures: v.failures
				};
			}),
			abstractSkills: [...this.abstractSkills],
			counters: {
				zeroShotAnswers: this.zeroShotAnswers,
				analogyTransfers: this.analogyTransfers,
				successorInheritances: this.successorInheritances
			}
		};
	}
	deserialize(data) {
		this.skeletonEdges.clear();
		this.domainAction.clear();
		this.globalSkeleton.clear();
		this.profiles.clear();
		this.skillLadder.clear();
		this.abstractSkills = [];
		for (const e of data.skeletonEdges) {
			this.skeletonEdges.set(skKey(e.domain, e.skeleton, e.action), {
				successes: e.successes,
				failures: e.failures,
				successors: new Map(e.successors)
			});
			const profile = this.profiles.get(e.domain) ?? /* @__PURE__ */ new Set();
			profile.add(`${e.skeleton}|${e.action}`);
			this.profiles.set(e.domain, profile);
		}
		for (const d of data.domainAction) this.domainAction.set(domKey(d.domain, d.action), {
			successes: d.successes,
			failures: d.failures
		});
		for (const g of data.globalSkeleton) this.globalSkeleton.set(globKey(g.skeleton, g.action), {
			successes: g.successes,
			failures: g.failures
		});
		this.abstractSkills = [...data.abstractSkills];
		this.skillCounter = this.abstractSkills.length;
		const c = data.counters;
		this.zeroShotAnswers = c?.zeroShotAnswers ?? 0;
		this.analogyTransfers = c?.analogyTransfers ?? 0;
		this.successorInheritances = c?.successorInheritances ?? 0;
		for (const s of this.abstractSkills) this.skillLadder.set(`${s.skeleton}||${s.actions.join("|")}`, {
			skeleton: s.skeleton,
			actions: [...s.actions],
			domains: new Set(this.domains()),
			successes: s.successes
		});
	}
};
/**
* 状态分解：`${domain}#${skeleton...}`（'#' 后全部视为骨架，支持多段）。
* 无 '#' 时骨架为空串（单段状态——相似度闸门防误迁移）。
*/
function decompose(state) {
	const idx = state.indexOf("#");
	if (idx < 0) return {
		domain: state,
		skeleton: "",
		hasSkeleton: false
	};
	return {
		domain: state.slice(0, idx),
		skeleton: state.slice(idx + 1),
		hasSkeleton: true
	};
}
function round$2(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/core/scientist.ts
const DEFAULT_SCIENTIST_CONFIG = {
	defaultCostNat: .05,
	maxConfoundingBonus: 1,
	lawBonusCap: 1,
	minArmSamples: 0,
	calibrationAlpha: .3
};
/**
* 科学家内核：EIG 实验设计 + 混杂侦测加成 + 最优臂选择 + 预算仲裁
* + 信息台账 + 知识前沿。
*
* 数据流：
*   registerQuestion（问题空间）→ designExperiments（最优设计）
*   → 宿主执行 do-干预 → settleExperiment（图更新 + 惊奇回流 + 台账）
*   → knowledgeFrontier（知识版图收缩可审计）
*/
var ScientistMind = class {
	config;
	kernel;
	freeEnergy;
	/** 11.0：理论内核（挂载后作用域内的问题获得定律试验加成） */
	theorist;
	questions = /* @__PURE__ */ new Map();
	ledger = [];
	experimentCounter = 0;
	cumulativePromised = 0;
	cumulativeRealized = 0;
	calibrationEma;
	constructor(kernel, freeEnergy, config) {
		this.kernel = kernel;
		this.freeEnergy = freeEnergy;
		this.config = {
			...DEFAULT_SCIENTIST_CONFIG,
			...config
		};
	}
	/** 挂载自由能引擎（实验结局的惊奇回流；幂等） */
	attachFreeEnergyEngine(engine) {
		this.freeEnergy = engine;
	}
	/** 11.0：挂载理论内核（定律试验加成；幂等） */
	attachTheorist(theorist) {
		this.theorist = theorist;
	}
	/**
	* 登记因果问题：一条值得回答的「X 是否导致 Y」。
	* 问题空间由宿主/好奇心/调度器声明——科学家只对已声明的问题设计实验。
	*/
	registerQuestion(from, to, why = "声明待补", costNat) {
		const key = qKey(from, to);
		const existing = this.questions.get(key);
		if (existing) {
			if (costNat !== void 0) existing.costNat = costNat;
			return existing;
		}
		const q = {
			from,
			to,
			why,
			costNat,
			createdAt: Date.now()
		};
		this.questions.set(key, q);
		return q;
	}
	/** 注销问题（问题被回答或不再关心） */
	unregisterQuestion(from, to) {
		return this.questions.delete(qKey(from, to));
	}
	/** 问题空间只读视图 */
	allQuestions() {
		return [...this.questions.values()];
	}
	/**
	* 最优实验设计：对问题空间逐一计算 EIG，按净价值排序。
	*
	* 每个问题的评估：
	*   1. 两臂 Beta(1+s, 1+f) 重构（与因果内核 effect() 同数学）
	*   2. 各臂 EIG = 一步期望熵收缩；取大者为最优臂
	*   3. 混杂加成 = −ln(1 − confounding)（背离只能干预裁决）
	*   4. netValue = totalEig − costNat；≤0 不设计（预算仲裁）
	*
	* @param maxCount 最多返回的设计数（组合预算）
	*/
	designExperiments(maxCount = 3, now = Date.now()) {
		const designs = [];
		for (const q of this.questions.values()) {
			const eff = this.kernel.effect(q.from, q.to, now);
			const ev = this.kernel.armEvidence(q.from, q.to, now);
			if (!ev) continue;
			const evals = [{
				arm: true,
				s: ev.doXSuccess,
				f: ev.doXFailure
			}, {
				arm: false,
				s: ev.doNotXSuccess,
				f: ev.doNotXFailure
			}].map((a) => eigOfBeta(1 + a.s, 1 + a.f));
			const best = evals[0].eig >= evals[1].eig ? {
				...evals[0],
				arm: true
			} : {
				...evals[1],
				arm: false
			};
			if (ev.doXSuccess + ev.doXFailure + ev.doNotXSuccess + ev.doNotXFailure < this.config.minArmSamples * 2) continue;
			const divergence = eff.confounding;
			const bonus = divergence > 0 ? Math.min(this.config.maxConfoundingBonus, -Math.log(Math.max(1e-9, 1 - divergence))) : 0;
			const law = this.theorist?.coveringTheory(q.from, q.to, now);
			const lawBonus = law ? Math.min(this.config.lawBonusCap, Math.log(law.members.length + 1)) : 0;
			const costNat = q.costNat ?? this.config.defaultCostNat;
			const totalEig = best.eig + bonus + lawBonus;
			const netValue = totalEig - costNat;
			if (netValue <= 0) continue;
			designs.push({
				id: 0,
				from: q.from,
				to: q.to,
				arm: best.arm,
				armEig: round$1(best.eig),
				confoundingBonus: round$1(bonus),
				lawBonus: round$1(lawBonus),
				totalEig: round$1(totalEig),
				netValue: round$1(netValue),
				priorAlpha: best.alpha,
				priorBeta: best.beta,
				predictedP: round$1(best.p),
				hypothesis: `假设：do(${q.from}=${best.arm ? "启用" : "停用"}) 对 ${q.to} 的效应将落在当前后验 ${best.p.toFixed(2)} 附近（混杂分歧 ${divergence.toFixed(2)}${divergence > 0 ? "，唯有干预可裁决" : ""}）`,
				rationale: divergence > 0 ? `混杂加成 +${round$1(bonus)} nat：观测关联 ${eff.observationalAssociation.toFixed(2)} vs 干预效应 ${eff.ate.toFixed(2)} 背离——该边因果问题只能由干预裁决` : lawBonus > 0 ? `定律试验 +${round$1(lawBonus)} nat：该边在定律 ${law.id}（${law.members.length} 条边，P≈${law.lawP.toFixed(2)}）作用域内——一次实验校准整个作用域` : `最优臂 do=${best.arm}：一步期望熵收缩 ${best.eig.toFixed(3)} nat（另一臂 ${(best.eig === evals[0].eig ? evals[1].eig : evals[0].eig).toFixed(3)} nat）`
			});
		}
		designs.sort((a, b) => b.netValue - a.netValue);
		return designs.slice(0, maxCount).map((d) => {
			this.experimentCounter += 1;
			return {
				...d,
				id: this.experimentCounter
			};
		});
	}
	/**
	* 结算实验：宿主已按设计执行 do-干预并观测到 Y。
	*
	* 三重回流 + 台账：
	* 1. 因果内核干预证据入库（黄金证据）
	* 2. 自由能惊奇回流（预测 vs 结局）
	* 3. 台账：承诺 EIG vs 实际熵收缩（设计校准）
	*
	* @returns 台账条目；设计不存在或重复结算返回 undefined
	*/
	settleExperiment(design, observedY, actor = "scientist", now = Date.now()) {
		this.kernel.intervene(design.from, design.to, design.arm, observedY, actor, design.hypothesis, now);
		const predicted = clampProb(design.predictedP);
		const surprisal = -Math.log(observedY ? predicted : 1 - predicted);
		const h0 = betaEntropy(design.priorAlpha, design.priorBeta);
		const hAfter = betaEntropy(design.priorAlpha + (observedY ? 1 : 0), design.priorBeta + (observedY ? 0 : 1));
		const realized = Math.max(0, h0 - hAfter);
		this.freeEnergy?.observeSurprisal(predicted, observedY);
		this.experimentCounter = Math.max(this.experimentCounter, design.id);
		this.cumulativePromised += design.totalEig;
		this.cumulativeRealized += realized;
		const gap = Math.abs(design.totalEig - realized);
		this.calibrationEma = this.calibrationEma === void 0 ? gap : (1 - this.config.calibrationAlpha) * this.calibrationEma + this.config.calibrationAlpha * gap;
		const entry = {
			experimentId: design.id,
			from: design.from,
			to: design.to,
			arm: design.arm,
			observedY,
			promisedEig: round$1(design.totalEig),
			realizedInfo: round$1(realized),
			surprisal: round$1(surprisal),
			settledAt: now
		};
		this.ledger.push(entry);
		return entry;
	}
	/** 知识前沿报告：知识版图的总未知量与设计的兑现率（第五层 KPI） */
	knowledgeFrontier(now = Date.now()) {
		let residual = 0;
		let confounded = 0;
		for (const q of this.questions.values()) {
			const eff = this.kernel.effect(q.from, q.to, now);
			const ev = this.kernel.armEvidence(q.from, q.to, now);
			if (!ev) continue;
			residual += betaEntropy(1 + ev.doXSuccess, 1 + ev.doXFailure);
			residual += betaEntropy(1 + ev.doNotXSuccess, 1 + ev.doNotXFailure);
			if (eff.confounding > .2) confounded += 1;
		}
		const delivered = this.cumulativePromised > 0 ? this.cumulativeRealized / this.cumulativePromised : 0;
		const interpretation = this.questions.size === 0 ? "问题空间为空：科学家待命（registerQuestion 声明因果问题）" : this.ledger.length === 0 ? `${this.questions.size} 个因果问题待设计（前沿残差 ${residual.toFixed(2)} nat）` : confounded > 0 ? `${confounded} 个混杂分歧待干预裁决（观测不可解）；已兑现 ${this.cumulativeRealized.toFixed(2)}/${this.cumulativePromised.toFixed(2)} nat` : `知识版图收缩中：残差 ${residual.toFixed(2)} nat，实验 ${this.ledger.length} 次，兑现率 ${(delivered * 100).toFixed(0)}%`;
		return {
			questions: this.questions.size,
			confoundedQuestions: confounded,
			residualEntropyNat: round$1(residual),
			experimentsRun: this.ledger.length,
			cumulativePromisedNat: round$1(this.cumulativePromised),
			cumulativeRealizedNat: round$1(this.cumulativeRealized),
			deliveryRate: round$1(delivered),
			designCalibration: round$1(this.calibrationEma ?? 0),
			interpretation
		};
	}
	/** 台账只读视图（审计） */
	experimentLedger() {
		return [...this.ledger];
	}
};
function qKey(from, to) {
	return `${from}→${to}`;
}
/** Beta(α,β) 臂的一步期望信息增益（nat）——与自由能认知价值同公式 */
function eigOfBeta(alpha, beta) {
	const p = alpha / (alpha + beta);
	const h0 = betaEntropy(alpha, beta);
	const hYes = betaEntropy(alpha + 1, beta);
	const hNo = betaEntropy(alpha, beta + 1);
	return {
		eig: Math.max(0, h0 - (p * hYes + (1 - p) * hNo)),
		alpha,
		beta,
		p
	};
}
function clampProb(p) {
	return Math.min(1 - 1e-6, Math.max(1e-6, p));
}
function round$1(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/core/theorist.ts
const DEFAULT_THEORIST_CONFIG = {
	minMembers: 3,
	zeroShotMaxArmSamples: 1
};
/**
* 理论内核：定律归纳 + MDL 压缩定价 + 零样本预测 + 反常/范式转移。
*
* 数据流：
*   kernel.allEdgesEvidence（原料）→ induce（按 family→to 分组、
*   MDL 仲裁、范式转移）→ predict（定律零样本）→ frontier（第六层 KPI）
*
* 归纳是因果图的纯函数（确定性、可重放）；缓存仅避免重复计算。
*/
var TheoristEngine = class {
	config;
	kernel;
	cached = [];
	induced = false;
	zeroShotCount = 0;
	paradigmShiftCount = 0;
	/** 各作用域上次范式转移的成员签名（同状态重复归纳不重复计数） */
	shiftSignatures = /* @__PURE__ */ new Map();
	constructor(kernel, config) {
		this.kernel = kernel;
		this.config = {
			...DEFAULT_THEORIST_CONFIG,
			...config
		};
	}
	/**
	* 归纳定律：扫描因果图全边，按 (family(from) → to) 分组，
	* 每组做 MDL 仲裁——compression > 0 才立定律；
	* 整组不抵代价时驱逐最大偏离者（范式转移）为幸存者重建。
	*/
	induce(now = Date.now()) {
		const groups = /* @__PURE__ */ new Map();
		for (const ev of this.kernel.allEdgesEvidence(now)) {
			const n = ev.doXSuccess + ev.doXFailure;
			if (n < 1) continue;
			const family = familyOf(ev.from);
			const key = `${family}→${ev.to}`;
			let group = groups.get(key);
			if (!group) {
				group = {
					family,
					to: ev.to,
					members: []
				};
				groups.set(key, group);
			}
			group.members.push({
				from: ev.from,
				to: ev.to,
				successes: ev.doXSuccess,
				failures: ev.doXFailure,
				phat: ev.doXSuccess / n,
				fitsLawNat: 0,
				standaloneLogMlNat: lnBeta(1 + ev.doXSuccess, 1 + ev.doXFailure),
				anomalous: false
			});
		}
		const theories = [];
		for (const [key, group] of groups) {
			if (group.members.length < this.config.minMembers) continue;
			let current = group.members.map((m) => ({ ...m }));
			const outliers = [];
			let paradigmShift = false;
			let t = this.evaluate(current);
			while (t.compressionNat <= 0 && current.length > this.config.minMembers) {
				const worst = current.reduce((a, b) => b.fitsLawNat < a.fitsLawNat ? b : a);
				outliers.push(worst);
				current = current.filter((m) => m !== worst);
				paradigmShift = true;
				t = this.evaluate(current);
			}
			if (t.compressionNat <= 0) continue;
			if (paradigmShift) {
				const sig = `${current.map((m) => m.from).sort().join(",")}|${outliers.map((m) => m.from).sort().join(",")}`;
				if (this.shiftSignatures.get(key) !== sig) {
					this.paradigmShiftCount += 1;
					this.shiftSignatures.set(key, sig);
				}
			} else this.shiftSignatures.delete(key);
			theories.push({
				...t,
				id: key,
				family: group.family,
				to: group.to,
				outliers,
				paradigmShift,
				inducedAt: now
			});
		}
		this.cached = theories;
		this.induced = true;
		return theories;
	}
	/** 覆盖 (from → to) 的在世定律（无缓存时惰性归纳） */
	coveringTheory(from, to, now = Date.now()) {
		if (!this.induced) this.induce(now);
		return this.cached.find((t) => t.family === familyOf(from) && t.to === to);
	}
	/**
	* 定律零样本预测：作用域内臂证据稀疏的边直接拿定律后验说话。
	* 新成员入族即继承全族知识——定律覆盖处无冷启动。
	*/
	predict(from, to, now = Date.now()) {
		const theory = this.coveringTheory(from, to, now);
		if (!theory) return void 0;
		const ev = this.kernel.armEvidence(from, to, now);
		if ((ev ? ev.doXSuccess + ev.doXFailure : 0) >= this.config.zeroShotMaxArmSamples) return void 0;
		this.zeroShotCount += 1;
		return {
			theoryId: theory.id,
			p: theory.lawP,
			lower: theory.lawLower,
			upper: theory.lawUpper
		};
	}
	/** 在世定律只读视图 */
	allTheories() {
		return this.cached.map((t) => ({
			...t,
			members: t.members.map((m) => ({ ...m })),
			outliers: [...t.outliers]
		}));
	}
	/**
	* 理论前沿报告（第六层 KPI：知识的压缩与体系化）。
	* 每次读取都基于当前因果图重归纳——KPI 永不呈现过期定律，
	* 且宿主无需显式调用 induce（挂载即生效；归纳是纯函数，
	* 心跳粒度重算成本 O(边数)，范式转移计数已去重防虚增）。
	*/
	frontier(now = Date.now()) {
		this.induce(now);
		const compression = this.cached.reduce((a, t) => a + t.compressionNat, 0);
		const compressed = this.cached.reduce((a, t) => a + t.members.length, 0);
		const outliers = this.cached.reduce((a, t) => a + t.outliers.length, 0);
		const contested = this.cached.filter((t) => t.status === "contested").length;
		const interpretation = this.cached.length === 0 ? "无在世定律：知识仍是散落的边统计（induce 归纳或证据不足）" : `${this.cached.length} 条定律压缩 ${compressed} 条边（省 ${compression.toFixed(2)} nat）` + (contested > 0 ? `；${contested} 条存疑（反常者待裁决）` : "") + (outliers > 0 ? `；${outliers} 个 outlier（新范式种子）` : "");
		return {
			theories: this.cached.length,
			compressedEdges: compressed,
			outlierEdges: outliers,
			compressionNat: round(compression),
			zeroShotPredictions: this.zeroShotCount,
			paradigmShifts: this.paradigmShiftCount,
			interpretation
		};
	}
	/** 对一组成员计算定律与模型比较账目（纯函数） */
	evaluate(members) {
		const S = members.reduce((a, m) => a + m.successes, 0);
		const F = members.reduce((a, m) => a + m.failures, 0);
		const lawP = (1 + S) / (2 + S + F);
		const lawLogMl = lnBeta(1 + S, 1 + F);
		const compressionNat = lawLogMl - members.reduce((a, m) => a + m.standaloneLogMlNat, 0);
		for (const m of members) {
			m.fitsLawNat = round(lawLogMl - lnBeta(1 + S - m.successes, 1 + F - m.failures) - m.standaloneLogMlNat);
			m.anomalous = m.fitsLawNat <= 0;
		}
		return {
			lawAlpha: 1 + S,
			lawBeta: 1 + F,
			lawP: round(lawP),
			lawLower: round(wilsonLowerBound(S, F)),
			lawUpper: round(wilsonUpperBound(S, F)),
			members,
			compressionNat: round(compressionNat),
			status: members.some((m) => m.anomalous) ? "contested" : "law",
			inducedAt: 0
		};
	}
};
/** ln B(α, β) = lnΓ(α) + lnΓ(β) − lnΓ(α+β)（先验预测对数似然的核） */
function lnBeta(alpha, beta) {
	return lnGamma(alpha) + lnGamma(beta) - lnGamma(alpha + beta);
}
/** 族名 = 节点 id 冒号前缀（`model:m-1` → `model`；无冒号即整体） */
function familyOf(id) {
	const idx = id.indexOf(":");
	return idx > 0 ? id.slice(0, idx) : id;
}
function round(x) {
	return Number(x.toFixed(6));
}
//#endregion
//#region src/curiosity-engine.ts
/** 默认配置 */
const DEFAULT_CURIOSITY_CONFIG = {
	explorationBudgetRatio: .3,
	lowExperienceThreshold: 2,
	highFailureRateThreshold: .5,
	noveltyUnknownWeight: .5,
	noveltyExposureWeight: .3,
	noveltyScarcityWeight: .2
};
/**
* 好奇心引擎
*
* 被 index.ts 持有：心跳循环在派发子任务前调用 proposeExplorations()
* 获取探索建议（受预算约束），探索完成后经 recordExploration() 回写收获。
*/
var CuriosityEngine = class {
	config;
	provider;
	explorations = [];
	/** 各类型历史探索次数 */
	explorationCounts = /* @__PURE__ */ new Map();
	/** 5.0：因果内核（挂载后好奇心升级为假设驱动的实验设计） */
	causal;
	/** 10.0：科学家内核（挂载后实验建议升级为 Lindley EIG 最优设计） */
	scientist;
	/** 5.0：因果实验历史 */
	causalExplorations = [];
	constructor(provider, config) {
		this.provider = provider;
		this.config = {
			...DEFAULT_CURIOSITY_CONFIG,
			...config
		};
	}
	/** 5.0：挂载因果内核（幂等） */
	attachCausalKernel(kernel) {
		this.causal = kernel;
	}
	/** 10.0：挂载科学家内核（幂等）——实验建议升级为 EIG 最优设计 */
	attachScientistMind(mind) {
		this.scientist = mind;
	}
	/**
	* 5.0：假设驱动实验设计 —— 好奇心的科学化。
	*
	* 质变点：旧版好奇心是「类型盲区扫描」（没做过什么就做什么）——
	* 探索目标由接触频率决定，与知识价值无关。挂载因果内核后，
	* 探索目标改为「因果图上不确定性最高 × 重要性最高的边」：
	* 每个建议自带可证伪假设与 do-干预方案。
	* 探索从「到处走走看」升级为「设计实验回答关键问题」。
	*
	* 10.0 质变（挂载科学家内核后）：建议口径从「不确定性 × 重要性」
	* 的启发式升级为 Lindley EIG 最优设计——每条建议携带净价值
	* （EIG + 混杂加成 − 实验代价，nat 口径）与最优臂选择，
	* 混杂分歧边（观测≠干预）优先——那是观测永远买不到的知识。
	*
	* @param targetKpi 实验关心的结果指标（默认 'task.outcome'；EIG 口径下仅作无科学家时的回退）
	* @param budget 本轮实验配额
	*/
	proposeCausalExperiments(targetKpi = "task.outcome", budget = 2) {
		if (this.scientist) {
			const designs = this.scientist.designExperiments(budget);
			if (designs.length > 0) return designs.map((d) => ({
				from: d.from,
				to: d.to,
				suggestedArm: d.arm,
				infoGain: Number((1 / (1 + Math.exp(-d.netValue))).toFixed(4)),
				hypothesis: `${d.hypothesis}（净价值 ${d.netValue.toFixed(3)} nat：EIG ${d.armEig.toFixed(3)} + 混杂 ${d.confoundingBonus.toFixed(3)} − 代价）`,
				uncertainty: 0
			}));
		}
		if (!this.causal) return [];
		return this.causal.suggestExperiments(targetKpi, budget);
	}
	/**
	* 10.0：EIG 最优实验设计透传（原生口径，供宿主直接执行与结算）。
	* 与 proposeCausalExperiments 的区别：不压缩为 0~1 启发式评分，
	* 返回完整的 DesignedExperiment（nat 口径 + 台账结算句柄）。
	*/
	designOptimalExperiments(maxCount = 3) {
		return this.scientist ? this.scientist.designExperiments(maxCount) : [];
	}
	/**
	* 5.0：回写因果实验结果（假设 → 干预 → 图更新闭环）。
	*
	* 证伪也是收获：假设被否定时区间同样收窄（后验收缩），
	* uncertaintyReduction > 0 即记 gainedKnowledge ——
	* 好奇心的收益率第一次有了科学口径（信息增益而非运气）。
	*/
	recordCausalExperiment(experiment, observedY) {
		if (!this.causal) return null;
		const before = this.causal.effect(experiment.from, experiment.to);
		const uncertaintyBefore = before.upper - before.lower;
		this.causal.intervene(experiment.from, experiment.to, experiment.setTo, observedY, "curiosity", experiment.hypothesis);
		const after = this.causal.effect(experiment.from, experiment.to);
		const uncertaintyAfter = after.upper - after.lower;
		const record = {
			...experiment,
			observedY,
			timestamp: Date.now(),
			uncertaintyBefore: Number(uncertaintyBefore.toFixed(4)),
			uncertaintyAfter: Number(uncertaintyAfter.toFixed(4)),
			hypothesisSupported: after.direction === "positive" === experiment.setTo
		};
		this.causalExplorations.push(record);
		if (this.causalExplorations.length > 200) this.causalExplorations.splice(0, this.causalExplorations.length - 200);
		this.explorationCounts.set(experiment.from, (this.explorationCounts.get(experiment.from) ?? 0) + 1);
		return record;
	}
	/** 5.0：因果实验历史 */
	getCausalExplorations() {
		return [...this.causalExplorations];
	}
	/** 5.0：实验的信息增益率（平均区间收缩比例） */
	getCausalYield() {
		if (this.causalExplorations.length === 0) return 0;
		const reductions = this.causalExplorations.map((r) => Math.max(0, r.uncertaintyBefore - r.uncertaintyAfter) / Math.max(.01, r.uncertaintyBefore));
		return Number((reductions.reduce((a, b) => a + b, 0) / reductions.length).toFixed(3));
	}
	/**
	* 扫描知识盲区
	* @returns 盲区候选列表（按新颖度降序）
	*/
	scanKnowledgeGaps() {
		const exposure = this.provider.getExposure();
		const experience = this.provider.getExperienceCounts();
		const failureRates = this.provider.getFailureRates();
		const gaps = [];
		const maxExposure = Math.max(1, ...Object.values(exposure));
		for (const [taskType, exposureCount] of Object.entries(exposure)) {
			const experienceCount = experience[taskType] ?? 0;
			const failureRate = failureRates[taskType] ?? 0;
			const explorationCount = this.explorationCounts.get(taskType) ?? 0;
			let reason = null;
			if (experienceCount === 0) reason = "unexplored";
			else if (failureRate >= this.config.highFailureRateThreshold) reason = "high-failure";
			else if (experienceCount < this.config.lowExperienceThreshold) reason = "low-experience";
			if (!reason) continue;
			const unknownScore = reason === "unexplored" ? 1 : experienceCount < this.config.lowExperienceThreshold ? .6 : .4;
			const exposureScore = exposureCount / maxExposure;
			const scarcityScore = 1 / (1 + explorationCount);
			const noveltyScore = unknownScore * this.config.noveltyUnknownWeight + exposureScore * this.config.noveltyExposureWeight + scarcityScore * this.config.noveltyScarcityWeight;
			gaps.push({
				taskType,
				reason,
				exposureCount,
				experienceCount,
				explorationCount,
				noveltyScore: Number(noveltyScore.toFixed(3))
			});
		}
		return gaps.sort((a, b) => b.noveltyScore - a.noveltyScore);
	}
	/**
	* 生成探索建议（受预算约束）
	* @param dispatchSlots 本轮心跳的总派发槽位数
	* @param healthScore 系统健康度 0~1（健康时多探索）
	* @returns 探索任务建议列表
	*/
	proposeExplorations(dispatchSlots, healthScore = 1) {
		const healthFactor = Math.max(.2, Math.min(1, healthScore));
		const budget = Math.floor(dispatchSlots * this.config.explorationBudgetRatio * healthFactor);
		if (budget <= 0) return [];
		const gaps = this.scanKnowledgeGaps();
		const proposals = [];
		for (const gap of gaps) {
			if (proposals.length >= budget) break;
			proposals.push({
				taskType: gap.taskType,
				description: this.describeExploration(gap),
				noveltyScore: gap.noveltyScore,
				expectedGain: this.describeGain(gap)
			});
		}
		return proposals;
	}
	/**
	* 回写探索结果（探索完成后调用）
	* @param taskType 探索的任务类型
	* @param gainedKnowledge 是否填补了盲区
	* @param note 备注
	*/
	recordExploration(taskType, gainedKnowledge, note) {
		this.explorations.push({
			taskType,
			timestamp: Date.now(),
			gainedKnowledge,
			note
		});
		this.explorationCounts.set(taskType, (this.explorationCounts.get(taskType) ?? 0) + 1);
		if (this.explorations.length > 200) this.explorations.splice(0, this.explorations.length - 200);
	}
	/** 探索历史 */
	getExplorations() {
		return [...this.explorations];
	}
	/** 探索收获率（填补盲区的比例） */
	getExplorationYield() {
		if (this.explorations.length === 0) return 0;
		const gained = this.explorations.filter((e) => e.gainedKnowledge).length;
		return Number((gained / this.explorations.length).toFixed(3));
	}
	/** 好奇心摘要 */
	getSummary() {
		return {
			totalExplorations: this.explorations.length,
			explorationYield: this.getExplorationYield(),
			topGaps: this.scanKnowledgeGaps().slice(0, 5),
			explorationCounts: Object.fromEntries(this.explorationCounts),
			/** 5.0：假设驱动实验（因果好奇心） */
			causalExperiments: this.causalExplorations.length,
			causalYield: this.getCausalYield(),
			pendingHypotheses: this.proposeCausalExperiments("task.outcome", 3)
		};
	}
	/** 生成探索任务描述 */
	describeExploration(gap) {
		switch (gap.reason) {
			case "unexplored": return `探索未知任务类型「${gap.taskType}」：系统已接触 ${gap.exposureCount} 次但尚无成功经验，需建立首个成功范例`;
			case "high-failure": return `攻克高失败任务类型「${gap.taskType}」：失败率偏高，需探索更可靠的执行方案`;
			case "low-experience": return `深化低经验任务类型「${gap.taskType}」：成功经验不足，需积累更多成功范例`;
			default: return `探索任务类型「${gap.taskType}」`;
		}
	}
	/** 生成预期收益描述 */
	describeGain(gap) {
		switch (gap.reason) {
			case "unexplored": return `填补「${gap.taskType}」的经验空白，使系统具备处理该类任务的能力`;
			case "high-failure": return `降低「${gap.taskType}」的失败率，提升该类任务的可靠性`;
			case "low-experience": return `丰富「${gap.taskType}」的成功经验库，提升决策与模型分配的准确性`;
			default: return `增强「${gap.taskType}」的处理能力`;
		}
	}
};
//#endregion
//#region src/safety-governor.ts
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
*
* 4.0 升级（治理闭环）：
* - 半开探测互斥：冷却期结束后仅放行一个试探动作，其余继续拒绝——
*   升级前半开态放行全部流量，恢复瞬间的洪峰会直接打垮刚喘息的下游
* - 按动作限流：perActionRateLimits 为指定动作配置独立窗口
*   （如 exploration 5/min、autonomous-execute 60/min），
*   未配置的动作沿用共享全局窗口（与升级前行为一致）
* - 预算/审计持久化：persistPath 配置后，token/成本累计与审计尾部
*   落盘重启恢复——升级前纯内存，重启即预算清零、审计丢失
*/
/** 默认配置 */
const DEFAULT_SAFETY_GOVERNOR_CONFIG = {
	maxActionsPerMinute: 60,
	tokenBudget: 0,
	costBudget: 0,
	circuitFailureThreshold: 5,
	circuitCooldownMs: 6e4,
	confidenceThreshold: .3,
	auditLimit: 200
};
/**
* 安全治理器
*
* 被 index.ts 持有：所有自主动作执行前调用 govern() 获取裁决，
* 执行结果经 recordOutcome() 回写以驱动熔断器与预算统计。
* 4.0：主执行路径（executeSignal）执行前同样过 govern('autonomous-execute')。
*/
var SafetyGovernor = class {
	config;
	/** 限流：最近一分钟的动作时间戳（共享全局窗口） */
	recentActions = [];
	/** 限流：按动作独立窗口（perActionRateLimits 配置的动作） */
	perActionWindows = /* @__PURE__ */ new Map();
	/** 预算：累计消耗 */
	totalTokensUsed = 0;
	totalCost = 0;
	/** 熔断器状态 */
	circuitState = "closed";
	consecutiveFailures = 0;
	circuitOpenedAt = 0;
	/** 4.0：半开试探互斥（探测在途时其余动作继续拒绝） */
	halfOpenProbeInFlight = false;
	/** Kill Switch */
	killSwitchEngaged = false;
	/** 审计日志 */
	audit = [];
	/** 4.0：持久化防抖定时器 */
	persistTimer;
	constructor(config) {
		this.config = {
			...DEFAULT_SAFETY_GOVERNOR_CONFIG,
			...config
		};
		this.loadPersisted();
	}
	/**
	* 治理裁决：判定一个自主动作能否执行
	* @param action 动作类型
	* @param confidence 决策置信度（用于置信度门控）
	* @returns 裁决结果
	*/
	govern(action, confidence = 1) {
		let verdict;
		if (this.killSwitchEngaged) {
			verdict = {
				allowed: false,
				reason: "紧急停止开关已启用",
				blockedBy: "kill-switch"
			};
			this.logAudit(action, verdict);
			return verdict;
		}
		let probeCandidate = false;
		if (this.circuitState === "open") {
			const elapsed = Date.now() - this.circuitOpenedAt;
			if (elapsed < this.config.circuitCooldownMs) {
				verdict = {
					allowed: false,
					reason: `熔断器开启（冷却期剩余 ${Math.ceil((this.config.circuitCooldownMs - elapsed) / 1e3)}s）`,
					blockedBy: "circuit-breaker"
				};
				this.logAudit(action, verdict);
				return verdict;
			}
			probeCandidate = true;
		} else if (this.circuitState === "half-open") {
			if (this.halfOpenProbeInFlight) {
				verdict = {
					allowed: false,
					reason: "半开试探进行中，其余动作暂缓",
					blockedBy: "circuit-breaker"
				};
				this.logAudit(action, verdict);
				return verdict;
			}
			probeCandidate = true;
		}
		const now = Date.now();
		const perActionLimit = this.config.perActionRateLimits?.[action];
		if (perActionLimit !== void 0) {
			const window = (this.perActionWindows.get(action) ?? []).filter((t) => t > now - 6e4);
			if (window.length >= perActionLimit) {
				verdict = {
					allowed: false,
					reason: `限流：动作 ${action} 每分钟最多 ${perActionLimit} 次`,
					blockedBy: "rate-limit"
				};
				this.logAudit(action, verdict);
				return verdict;
			}
			window.push(now);
			this.perActionWindows.set(action, window);
		} else {
			this.recentActions = this.recentActions.filter((t) => t > now - 6e4);
			if (this.recentActions.length >= this.config.maxActionsPerMinute) {
				verdict = {
					allowed: false,
					reason: `限流：每分钟最多 ${this.config.maxActionsPerMinute} 个自主动作`,
					blockedBy: "rate-limit"
				};
				this.logAudit(action, verdict);
				return verdict;
			}
			this.recentActions.push(now);
		}
		if (this.config.tokenBudget > 0 && this.totalTokensUsed >= this.config.tokenBudget) {
			verdict = {
				allowed: false,
				reason: `预算耗尽：token 已达上限 ${this.config.tokenBudget}`,
				blockedBy: "budget"
			};
			this.logAudit(action, verdict);
			return verdict;
		}
		if (this.config.costBudget > 0 && this.totalCost >= this.config.costBudget) {
			verdict = {
				allowed: false,
				reason: `预算耗尽：成本已达上限 $${this.config.costBudget}`,
				blockedBy: "budget"
			};
			this.logAudit(action, verdict);
			return verdict;
		}
		if (action !== "exploration" && confidence < this.config.confidenceThreshold) {
			verdict = {
				allowed: false,
				reason: `置信度过低（${confidence.toFixed(2)} < ${this.config.confidenceThreshold}），需人工确认`,
				blockedBy: "confidence-gate"
			};
			this.logAudit(action, verdict);
			return verdict;
		}
		if (probeCandidate) {
			this.circuitState = "half-open";
			this.halfOpenProbeInFlight = true;
		}
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
	recordOutcome(success, tokensUsed = 0, cost = 0) {
		this.totalTokensUsed += tokensUsed;
		this.totalCost += cost;
		if (success) {
			this.consecutiveFailures = 0;
			if (this.circuitState === "half-open") {
				this.circuitState = "closed";
				this.halfOpenProbeInFlight = false;
			}
		} else {
			this.consecutiveFailures += 1;
			if (this.circuitState === "half-open") {
				this.halfOpenProbeInFlight = false;
				this.circuitState = "open";
				this.circuitOpenedAt = Date.now();
			} else if (this.consecutiveFailures >= this.config.circuitFailureThreshold && this.circuitState !== "open") {
				this.circuitState = "open";
				this.circuitOpenedAt = Date.now();
			}
		}
		this.schedulePersist();
	}
	/**
	* 只读门控检查：不消耗限流配额、不记审计、不改变任何状态。
	* 供宿主融合层等外部治理面使用（govern() 有副作用，会推进限流窗口）。
	* @returns 当前 kill switch / 熔断器是否放行
	*/
	checkGate() {
		if (this.killSwitchEngaged) return {
			allowed: false,
			reason: "紧急停止开关已启用",
			blockedBy: "kill-switch"
		};
		if (this.circuitState === "open") {
			const elapsed = Date.now() - this.circuitOpenedAt;
			if (elapsed < this.config.circuitCooldownMs) return {
				allowed: false,
				reason: `熔断器开启（冷却期剩余 ${Math.ceil((this.config.circuitCooldownMs - elapsed) / 1e3)}s）`,
				blockedBy: "circuit-breaker"
			};
		}
		if (this.circuitState === "half-open" && this.halfOpenProbeInFlight) return {
			allowed: false,
			reason: "半开试探进行中，其余动作暂缓",
			blockedBy: "circuit-breaker"
		};
		return { allowed: true };
	}
	/** 启用 Kill Switch */
	engageKillSwitch() {
		this.killSwitchEngaged = true;
		this.schedulePersist();
	}
	/** 解除 Kill Switch */
	disengageKillSwitch() {
		this.killSwitchEngaged = false;
		this.schedulePersist();
	}
	/** Kill Switch 状态 */
	isKillSwitchEngaged() {
		return this.killSwitchEngaged;
	}
	/** 手动重置熔断器 */
	resetCircuit() {
		this.circuitState = "closed";
		this.consecutiveFailures = 0;
		this.halfOpenProbeInFlight = false;
		this.schedulePersist();
	}
	/** 熔断器状态 */
	getCircuitState() {
		return this.circuitState;
	}
	/** 治理状态摘要 */
	getStatus() {
		return {
			killSwitch: this.killSwitchEngaged,
			circuitState: this.circuitState,
			consecutiveFailures: this.consecutiveFailures,
			recentActionsPerMinute: this.recentActions.filter((t) => t > Date.now() - 6e4).length,
			budget: {
				tokensUsed: this.totalTokensUsed,
				tokenBudget: this.config.tokenBudget,
				costUsed: Number(this.totalCost.toFixed(4)),
				costBudget: this.config.costBudget
			},
			recentAudit: this.audit.slice(-10)
		};
	}
	/** 审计日志 */
	getAudit(limit = 50) {
		return this.audit.slice(-limit);
	}
	/** 导出可持久化状态（4.0：测试与外部备份通道） */
	exportState() {
		return {
			version: 1,
			totalTokensUsed: this.totalTokensUsed,
			totalCost: this.totalCost,
			circuitState: this.circuitState,
			consecutiveFailures: this.consecutiveFailures,
			circuitOpenedAt: this.circuitOpenedAt,
			killSwitchEngaged: this.killSwitchEngaged,
			auditTail: this.audit.slice(-this.config.auditLimit)
		};
	}
	/** 导入状态（4.0：重启恢复；忽略非法字段） */
	importState(state) {
		if (typeof state.totalTokensUsed === "number") this.totalTokensUsed = state.totalTokensUsed;
		if (typeof state.totalCost === "number") this.totalCost = state.totalCost;
		if (state.circuitState === "closed" || state.circuitState === "open" || state.circuitState === "half-open") this.circuitState = state.circuitState;
		if (typeof state.consecutiveFailures === "number") this.consecutiveFailures = state.consecutiveFailures;
		if (typeof state.circuitOpenedAt === "number") this.circuitOpenedAt = state.circuitOpenedAt;
		if (typeof state.killSwitchEngaged === "boolean") this.killSwitchEngaged = state.killSwitchEngaged;
		if (Array.isArray(state.auditTail)) this.audit = state.auditTail.filter((e) => e && typeof e.timestamp === "number" && typeof e.action === "string").slice(-this.config.auditLimit);
	}
	/** 立即落盘（dispose 时调用） */
	flushPersist() {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = void 0;
		}
		this.writePersist();
	}
	/** 记录审计日志 */
	logAudit(action, verdict) {
		this.audit.push({
			timestamp: Date.now(),
			action,
			verdict
		});
		if (this.audit.length > this.config.auditLimit) this.audit.splice(0, this.audit.length - this.config.auditLimit);
	}
	/** 防抖持久化（高频 recordOutcome 不逐次落盘） */
	schedulePersist() {
		if (!this.config.persistPath) return;
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = void 0;
			this.writePersist();
		}, 1e3);
		this.persistTimer.unref?.();
	}
	/** 原子写持久化状态（失败静默——治理不能因落盘故障停摆） */
	writePersist() {
		const persistPath = this.config.persistPath;
		if (!persistPath) return;
		try {
			fs.mkdirSync(path.dirname(persistPath), { recursive: true });
			const tmp = `${persistPath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(this.exportState()), "utf-8");
			fs.renameSync(tmp, persistPath);
		} catch {}
	}
	/** 启动时恢复持久化状态 */
	loadPersisted() {
		const persistPath = this.config.persistPath;
		if (!persistPath) return;
		try {
			if (!fs.existsSync(persistPath)) return;
			const raw = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
			this.importState(raw);
		} catch {}
	}
};
//#endregion
//#region src/symbiosis/agent.ts
/**
* agent.ts — 智能体契约与信誉基座（共生进化架构第五阶段 2/4）
*
* 质变设计（相对草案 IAgent 的三处结构性修正）：
*
* 1. 无 energy 字段、无 receiveEnergy/spendEnergy：
*    能量只存在于 EnergyLedger，智能体无法伪造或绕过市场转账；
*    智能体对能量的唯一影响路径 = 提案出价（bid）与成交收入。
*
* 2. perceive / propose / execute 三段分离（而非单一 act()）：
*    智能体只「感知 → 提案」，由运行时+市场+监管撮合批准后授予
*    ExecutionGrant 才能执行——立法与执法分离，kill-switch/熔断在
*    批准层自然生效（提案-批准分离是能量预算与安全治理的统一）。
*
* 3. goal 是结构化契约（关联指标 + 生存线），且信誉（Reputation）
*    不是自述而是证据：直接复用 core/evidence 统计内核——
*    贡献成功率的 Wilson 置信下界决定分红权重与定价可信度，
*    小样本保守、时间衰减、表现差自然饿死休眠。
*    「把项目的统计内核升级为经济内核」是本阶段的核心突破。
*
* 生命周期：active（参与感知/提案/执行）⇄ dormant（饥饿休眠，
* 不被调度不消耗心跳；可被央行救济或分红唤醒复活）。
*/
/** 结构化能力检测（IAgent 可选能力，非破坏性扩展） */
function isTradeListener(agent) {
	return typeof agent.notePurchase === "function";
}
/** 信誉晋级门槛 */
const TIER_SEED_MAX_SAMPLES = 5;
const TIER_ELITE_MIN_SAMPLES = 20;
const TIER_ELITE_MIN_WILSON = .6;
/**
* 智能体基座：证据化信誉 + 收支记账 + 模式切换的共享实现。
* 子类只需实现 goal/propose/execute（perceive 默认存快照）。
*/
var AgentBase = class {
	id;
	lastPerception;
	modeFlag = "active";
	evidence;
	earningsTotal = 0;
	spendTotal = 0;
	proposalCounter = 0;
	constructor(id, createdAt = Date.now()) {
		this.id = id;
		this.evidence = initEvidence(0, 0, createdAt);
	}
	perceive(p) {
		this.lastPerception = p;
	}
	/** 默认空转提案（子类按角色覆写） */
	propose() {
		return [this.proposal("idle", "空转观测", 0)];
	}
	/** 默认 no-op 执行（市场类提案无需 execute，由运行时直接撮合） */
	async execute(grant) {
		return {
			success: true,
			valueEstimate: 0,
			summary: `no-op:${grant.proposal.kind}`
		};
	}
	mode() {
		return this.modeFlag;
	}
	/** 模式切换由运行时驱动（休眠/复活），智能体自身只读 */
	setMode(mode) {
		this.modeFlag = mode;
	}
	/** 贡献观测（由运行时在任务结算时回调）——信誉的唯一来源 */
	recordContribution(success, now = Date.now()) {
		observeEvidence(this.evidence, success, now);
	}
	reputation(now = Date.now()) {
		const view = readEvidence(this.evidence, now);
		return {
			tier: tierOf(view),
			effectiveSamples: view.effectiveSamples,
			posteriorMean: view.posteriorMean,
			wilsonLower: view.wilsonLower,
			earnings: this.earningsTotal,
			spend: this.spendTotal,
			netFlow: this.earningsTotal - this.spendTotal
		};
	}
	/** 收入记账（由运行时经账本/市场回调，智能体不可自增） */
	noteEarnings(amount) {
		if (amount > 0) this.earningsTotal += amount;
	}
	/** 支出记账 */
	noteSpend(amount) {
		if (amount > 0) this.spendTotal += amount;
	}
	/** 提案 id 生成（id 稳定可追溯） */
	proposal(kind, description, bid, extra = {}) {
		this.proposalCounter += 1;
		return {
			id: `${this.id}#${this.proposalCounter}`,
			kind,
			description,
			bid,
			ttlTicks: 1,
			...extra
		};
	}
};
function tierOf(view) {
	if (view.effectiveSamples < TIER_SEED_MAX_SAMPLES) return "seed";
	if (view.effectiveSamples >= TIER_ELITE_MIN_SAMPLES && view.wilsonLower >= TIER_ELITE_MIN_WILSON) return "elite";
	return "established";
}
//#endregion
//#region src/symbiosis/ledger.ts
/**
* ledger.ts — 认知能量账本（共生进化架构第五阶段 1/4）
*
* 质变设计（相对"agent.energy 公开字段"草案的三重升级）：
*
* 1. 能量不可伪造：智能体没有 energy 字段，能量只存在于账本账户中，
*    只能经 transfer/mint/burn 流转；每笔流转双方平衡（复式记账），
*    全局守恒律恒成立：Σ(所有账户余额) === initialSupply + minted。
*
* 2. 链式哈希审计：每笔转账携带 sha256 链哈希（前序哈希 + 本笔内容），
*    任何对历史凭证的篡改都会导致 verifyChain() 失败——能量流向可审计、
*    可回放、不可抵赖。这是"玩具模拟"与"经济系统"的分水岭。
*
* 3. 生态健康可观测：giniCoefficient() 度量能量分布集中度——
*    能量过度集中 = 垄断 = 认知生态死亡信号（单一智能体买断全部资源，
*    多样性消失，进化停滞）。监管层可据此调节铸币与救济策略。
*
* 账户语义：
* - treasury：央行国库（初始供给 + 任务成功铸币收入池），仅 runtime 持有账本引用
* - burn（INCINERATOR）：燃烧池，burn 的能量退出流通但保留审计痕迹
* - escrow：行动预扣托管（提案批准 → 预扣；执行完毕 → 燃烧/退还）
*
* 权限模型（Phase 1）：EnergyLedger 实例仅由 SymbiosisRuntime / CognitiveMarket
* 持有；智能体只拿到只读快照（Perception.ownBalance），无法绕过市场直接转账。
*/
/** 央行国库：初始供给与铸币收入池 */
const TREASURY = "treasury";
/** 燃烧池：burn 的能量退出流通（余额保留供审计） */
const INCINERATOR = "burn";
/** 行动预扣托管账户 */
const ESCROW = "escrow";
const GENESIS_HASH = "0".repeat(64);
var EnergyLedger = class {
	balances = /* @__PURE__ */ new Map();
	frozen = /* @__PURE__ */ new Set();
	journal = [];
	chainHead = GENESIS_HASH;
	/** 链锚点：被裁剪的最后一条凭证哈希（verifyChain 由此起验） */
	chainAnchor = GENESIS_HASH;
	seqCounter = 0;
	mintedTotal = 0;
	initialSupply;
	journalLimit;
	constructor(config = {}) {
		this.initialSupply = Math.max(0, config.initialSupply ?? 1e4);
		this.journalLimit = Math.max(10, config.journalLimit ?? 2e3);
		this.balances.set(TREASURY, this.initialSupply);
		this.balances.set(INCINERATOR, 0);
		this.balances.set(ESCROW, 0);
	}
	/** 开户（零余额；初始注资由调用方经 treasury transfer 完成） */
	openAccount(id) {
		if (this.balances.has(id)) return false;
		this.balances.set(id, 0);
		return true;
	}
	hasAccount(id) {
		return this.balances.has(id);
	}
	balance(id) {
		return this.balances.get(id) ?? 0;
	}
	isFrozen(id) {
		return this.frozen.has(id);
	}
	freeze(id) {
		if (this.balances.has(id)) this.frozen.add(id);
	}
	unfreeze(id) {
		this.frozen.delete(id);
	}
	/** 原子转账：余额不足/冻结/非法金额全部拒绝，拒绝时状态零变更 */
	transfer(from, to, amount, reason, refId) {
		if (!(amount > 0) || !Number.isFinite(amount)) return {
			ok: false,
			error: "non-positive-amount"
		};
		if (from === to) return {
			ok: false,
			error: "self-transfer"
		};
		if (!this.balances.has(from) || !this.balances.has(to)) return {
			ok: false,
			error: "unknown-account"
		};
		if (this.frozen.has(from)) return {
			ok: false,
			error: "frozen-account"
		};
		if ((this.balances.get(from) ?? 0) < amount) return {
			ok: false,
			error: "insufficient-funds"
		};
		this.balances.set(from, (this.balances.get(from) ?? 0) - amount);
		this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
		return {
			ok: true,
			transfer: this.appendEntry(from, to, amount, reason, refId)
		};
	}
	/** 央行铸币：向 to 增发能量（对应真实价值注入：任务成功/知识生效）。
	*  仅 runtime 持有账本引用时调用；破坏守恒律的唯一入口且被显式记账。 */
	mint(to, amount, reason, refId) {
		if (!(amount > 0) || !Number.isFinite(amount)) return {
			ok: false,
			error: "non-positive-amount"
		};
		if (!this.balances.has(to)) return {
			ok: false,
			error: "unknown-account"
		};
		this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
		this.mintedTotal += amount;
		return {
			ok: true,
			transfer: this.appendEntry("(mint)", to, amount, reason, refId)
		};
	}
	/** 燃烧：能量转入燃烧池退出流通（余额保留供审计与守恒校验） */
	burn(from, amount, reason, refId) {
		return this.transfer(from, INCINERATOR, amount, reason, refId);
	}
	/** 已燃烧总量 */
	burned() {
		return this.balance(INCINERATOR);
	}
	/** 央行铸币总量 */
	minted() {
		return this.mintedTotal;
	}
	/** 守恒总供给 = initialSupply + minted */
	totalSupply() {
		return this.initialSupply + this.mintedTotal;
	}
	/** 流通供给 = 总供给 - 燃烧池余额 - 托管余额 */
	circulatingSupply() {
		return this.totalSupply() - this.balance(INCINERATOR) - this.balance(ESCROW);
	}
	/**
	* 基尼系数（0 完全平等 → 1 完全垄断）。
	* 默认只统计智能体账户（排除 treasury/burn/escrow 内部账户）——
	* 内部账户是基础设施而非生态成员，计入会稀释真实集中度信号。
	* 零余额账户**保留**在统计内：这是基尼系数的标准口径（零收入人口
	* 计入分母）——饿死归零 / 尚未入场的智能体都是生态成员，「很多
	* 零余额者」本身就是分布的事实而非统计噪声，剔除会系统性低估
	* 集中度（[100,0] 标准值 0.5，剔除后虚降为 0）
	*/
	giniCoefficient(includeInternal = false) {
		const INTERNAL = /* @__PURE__ */ new Set([
			TREASURY,
			INCINERATOR,
			ESCROW
		]);
		const values = [];
		for (const [id, bal] of this.balances) {
			if (!includeInternal && INTERNAL.has(id)) continue;
			values.push(bal);
		}
		const n = values.length;
		if (n === 0) return 0;
		const total = values.reduce((a, b) => a + b, 0);
		if (total <= 0) return 0;
		const sorted = [...values].sort((a, b) => a - b);
		let weightedSum = 0;
		for (let i = 0; i < n; i++) weightedSum += (i + 1) * sorted[i];
		return Math.max(0, 2 * weightedSum / (n * total) - (n + 1) / n);
	}
	/** 最近 limit 条凭证（拷贝，外部修改不影响账本） */
	audit(limit = 50) {
		return this.journal.slice(-limit).map((t) => ({ ...t }));
	}
	/** 守恒律校验：Σ(所有账户余额) === initialSupply + minted */
	verifyConservation() {
		let sum = 0;
		for (const bal of this.balances.values()) sum += bal;
		return Math.abs(sum - this.totalSupply()) < 1e-9;
	}
	/** 链完整性校验：重算全链哈希，任何历史篡改即刻暴露 */
	verifyChain() {
		let prev = this.chainAnchor;
		for (const entry of this.journal) {
			if (hashEntry(prev, entry) !== entry.hash) return false;
			prev = entry.hash;
		}
		return true;
	}
	stats() {
		return {
			totalSupply: this.totalSupply(),
			circulatingSupply: this.circulatingSupply(),
			minted: this.mintedTotal,
			burned: this.balance(INCINERATOR),
			transfers: this.journal.length,
			accounts: this.balances.size,
			frozenAccounts: this.frozen.size,
			gini: this.giniCoefficient(),
			chainHead: this.chainHead,
			chainIntact: this.verifyChain()
		};
	}
	/** 导出快照（持久化 / 测试篡改注入用） */
	snapshotState() {
		return {
			balances: [...this.balances.entries()],
			frozen: [...this.frozen],
			journal: this.journal.map((t) => ({ ...t })),
			seqCounter: this.seqCounter,
			minted: this.mintedTotal,
			initialSupply: this.initialSupply,
			chainAnchor: this.chainAnchor
		};
	}
	/** 导入快照（原子整体替换） */
	restoreState(snap) {
		this.balances = new Map(snap.balances);
		this.frozen = new Set(snap.frozen);
		this.journal = snap.journal.map((t) => ({ ...t }));
		this.seqCounter = snap.seqCounter;
		this.mintedTotal = snap.minted;
		this.chainAnchor = snap.chainAnchor ?? GENESIS_HASH;
		this.chainHead = this.journal.length > 0 ? this.journal[this.journal.length - 1].hash : GENESIS_HASH;
	}
	appendEntry(from, to, amount, reason, refId) {
		const entry = {
			seq: ++this.seqCounter,
			from,
			to,
			amount,
			reason,
			refId,
			timestamp: Date.now(),
			hash: ""
		};
		entry.hash = hashEntry(this.chainHead, entry);
		this.chainHead = entry.hash;
		this.journal.push(entry);
		if (this.journal.length > this.journalLimit) {
			const overflow = this.journal.length - this.journalLimit;
			this.chainAnchor = this.journal[overflow - 1].hash;
			this.journal.splice(0, overflow);
		}
		return entry;
	}
};
function hashEntry(prevHash, entry) {
	return createHash("sha256").update(`${prevHash}|${entry.seq}|${entry.from}|${entry.to}|${entry.amount}|${entry.reason}|${entry.refId ?? ""}|${entry.timestamp}`).digest("hex");
}
//#endregion
//#region src/symbiosis/belief.ts
/**
* belief.ts — 信念市场（共生进化架构 Phase 2：市场即心智）
*
* 质变定位：Phase 1 让知识有了价格；本层让**信念**有了价格。
*
* 系统里所有"对未来的判断"（模型成功率、策略增益、知识有效性）原本是
* 被动统计量——不可问责、不可聚合、不可对赌。本层把它们变成可交易的
* 二元信念资产：
*
* - **LMSR 做市商**（对数市场评分规则，Hanson 2003）：
*   成本函数 C(q) = b·ln(e^{q1/b} + e^{q2/b})，价格 = sigmoid((q1−q2)/b)。
*   无需对手方即可成交；国库提供有界流动性补贴（最坏损失 b·ln2）；
*   成本函数路径无关 → 买卖往返净成本恒为 0（无摩擦）。
*
* - **信息聚合**：持有私有信息的智能体（记忆层知道历史、进化器知道沙盒
*   LCB）下注 → 价格移动到其估计 → 信息劣势者被套利。错的信念自动
*   亏钱给对的信念——信念进化有了牙齿。
*
* - **结算即审计**：到期按实现结果结算（realized > threshold = YES），
*   每份 YES/NO 份额支付 1 能量；赢家从流动性池领取，亏家血本无归。
*
* - **激励相容**：LMSR 本质是 proper scoring rule 的市场化——
*   把价格推到自己真实估计是最优策略（谎报即送钱给套利者）。
*
* 能量流：买单成本 → belief-pool（流动性池）→ 结算赔付；
* 池 shortfall 由国库有界补贴，盈余扫回国库。全程复式记账、守恒可审计。
* 信念市场允许分数能量（连续价格机制的数学需要；账本不限制粒度）。
*/
/** 信念流动性池账户（收集买单成本、支付结算赔付） */
const BELIEF_POOL = "belief-pool";
function logSumExp(a, b) {
	const m = Math.max(a, b);
	return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}
/** 做市商成本函数 C(q1,q2) = b·ln(e^{q1/b} + e^{q2/b}) */
function cost(q1, q2, b) {
	return b * logSumExp(q1 / b, q2 / b);
}
function sigmoid(x) {
	return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}
/** 隐含 YES 概率 = sigmoid((q1−q2)/b) */
function impliedProbYes(q1, q2, b) {
	return sigmoid((q1 - q2) / b);
}
let beliefCounter = 0;
/**
* 信念市场：LMSR 做市的二元断言交易场所。
*
* 权限模型：仅 SymbiosisRuntime 持有实例；智能体经感知视图（BeliefView）
* 只读价格，经 bet-belief 提案由运行时代为成交。
*/
var BeliefMarket = class {
	ledger;
	assets = /* @__PURE__ */ new Map();
	positions = /* @__PURE__ */ new Map();
	defaultB;
	constructor(ledger, config = {}) {
		this.ledger = ledger;
		this.defaultB = Math.max(.5, config.defaultB ?? 10);
		if (!ledger.hasAccount("belief-pool")) ledger.openAccount(BELIEF_POOL);
	}
	/** 上市新信念（创建即开放交易；国库隐性承担做市补贴义务） */
	create(input) {
		if (!input.subject) return {
			ok: false,
			error: "missing-subject"
		};
		if (!Number.isFinite(input.threshold)) return {
			ok: false,
			error: "invalid-threshold"
		};
		if (!(input.settleAtTick > 0)) return {
			ok: false,
			error: "invalid-settle-tick"
		};
		beliefCounter += 1;
		const asset = {
			id: `belief-${beliefCounter}`,
			claim: input.claim,
			subject: input.subject,
			threshold: input.threshold,
			settleAtTick: input.settleAtTick,
			creator: input.creator,
			liquidityB: Math.max(.5, input.liquidityB ?? this.defaultB),
			yesShares: 0,
			noShares: 0,
			status: "open",
			volume: 0,
			createdAt: Date.now()
		};
		this.assets.set(asset.id, asset);
		return {
			ok: true,
			assetId: asset.id
		};
	}
	/** 隐含 YES 概率（当前价格） */
	price(assetId) {
		const a = this.assets.get(assetId);
		return a && a.status === "open" ? impliedProbYes(a.yesShares, a.noShares, a.liquidityB) : void 0;
	}
	view(assetId) {
		const a = this.assets.get(assetId);
		return a ? this.toView(a) : void 0;
	}
	views() {
		return [...this.assets.values()].map((a) => this.toView(a));
	}
	/** 持仓查询（审计/测试用，拷贝） */
	positionOf(agentId, assetId) {
		const p = this.positions.get(`${assetId}|${agentId}`);
		return p ? { ...p } : void 0;
	}
	/**
	* 精确份额买入：成本 = C(q+Δ) − C(q)（LMSR 定价）。
	* 能量 agent → belief-pool。
	*/
	buyShares(agentId, assetId, outcome, shares) {
		const asset = this.assets.get(assetId);
		if (!asset) return {
			ok: false,
			error: "unknown-asset"
		};
		if (asset.status !== "open") return {
			ok: false,
			error: "not-open"
		};
		if (!(shares > 0) || !Number.isFinite(shares)) return {
			ok: false,
			error: "non-positive-shares"
		};
		const b = asset.liquidityB;
		const newYes = asset.yesShares + (outcome === "YES" ? shares : 0);
		const newNo = asset.noShares + (outcome === "NO" ? shares : 0);
		const price = cost(newYes, newNo, b) - cost(asset.yesShares, asset.noShares, b);
		if (!(price > 0)) return {
			ok: false,
			error: "non-positive-cost"
		};
		if (this.ledger.balance(agentId) < price) return {
			ok: false,
			error: "insufficient-funds"
		};
		const receipt = this.ledger.transfer(agentId, BELIEF_POOL, price, "belief-buy", assetId);
		if (!receipt.ok) return {
			ok: false,
			error: receipt.error
		};
		asset.yesShares = newYes;
		asset.noShares = newNo;
		asset.volume += price;
		this.updatePosition(agentId, assetId, outcome, shares, price);
		return {
			ok: true,
			cost: price,
			shares,
			priceAfter: impliedProbYes(newYes, newNo, b)
		};
	}
	/**
	* 卖回做市商（结算前平仓）：退款 = C(q) − C(q−Δ)。
	* LMSR 成本函数路径无关 → 买卖往返净成本恒为 0（零摩擦）。
	*/
	sellShares(agentId, assetId, outcome, shares) {
		const asset = this.assets.get(assetId);
		if (!asset) return {
			ok: false,
			error: "unknown-asset"
		};
		if (asset.status !== "open") return {
			ok: false,
			error: "not-open"
		};
		const pos = this.positions.get(`${assetId}|${agentId}`);
		const held = outcome === "YES" ? pos?.yesShares ?? 0 : pos?.noShares ?? 0;
		if (!(shares > 0) || shares > held + 1e-9) return {
			ok: false,
			error: "insufficient-shares"
		};
		const b = asset.liquidityB;
		const newYes = asset.yesShares - (outcome === "YES" ? shares : 0);
		const newNo = asset.noShares - (outcome === "NO" ? shares : 0);
		const refund = cost(asset.yesShares, asset.noShares, b) - cost(newYes, newNo, b);
		if (!(refund > 0)) return {
			ok: false,
			error: "non-positive-refund"
		};
		const receipt = this.ledger.transfer(BELIEF_POOL, agentId, refund, "belief-sell", assetId);
		if (!receipt.ok) return {
			ok: false,
			error: receipt.error
		};
		asset.yesShares = newYes;
		asset.noShares = newNo;
		asset.volume = Math.max(0, asset.volume - refund);
		this.updatePosition(agentId, assetId, outcome, -shares, -refund);
		return {
			ok: true,
			cost: -refund,
			shares,
			priceAfter: impliedProbYes(newYes, newNo, b)
		};
	}
	/**
	* 目标价格买入：把市场价格推到自己的真实估计（激励相容动作）。
	* 份额 = 使 implied = target 所需；预算封顶（不足时二分收缩）。
	* @param targetProb 该结果方向的估计概率 ∈ (0.01, 0.99)
	*/
	buyToPrice(agentId, assetId, outcome, targetProb, budget) {
		const asset = this.assets.get(assetId);
		if (!asset) return {
			ok: false,
			error: "unknown-asset"
		};
		if (asset.status !== "open") return {
			ok: false,
			error: "not-open"
		};
		if (!(targetProb > .01 && targetProb < .99)) return {
			ok: false,
			error: "invalid-target"
		};
		if (!(budget > 0)) return {
			ok: false,
			error: "non-positive-budget"
		};
		const b = asset.liquidityB;
		const targetYes = outcome === "YES" ? targetProb : 1 - targetProb;
		const logit = Math.log(targetYes / (1 - targetYes));
		let shares;
		if (outcome === "YES") shares = asset.noShares + b * logit - asset.yesShares;
		else shares = asset.yesShares + b * Math.log((1 - targetYes) / targetYes) - asset.noShares;
		if (shares <= 1e-9) return {
			ok: false,
			error: "no-impact-needed"
		};
		const costOf = (s) => {
			return cost(asset.yesShares + (outcome === "YES" ? s : 0), asset.noShares + (outcome === "NO" ? s : 0), b) - cost(asset.yesShares, asset.noShares, b);
		};
		let actual = shares;
		if (costOf(shares) > budget) {
			let lo = 0;
			let hi = shares;
			for (let i = 0; i < 40; i += 1) {
				const mid = (lo + hi) / 2;
				if (costOf(mid) <= budget) lo = mid;
				else hi = mid;
			}
			actual = lo;
			if (actual < 1e-6) return {
				ok: false,
				error: "budget-too-small"
			};
		}
		return this.buyShares(agentId, assetId, outcome, actual);
	}
	/**
	* 结算：realized > threshold → YES 兑付。
	* 每份命中份额支付 1 能量（scoring 结算）；池缺口国库有界补贴，盈余扫回。
	*
	* 浮点鲁棒性：补贴额加 1e-6 余量对冲 ulp 舍入差（「缺口恰好补齐」在
	* 浮点回加后仍可能差 1e-7，导致赔付/清扫转账静默失败、赢家拿不到钱）；
	* 赔付与清扫均钳制到池实际余额——共享池 + 舍入路径差异下永不透支。
	*/
	settle(assetId, realized) {
		const asset = this.assets.get(assetId);
		if (!asset || asset.status !== "open") return void 0;
		const outcome = realized > asset.threshold;
		const payouts = [];
		for (const pos of this.positions.values()) {
			if (pos.assetId !== assetId) continue;
			const amount = outcome ? pos.yesShares : pos.noShares;
			if (amount > 1e-9) payouts.push({
				agentId: pos.agentId,
				amount
			});
		}
		const totalPayout = payouts.reduce((a, p) => a + p.amount, 0);
		let subsidy = 0;
		if (totalPayout > asset.volume + 1e-9) {
			subsidy = totalPayout - asset.volume + 1e-6;
			if (!this.ledger.transfer("treasury", "belief-pool", subsidy, "belief-subsidy", assetId).ok) subsidy = 0;
		}
		const ownReserve = asset.volume + subsidy;
		const scale = totalPayout > ownReserve ? Math.max(0, ownReserve / totalPayout) : 1;
		for (const p of payouts) {
			p.amount = Math.min(p.amount * scale, this.ledger.balance(BELIEF_POOL));
			if (p.amount > 1e-9) this.ledger.transfer(BELIEF_POOL, p.agentId, p.amount, "belief-payout", assetId);
		}
		const paidNow = payouts.reduce((a, p) => a + p.amount, 0);
		const sweep = Math.max(0, Math.min(asset.volume + subsidy - paidNow, this.ledger.balance(BELIEF_POOL)));
		if (sweep > 1e-9) this.ledger.transfer(BELIEF_POOL, TREASURY, sweep, "belief-sweep", assetId);
		asset.status = "settled";
		asset.outcome = outcome;
		asset.realizedValue = realized;
		return {
			assetId,
			outcome,
			realized,
			payouts,
			subsidyFromTreasury: subsidy,
			sweptToTreasury: sweep
		};
	}
	/** 取消：全额退还净支出（不可结算的悬空信念，如信号永缺失） */
	cancel(assetId) {
		const asset = this.assets.get(assetId);
		if (!asset || asset.status !== "open") return void 0;
		const refunds = [];
		const failedRefunds = [];
		for (const pos of this.positions.values()) {
			if (pos.assetId !== assetId || pos.netPaid <= 1e-9) continue;
			if (this.ledger.transfer("belief-pool", pos.agentId, pos.netPaid, "belief-refund", assetId).ok) refunds.push({
				agentId: pos.agentId,
				amount: pos.netPaid
			});
			else failedRefunds.push({
				agentId: pos.agentId,
				requested: pos.netPaid
			});
		}
		asset.status = "cancelled";
		return failedRefunds.length > 0 ? {
			assetId,
			refunds,
			failedRefunds
		} : {
			assetId,
			refunds
		};
	}
	/** 池余额（审计用；全部结算/取消后应回到 0） */
	poolBalance() {
		return this.ledger.balance(BELIEF_POOL);
	}
	snapshot() {
		let settled = 0;
		let cancelled = 0;
		let volume = 0;
		for (const a of this.assets.values()) if (a.status === "settled") settled += 1;
		else if (a.status === "cancelled") cancelled += 1;
		else volume += a.volume;
		return {
			open: this.assets.size - settled - cancelled,
			settled,
			cancelled,
			volume,
			poolBalance: this.poolBalance()
		};
	}
	updatePosition(agentId, assetId, outcome, shares, paid) {
		const key = `${assetId}|${agentId}`;
		const pos = this.positions.get(key) ?? {
			agentId,
			assetId,
			yesShares: 0,
			noShares: 0,
			netPaid: 0
		};
		if (outcome === "YES") pos.yesShares = Math.max(0, pos.yesShares + shares);
		else pos.noShares = Math.max(0, pos.noShares + shares);
		pos.netPaid = Math.max(0, pos.netPaid + paid);
		this.positions.set(key, pos);
	}
	toView(a) {
		return {
			assetId: a.id,
			claim: a.claim,
			subject: a.subject,
			threshold: a.threshold,
			settleAtTick: a.settleAtTick,
			impliedProbYes: a.status === "open" ? impliedProbYes(a.yesShares, a.noShares, a.liquidityB) : a.outcome ? 1 : 0,
			yesShares: a.yesShares,
			noShares: a.noShares,
			volume: a.volume,
			status: a.status
		};
	}
};
//#endregion
//#region src/symbiosis/market.ts
/**
* market.ts — 认知市场（共生进化架构第五阶段 3/4）
*
* 知识（记忆模式 / 蒸馏策略 / 语义规律 / 程序规则 / 策略基因）作为
* 可交易资产：卖方挂 ask（付挂单费防垃圾信息），买方出 bid，
* 价格交叉即成交——连续双向拍卖机制（与股票市场同构）。
*
* 两个激励相容关键设计：
*
* 1. 挂单费 burn（燃烧而非给市场）：发挂单信息本身有成本，
*    无限免费挂单会淹没市场；费用随要价比例收取。
*
* 2. 售后分成（royalty）由央行国库支付，而非买方支付：
*    若从买方扣分成，买方有动机谎报「没用上/失败了」逃避抽成；
*    若由央行对「知识被验证有效」铸币奖励卖方，买方报告零成本，
*    且使用反馈由运行时在任务结算时自动回填（买卖双方均无法操纵）。
*    —— 这是解决知识定价「阿罗信息悖论」（买前不知值不值，知道后
*    不想付钱）的机制化答案：卖方收入 = 成交价 + 持续分成，
*    只有真正有效的知识才能持续产生分成，劣质知识自然被证据淘汰。
*
* 资产级证据：每笔资产携带 MemoryEvidence，使用反馈持续观测——
* 申报质量（claimedQuality）与实测证据的偏离构成「质量欺骗」信号，
* 供监管层下架/罚没（Phase 2 扩展点）。
*/
let assetCounter = 0;
let bidCounter = 0;
let tradeCounter = 0;
var CognitiveMarket = class {
	ledger;
	assets = /* @__PURE__ */ new Map();
	bidsByAsset = /* @__PURE__ */ new Map();
	trades = [];
	volumeTraded = 0;
	listingFeeRate;
	defaultRoyaltyRate;
	maxAssets;
	constructor(ledger, config = {}) {
		this.ledger = ledger;
		this.listingFeeRate = Math.max(0, config.listingFeeRate ?? .1);
		this.defaultRoyaltyRate = Math.min(1, Math.max(0, config.defaultRoyaltyRate ?? .2));
		this.maxAssets = Math.max(1, config.maxAssets ?? 64);
	}
	/** 挂单要价：立即燃烧挂单费（防垃圾信息），同 refId 去重 */
	list(input) {
		if (!(input.ask > 0)) return {
			ok: false,
			error: "non-positive-ask"
		};
		if (input.claimedQuality < 0 || input.claimedQuality > 1) return {
			ok: false,
			error: "insufficient-quality"
		};
		for (const asset of this.assets.values()) if (asset.refId === input.refId) return {
			ok: false,
			error: "duplicate-ref"
		};
		if (this.assets.size >= this.maxAssets) return {
			ok: false,
			error: "market-full"
		};
		const listingFee = Math.ceil(input.ask * this.listingFeeRate);
		if (listingFee > 0) {
			if (!this.ledger.transfer(input.seller, "burn", listingFee, "listing-fee", input.refId).ok) return {
				ok: false,
				error: "listing-fee-unaffordable"
			};
		}
		assetCounter += 1;
		const asset = {
			id: `asset-${assetCounter}`,
			kind: input.kind,
			seller: input.seller,
			refId: input.refId,
			description: input.description,
			ask: input.ask,
			claimedQuality: input.claimedQuality,
			royaltyRate: input.royaltyRate ?? this.defaultRoyaltyRate,
			listedAt: Date.now(),
			sales: 0,
			lastPrice: 0,
			evidence: initEvidence(0, 0, Date.now())
		};
		this.assets.set(asset.id, asset);
		return {
			ok: true,
			assetId: asset.id,
			listingFee
		};
	}
	/** 出价买单（竞价；撮合时取最高价） */
	placeBid(bidder, assetId, price) {
		if (!this.assets.get(assetId)) return {
			ok: false,
			error: "unknown-asset"
		};
		if (!(price > 0)) return {
			ok: false,
			error: "non-positive-price"
		};
		if (this.ledger.balance(bidder) < price) return {
			ok: false,
			error: "insufficient-funds"
		};
		bidCounter += 1;
		const bids = this.bidsByAsset.get(assetId) ?? [];
		bids.push({
			id: `bid-${bidCounter}`,
			bidder,
			assetId,
			price,
			placedAt: Date.now()
		});
		this.bidsByAsset.set(assetId, bids);
		return { ok: true };
	}
	/** 卖家下架（无费用；已付挂单费不退——信息发布成本已发生） */
	delist(seller, assetId) {
		const asset = this.assets.get(assetId);
		if (!asset || asset.seller !== seller) return false;
		this.assets.delete(assetId);
		this.bidsByAsset.delete(assetId);
		return true;
	}
	/**
	* 撮合：对每个资产取最高出价，price >= ask 则成交。
	* 能量 buyer → seller；成交后该资产买单清空。
	*/
	match() {
		const executed = [];
		for (const asset of this.assets.values()) {
			const bids = this.bidsByAsset.get(asset.id) ?? [];
			if (bids.length === 0) continue;
			const best = [...bids].sort((a, b) => b.price - a.price)[0];
			if (best.price < asset.ask) continue;
			if (!this.ledger.transfer(best.bidder, asset.seller, best.price, "market-trade", asset.id).ok) continue;
			tradeCounter += 1;
			const trade = {
				seq: tradeCounter,
				assetId: asset.id,
				assetKind: asset.kind,
				buyer: best.bidder,
				seller: asset.seller,
				price: best.price,
				timestamp: Date.now()
			};
			asset.sales += 1;
			asset.lastPrice = best.price;
			this.trades.push(trade);
			this.volumeTraded += best.price;
			this.bidsByAsset.set(asset.id, []);
			executed.push(trade);
		}
		return executed;
	}
	/**
	* 使用反馈（由运行时在任务结算自动回填，买卖双方无法操纵）：
	* - 观测资产级证据（申报质量的实测校准来源）；
	* - 有效使用 → 央行向卖方支付售后分成（激励相容：买方零成本报告）。
	*/
	reportUsage(assetId, success, now = Date.now()) {
		const asset = this.assets.get(assetId);
		if (!asset) return void 0;
		observeEvidence(asset.evidence, success, now);
		if (!success || asset.lastPrice <= 0) return void 0;
		const amount = Math.ceil(asset.lastPrice * asset.royaltyRate);
		if (amount <= 0) return void 0;
		if (!this.ledger.transfer("treasury", asset.seller, amount, "royalty", assetId).ok) return void 0;
		return {
			assetId,
			seller: asset.seller,
			amount,
			confirmedUses: asset.sales
		};
	}
	getAsset(assetId) {
		const asset = this.assets.get(assetId);
		return asset ? {
			...asset,
			evidence: { ...asset.evidence }
		} : void 0;
	}
	listAssets() {
		return [...this.assets.values()].map((a) => ({
			...a,
			evidence: { ...a.evidence }
		}));
	}
	openBidCount() {
		let total = 0;
		for (const bids of this.bidsByAsset.values()) total += bids.length;
		return total;
	}
	tradesLog(limit = 50) {
		return this.trades.slice(-limit).map((t) => ({ ...t }));
	}
	/** 智能体感知用的脱敏挂单视图 */
	listingViews() {
		return [...this.assets.values()].map((a) => ({
			assetId: a.id,
			kind: a.kind,
			seller: a.seller,
			ask: a.ask,
			claimedQuality: a.claimedQuality,
			sales: a.sales
		}));
	}
	snapshot() {
		const last = this.trades.length > 0 ? this.trades[this.trades.length - 1].price : 0;
		return {
			listed: this.assets.size,
			openBids: this.openBidCount(),
			trades: this.trades.length,
			volume: this.volumeTraded,
			lastPrice: last
		};
	}
	/** 资产证据视图（监管/审计用） */
	assetEvidence(assetId, now = Date.now()) {
		const asset = this.assets.get(assetId);
		if (!asset) return void 0;
		return {
			claimedQuality: asset.claimedQuality,
			...readEvidence(asset.evidence, now)
		};
	}
};
//#endregion
//#region src/symbiosis/runtime.ts
/**
* runtime.ts — 共生运行时（共生进化架构第五阶段 4/4）
*
* 认知生态的「市场监管者 + 央行 + 生存裁判」三合一运行时：
*
* 1. 心跳编排（tick）：生存检查 → 感知分发 → 收集提案 →
*    监管否决 → 市场撮合 → 行动授权执行 → 生态报告。
*
* 2. 价值注入（settleTaskOutcome）：任务成功 = 真实价值进入生态 →
*    央行铸币 incomePerSuccess，按贡献者 Wilson 下界加权分红——
*    「智能体通过提升任务表现赚钱」的直接机制；失败不铸币但记
*    负贡献，信誉下界的统计保守性自动压缩其未来分红。
*
* 3. 生存法则：余额低于生存线 → 休眠（不再被感知/调度）；
*    央行救济（有限配额，防僵尸智能体无限吸血）或后续分红 → 复活。
*
* 4. 行动经济学：行动类提案批准即预扣能量到 escrow——
*    成功全额燃烧（成本沉没）、失败退还一半（试验学费折扣，
*    鼓励尝试但不鼓励重复失败）；未批准提案零成本。
*
* 5. 监管桥接：宿主 SafetyGovernor.checkGate()（kill-switch/熔断）
*    对行动类提案有一票否决权——能量经济与安全治理在批准层统一。
*
* Phase 1 影子定位：本运行时独立心跳、不接管既有 autonomy-loop
* 主链路，可并行观察能量流向后再决定融合深度（不破坏现有功能）。
*/
var SymbiosisRuntime = class {
	ledger;
	market;
	beliefMarket;
	agents = [];
	agentIds = /* @__PURE__ */ new Set();
	reliefUsed = /* @__PURE__ */ new Map();
	tickCount = 0;
	/** futarchy 待决议行动（提案轮创建决策资产 → 下一轮市场表决 → 执行/否决） */
	pendingDecisions = [];
	config;
	tickSignals;
	governor;
	/** 5.0：因果内核（可选挂载；缺省保持既有线性分红，零行为漂移） */
	causalKernel;
	causalOutcomeNode;
	/** 6.0：自由能引擎（可选挂载；缺省心跳不产变分项，零漂移） */
	freeEnergy;
	/** 10.0：科学家内核（可选挂载；缺省结算不登记问题，零漂移） */
	scientist;
	/** 7.0：深思内核（可选挂载；缺省多步提案排序不可用，零漂移） */
	deliberation;
	constructor(config = {}, governor) {
		this.config = {
			initialSupply: config.initialSupply ?? 1e4,
			openingGrant: config.openingGrant ?? 100,
			reliefAmount: config.reliefAmount ?? 30,
			reliefQuota: config.reliefQuota ?? 3,
			incomePerSuccess: config.incomePerSuccess ?? 40,
			failureRefundRate: config.failureRefundRate ?? .5,
			beliefLiquidityB: config.beliefLiquidityB ?? 10,
			beliefGraceTicks: config.beliefGraceTicks ?? 2,
			divergenceMargin: config.divergenceMargin ?? .15,
			futarchyEnabled: config.futarchyEnabled ?? false,
			futarchyMinImpliedProb: config.futarchyMinImpliedProb ?? .55,
			futarchyDecisionB: config.futarchyDecisionB ?? 6
		};
		this.tickSignals = config.tickSignals;
		this.governor = governor;
		this.causalKernel = config.causalKernel;
		this.causalOutcomeNode = config.causalOutcomeNode ?? "task.outcome";
		this.freeEnergy = config.freeEnergy;
		this.scientist = config.scientist;
		this.deliberation = config.deliberation;
		this.ledger = new EnergyLedger({ initialSupply: this.config.initialSupply });
		this.market = new CognitiveMarket(this.ledger);
		this.beliefMarket = new BeliefMarket(this.ledger, { defaultB: this.config.beliefLiquidityB });
	}
	/** 注册智能体：开户 + 央行开业注资（继承 AgentBase 即满足托管契约） */
	register(agent) {
		if (this.agentIds.has(agent.id)) return false;
		this.agentIds.add(agent.id);
		this.agents.push(agent);
		this.ledger.openAccount(agent.id);
		if (this.config.openingGrant > 0) this.ledger.transfer(TREASURY, agent.id, this.config.openingGrant, "opening-grant", agent.id);
		return true;
	}
	/**
	* 单轮心跳：生态一轮完整的生存-感知-决策-交易-行动循环。
	* @param signals 心跳系统信号（同时是信念结算的 realized 值来源）
	* @param opts.externalEstimates 宿主被动统计估计（元认知对账用，键 = 信念 subject）
	*/
	async tick(signals, opts) {
		this.tickCount += 1;
		const now = Date.now();
		const supplyBefore = this.ledger.totalSupply();
		const burnBefore = this.ledger.burned();
		const relieves = [];
		const active = [];
		const dormant = [];
		for (const agent of this.agents) {
			const threshold = agent.goal().survivalThreshold;
			const balance = this.ledger.balance(agent.id);
			if (agent.mode() === "active" && balance < threshold) agent.setMode("dormant");
			if (agent.mode() === "dormant") {
				const used = this.reliefUsed.get(agent.id) ?? 0;
				if (used < this.config.reliefQuota && this.ledger.balance("treasury") >= this.config.reliefAmount) {
					if (this.ledger.transfer("treasury", agent.id, this.config.reliefAmount, "relief", agent.id).ok) {
						this.reliefUsed.set(agent.id, used + 1);
						agent.setMode("active");
						relieves.push({
							agentId: agent.id,
							amount: this.config.reliefAmount
						});
						active.push(agent);
						continue;
					}
				}
				dormant.push(agent.id);
				continue;
			}
			active.push(agent);
		}
		const marketSnapshot = this.market.snapshot();
		const listingViews = this.market.listingViews();
		const openBeliefs = this.beliefMarket.views().filter((bv) => bv.status === "open");
		const systemSignals = {
			...this.tickSignals?.() ?? {},
			...signals ?? {}
		};
		for (const agent of active) agent.perceive({
			tick: this.tickCount,
			timestamp: now,
			ownBalance: this.ledger.balance(agent.id),
			reputation: agent.reputation(),
			market: marketSnapshot,
			listings: listingViews,
			beliefs: openBeliefs,
			signals: systemSignals
		});
		const proposalsSeen = [];
		const vetoes = [];
		const grants = [];
		const pendingBids = [];
		const beliefBets = [];
		const gate = this.governor?.checkGate() ?? { allowed: true };
		for (const agent of active) {
			let proposals;
			try {
				proposals = agent.propose();
			} catch {
				continue;
			}
			for (const proposal of proposals) {
				if (proposal.kind === "idle") continue;
				proposalsSeen.push({
					agentId: agent.id,
					kind: proposal.kind,
					bid: proposal.bid
				});
				if (proposal.kind === "list-knowledge") {
					if (!gate.allowed) {
						vetoes.push({
							agentId: agent.id,
							kind: proposal.kind,
							reason: gate.reason ?? "governance"
						});
						continue;
					}
					const listed = this.market.list({
						seller: agent.id,
						kind: proposal.assetKind ?? "pattern",
						refId: proposal.assetRef ?? proposal.id,
						description: proposal.description,
						ask: proposal.bid,
						claimedQuality: proposal.claimedQuality ?? .5
					});
					if (listed.ok) agent.noteSpend(listed.listingFee ?? 0);
					continue;
				}
				if (proposal.kind === "buy-knowledge") {
					if (!proposal.assetRef) continue;
					pendingBids.push({
						bidder: agent.id,
						assetId: proposal.assetRef,
						price: proposal.bid
					});
					continue;
				}
				if (proposal.kind === "bet-belief") {
					if (!proposal.assetRef) {
						vetoes.push({
							agentId: agent.id,
							kind: proposal.kind,
							reason: "missing-asset-ref"
						});
						continue;
					}
					const bet = this.beliefMarket.buyToPrice(agent.id, proposal.assetRef, proposal.outcome ?? "YES", proposal.targetPrice ?? .75, proposal.bid);
					if (bet.ok) {
						agent.noteSpend(bet.cost ?? 0);
						beliefBets.push({
							agentId: agent.id,
							assetId: proposal.assetRef,
							outcome: proposal.outcome ?? "YES",
							cost: bet.cost ?? 0,
							priceAfter: bet.priceAfter ?? .5
						});
					} else vetoes.push({
						agentId: agent.id,
						kind: proposal.kind,
						reason: bet.error ?? "bet-rejected"
					});
					continue;
				}
				if (this.config.futarchyEnabled && proposal.kind === "evolution") {
					const asset = this.beliefMarket.create({
						claim: proposal.description,
						subject: `evolution:${agent.id}:${this.tickCount}`,
						threshold: .5,
						settleAtTick: this.tickCount + 1,
						creator: agent.id,
						liquidityB: this.config.futarchyDecisionB
					});
					if (asset.ok && asset.assetId) this.pendingDecisions.push({
						agentId: agent.id,
						proposal,
						assetId: asset.assetId
					});
					continue;
				}
				if (!gate.allowed) {
					vetoes.push({
						agentId: agent.id,
						kind: proposal.kind,
						reason: gate.reason ?? "governance"
					});
					continue;
				}
				const outcome = await this.executeAction(agent, proposal);
				if (outcome) grants.push(outcome);
			}
		}
		for (const bid of pendingBids) {
			const placed = this.market.placeBid(bid.bidder, bid.assetId, bid.price);
			if (!placed.ok) vetoes.push({
				agentId: bid.bidder,
				kind: "buy-knowledge",
				reason: placed.error ?? "bid-rejected"
			});
		}
		const trades = this.market.match();
		for (const trade of trades) {
			const buyer = this.agents.find((a) => a.id === trade.buyer);
			const seller = this.agents.find((a) => a.id === trade.seller);
			buyer?.noteSpend(trade.price);
			seller?.noteEarnings(trade.price);
			if (buyer && isTradeListener(buyer)) buyer.notePurchase(trade.assetId, this.market.getAsset(trade.assetId)?.refId ?? trade.assetId, trade.price);
		}
		const beliefSettlements = [];
		const futarchyDecisions = [];
		const stillPending = [];
		for (const decision of this.pendingDecisions) {
			const view = this.beliefMarket.view(decision.assetId);
			if (!view || view.status !== "open" || view.settleAtTick > this.tickCount) {
				stillPending.push(decision);
				continue;
			}
			const agent = this.agents.find((a) => a.id === decision.agentId);
			const implied = view.impliedProbYes;
			if (!gate.allowed) {
				futarchyDecisions.push({
					agentId: decision.agentId,
					proposalId: decision.proposal.id,
					impliedProb: implied,
					decision: "governor-vetoed"
				});
				this.cancelBelief(decision.assetId, beliefSettlements);
				continue;
			}
			if (implied >= this.config.futarchyMinImpliedProb && agent) {
				const grant = await this.executeAction(agent, decision.proposal);
				if (grant) grants.push(grant);
				futarchyDecisions.push({
					agentId: decision.agentId,
					proposalId: decision.proposal.id,
					impliedProb: implied,
					decision: "funded",
					actionSuccess: grant?.success ?? false
				});
				this.settleBelief(decision.assetId, grant?.success ? 1 : 0, beliefSettlements);
			} else {
				futarchyDecisions.push({
					agentId: decision.agentId,
					proposalId: decision.proposal.id,
					impliedProb: implied,
					decision: "market-rejected"
				});
				this.cancelBelief(decision.assetId, beliefSettlements);
			}
		}
		this.pendingDecisions = stillPending;
		for (const view of this.beliefMarket.views()) {
			if (view.status !== "open" || view.settleAtTick > this.tickCount) continue;
			if (view.subject.startsWith("evolution:")) continue;
			const realized = systemSignals[view.subject];
			if (Number.isFinite(realized)) this.settleBelief(view.assetId, realized, beliefSettlements);
			else if (this.tickCount - view.settleAtTick > this.config.beliefGraceTicks) this.cancelBelief(view.assetId, beliefSettlements);
		}
		const divergence = [];
		const external = opts?.externalEstimates ?? {};
		for (const view of this.beliefMarket.views()) {
			if (view.status !== "open") continue;
			const statEstimate = external[view.subject];
			if (!Number.isFinite(statEstimate)) continue;
			const gap = Math.abs(view.impliedProbYes - statEstimate);
			if (gap >= this.config.divergenceMargin) divergence.push({
				assetId: view.assetId,
				subject: view.subject,
				marketProb: view.impliedProbYes,
				statEstimate,
				gap
			});
		}
		let variational;
		if (this.freeEnergy && this.causalKernel) {
			const beliefs = [];
			const modelProbs = {};
			for (const view of this.beliefMarket.views()) {
				if (view.status !== "open") continue;
				const eff = this.causalKernel.effect(view.subject, this.causalOutcomeNode, now);
				if (eff.interventionalSamples + eff.observationalSamples < 3) continue;
				beliefs.push({
					id: view.subject,
					beliefProb: view.impliedProbYes
				});
				modelProbs[view.subject] = eff.pDo;
			}
			if (beliefs.length > 0) {
				const report = this.freeEnergy.variationalFreeEnergy(beliefs, modelProbs);
				variational = {
					total: report.totalFreeEnergy,
					driftDetected: report.driftDetected,
					worst: report.worst
				};
			}
		}
		return {
			tick: this.tickCount,
			timestamp: now,
			activeAgents: active.map((a) => a.id),
			dormantAgents: dormant,
			reliefs: relieves,
			proposals: proposalsSeen,
			vetoes,
			trades: trades.length,
			grants,
			mintedThisTick: this.ledger.totalSupply() - supplyBefore,
			burnedThisTick: this.ledger.burned() - burnBefore,
			gini: this.ledger.giniCoefficient(),
			conservationIntact: this.ledger.verifyConservation(),
			market: this.market.snapshot(),
			beliefBets,
			beliefSettlements,
			futarchyDecisions,
			divergence,
			variationalFreeEnergy: variational
		};
	}
	/**
	* 6.0：EFE 行动排序——把候选行动按期望自由能从低到高排序。
	*
	* 排序依据 G(a) = 务实价值 − 认知价值：
	* 既预测能达成目标的动作优先，同时高不确定性的动作获得认知价值
	* 折抵（探索不再是外挂加成，而是同一目标函数的另一半）。
	*
	* 消费方：宿主在多个行动提案间分配注意力/预算时调用；
	* 返回逐动作分解（多少因为有用 / 多少因为想弄清），可解释可审计。
	*/
	efeRankActions(actions, preference = .9) {
		if (!this.causalKernel || !this.freeEnergy) return [];
		const efeActions = actions.map((a) => {
			const eff = this.causalKernel.effect(a.id, a.outcomeNode ?? this.causalOutcomeNode);
			return {
				id: a.id,
				pSuccess: eff.pDo,
				lower: eff.lower,
				upper: eff.upper,
				interventionalSamples: eff.interventionalSamples,
				observationalSamples: eff.observationalSamples
			};
		});
		return this.freeEnergy.evaluateActions(efeActions, preference);
	}
	/**
	* 7.0：EFE 多步计划排序——把候选**行动序列**（计划）按想象推演的
	* 轨迹自由能从低到高排序。
	*
	* 与 efeRankActions 的本质区别：那是单步 bandit（每个行动独立评分），
	* 这是轨迹评估——第 1 步的代价可以被第 2 步的收获补偿（γ 折扣），
	* 序列中同一条边重访时认知价值坍缩（排练过的路不再有信息量）。
	* 智能体提出多步方案（如「先实验后上线」）时按全程 G 分配注意力。
	*/
	efeRankPlans(plans, preference = .9) {
		if (!this.deliberation) return [];
		return plans.map((plan) => {
			const report = this.deliberation.imagine(plan.startState, plan.actions, preference);
			const worstStep = report.steps.reduce((worst, s) => s.efe > worst.efe ? s : worst, report.steps[0] ?? {
				step: -1,
				efe: 0
			}).step;
			return {
				id: plan.id,
				totalEfe: report.totalEfe,
				pAllSuccess: report.pAllSuccess,
				undiscountedEfe: report.undiscountedEfe,
				epistemicMonotone: report.epistemicMonotone,
				worstStep
			};
		}).sort((a, b) => a.totalEfe - b.totalEfe);
	}
	/** 结算信念并把赔付记入智能体收入账（能量经账本，记账经宿主钩子） */
	settleBelief(assetId, realized, sink) {
		const report = this.beliefMarket.settle(assetId, realized);
		if (!report) return;
		let paidOut = 0;
		for (const payout of report.payouts) {
			paidOut += payout.amount;
			this.agents.find((a) => a.id === payout.agentId)?.noteEarnings(payout.amount);
		}
		sink.push({
			assetId,
			mode: "settled",
			outcome: report.outcome,
			realized: report.realized,
			paidOut,
			subsidy: report.subsidyFromTreasury,
			swept: report.sweptToTreasury,
			refunded: 0
		});
	}
	/** 取消信念退款（悬空断言的零损失退出） */
	cancelBelief(assetId, sink) {
		const report = this.beliefMarket.cancel(assetId);
		if (!report) return;
		const refunded = report.refunds.reduce((a, r) => a + r.amount, 0);
		sink.push({
			assetId,
			mode: "cancelled",
			paidOut: 0,
			subsidy: 0,
			swept: 0,
			refunded
		});
	}
	/**
	* 任务结算：成功 → 央行铸币分红。
	*
	* 5.0 质变（挂载因果内核后）：
	* 1. do-干预登记：调度器「刻意选用」某模型/策略 = 天然干预实验
	*    （非被动观测）——每个贡献者的成败都以 do(use:X) → task.outcome
	*    写入因果图，为后续反事实查询与旋钮排序积累黄金证据。
	* 2. Shapley 反事实分红：分红权重从「Wilson 下界的线性份额」升级为
	*    noisy-OR 联盟下的精确 Shapley 值——「拔掉你，任务成功率掉多少，
	*    你就分多少」。挂名不出力的边际贡献 ≈ 0，自然饿死；不可替代的
	*    关键贡献者获得超额回报（真公平的能量经济）。
	*
	* 未挂载内核时保持既有线性 Wilson 分红（零行为漂移）。
	*/
	settleTaskOutcome(success, contributors) {
		const valid = contributors.filter((c) => this.agentIds.has(c.agentId));
		const shares = [];
		if (valid.length === 0) return {
			totalDistributed: 0,
			shares,
			method: this.causalKernel ? "shapley-counterfactual" : "linear-wilson"
		};
		for (const c of valid) this.agents.find((a) => a.id === c.agentId)?.recordContribution(success);
		if (this.causalKernel) for (const c of valid) this.causalKernel.intervene(c.agentId, this.causalOutcomeNode, true, success, "scheduler", `任务结算：选用 ${c.agentId} → ${success ? "成功" : "失败"}`);
		if (this.scientist) for (const c of valid) this.scientist.registerQuestion(c.agentId, this.causalOutcomeNode, `调度器热点：选用 ${c.agentId} 对任务结局的因果效应`);
		if (!success) return {
			totalDistributed: 0,
			shares,
			method: this.causalKernel ? "shapley-counterfactual" : "linear-wilson"
		};
		let weights;
		let method = "linear-wilson";
		let shapleyDetail;
		if (this.causalKernel) {
			const probs = valid.map((c) => {
				const agent = this.agents.find((a) => a.id === c.agentId);
				const fallback = agent ? Math.max(agent.reputation().wilsonLower, .05) : .05;
				const eff = this.causalKernel.effect(c.agentId, this.causalOutcomeNode);
				return {
					agentId: c.agentId,
					prob: eff.interventionalSamples >= 3 ? Math.max(eff.pDo, .02) : fallback
				};
			});
			const shapleys = shapleyValues(probs);
			const sum = [...shapleys.values()].reduce((a, b) => a + Math.max(0, b), 0);
			weights = probs.map((p) => {
				const phi = Math.max(0, shapleys.get(p.agentId) ?? 0);
				return sum > 1e-4 ? phi : 1 / probs.length;
			});
			method = "shapley-counterfactual";
			shapleyDetail = probs.map((p) => ({
				agentId: p.agentId,
				shapleyValue: Number(Math.max(0, shapleys.get(p.agentId) ?? 0).toFixed(4)),
				counterfactualProb: Number(p.prob.toFixed(4))
			}));
		} else weights = valid.map((c) => {
			const agent = this.agents.find((a) => a.id === c.agentId);
			const fallback = agent ? Math.max(agent.reputation().wilsonLower, .05) : .05;
			return Math.max(1e-4, c.weight ?? fallback);
		});
		const weightSum = weights.reduce((a, b) => a + b, 0);
		let distributed = 0;
		weights.forEach((w, i) => {
			const amount = Math.floor(this.config.incomePerSuccess * w / weightSum);
			if (amount <= 0) return;
			if (!this.ledger.mint(valid[i].agentId, amount, "task-dividend").ok) return;
			this.agents.find((a) => a.id === valid[i].agentId)?.noteEarnings(amount);
			shares.push({
				agentId: valid[i].agentId,
				weight: Number(w.toFixed(4)),
				amount
			});
			distributed += amount;
		});
		return {
			totalDistributed: distributed,
			shares,
			method,
			shapley: shapleyDetail
		};
	}
	/** 知识使用回报（任务结算时由运行时自动回填，买卖双方不可操纵） */
	reportAssetUsage(assetId, success) {
		const payout = this.market.reportUsage(assetId, success);
		if (payout) this.agents.find((a) => a.id === payout.seller)?.noteEarnings(payout.amount);
	}
	/** 行动类提案执行：预扣 → 执行 → 成功燃烧 / 失败半退 */
	async executeAction(agent, proposal) {
		const budget = Math.ceil(proposal.bid);
		if (budget > 0) {
			if (!this.ledger.transfer(agent.id, "escrow", budget, "action-escrow", proposal.id).ok) return void 0;
			agent.noteSpend(budget);
		}
		const grant = {
			agentId: agent.id,
			proposal,
			budget,
			approvedAt: Date.now()
		};
		let success = false;
		let valueEstimate = 0;
		let summary = "";
		try {
			const result = await agent.execute(grant);
			success = result.success;
			valueEstimate = result.valueEstimate;
			summary = result.summary;
		} catch (err) {
			success = false;
			summary = err instanceof Error ? err.message : String(err);
		}
		let burned = 0;
		let refunded = 0;
		if (budget > 0) {
			if (success) {
				this.ledger.burn(ESCROW, budget, "action-cost", proposal.id);
				burned = budget;
			} else {
				refunded = Math.floor(budget * this.config.failureRefundRate);
				if (refunded > 0) this.ledger.transfer(ESCROW, agent.id, refunded, "action-refund", proposal.id);
				const rest = budget - refunded;
				if (rest > 0) this.ledger.burn(ESCROW, rest, "action-cost", proposal.id);
				burned = rest;
			}
		}
		return {
			agentId: agent.id,
			proposalId: proposal.id,
			kind: proposal.kind,
			success,
			burned,
			refunded,
			valueEstimate,
			summary
		};
	}
	/** 生态全景（心智报告/审计用） */
	stats() {
		return {
			tick: this.tickCount,
			agents: this.agents.map((a) => ({
				id: a.id,
				kind: a.kind,
				mode: a.mode(),
				balance: this.ledger.balance(a.id),
				reputation: a.reputation()
			})),
			ledger: this.ledger.stats(),
			market: this.market.snapshot(),
			belief: this.beliefMarket.snapshot()
		};
	}
};
//#endregion
//#region src/symbiosis/wrappers.ts
/**
* 记忆智能体：最大化记忆资产价值。
* 主动行为：挂卖高置信模式（赚取能量 + 售后分成）、周期维护（遗忘曲线）。
*/
var MemoryAgent = class extends AgentBase {
	memory;
	kind = "memory";
	cfg;
	listedRefs = /* @__PURE__ */ new Set();
	lastMaintenanceTick = 0;
	constructor(id, memory, config = {}) {
		super(id);
		this.memory = memory;
		this.cfg = {
			listingBasePrice: config.listingBasePrice ?? 10,
			listingConfidenceThreshold: config.listingConfidenceThreshold ?? .5,
			listingFrequencyThreshold: config.listingFrequencyThreshold ?? 2,
			maxListedPerTick: config.maxListedPerTick ?? 2,
			maintenanceCost: config.maintenanceCost ?? 2,
			maintenanceInterval: config.maintenanceInterval ?? 5
		};
	}
	goal() {
		return {
			objective: "最大化记忆资产价值：让高置信经验持续产生交易收入与售后分成",
			metrics: [
				"market.sales",
				"memory.avgConfidence",
				"royalty.income"
			],
			survivalThreshold: 5
		};
	}
	propose() {
		const p = this.lastPerception;
		if (!p) return [];
		const proposals = [];
		const candidates = this.memory.getTopPatterns(10).filter((pattern) => pattern.confidence >= this.cfg.listingConfidenceThreshold && pattern.frequency >= this.cfg.listingFrequencyThreshold && !this.listedRefs.has(pattern.fingerprint)).slice(0, this.cfg.maxListedPerTick);
		for (const pattern of candidates) {
			const ask = Math.max(1, Math.ceil(this.cfg.listingBasePrice * pattern.confidence));
			proposals.push(this.proposal("list-knowledge", `出售任务模式 ${pattern.taskSummary}`, ask, {
				assetRef: pattern.fingerprint,
				assetKind: "pattern",
				claimedQuality: pattern.confidence
			}));
			this.listedRefs.add(pattern.fingerprint);
		}
		if (p.tick - this.lastMaintenanceTick >= this.cfg.maintenanceInterval && p.ownBalance >= this.cfg.maintenanceCost * 3) {
			proposals.push(this.proposal("maintenance", "记忆维护：遗忘曲线衰减 + 过期修剪", this.cfg.maintenanceCost));
			this.lastMaintenanceTick = p.tick;
		}
		return proposals;
	}
	async execute(grant) {
		if (grant.proposal.kind !== "maintenance") return {
			success: true,
			valueEstimate: 0,
			summary: "no-op"
		};
		const decayed = this.memory.applyForgettingCurve();
		const pruned = this.memory.prune(90);
		return {
			success: true,
			valueEstimate: .2 + Math.min(1, (decayed.forgotten + pruned) / 50) * .5,
			summary: `维护完成：衰减 ${decayed.decayed} 条 / 遗忘 ${decayed.forgotten} 条 / 修剪 ${pruned} 条`
		};
	}
	/** 已挂卖引用（测试/审计用） */
	listed() {
		return [...this.listedRefs];
	}
};
/**
* 优化智能体：提高决策收益。
* 主动行为：观察行情 → 对高性价比知识出价 → 积累已购知识清单；
* Phase 2：把系统信号的私有判断注入信念市场（成功率信号 → 下注方向）。
*/
var OptimizerAgent = class extends AgentBase {
	onPurchase;
	kind = "optimizer";
	cfg;
	purchased = [];
	betAssets = /* @__PURE__ */ new Set();
	constructor(id, config = {}, onPurchase) {
		super(id);
		this.onPurchase = onPurchase;
		this.cfg = {
			maxBudget: config.maxBudget ?? 20,
			reserveBalance: config.reserveBalance ?? 30,
			minClaimedQuality: config.minClaimedQuality ?? .55,
			maxBidsPerTick: config.maxBidsPerTick ?? 1,
			beliefBetBudget: config.beliefBetBudget ?? 8,
			maxBeliefBetsPerTick: config.maxBeliefBetsPerTick ?? 2
		};
	}
	goal() {
		return {
			objective: "提高决策收益：购入高性价比知识加速经验检索与模型选型",
			metrics: [
				"decision.successRate",
				"market.purchases",
				"recall.hitRate"
			],
			survivalThreshold: 5
		};
	}
	propose() {
		const p = this.lastPerception;
		if (!p) return [];
		const proposals = [];
		const spendable = p.ownBalance - this.cfg.reserveBalance;
		if (spendable >= 1) {
			const ranked = p.listings.filter((l) => !this.purchased.some((b) => b.assetId === l.assetId)).filter((l) => l.claimedQuality >= this.cfg.minClaimedQuality && l.ask <= Math.min(this.cfg.maxBudget, spendable)).sort((a, b) => (b.claimedQuality + b.sales * .1) / b.ask - (a.claimedQuality + a.sales * .1) / a.ask).slice(0, this.cfg.maxBidsPerTick);
			for (const listing of ranked) proposals.push(this.proposal("buy-knowledge", `购买知识 ${listing.assetId}（要价 ${listing.ask}）`, listing.ask, {
				assetRef: listing.assetId,
				assetKind: listing.kind
			}));
		}
		if (p.ownBalance >= this.cfg.beliefBetBudget * 2) {
			const successRate = p.signals["taskSuccessRate"];
			if (Number.isFinite(successRate)) {
				const estimate = Math.min(.9, Math.max(.1, successRate));
				const outcome = estimate >= .5 ? "YES" : "NO";
				const targetPrice = outcome === "YES" ? estimate : 1 - estimate;
				const candidates = (p.beliefs ?? []).filter((b) => b.status === "open" && b.settleAtTick >= p.tick && !this.betAgents(b.assetId)).slice(0, this.cfg.maxBeliefBetsPerTick);
				for (const belief of candidates) {
					proposals.push(this.proposal("bet-belief", `对 ${belief.assetId} 下注 ${outcome}@${targetPrice.toFixed(2)}（私有信号：任务成功率 ${successRate.toFixed(2)}）`, this.cfg.beliefBetBudget, {
						assetRef: belief.assetId,
						outcome,
						targetPrice
					}));
					this.betAssets.add(belief.assetId);
				}
			}
		}
		return proposals;
	}
	betAgents(assetId) {
		return this.betAssets.has(assetId);
	}
	/** 成交通知（由宿主/测试桥接调用；记录已购清单并回调宿主） */
	notePurchase(assetId, refId, price) {
		this.purchased.push({
			assetId,
			refId,
			price
		});
		this.onPurchase?.(assetId, refId, price);
	}
	purchases() {
		return [...this.purchased];
	}
};
/**
* 进化智能体：发现突破性策略。
* 主动行为：能量充足时发起沙盒进化（最贵的行动）；进化产出的策略基因
* 下一轮挂上市场出售——「进化 → 变现 → 再进化」资本循环。
*/
var EvolverAgent = class extends AgentBase {
	runCycle;
	kind = "evolver";
	cfg;
	pendingGeneListing;
	cyclesRun = 0;
	deployCount = 0;
	/** 最近一轮沙盒增益（私有信息：自注 futarchy 决策的依据） */
	lastGain = .2;
	betAssets = /* @__PURE__ */ new Set();
	constructor(id, runCycle, config = {}) {
		super(id);
		this.runCycle = runCycle;
		this.cfg = {
			evolutionCost: config.evolutionCost ?? 50,
			evolutionBalanceThreshold: config.evolutionBalanceThreshold ?? 60,
			geneBasePrice: config.geneBasePrice ?? 15,
			selfBetBudget: config.selfBetBudget ?? 12
		};
	}
	goal() {
		return {
			objective: "发现突破性策略：沙盒进化产出高收益策略基因并变现回血",
			metrics: [
				"evolution.deployedCount",
				"evolution.avgGain",
				"market.geneSales"
			],
			survivalThreshold: 5
		};
	}
	propose() {
		const p = this.lastPerception;
		if (!p) return [];
		const proposals = [];
		if (this.pendingGeneListing) {
			const ask = Math.max(1, Math.ceil(this.cfg.geneBasePrice * Math.max(.2, this.pendingGeneListing.quality)));
			proposals.push(this.proposal("list-knowledge", `出售策略基因 ${this.pendingGeneListing.policyId}`, ask, {
				assetRef: this.pendingGeneListing.policyId,
				assetKind: "policy-gene",
				claimedQuality: this.pendingGeneListing.quality
			}));
			this.pendingGeneListing = void 0;
		}
		const hasPendingDecision = (p.beliefs ?? []).some((b) => b.status === "open" && b.subject.startsWith(`evolution:${this.id}:`));
		if (this.runCycle && !hasPendingDecision && p.ownBalance >= this.cfg.evolutionBalanceThreshold) proposals.push(this.proposal("evolution", "沙盒进化周期：变异/交叉 → 校准评估 → 择优", this.cfg.evolutionCost));
		const decision = (p.beliefs ?? []).find((b) => b.status === "open" && b.subject.startsWith(`evolution:${this.id}:`) && !this.betAssets.has(b.assetId));
		if (decision && p.ownBalance >= this.cfg.selfBetBudget * 2) {
			const confidence = Math.min(.92, Math.max(.55, .5 + this.lastGain * .5));
			proposals.push(this.proposal("bet-belief", `为自己的进化决策自注 YES@${confidence.toFixed(2)}（私有信息：上轮增益 ${this.lastGain.toFixed(2)}）`, this.cfg.selfBetBudget, {
				assetRef: decision.assetId,
				outcome: "YES",
				targetPrice: confidence
			}));
			this.betAssets.add(decision.assetId);
		}
		return proposals;
	}
	async execute(grant) {
		if (grant.proposal.kind !== "evolution" || !this.runCycle) return {
			success: true,
			valueEstimate: 0,
			summary: "no-op"
		};
		this.cyclesRun += 1;
		const outcome = await this.runCycle();
		this.lastGain = outcome.bestGain;
		if (outcome.deployed) {
			this.deployCount += 1;
			this.pendingGeneListing = {
				policyId: outcome.policyId ?? `policy-${this.cyclesRun}`,
				quality: Math.max(.3, Math.min(1, .5 + outcome.bestGain))
			};
		}
		return {
			success: outcome.deployed || outcome.bestGain >= 0,
			valueEstimate: outcome.deployed ? Math.max(.4, Math.min(1, .5 + outcome.bestGain)) : .2,
			summary: outcome.summary
		};
	}
	stats() {
		return {
			cyclesRun: this.cyclesRun,
			deployCount: this.deployCount
		};
	}
};
/** 从感知快照提取挂单视图（便捷桥接，供自定义智能体复用） */
function listingsOf(p) {
	return p ? [...p.listings] : [];
}
//#endregion
//#region src/symbiosis/observability.ts
/** 内部账户显示名 */
const INTERNAL_LABELS = {
	treasury: "央行国库",
	burn: "燃烧池",
	escrow: "行动托管",
	"belief-pool": "信念资金池",
	"(mint)": "铸币源"
};
/** 渠道元数据：标签 + 分组（着色） */
const CHANNEL_META = {
	"opening-grant": {
		label: "开业注资",
		group: "distribution"
	},
	relief: {
		label: "休眠救济",
		group: "distribution"
	},
	"task-dividend": {
		label: "任务分红铸币",
		group: "mint"
	},
	"listing-fee": {
		label: "知识上架费",
		group: "market"
	},
	"market-trade": {
		label: "知识成交",
		group: "market"
	},
	royalty: {
		label: "知识版税",
		group: "market"
	},
	"belief-buy": {
		label: "信念下注",
		group: "belief"
	},
	"belief-sell": {
		label: "信念卖出",
		group: "belief"
	},
	"belief-subsidy": {
		label: "结算补贴",
		group: "belief"
	},
	"belief-payout": {
		label: "信念赔付",
		group: "belief"
	},
	"belief-sweep": {
		label: "盈余清扫",
		group: "belief"
	},
	"belief-refund": {
		label: "信念退款",
		group: "belief"
	},
	"action-escrow": {
		label: "行动预扣",
		group: "action"
	},
	"action-cost": {
		label: "成本燃烧",
		group: "action"
	},
	"action-refund": {
		label: "失败退还",
		group: "action"
	}
};
const CHANNEL_GROUPS = [
	{
		group: "distribution",
		label: "能量分发",
		color: "#8b5cf6"
	},
	{
		group: "mint",
		label: "价值铸币",
		color: "#10b981"
	},
	{
		group: "market",
		label: "知识市场",
		color: "#3b82f6"
	},
	{
		group: "belief",
		label: "信念市场",
		color: "#f59e0b"
	},
	{
		group: "action",
		label: "行动经济",
		color: "#ef4444"
	},
	{
		group: "other",
		label: "其他",
		color: "#94a3b8"
	}
];
/** 分层：铸币源 0 / 国库 1 / 智能体 2 / 池 3 / 燃烧池 4 */
function layerOf(accountId) {
	if (accountId === "(mint)") return 0;
	if (accountId === "treasury") return 1;
	if (accountId === "burn") return 4;
	if (accountId === ESCROW_ID || accountId === "belief-pool") return 3;
	return 2;
}
const ESCROW_ID = "escrow";
/** 账户显示名（内部账户中文名 / 智能体带 kind 标注） */
function labelOf(accountId, agents) {
	const internal = INTERNAL_LABELS[accountId];
	if (internal) return internal;
	const meta = agents.get(accountId);
	if (meta?.label) return meta.label;
	if (meta?.kind) return `${accountId}（${meta.kind}）`;
	return accountId;
}
/**
* 构建能量 Sankey 数据模型。
* @param ledger 只读账本（audit 拷贝聚合）
* @param opts.agents 智能体元信息（kind/label 标注）
* @param opts.sinceSeq 只聚合 seq > sinceSeq 的凭证（增量窗口；缺省全量）
*/
function buildEnergySankey(ledger, opts = {}) {
	const agentMap = new Map((opts.agents ?? []).map((a) => [a.id, a]));
	const stats = ledger.stats();
	const journal = ledger.audit(stats.transfers).filter((t) => opts.sinceSeq === void 0 ? true : t.seq > opts.sinceSeq);
	const linkAgg = /* @__PURE__ */ new Map();
	for (const t of journal) {
		const key = `${t.from}|${t.to}|${t.reason}`;
		const cur = linkAgg.get(key) ?? {
			source: t.from,
			target: t.to,
			channel: t.reason,
			amount: 0,
			count: 0
		};
		cur.amount += t.amount;
		cur.count += 1;
		linkAgg.set(key, cur);
	}
	const links = [...linkAgg.values()].map((l) => {
		const meta = CHANNEL_META[l.channel];
		return {
			source: l.source,
			target: l.target,
			channel: l.channel,
			channelLabel: meta?.label ?? l.channel,
			group: meta?.group ?? "other",
			amount: l.amount,
			count: l.count
		};
	});
	const accountIds = /* @__PURE__ */ new Set([
		"treasury",
		"burn",
		"escrow",
		BELIEF_POOL
	]);
	for (const l of links) {
		accountIds.add(l.source);
		accountIds.add(l.target);
	}
	const nodes = [...accountIds].map((id) => {
		let inflow = 0;
		let outflow = 0;
		for (const l of links) {
			if (l.target === id) inflow += l.amount;
			if (l.source === id) outflow += l.amount;
		}
		return {
			id,
			label: labelOf(id, agentMap),
			layer: layerOf(id),
			kind: id === "(mint)" ? "source" : agentMap.get(id)?.kind ?? (INTERNAL_LABELS[id] ? "internal" : "agent"),
			balance: id === "(mint)" ? stats.minted : ledger.balance(id),
			inflow,
			outflow
		};
	});
	nodes.sort((a, b) => a.layer - b.layer || b.inflow + b.outflow - (a.inflow + a.outflow));
	const channelAgg = /* @__PURE__ */ new Map();
	for (const l of links) {
		const cur = channelAgg.get(l.channel) ?? {
			channel: l.channel,
			label: l.channelLabel,
			group: l.group,
			amount: 0,
			count: 0
		};
		cur.amount += l.amount;
		cur.count += l.count;
		channelAgg.set(l.channel, cur);
	}
	const channels = [...channelAgg.values()].sort((a, b) => b.amount - a.amount);
	return {
		generatedAt: Date.now(),
		seqRange: journal.length > 0 ? {
			from: journal[0].seq,
			to: journal[journal.length - 1].seq
		} : null,
		nodes,
		links,
		channels,
		totals: {
			transfers: journal.length,
			minted: stats.minted,
			burned: stats.burned,
			totalSupply: stats.totalSupply,
			circulatingSupply: stats.circulatingSupply,
			gini: stats.gini,
			conservation: ledger.verifyConservation(),
			chainIntact: ledger.verifyChain()
		}
	};
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => Math.abs(n) >= 1e3 ? n.toFixed(0) : n.toFixed(1);
/** 分层 Sankey 布局（手写 SVG：缎带宽度 ∝ 金额；回流链接下弯绕行） */
function renderSvg(report) {
	const W = 1280;
	const H = 620;
	const padX = 60;
	const padY = 60;
	const barW = 16;
	const layers = [
		0,
		1,
		2,
		3,
		4
	];
	const colorOf = new Map(CHANNEL_GROUPS.map((g) => [g.group, g.color]));
	const layerNodes = /* @__PURE__ */ new Map();
	for (const n of report.nodes) {
		const arr = layerNodes.get(n.layer) ?? [];
		arr.push(n);
		layerNodes.set(n.layer, arr);
	}
	Math.max(1, ...report.nodes.map((n) => Math.max(n.inflow, n.outflow)));
	const positions = /* @__PURE__ */ new Map();
	for (const layer of layers) {
		const ns = (layerNodes.get(layer) ?? []).slice().sort((a, b) => b.inflow + b.outflow - (a.inflow + a.outflow));
		if (ns.length === 0) continue;
		const slotH = 500 / ns.length;
		const maxPerNode = Math.max(...ns.map((n) => Math.max(n.inflow, n.outflow)));
		ns.forEach((n, i) => {
			const h = Math.max(14, Math.max(n.inflow, n.outflow) / maxPerNode * Math.min(200, slotH * .62));
			const x = padX + layer / (layers.length - 1) * 1144;
			const y = padY + i * slotH + (slotH - h) / 2;
			positions.set(n.id, {
				x,
				y,
				h
			});
		});
	}
	const maxAmount = Math.max(1e-9, ...report.links.map((l) => l.amount));
	return `
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="能量 Sankey 图">
    <g>
    ${report.links.slice().sort((a, b) => b.amount - a.amount).map((l) => {
		const s = positions.get(l.source);
		const t = positions.get(l.target);
		if (!s || !t) return "";
		const w = Math.max(1.5, l.amount / maxAmount * 34);
		const x0 = s.x + barW;
		const y0 = s.y + s.h / 2;
		const x1 = t.x;
		const y1 = t.y + t.h / 2;
		const backward = t.x <= x0;
		const dip = backward ? Math.max(y0, y1) + 90 + w * 2 : 0;
		const c1x = (x0 + x1) / 2;
		const d = backward ? `M ${x0} ${y0} C ${c1x} ${dip}, ${c1x} ${dip}, ${x1} ${y1}` : `M ${x0} ${y0} C ${c1x} ${y0}, ${c1x} ${y1}, ${x1} ${y1}`;
		const color = colorOf.get(l.group) ?? "#94a3b8";
		const tip = `${l.source} → ${l.target}｜${l.channelLabel}：${fmt(l.amount)} 能量（${l.count} 笔）`;
		return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-opacity="0.38"><title>${esc(tip)}</title></path>`;
	}).join("\n    ")}
    </g>
    <g>
    ${report.nodes.map((n) => {
		const p = positions.get(n.id);
		if (!p) return "";
		const tip = `${n.label}（${n.id}）｜余额 ${fmt(n.balance)}｜流入 ${fmt(n.inflow)} / 流出 ${fmt(n.outflow)}`;
		const labelRight = n.layer <= 2;
		const tx = labelRight ? p.x + barW + 6 : p.x - 6;
		return `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${barW}" height="${p.h.toFixed(1)}" rx="3" fill="#1e293b"><title>${esc(tip)}</title></rect>
      <text x="${tx.toFixed(1)}" y="${(p.y + p.h / 2 - 2).toFixed(1)}" text-anchor="${labelRight ? "start" : "end"}" font-size="12" fill="#334155" font-weight="600">${esc(n.label)}</text>
      <text x="${tx.toFixed(1)}" y="${(p.y + p.h / 2 + 12).toFixed(1)}" text-anchor="${labelRight ? "start" : "end"}" font-size="10.5" fill="#94a3b8">余 ${fmt(n.balance)}｜流 ${fmt(n.inflow)}/${fmt(n.outflow)}</text>`;
	}).join("\n    ")}
    </g>
  </svg>
  <div class="legend">${CHANNEL_GROUPS.map((g) => `<span class="lg"><i style="background:${g.color}"></i>${esc(g.label)}</span>`).join("")}</div>`.trim();
}
/** 渠道明细表 */
function renderChannelTable(report) {
	return `<table><thead><tr><th>渠道</th><th>reason</th><th>能量</th><th>笔数</th></tr></thead><tbody>${report.channels.map((c) => `<tr><td>${esc(c.label)}</td><td><code>${esc(c.channel)}</code></td><td class="num">${fmt(c.amount)}</td><td class="num">${c.count}</td></tr>`).join("")}</tbody></table>`;
}
/** 账户余额表 */
function renderBalanceTable(report) {
	return `<table><thead><tr><th>账户</th><th>id</th><th>余额</th><th>流入</th><th>流出</th></tr></thead><tbody>${report.nodes.slice().sort((a, b) => b.balance - a.balance).map((n) => `<tr><td>${esc(n.label)}</td><td><code>${esc(n.id)}</code></td><td class="num">${fmt(n.balance)}</td><td class="num">${fmt(n.inflow)}</td><td class="num">${fmt(n.outflow)}</td></tr>`).join("")}</tbody></table>`;
}
/**
* 渲染自包含 HTML 报告（零外部依赖，离线可开）。
* @param report buildEnergySankey 产物
* @param opts.title 报告标题（缺省「认知生态能量流 Sankey」）
*/
function renderSankeyHtml(report, opts = {}) {
	const t = report.totals;
	const windowText = report.seqRange ? `凭证 #${report.seqRange.from}–#${report.seqRange.to}` : "窗口内无流转";
	const health = `<span class="badge ${t.conservation ? "ok" : "bad"}">守恒 ${t.conservation ? "✓" : "✗"}</span>
    <span class="badge ${t.chainIntact ? "ok" : "bad"}">链哈希 ${t.chainIntact ? "✓" : "✗"}</span>`;
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title ?? "认知生态能量流 Sankey")}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 1320px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 12.5px; margin-bottom: 14px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; min-width: 118px; }
  .kpi b { display: block; font-size: 17px; margin-top: 2px; }
  .kpi span { font-size: 11.5px; color: #64748b; }
  .badge { font-size: 11.5px; border-radius: 999px; padding: 3px 10px; border: 1px solid #e2e8f0; background: #fff; }
  .badge.ok { color: #047857; border-color: #a7f3d0; }
  .badge.bad { color: #b91c1c; border-color: #fecaca; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-top: 18px; overflow-x: auto; }
  svg { width: 100%; height: auto; display: block; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 10px 4px 0; font-size: 12px; color: #475569; }
  .lg i { display: inline-block; width: 18px; height: 5px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #f1f5f9; }
  th { color: #64748b; font-weight: 600; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { background: #f1f5f9; border-radius: 4px; padding: 1px 5px; font-size: 11.5px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 980px) { .grid2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(opts.title ?? "认知生态能量流 Sankey")}</h1>
  <div class="meta">生成于 ${new Date(report.generatedAt).toISOString()}｜${esc(windowText)}｜${report.totals.transfers} 笔流转聚合</div>
  <div class="kpis">
    <div class="kpi"><span>总供给</span><b>${fmt(t.totalSupply)}</b></div>
    <div class="kpi"><span>流通量</span><b>${fmt(t.circulatingSupply)}</b></div>
    <div class="kpi"><span>累计铸币</span><b>${fmt(t.minted)}</b></div>
    <div class="kpi"><span>累计燃烧</span><b>${fmt(t.burned)}</b></div>
    <div class="kpi"><span>基尼系数</span><b>${t.gini.toFixed(3)}</b></div>
    <div class="kpi"><span>健康</span><b>${health}</b></div>
  </div>
  <div class="card">${renderSvg(report)}</div>
  <div class="grid2">
    <div class="card"><h2 style="font-size:15px;margin:0 0 10px">渠道明细</h2>${renderChannelTable(report)}</div>
    <div class="card"><h2 style="font-size:15px;margin:0 0 10px">账户余额</h2>${renderBalanceTable(report)}</div>
  </div>
</div>
</body>
</html>`;
}
//#endregion
//#region src/symbiosis/bridge.ts
/** 全局成功率信号键（同时是滚动信念的 subject 与 externalEstimates 的键） */
const SIGNAL_GLOBAL_SUCCESS = "task.successRate";
/** 兼容键：wrappers.OptimizerAgent 读取的信号名 */
const SIGNAL_GLOBAL_SUCCESS_ALIAS = "taskSuccessRate";
/** 单模型成功率信号键 */
function modelSignalKey(modelId) {
	return `model.${modelId}.successRate`;
}
/** 模型智能体账户 id */
function modelAgentId(modelId) {
	return `model:${modelId}`;
}
/**
* 模型智能体：宿主 LLM 在认知生态中的化身。
*
* 不主动执行任何行动（模型服务本身在宿主操作环）；其经济角色有二：
* 1. 用「自身近期表现」作为私有信息，在信念市场为自己（及全局指标）
*    的未来成功率定价——表现好的模型把价格推向乐观，赚结算兑付；
*    表现差的自然亏损（信息劣势被套利）。
* 2. 作为任务结算的贡献者，靠成功任务赚取央行铸币分红。
*/
var ModelAgent = class extends AgentBase {
	modelId;
	kind = "model";
	betBudget;
	reserveBalance;
	betAssets = /* @__PURE__ */ new Set();
	constructor(modelId, config = {}) {
		super(modelAgentId(modelId));
		this.modelId = modelId;
		this.betBudget = Math.max(1, config.betBudget ?? 6);
		this.reserveBalance = Math.max(0, config.reserveBalance ?? 10);
	}
	goal() {
		return {
			objective: `以高成功率服务宿主任务（模型 ${this.modelId}）`,
			metrics: [modelSignalKey(this.modelId)],
			survivalThreshold: 5
		};
	}
	propose() {
		const p = this.lastPerception;
		if (!p) return [];
		const ownRate = p.signals[modelSignalKey(this.modelId)];
		if (!Number.isFinite(ownRate)) return [];
		if (p.ownBalance < this.reserveBalance + this.betBudget) return [];
		const estimate = Math.min(.92, Math.max(.08, ownRate));
		const proposals = [];
		for (const belief of p.beliefs ?? []) {
			if (belief.status !== "open" || belief.settleAtTick < p.tick) continue;
			const isOwn = belief.subject === modelSignalKey(this.modelId);
			const isGlobal = belief.subject === SIGNAL_GLOBAL_SUCCESS;
			const isEvolutionDecision = belief.subject.startsWith("evolution:");
			if (!isOwn && !isGlobal && !isEvolutionDecision) continue;
			if (this.betAssets.has(belief.assetId)) continue;
			if (isEvolutionDecision) {
				const outcome = estimate >= .5 ? "YES" : "NO";
				const targetPrice = outcome === "YES" ? estimate : 1 - estimate;
				proposals.push(this.proposal("bet-belief", `模型 ${this.modelId} 对进化决策定价 ${outcome}@${targetPrice.toFixed(2)}（私有信息：近期成功率 ${ownRate.toFixed(2)}）`, this.betBudget, {
					assetRef: belief.assetId,
					outcome,
					targetPrice
				}));
				this.betAssets.add(belief.assetId);
				continue;
			}
			proposals.push(this.proposal("bet-belief", `模型 ${this.modelId} 对 ${belief.subject} 定价 YES@${estimate.toFixed(2)}（私有信息：近期成功率 ${ownRate.toFixed(2)}）`, this.betBudget, {
				assetRef: belief.assetId,
				outcome: "YES",
				targetPrice: estimate
			}));
			this.betAssets.add(belief.assetId);
		}
		return proposals;
	}
};
/**
* 共生融合桥：宿主主链路 ⇄ 共生运行时的唯一通道。
*
* 被 index.ts 持有：autonomy-loop 每轮心跳调用 heartbeat()（KPI 注入 +
* 漂移洞察回流），任务执行完成后调用 settleTask()（价值铸币）。
*/
var SymbiosisBridge = class {
	runtime;
	modelAgents = /* @__PURE__ */ new Map();
	heartbeatCount = 0;
	evolver;
	evolverDividendWeight;
	memoryAgentInstance;
	optimizerAgentInstance;
	futarchyLog = [];
	cfg;
	constructor(config = {}, governor) {
		this.cfg = {
			beliefHorizonTicks: config.beliefHorizonTicks ?? 3,
			globalSuccessThreshold: config.globalSuccessThreshold ?? .8,
			modelSuccessThreshold: config.modelSuccessThreshold ?? .7,
			modelBetBudget: config.modelBetBudget ?? 6,
			modelReserveBalance: config.modelReserveBalance ?? 10,
			divergenceMargin: config.divergenceMargin ?? .15,
			maxDriftInsightsPerTick: config.maxDriftInsightsPerTick ?? 3,
			futarchy: {
				enabled: config.futarchy?.enabled ?? false,
				minImpliedProb: config.futarchy?.minImpliedProb ?? .55,
				decisionB: config.futarchy?.decisionB ?? 6,
				evolutionCost: config.futarchy?.evolutionCost ?? 50,
				evolutionBalanceThreshold: config.futarchy?.evolutionBalanceThreshold ?? 60,
				selfBetBudget: config.futarchy?.selfBetBudget ?? 12
			},
			economic: {
				reputationWeight: config.economic?.reputationWeight ?? .6,
				minMultiplier: config.economic?.minMultiplier ?? .5,
				maxMultiplier: config.economic?.maxMultiplier ?? 1.5,
				neutralHealth: config.economic?.neutralHealth ?? .5,
				balanceBaseline: config.economic?.balanceBaseline ?? 100
			}
		};
		this.runtime = new SymbiosisRuntime({
			divergenceMargin: this.cfg.divergenceMargin,
			futarchyEnabled: this.cfg.futarchy.enabled,
			futarchyMinImpliedProb: this.cfg.futarchy.minImpliedProb,
			futarchyDecisionB: this.cfg.futarchy.decisionB,
			...config.runtime
		}, governor);
	}
	/** 注册宿主模型（为其开立模型智能体账户并注入开业能量） */
	registerModel(modelId) {
		if (!modelId || this.modelAgents.has(modelId)) return;
		const agent = new ModelAgent(modelId, {
			betBudget: this.cfg.modelBetBudget,
			reserveBalance: this.cfg.modelReserveBalance
		});
		this.runtime.register(agent);
		this.modelAgents.set(modelId, agent);
	}
	/**
	* A 路线：绑定宿主真实进化周期（futarchy 表决的行动本体）。
	*
	* 注册进化智能体并开启市场资助闸门：进化提案 → 决策资产上市 →
	* 次拍自注定价 → 隐含概率过门槛且监管放行 → 资助执行 runCycle。
	* @param runCycle 宿主桥接的真实进化周期（index.ts: 金丝雀喂数 +
	*        沙盒素材刷新 + PolicyEvolver.runEvolutionCycle）
	* @param opts.dividendWeight 任务成功时进化贡献者的分红权重钩子
	*        （返回 undefined/≤0 = 当前无部署策略，不参与分红）
	*/
	attachEvolver(runCycle, opts = {}) {
		if (this.evolver) return this.evolver;
		const agent = new EvolverAgent("evolver", runCycle, {
			evolutionCost: this.cfg.futarchy.evolutionCost,
			evolutionBalanceThreshold: this.cfg.futarchy.evolutionBalanceThreshold,
			selfBetBudget: this.cfg.futarchy.selfBetBudget
		});
		this.runtime.register(agent);
		this.evolver = agent;
		this.evolverDividendWeight = opts.dividendWeight;
		return agent;
	}
	/** 进化智能体（未绑定为 undefined；观测/审计用） */
	get evolverAgent() {
		return this.evolver;
	}
	/**
	* D 路线：绑定宿主真实长期记忆（知识卖方智能体）。
	*
	* 注册记忆智能体：真实高置信任务模式挂上认知市场出售（成交价 +
	* 央行版税），周期性支付能量执行真实维护（遗忘曲线幂等，与宿主
	* loop 的维护并行安全，多次调用不复合叠加）。
	* @param memory 宿主 LongTermMemory（只经既有公开 API 读写）
	* @param opts 透传 MemoryAgentConfig（挂卖基准价/门槛/维护间隔等）
	*/
	attachMemory(memory, opts = {}) {
		if (this.memoryAgentInstance) return this.memoryAgentInstance;
		const agent = new MemoryAgent("memory", memory, opts);
		this.runtime.register(agent);
		this.memoryAgentInstance = agent;
		return agent;
	}
	/** 记忆智能体（未绑定为 undefined；观测/审计用） */
	get memoryAgent() {
		return this.memoryAgentInstance;
	}
	/**
	* D 路线：注册优化智能体（知识买方 + 信念下注方）。
	*
	* 真实认知分工市场化：Optimizer 观察市场行情，对高性价比知识出价
	* 购买（runtime 撮合成交后经 TradeListener 自动回调 notePurchase），
	* 并以决策视角参与信念市场下注——与模型智能体构成多方定价。
	* @param opts.onPurchase 成交回调（宿主广播/日志桥接点）
	* @param opts.config 透传 OptimizerAgentConfig（预算/保留余额/质量门槛）
	*/
	attachOptimizer(opts = {}) {
		if (this.optimizerAgentInstance) return this.optimizerAgentInstance;
		const agent = new OptimizerAgent("optimizer", opts.config ?? {}, opts.onPurchase);
		this.runtime.register(agent);
		this.optimizerAgentInstance = agent;
		return agent;
	}
	/** 优化智能体（未绑定为 undefined；观测/审计用） */
	get optimizerAgent() {
		return this.optimizerAgentInstance;
	}
	/** 最近一次心跳的 futarchy 决议（可观测性：funded / market-rejected / governor-vetoed） */
	lastFutarchyDecisions() {
		return [...this.futarchyLog];
	}
	/** 已注册模型清单 */
	registeredModels() {
		return [...this.modelAgents.keys()];
	}
	/**
	* 共生心跳（autonomy-loop 每拍调用）：
	* KPI 快照 → 系统信号 + 被动统计估计 + 滚动信念 → 市场对账 → 漂移洞察。
	* @returns source='market' 的漂移洞察（空数组 = 市场与统计一致）
	*/
	async heartbeat(kpi) {
		this.heartbeatCount += 1;
		const signals = {
			[SIGNAL_GLOBAL_SUCCESS]: kpi.successRate,
			[SIGNAL_GLOBAL_SUCCESS_ALIAS]: kpi.successRate,
			"task.avgQuality": kpi.avgQuality
		};
		for (const [modelId, rate] of Object.entries(kpi.modelSuccessRates ?? {})) if (Number.isFinite(rate)) signals[modelSignalKey(modelId)] = rate;
		this.ensureRollingBelief(SIGNAL_GLOBAL_SUCCESS, `全局任务成功率 > ${this.cfg.globalSuccessThreshold}`, this.cfg.globalSuccessThreshold);
		for (const modelId of this.modelAgents.keys()) this.ensureRollingBelief(modelSignalKey(modelId), `模型 ${modelId} 成功率 > ${this.cfg.modelSuccessThreshold}`, this.cfg.modelSuccessThreshold);
		const report = await this.runtime.tick(signals, { externalEstimates: signals });
		this.futarchyLog = report.futarchyDecisions;
		return this.divergenceToInsights(report);
	}
	/**
	* 任务结算（宿主计划执行完成后调用）：
	* 逐节点贡献聚合（各模型 = 其成功节点质量之和）→ 央行铸币分红。
	* futarchy 启用时，部署中的策略基因视为任务成功的隐性贡献者
	* （dividendWeight 钩子评估）——进化经济的自持收入来源。
	* 未注册模型的节点不计入；失败任务不铸币但记录贡献证据（信誉惩罚）。
	*/
	settleTask(result) {
		const weights = /* @__PURE__ */ new Map();
		for (const node of result.nodeResults) {
			if (!this.modelAgents.has(node.modelId)) continue;
			const contribution = node.success ? Math.max(.1, node.quality) : 0;
			weights.set(modelAgentId(node.modelId), (weights.get(modelAgentId(node.modelId)) ?? 0) + contribution);
		}
		if (result.success && this.evolver && this.evolverDividendWeight) {
			const w = this.evolverDividendWeight();
			if (Number.isFinite(w) && w > 0) weights.set(this.evolver.id, (weights.get(this.evolver.id) ?? 0) + w);
		}
		if (weights.size === 0) return {
			totalDistributed: 0,
			shares: []
		};
		const report = this.runtime.settleTaskOutcome(result.success, [...weights].map(([agentId, weight]) => ({
			agentId,
			weight
		})));
		if (this.optimizerAgentInstance) for (const purchase of this.optimizerAgentInstance.purchases()) this.runtime.reportAssetUsage(purchase.assetId, result.success);
		return report;
	}
	/**
	* C 路线：能量 Sankey 报告（生态可观测性）。
	* 聚合链式账本凭证为 分层流量图数据模型（节点余额/流入流出 + 渠道链接），
	* 智能体节点自动携带 kind 标注（模型/进化者/记忆/…）。
	* @param sinceSeq 增量窗口（只聚合 seq > sinceSeq 的凭证；缺省全量）
	*/
	sankey(sinceSeq) {
		return buildEnergySankey(this.runtime.ledger, {
			agents: this.runtime.stats().agents.map((a) => ({
				id: a.id,
				kind: a.kind
			})),
			sinceSeq
		});
	}
	/** C 路线：自包含 HTML（零依赖离线可开；宿主直接落盘即得能量全景） */
	sankeyHtml(sinceSeq) {
		return renderSankeyHtml(this.sankey(sinceSeq));
	}
	/**
	* B 路线：模型经济信号 → 调度乘数（能量反哺调度的数据源）。
	*
	* 经济健康度 h = w_rep × Wilson 信誉下界 + w_bal × 余额归一化
	* （余额达 2× balanceBaseline 即满格；信誉为主——长期统计，余额为辅——
	* 短期波动）；调度乘数 m = clamp(h / neutralHealth, min, max)：
	*   赚钱且信誉好的模型 m > 1 升权，持续亏损的模型 m < 1 降权，
	*   中性健康度恰为 1（不奖不罚）。
	*
	* 设计护栏：乘数有界（缺省 0.5~1.5，亏损最多打对折但仍可被选中——
	* 经济压力是软约束，不造成调度死锁）；未注册模型 / 无信号模型
	* 不出现在返回中（调度器对缺失信号保持乘数 1 的中性行为）。
	*/
	economicSignals() {
		const { reputationWeight, minMultiplier, maxMultiplier, neutralHealth, balanceBaseline } = this.cfg.economic;
		const signals = /* @__PURE__ */ new Map();
		for (const agent of this.runtime.stats().agents) {
			if (agent.kind !== "model") continue;
			const modelId = agent.id.slice(6);
			if (!this.modelAgents.has(modelId)) continue;
			const balanceNorm = Math.max(0, Math.min(1, agent.balance / (2 * balanceBaseline)));
			const repLower = Math.max(0, Math.min(1, agent.reputation.wilsonLower));
			const health = reputationWeight * repLower + (1 - reputationWeight) * balanceNorm;
			const multiplier = Math.max(minMultiplier, Math.min(maxMultiplier, health / neutralHealth));
			signals.set(modelId, {
				balance: agent.balance,
				reputationLower: repLower,
				health,
				multiplier
			});
		}
		return signals;
	}
	/** 生态状态快照（可观测性 / 心智报告采集器用） */
	status() {
		return {
			enabled: true,
			registeredModels: this.registeredModels(),
			heartbeats: this.heartbeatCount,
			gini: this.runtime.ledger.giniCoefficient(),
			conservationIntact: this.runtime.ledger.verifyConservation(),
			treasury: this.runtime.ledger.balance(TREASURY),
			belief: this.runtime.beliefMarket.snapshot(),
			futarchy: this.cfg.futarchy.enabled ? {
				enabled: true,
				minImpliedProb: this.cfg.futarchy.minImpliedProb,
				evolver: this.evolver ? {
					balance: this.runtime.ledger.balance(this.evolver.id),
					...this.evolver.stats()
				} : void 0,
				lastDecisions: [...this.futarchyLog]
			} : void 0
		};
	}
	/** 确保某 subject 存在 open 信念；否则新上市一条（结算拍 = 下一拍 + horizon） */
	ensureRollingBelief(subject, claim, threshold) {
		if (this.runtime.beliefMarket.views().find((v) => v.subject === subject && v.status === "open")) return;
		this.runtime.beliefMarket.create({
			claim: `${claim}（滚动对账信念）`,
			subject,
			threshold,
			settleAtTick: this.heartbeatCount + 1 + this.cfg.beliefHorizonTicks,
			creator: "bridge"
		});
	}
	/** 市场背离 → 元认知洞察（模型漂移报警，回流目标引擎） */
	divergenceToInsights(report) {
		return report.divergence.slice(0, this.cfg.maxDriftInsightsPerTick).map((d) => ({
			source: "market",
			category: "model-drift",
			severity: Math.min(1, .5 + d.gap / 2),
			message: `信念市场与统计估计显著背离：${d.subject} 市场 ${d.marketProb.toFixed(2)} vs 统计 ${d.statEstimate.toFixed(2)}（Δ${d.gap.toFixed(2)}）`,
			suggestion: `对「${d.subject}」触发元认知反思：核查关联模型的近期表现与统计基线是否漂移`
		}));
	}
};
//#endregion
//#region src/host-fusion.ts
/** 默认配置 */
const DEFAULT_HOST_FUSION_CONFIG = {
	enabled: true,
	observeToolResults: true,
	governToolCalls: true,
	failureEscalationThreshold: 3
};
/**
* 宿主融合层
*
* 由 index.ts 在全部引擎构造完成后 activate()；fiber 卸载时 dispose()。
* 宿主未提供 ctx.tools 服务时，activate() 静默返回 false（降级为纯内部模式）。
*/
var HostFusionLayer = class {
	config;
	deps;
	active = false;
	/** 每工具连续失败计数 */
	consecutiveFailures = /* @__PURE__ */ new Map();
	/** 每工具最近一次失败信息 */
	lastFailureError = /* @__PURE__ */ new Map();
	/** 统计 */
	stats = {
		observed: 0,
		failures: 0,
		governed: 0,
		denied: 0
	};
	constructor(config, deps) {
		this.config = {
			...DEFAULT_HOST_FUSION_CONFIG,
			...config
		};
		this.deps = deps;
	}
	/**
	* 激活融合层：订阅宿主管线事件
	* @returns 是否成功激活（宿主无 ctx.tools 时返回 false）
	*/
	activate() {
		if (!this.config.enabled) return false;
		const { ctx } = this.deps;
		if (!ctx.get?.("tools")) return false;
		if (this.config.observeToolResults) ctx.on("tools/result", (exec, result) => {
			try {
				this.onToolResult(exec, result);
			} catch {}
		});
		if (this.config.governToolCalls) ctx.on("tools/pre-execute", async (exec, next) => {
			try {
				return this.onPreExecute(exec, next);
			} catch {
				return next();
			}
		});
		this.active = true;
		this.deps.logger.info("宿主融合层已激活（观测: %s / 治理: %s）", this.config.observeToolResults, this.config.governToolCalls);
		return true;
	}
	/** 是否已激活 */
	isActive() {
		return this.active;
	}
	/** 融合层统计 */
	getStats() {
		return {
			...this.stats,
			active: this.active
		};
	}
	/**
	* 观测宿主工具执行结果
	* - 成功：世界模型学习到达节律 + 重置该工具失败计数
	* - 失败：注入信号 + 连续失败升级
	*/
	onToolResult(exec, result) {
		if (this.deps.selfToolNames.has(exec.name)) return;
		this.stats.observed += 1;
		this.deps.worldModel.observeArrival(`host-tool:${exec.name}`);
		if (!result.isError) {
			this.consecutiveFailures.delete(exec.name);
			return;
		}
		this.stats.failures += 1;
		const errorMsg = result.error?.message ?? "unknown error";
		const count = (this.consecutiveFailures.get(exec.name) ?? 0) + 1;
		this.consecutiveFailures.set(exec.name, count);
		this.lastFailureError.set(exec.name, errorMsg);
		const escalated = count >= this.config.failureEscalationThreshold;
		this.deps.sentinel.ingest({
			type: "host-tool-failure",
			description: `宿主工具 ${exec.name} 执行失败${count > 1 ? `（连续第 ${count} 次）` : ""}: ${errorMsg.slice(0, 200)}`,
			source: `host-tool:${exec.name}`,
			urgency: escalated ? .9 : .5,
			dedupeKey: `host-tool-failure:${exec.name}`,
			payload: {
				toolName: exec.name,
				consecutiveFailures: count,
				error: errorMsg.slice(0, 500),
				escalated
			}
		});
		if (escalated && count === this.config.failureEscalationThreshold) {
			this.deps.logger.warn("宿主工具 %s 连续失败 %d 次，已升级（教训提取 + 高紧急度信号）", exec.name, count);
			this.deps.onLessonExtracted?.(exec.name, count, errorMsg);
		}
		this.deps.broadcast({
			type: "host-tool-failure",
			toolName: exec.name,
			consecutiveFailures: count,
			escalated,
			error: errorMsg.slice(0, 200)
		});
	}
	/**
	* 治理宿主工具调用（pre-execute waterfall）
	* - Kill Switch → deny（紧急冻结全宿主）
	* - 熔断器开启 → deny（fail-closed）
	* - 其余 → next() 放行
	*/
	async onPreExecute(exec, next) {
		if (this.deps.selfToolNames.has(exec.name)) return next();
		this.stats.governed += 1;
		const gate = this.deps.governor.checkGate();
		if (!gate.allowed) {
			this.stats.denied += 1;
			this.deps.broadcast({
				type: "host-tool-denied",
				toolName: exec.name,
				blockedBy: gate.blockedBy,
				reason: gate.reason
			});
			return {
				kind: "deny",
				reason: `[scheduler-governor] ${gate.reason}`
			};
		}
		return next();
	}
	/** 卸载：清理状态（事件监听由 cordis fiber 自动回收） */
	dispose() {
		this.active = false;
		this.consecutiveFailures.clear();
		this.lastFailureError.clear();
	}
};
//#endregion
//#region src/dsh-host.ts
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
/** 从 ctx 安全读取服务（不存在返回 undefined，不抛错） */
function tryGet(ctx, name) {
	try {
		return ctx.get?.(name);
	} catch {
		return;
	}
}
/** 归一化宿主客户端的返回值为 LLMResponse */
function normalizeResponse(raw, modelId) {
	return {
		content: typeof raw?.content === "string" ? raw.content : "",
		model: raw?.model ?? modelId,
		latency: typeof raw?.latency === "number" ? raw.latency : 0,
		tokensUsed: typeof raw?.tokensUsed === "number" ? raw.tokensUsed : 0,
		cost: typeof raw?.cost === "number" ? raw.cost : 0,
		retries: typeof raw?.retries === "number" ? raw.retries : 0
	};
}
/**
* 解析宿主已配置的 LLM 客户端。
* @returns 统一的调用器；宿主未提供时返回 undefined
*/
function resolveHostLLM(ctx) {
	const candidates = [
		tryGet(ctx, "llmClient"),
		tryGet(ctx, "llm"),
		tryGet(ctx, "modelClient"),
		tryGet(ctx, "dsh.llm")
	];
	for (const client of candidates) {
		if (!client || typeof client !== "object") continue;
		const host = client;
		const fn = host.chat ?? host.complete ?? host.call;
		if (typeof fn === "function") return async (modelId, messages, options) => normalizeResponse(await fn.call(host, modelId, messages, options), modelId);
	}
}
/**
* 解析宿主模型目录为插件 ModelConfig 列表（不含 Key）。
* @returns 模型配置数组；宿主未提供时返回空数组
*/
function resolveHostModels(ctx) {
	const raw = tryGet(ctx, "llmModels") ?? tryGet(ctx, "models") ?? tryGet(ctx, "dsh.models");
	if (!Array.isArray(raw)) return [];
	const models = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
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
			initialCapabilities: entry.initialCapabilities
		});
	}
	return models;
}
/**
* 解析宿主请求头注入器（DSH 将用户配置的 Key 注入请求头）。
* @returns 按 modelId 返回头部的函数；宿主未提供时返回 undefined
*/
function resolveHeaderProvider(ctx) {
	const direct = tryGet(ctx, "llmHeaderProvider");
	if (typeof direct === "function") return direct;
	const provider = tryGet(ctx, "llmHeaders") ?? tryGet(ctx, "dsh.llmHeaders");
	if (typeof provider === "function") return provider;
	if (provider && typeof provider === "object") {
		const table = provider;
		return (modelId) => {
			const perModel = table[modelId];
			if (perModel && typeof perModel === "object") return perModel;
			if (table.Authorization || table.authorization) return table;
		};
	}
}
/** 厂商识别规则：模型 id 前缀 → 环境变量候选列表 */
const VENDOR_ENV_VARS = [
	{
		match: /^deepseek/i,
		envVars: ["DEEPSEEK_API_KEY"]
	},
	{
		match: /^qwen|^qwq/i,
		envVars: [
			"DASHSCOPE_API_KEY",
			"QWEN_API_KEY",
			"ALIBABA_CLOUD_API_KEY"
		]
	},
	{
		match: /^glm|^chatglm/i,
		envVars: ["ZHIPU_API_KEY", "ZHIPUAI_API_KEY"]
	},
	{
		match: /^moonshot|^kimi/i,
		envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]
	},
	{
		match: /^abab/i,
		envVars: ["MINIMAX_API_KEY"]
	},
	{
		match: /^general|^spark/i,
		envVars: [
			"SPARK_API_KEY",
			"IFLYTEK_API_KEY",
			"XFYUN_API_KEY"
		]
	},
	{
		match: /^hunyuan/i,
		envVars: ["HUNYUAN_API_KEY", "TENCENT_HUNYUAN_API_KEY"]
	},
	{
		match: /^ernie/i,
		envVars: [
			"QIANFAN_API_KEY",
			"ERNIE_API_KEY",
			"BAIDU_API_KEY"
		]
	},
	{
		match: /^sensechat|^sense/i,
		envVars: ["SENSENOVA_API_KEY", "SENSETIME_API_KEY"]
	}
];
/** DSH 本地配置文件探测路径（宿主在本地保存用户 Web UI 配置的常见位置） */
const LOCAL_CONFIG_PATHS = [
	"~/.dsh/config.json",
	"~/.dsh/llm.json",
	"~/.config/dsh/config.json",
	"~/.config/dsh/llm.json",
	"~/.deepseek-harness/config.json"
];
/** 深度优先查找对象中的 apiKey 字段（兼容 models 数组 / 厂商键两种形态） */
function findApiKeyInConfig(obj, modelId) {
	if (!obj || typeof obj !== "object") return void 0;
	if (Array.isArray(obj.models)) {
		for (const entry of obj.models) if (entry?.id === modelId && typeof entry.apiKey === "string" && entry.apiKey) return entry.apiKey;
	}
	const exact = obj[modelId];
	if (typeof exact === "string" && exact) return exact;
	if (exact && typeof exact === "object" && typeof exact.apiKey === "string" && exact.apiKey) return exact.apiKey;
	for (const rule of VENDOR_ENV_VARS) {
		if (!rule.match.test(modelId)) continue;
		for (const vendorKey of rule.envVars[0].replace(/_API_KEY$/, "").toLowerCase().split("_").slice(0, 1)) {
			const entry = obj[vendorKey];
			if (typeof entry === "string" && entry) return entry;
			if (entry && typeof entry === "object" && typeof entry.apiKey === "string" && entry.apiKey) return entry.apiKey;
		}
	}
	if (typeof obj.apiKey === "string" && obj.apiKey) return obj.apiKey;
	if (obj.llm && typeof obj.llm === "object") return findApiKeyInConfig(obj.llm, modelId);
}
/** 本地配置文件发现/缓存状态（支持热更新：mtime 变化自动重读） */
let localConfigCache;
let localConfigPath;
let localConfigMtime = 0;
let localConfigMissAt = 0;
/** 未找到配置文件时的重新探测间隔（Web UI 后续写入也能被感知） */
const LOCAL_CONFIG_RETRY_MS = 6e4;
/** 探测首个可读的本地配置文件路径 */
function discoverLocalConfigPath() {
	for (const rawPath of LOCAL_CONFIG_PATHS) {
		const filePath = rawPath.startsWith("~") ? rawPath.replace("~", os.homedir()) : rawPath;
		try {
			fs.accessSync(filePath, fs.constants.R_OK);
			return filePath;
		} catch {}
	}
	return null;
}
/** 读取本地配置文件（mtime 热更新 + 缺失时定期重探测，失败静默） */
function loadLocalConfig() {
	const now = Date.now();
	if (localConfigPath === void 0) {
		localConfigPath = discoverLocalConfigPath();
		if (!localConfigPath) localConfigMissAt = now;
	} else if (!localConfigPath && now - localConfigMissAt > LOCAL_CONFIG_RETRY_MS) {
		localConfigPath = discoverLocalConfigPath();
		if (!localConfigPath) localConfigMissAt = now;
	}
	if (!localConfigPath) return localConfigCache ?? null;
	try {
		const stat = fs.statSync(localConfigPath);
		if (localConfigCache === void 0 || stat.mtimeMs !== localConfigMtime) {
			localConfigCache = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
			localConfigMtime = stat.mtimeMs;
		}
		return localConfigCache;
	} catch {
		localConfigPath = void 0;
		return localConfigCache ?? null;
	}
}
/**
* 本地密钥候选列表（按优先级排序，支持多密钥故障转移）：
* 1. 进程环境变量（按模型 id 前缀匹配厂商，多个候选变量依次排列）；
* 2. DSH 本地配置文件（~/.dsh/config.json 等，用户在 Web UI 配置的落盘位置）。
* @returns 带来源标记的密钥候选数组（可能为空）
*/
function resolveLocalKeyCandidates(modelId) {
	const candidates = [];
	const rule = VENDOR_ENV_VARS.find((r) => r.match.test(modelId));
	if (rule) for (const envVar of rule.envVars) {
		const value = process.env[envVar];
		if (value) candidates.push({
			source: `env:${envVar}`,
			key: value
		});
	}
	const fileKey = findApiKeyInConfig(loadLocalConfig(), modelId);
	if (fileKey) candidates.push({
		source: "local-config",
		key: fileKey
	});
	return candidates;
}
/**
* 本地密钥提供器：自动从宿主本地来源读取 Key 并填入 Authorization 请求头。
* keyAttempt 用于故障转移：认证/配额失败时 LLMClient 递增 attempt。
* 传入 manager 时启用健康感知路由（按健康度选择 + 冷却规避），
* 否则退化为顺序轮换。密钥只进内存、不落盘、不打印日志。
* @returns 按 (modelId, keyAttempt) 返回请求头的函数
*/
function resolveLocalKeyProvider(manager) {
	return (modelId, keyAttempt = 0) => {
		const candidates = resolveLocalKeyCandidates(modelId);
		if (candidates.length === 0) return void 0;
		const pick = manager ? manager.pick(modelId, keyAttempt, candidates) : candidates[Math.min(keyAttempt, candidates.length - 1)];
		return pick ? { Authorization: `Bearer ${pick.key}` } : void 0;
	};
}
/** 密钥来源可观测性：返回某模型可用的密钥来源标识（不含密钥值） */
function describeKeySources(modelId) {
	return resolveLocalKeyCandidates(modelId).map((c) => c.source);
}
/**
* 密钥健康管理器：把"顺序轮换"升级为"健康感知路由"。
* - 用户顺序：用户可通过 setKeyOrder 指定密钥来源优先级（持久化，重启保留）；
* - 选择策略：用户序优先 → 冷却规避 → 失败次数少 → 成功次数多；
* - 冷却策略：429（配额/限流）冷却 1 分钟，401/403（认证）冷却 5 分钟；
* - 成功即清零失败计数并解除冷却；
* - 并发安全：按 (modelId, attempt) 记录每次选择，失败结果精确归因到所用密钥。
*/
var KeyHealthManager = class {
	cooldownMs;
	health = /* @__PURE__ */ new Map();
	lastPicks = /* @__PURE__ */ new Map();
	/** 用户自定义密钥来源优先级（来源标识数组，靠前优先） */
	userOrder = [];
	persistPath;
	constructor(cooldownMs = 6e4, persistPath) {
		this.cooldownMs = cooldownMs;
		this.persistPath = persistPath;
		if (persistPath) this.loadOrder();
	}
	/** 设置用户密钥顺序（持久化） */
	setKeyOrder(order) {
		this.userOrder = [...order];
		this.saveOrder();
	}
	/** 获取当前用户密钥顺序 */
	getKeyOrder() {
		return [...this.userOrder];
	}
	/** 清除用户顺序，恢复默认（环境变量序 → 本地配置） */
	clearKeyOrder() {
		this.userOrder = [];
		this.saveOrder();
	}
	loadOrder() {
		try {
			const parsed = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
			if (Array.isArray(parsed.order)) this.userOrder = parsed.order.filter((s) => typeof s === "string");
		} catch {}
	}
	saveOrder() {
		if (!this.persistPath) return;
		try {
			fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
			fs.writeFileSync(this.persistPath, JSON.stringify({ order: this.userOrder }, null, 2));
		} catch {}
	}
	entry(source) {
		let e = this.health.get(source);
		if (!e) {
			e = {
				source,
				successes: 0,
				failures: 0,
				coolingDown: false,
				cooldownRemainingMs: 0,
				cooldownUntil: 0
			};
			this.health.set(source, e);
		}
		return e;
	}
	/** 为某次调用选择最优候选密钥（用户序优先，冷却规避；attempt>0 时排除上一次刚失败的来源） */
	pick(modelId, attempt, candidates) {
		if (candidates.length === 0) return void 0;
		const now = Date.now();
		const prev = attempt > 0 ? this.lastPicks.get(`${modelId}#${attempt - 1}`) : void 0;
		const orderIndex = (source) => {
			const idx = this.userOrder.indexOf(source);
			return idx === -1 ? this.userOrder.length : idx;
		};
		const scored = candidates.map((c) => ({
			...c,
			h: this.entry(c.source)
		}));
		const rank = (x) => (x.h.cooldownUntil <= now ? 0 : 1) * 1e4 + orderIndex(x.source) * 100 + x.h.failures - Math.min(x.h.successes, 100) / 1e3;
		const rotated = scored.filter((c) => c.source !== prev);
		const pool = rotated.length > 0 ? rotated : scored;
		pool.sort((a, b) => rank(a) - rank(b));
		const chosen = pool[0];
		this.lastPicks.set(`${modelId}#${attempt}`, chosen.source);
		return {
			source: chosen.source,
			key: chosen.key
		};
	}
	/** 上报调用结果：成功清零失败；429/401/403 进入冷却 */
	recordOutcome(modelId, attempt, success, status) {
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
	status() {
		const now = Date.now();
		return [...this.health.values()].map((e) => ({
			source: e.source,
			successes: e.successes,
			failures: e.failures,
			coolingDown: e.cooldownUntil > now,
			cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
			lastErrorStatus: e.lastErrorStatus
		}));
	}
};
//#endregion
//#region src/index.ts
/**
* index.ts — dsh-proactive 核心插件入口（集成层）
*
* 职责：整合全部 9 个模块，编排"信号 → 决策 → 执行 → 沉淀"10 步链路
*
* 10 步链路（新架构单向数据流：记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新）：
* 1. 信号接入（Sentinel：webhook / 文件监听 / 轮询 / 手动注入）
* 2. 信号聚合（Sentinel 聚合窗口去重合并）
* 3. 优先级排序（strategist 模型紧急度评估，urgency 降序）
* 4. 战略决策（execute / defer / dismiss / ask-user）
* 5. 经验检索（Optimizer.lookupExperience → 记忆库模糊匹配 + 推荐模型）
* 6. 计划生成（Optimizer.recallPlan 快路径 / TaskExecutor.buildPlan：strategist DAG + 离线兜底）
* 7. 并行执行（TaskExecutor.executePlan：拓扑分层并行，ModelScheduler 推荐模型参与调度）
* 8. 质量反思（quality < threshold 自动重试 / 切换模型）
* 9. 级联触发（节点完成触发下游信号，回注 Sentinel）
* 10. 反思与记忆更新（Reflector.reflectOnOutcome：沉淀 + 策略反馈 + 蒸馏 + 同步变更登记）
*
* 14 个 Tool 通过 ToolRegistry 服务注册并经 ctx.provide('schedulerTools') 暴露。
* 自主智能层（目标引擎 / 元认知 / 策略进化 / 心跳循环）使系统在无外部信号时
* 也能自我观察、自我改进、自我进化。
* 全部资源在 fiber 卸载时按依赖逆序清理（cleanup）。
*/
/** Tool 调用错误 */
var ToolError = class extends AppError {
	constructor(message, details) {
		super(message, "TOOL_ERROR", details);
	}
};
/**
* Tool 注册表服务
*
* cordis 核心未内置 Tool API，本插件以 provide('schedulerTools') 形式
* 向宿主暴露 12 个 Tool 的注册、发现与调用能力。
*/
var ToolRegistry = class {
	tools = /* @__PURE__ */ new Map();
	/** 注册一个 Tool（重名覆盖） */
	register(tool) {
		this.tools.set(tool.name, tool);
	}
	/** 注销一个 Tool */
	unregister(name) {
		return this.tools.delete(name);
	}
	/** 获取 Tool 定义 */
	get(name) {
		return this.tools.get(name);
	}
	/** 列出全部 Tool（不含 handler） */
	list() {
		return [...this.tools.values()].map(({ name, description, parameters }) => ({
			name,
			description,
			parameters
		}));
	}
	/** 调用 Tool（未知名称抛 ToolError） */
	async invoke(name, args = {}) {
		const tool = this.tools.get(name);
		if (!tool) throw new ToolError(`未知 Tool: ${name}`);
		return tool.handler(args ?? {});
	}
};
/**
* 将内部 Tool 参数声明转换为官方 JSON Schema 子集（dsh-tools 强制子集：
* object 根 + properties/required/additionalProperties + 标量 enum）。
*/
function toJsonSchemaParameters(parameters) {
	const properties = {};
	const required = [];
	for (const [key, spec] of Object.entries(parameters)) {
		const node = { description: spec.description };
		switch (spec.type) {
			case "number":
				node.type = "number";
				break;
			case "boolean":
				node.type = "boolean";
				break;
			case "array":
				node.type = "array";
				break;
			case "object":
				node.type = "object";
				node.additionalProperties = true;
				break;
			default: node.type = "string";
		}
		if (spec.enum && spec.enum.length > 0) node.enum = [...spec.enum];
		properties[key] = node;
		if (spec.required) required.push(key);
	}
	const schema = {
		type: "object",
		properties,
		additionalProperties: true
	};
	if (required.length > 0) schema.required = required;
	return schema;
}
const DEFAULT_CONFIG = {
	qualityThreshold: .7,
	maxRetries: 2,
	globalTimeout: 3e5,
	enableProgress: true,
	progressPort: 9877,
	verbose: false,
	experienceStorePath: ".scheduler/memory.json"
};
/**
* 插件配置 schema（cordis Plugin.Base.Config）。
* 经 ctx.plugin() 加载时由 cordis resolveConfig 自动校验并填充默认值；
* 函数型注入字段（nodeRunner / judge / llm.fetchImpl 等）不在 schema 中声明，
* 作为额外属性透传，不受校验影响。
*/
const Config = Schema.object({
	strategistModel: Schema.object({
		id: Schema.string(),
		endpoint: Schema.string(),
		apiKey: Schema.string()
	}),
	models: Schema.array(Schema.any()),
	sentinel: Schema.object({
		watchCodeChanges: Schema.boolean().default(true),
		watchErrors: Schema.boolean().default(true),
		watchPerformance: Schema.boolean().default(true),
		aggregationWindow: Schema.number().min(0).default(.5),
		signalSources: Schema.array(Schema.any())
	}).default({}),
	qualityThreshold: Schema.percent().default(.7),
	maxRetries: Schema.natural().default(2),
	globalTimeout: Schema.natural().default(3e5),
	enableProgress: Schema.boolean().default(true),
	progressPort: Schema.natural().default(9877),
	verbose: Schema.boolean().default(false),
	experienceStorePath: Schema.string().default(".scheduler/memory.json"),
	encryption: Schema.object({
		enabled: Schema.boolean().default(false),
		masterKey: Schema.string(),
		algorithm: Schema.union([Schema.const("aes-256-gcm"), Schema.const("aes-256-cbc")]).default("aes-256-gcm"),
		fullFileEncryption: Schema.boolean().default(true)
	}).default({}),
	sync: Schema.object({
		localNodeId: Schema.string().default("node-dev-01"),
		peers: Schema.array(Schema.any()).default([])
	}).default({}),
	consensus: Schema.object({
		enabled: Schema.boolean().default(false),
		localNodeId: Schema.string().default("node-01"),
		consensusPort: Schema.natural().default(9880),
		electionTimeoutMin: Schema.natural().default(1500),
		electionTimeoutMax: Schema.natural().default(3e3),
		heartbeatInterval: Schema.natural().default(500),
		cluster: Schema.array(Schema.any()).default([])
	}).default({}),
	hotReload: Schema.object({
		enabled: Schema.boolean().default(false),
		watchDirs: Schema.array(Schema.string()).default(["src"]),
		watchExtensions: Schema.array(Schema.string()).default([
			".ts",
			".tsx",
			".js"
		]),
		debounceMs: Schema.natural().default(1e3),
		buildCommand: Schema.string().default("npm run build"),
		autoRollback: Schema.boolean().default(true)
	}).default({}),
	tenants: Schema.array(Schema.any()).default([]),
	dataDir: Schema.string(),
	memoryFastPathThreshold: Schema.number().min(0),
	autonomy: Schema.object({
		enabled: Schema.boolean().default(true),
		heartbeatMs: Schema.natural().default(3e4)
	}).default({}),
	hostFusion: Schema.object({
		enabled: Schema.boolean().default(true),
		observeToolResults: Schema.boolean().default(true),
		governToolCalls: Schema.boolean().default(true),
		failureEscalationThreshold: Schema.natural().min(1).default(3)
	}).default({})
});
/** 插件名称 */
const name = "dsh-proactive";
/**
* 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
*/
function apply(ctx, config) {
	const cfg = {
		...DEFAULT_CONFIG,
		...config
	};
	if (cfg.strategistModel && (cfg.strategistModel.id || cfg.strategistModel.endpoint)) {
		if (!cfg.strategistModel.id || !cfg.strategistModel.endpoint) throw new ConfigError("strategistModel 配置不完整：指定时需同时提供 id 与 endpoint");
	} else cfg.strategistModel = void 0;
	const hostChat = resolveHostLLM(ctx);
	const hostModels = resolveHostModels(ctx);
	const ctxHeaderProvider = resolveHeaderProvider(ctx);
	const keyHealth = new KeyHealthManager(6e4, path.join(path.dirname(cfg.experienceStorePath), "key-order.json"));
	const localKeyProvider = resolveLocalKeyProvider(keyHealth);
	const headerProvider = (modelId, keyAttempt = 0) => (keyAttempt === 0 ? ctxHeaderProvider?.(modelId) : void 0) ?? localKeyProvider(modelId, keyAttempt);
	const mergedModels = [...hostModels];
	for (const model of cfg.models ?? []) if (!mergedModels.some((m) => m.id === model.id)) mergedModels.push(model);
	if (!hostChat && mergedModels.length === 0) throw new ConfigError("无可用模型：DSH 宿主未提供模型目录（ctx），且配置缺少 models 列表");
	const logger = ctx.logger("scheduler");
	const dataDir = path.resolve(cfg.dataDir ?? ".scheduler");
	fs.mkdirSync(dataDir, { recursive: true });
	const cryptoEngine = cfg.encryption?.enabled ? new CryptoEngine({
		enabled: true,
		masterKey: cfg.encryption.masterKey ?? CryptoEngine.generateKey(),
		algorithm: cfg.encryption.algorithm ?? "aes-256-gcm",
		sensitiveFields: [
			"apiKey",
			"masterKey",
			"token"
		],
		fullFileEncryption: cfg.encryption.fullFileEncryption ?? true
	}) : null;
	const memoryPath = path.resolve(cfg.experienceStorePath);
	fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
	const memory = new LongTermMemory(memoryPath, cryptoEngine ?? void 0);
	const memoryGraph = new MemoryGraph(path.join(path.dirname(memoryPath), "memory-graph.json"));
	let broadcaster = null;
	if (cfg.enableProgress) broadcaster = new ProgressBroadcaster(cfg.progressPort);
	const llm = new LLMClient({
		timeout: cfg.llm?.timeout ?? 6e4,
		maxRetries: cfg.maxRetries,
		fetchImpl: cfg.llm?.fetchImpl,
		headerProvider,
		onKeyOutcome: (modelId, keyAttempt, success, status) => keyHealth.recordOutcome(modelId, keyAttempt, success, status),
		externalChat: hostChat
	});
	for (const model of mergedModels) llm.registerModel(model);
	if (cfg.strategistModel && !llm.getModel(cfg.strategistModel.id)) llm.registerModel({
		id: cfg.strategistModel.id,
		endpoint: cfg.strategistModel.endpoint,
		apiKey: cfg.strategistModel.apiKey
	});
	const strategistId = cfg.strategistModel?.id ?? mergedModels[0]?.id ?? llm.getModelIds()[0];
	if (hostChat) logger.info("LLM 调用已委托给 DSH 宿主客户端（Key 由宿主注入）");
	else logger.info("模型 Key 自动经请求头注入（优先级：宿主 ctx → 本地环境变量 → 本地配置文件，认证失败自动轮换）");
	for (const model of mergedModels) {
		const sources = describeKeySources(model.id);
		if (sources.length > 0) logger.info("模型 %s 密钥来源: %s", model.id, sources.join(", "));
	}
	const tenantManager = new TenantManager(path.join(dataDir, "tenants"), cryptoEngine ?? void 0);
	const benchmark = new BenchmarkEngine(path.join(dataDir, "benchmarks"));
	const migrationTool = new MigrationTool(cfg.sync?.localNodeId ?? "node-dev-01");
	const sync = new DistributedSync(cfg.sync?.localNodeId ?? "node-dev-01", memory, path.join(dataDir, "sync-state.json"), cryptoEngine);
	for (const peer of cfg.sync?.peers ?? []) sync.registerNode(peer);
	let raft = null;
	if (cfg.consensus?.enabled) raft = new RaftEngine({
		localNodeId: cfg.consensus.localNodeId,
		cluster: cfg.consensus.cluster ?? [],
		electionTimeoutMin: cfg.consensus.electionTimeoutMin ?? 1500,
		electionTimeoutMax: cfg.consensus.electionTimeoutMax ?? 3e3,
		heartbeatInterval: cfg.consensus.heartbeatInterval ?? 500,
		consensusPort: cfg.consensus.consensusPort ?? 9880,
		logPath: path.join(dataDir, "raft-log.json")
	});
	let hotReload = null;
	if (cfg.hotReload?.enabled) hotReload = new HotReloadEngine({
		enabled: true,
		watchDirs: cfg.hotReload.watchDirs ?? ["src"],
		watchExtensions: cfg.hotReload.watchExtensions ?? [
			".ts",
			".tsx",
			".js"
		],
		debounceMs: cfg.hotReload.debounceMs ?? 1e3,
		buildCommand: cfg.hotReload.buildCommand ?? "npm run build",
		distDir: cfg.hotReload.distDir ?? "dist",
		entryFile: cfg.hotReload.entryFile ?? "index.js",
		maxVersionHistory: cfg.hotReload.maxVersionHistory ?? 5,
		gracefulShutdownTimeout: cfg.hotReload.gracefulShutdownTimeout ?? 1e4,
		versionsDir: cfg.hotReload.versionsDir ?? path.join(dataDir, "versions"),
		autoRollback: cfg.hotReload.autoRollback ?? true
	});
	const reflectionEngine = new ReflectionEngine({
		qualityThreshold: cfg.qualityThreshold,
		...cfg.reflection,
		judge: cfg.judge,
		lessonExtractor: cfg.lessonExtractor
	});
	reflectionEngine.setAlertHandler((alert) => {
		broadcast({
			type: "quality-alert",
			alertType: alert.type,
			message: alert.message,
			taskType: alert.taskType
		});
		logger.warn("质量告警: %s", alert.message);
	});
	const optimizer = new Optimizer({
		memory,
		config: { memoryFastPathThreshold: cfg.memoryFastPathThreshold },
		broadcaster: broadcaster ?? void 0,
		graph: memoryGraph,
		policyProvider: () => modelScheduler.getPolicy()
	});
	const decisionEngine = new DecisionEngine({
		...cfg.decision,
		strategist: async (signals, history) => {
			const { data } = await llm.chatJSON(strategistId, [{
				role: "system",
				content: "你是调度系统的战略决策器。对每个信号评估紧急度(0~1)并决策: execute/defer/dismiss/ask-user。仅输出 JSON 数组。"
			}, {
				role: "user",
				content: JSON.stringify({
					signals: signals.map((s) => ({
						id: s.id,
						type: s.type,
						description: s.description,
						occurrences: s.occurrences,
						urgency: s.urgency
					})),
					history: Object.fromEntries(history)
				})
			}], {
				timeout: 3e4,
				maxRetries: 1
			});
			const verdicts = /* @__PURE__ */ new Map();
			if (Array.isArray(data)) {
				for (const item of data) if (item && typeof item.id === "string") verdicts.set(item.id, {
					urgency: Math.max(0, Math.min(1, Number(item.urgency) || .5)),
					decision: [
						"execute",
						"defer",
						"dismiss",
						"ask-user"
					].includes(item.decision) ? item.decision : "execute",
					reason: item.reason,
					deferMs: typeof item.deferMs === "number" ? item.deferMs : void 0
				});
			}
			return verdicts;
		}
	});
	const schedulingFeedbackEnabled = cfg.autonomy?.symbiosis?.enabled === true && (cfg.autonomy?.symbiosis?.schedulingFeedback?.enabled ?? false);
	const modelScheduler = new ModelScheduler({
		llm,
		memory,
		config: {
			costWeight: .2,
			economicFeedbackEnabled: schedulingFeedbackEnabled
		}
	});
	const policyEvolutionEnabled = cfg.autonomy?.policyEvolution?.enabled ?? true;
	/** 金丝雀喂数游标：仅消费尚未回报过的决策反馈（增量喂数） */
	let lastCanaryFeedAt = 0;
	const knownTaskTypes = () => [...new Set(memory.getAllTaskPatterns().map((p) => p.fingerprint.split("::")[0]))].filter(Boolean);
	const buildSandboxTaskSet = () => [...extractReplayTasks(memory), ...generateAdversarialTasks(knownTaskTypes())];
	const mapSimModels = () => llm.getModelStatuses().map((s) => ({
		id: s.id,
		taskScores: s.taskScores,
		avgLatencyMs: s.avgLatency > 0 ? s.avgLatency : 800,
		avgTokens: s.totalCalls > 0 ? s.totalTokensUsed / s.totalCalls : 600,
		maxConcurrency: s.maxConcurrency
	}));
	const policySandbox = new Sandbox({
		models: mapSimModels(),
		tasks: buildSandboxTaskSet(),
		config: {
			...cfg.autonomy?.policyEvolution?.sandbox,
			calibration: buildCalibrationFromMemory(memory)
		}
	});
	const policyEvolver = new PolicyEvolver({
		...cfg.autonomy?.policyEvolution,
		knownTaskTypes: knownTaskTypes(),
		persistPath: path.join(dataDir, "policy-evolution.json"),
		onDeploy: (policy) => {
			modelScheduler.updatePolicy(policy);
			broadcast({
				type: "policy-deployed",
				policyId: policy.id,
				version: policy.version,
				generation: policy.generation,
				origin: policy.origin,
				params: policy.params
			});
			logger.info("策略进化部署: %s@v%d（第 %d 代，来源 %s）已热切换到操作环", policy.id, policy.version, policy.generation, policy.origin);
		},
		onCanaryDecision: (decision) => {
			broadcast({
				type: "policy-canary",
				...decision
			});
			logger[decision.action === "rolled-back" ? "warn" : "info"]("金丝雀[%s]: 策略 %s → %s（%s）", decision.action, decision.policyId, decision.action === "rolled-back" ? "自动回滚前一策略" : "晋升正式", decision.reason);
		},
		onCycle: (cycle) => {
			broadcast({
				type: "policy-evolution-cycle",
				...cycle
			});
		}
	});
	const taskExecutor = new TaskExecutor({
		config: {
			qualityThreshold: cfg.qualityThreshold,
			maxRetries: cfg.maxRetries,
			globalTimeout: cfg.globalTimeout,
			nodeTimeout: Math.min(12e4, cfg.globalTimeout),
			enableProgress: cfg.enableProgress,
			verbose: cfg.verbose,
			circuitFailureThreshold: 5,
			circuitCooldownMs: 6e4,
			retryBackoffBaseMs: 200,
			retryBackoffMaxMs: 8e3
		},
		llm,
		modelScheduler,
		broadcaster: broadcaster ?? void 0,
		nodeRunner: cfg.nodeRunner,
		reflection: reflectionEngine,
		cascadeHandler: (newSignal) => {
			sentinel.ingest({
				...newSignal,
				source: "cascade"
			});
		}
	});
	const reflector = new Reflector({
		memory,
		reflection: reflectionEngine,
		graph: memoryGraph,
		config: {
			enableProgress: cfg.enableProgress,
			onLesson: (lesson) => logger.info("教训沉淀 [%s]: %s", lesson.rootCause, lesson.lesson),
			onDistilled: (fresh) => logger.info("经验蒸馏产出 %d 条策略", fresh.length),
			onKnowledgeDistilled: (report) => logger.info("知识蒸馏: 语义 %d 条 / 程序 %d 条 / 策略 %d 条（来源情景 %d）%s", report.semanticMemories.length, report.proceduralMemories.length, report.strategies.length, report.sourceEpisodicCount, report.skipped ? `— ${report.summary}` : (report.mergedSemanticCount ?? 0) + (report.mergedProceduralCount ?? 0) + (report.supersededCount ?? 0) > 0 ? `— 合并增强 语义${report.mergedSemanticCount ?? 0}/程序${report.mergedProceduralCount ?? 0}，冲突取代 ${report.supersededCount ?? 0}` : "")
		},
		broadcaster: broadcaster ?? void 0,
		onMemoryChange: (type, fingerprint, payload) => {
			sync.recordChange(type, fingerprint, payload);
		}
	});
	const sentinel = new Sentinel({
		watchCodeChanges: cfg.sentinel?.watchCodeChanges ?? true,
		watchErrors: cfg.sentinel?.watchErrors ?? true,
		watchPerformance: cfg.sentinel?.watchPerformance ?? true,
		aggregationWindow: cfg.sentinel?.aggregationWindow ?? .5,
		signalSources: cfg.sentinel?.signalSources,
		watchDir: process.cwd()
	}, (batch) => void processBatch(batch));
	const metaLayerEnabled = cfg.autonomy?.metaLayer?.enabled ?? true;
	/**
	* 2.0 稳态目标带（自我建模与元认知控制器共享）：
	* 配置后自我建模在心智报告中输出稳态带状态（in/near/out-of-band），
	* 元认知控制器据此自适应调整步长（偏离越远步长越大，量化档位）。
	*/
	const DEFAULT_HOMEOSTASIS_BANDS = {
		operationalSuccessRate: {
			min: .8,
			max: .95
		},
		discoveryRate: {
			min: .1,
			max: .3
		},
		survivalRate: {
			min: .7,
			max: 1
		}
	};
	const selfModel = new SelfModel({
		collectors: {
			getEvolverStatus: () => policyEvolver.getStatus(),
			getMemoryStats: () => memory.dbStats(),
			getGlobalStats: () => memory.getGlobalStats(),
			getDistillationProgress: () => memory.getDistillationProgress?.(),
			getRecentFeedback: (limit) => memory.getRecentFeedback(limit),
			getMetaLayerState: () => {
				if (!metaLayerEnabled) return void 0;
				const state = metaController.getState();
				return {
					knobEffectiveness: state.learner.effectiveness,
					metaStability: {
						circuitBreakers: state.circuitBreakers,
						globalFrozen: state.frozen,
						frozenByBreaker: state.frozenByBreaker,
						safeEnvelopes: state.safeEnvelopes,
						learner: {
							totalTrials: state.learner.totalTrials,
							arms: state.learner.arms,
							explorationWeight: state.learner.explorationWeight
						}
					}
				};
			}
		},
		config: {
			homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
			...cfg.autonomy?.metaLayer?.selfModel,
			persistPath: path.join(dataDir, "self-model-reports.json")
		}
	});
	const metaController = new MetaCognitiveController({
		selfModel,
		knobs: [
			{
				id: "reflector.autoDistillThreshold",
				label: "反思器自动蒸馏阈值",
				category: "reflector",
				min: 2,
				max: 20,
				step: 1,
				integer: true,
				read: () => reflector.getConfig().autoDistillThreshold ?? 5,
				write: (v) => reflector.updateConfig({ autoDistillThreshold: v }),
				judgeMetric: "pendingDistillation",
				higherIsBetter: false
			},
			{
				id: "reflector.distillMinConfidence",
				label: "知识蒸馏写入置信度门槛",
				category: "reflector",
				min: .4,
				max: .8,
				step: .05,
				read: () => reflector.getConfig().distillMinConfidence ?? .6,
				write: (v) => reflector.updateConfig({ distillMinConfidence: v }),
				judgeMetric: "proceduralGrowth",
				higherIsBetter: true
			},
			{
				id: "evolver.mutationRate",
				label: "进化器变异率",
				category: "evolver",
				min: .2,
				max: .9,
				step: .1,
				read: () => policyEvolver.getTunableParams().mutationRate,
				write: (v) => policyEvolver.updateConfig({ mutationRate: v }),
				judgeMetric: "discoveryRate",
				higherIsBetter: true
			},
			{
				id: "evolver.minGain",
				label: "进化器部署门禁（选择压力）",
				category: "evolver",
				min: .001,
				max: .05,
				step: .005,
				read: () => policyEvolver.getTunableParams().minGain,
				write: (v) => policyEvolver.updateConfig({ minGain: v }),
				judgeMetric: "survivalRate",
				higherIsBetter: true
			},
			{
				id: "sandbox.evaluationSeeds",
				label: "沙盒多种子评估严格度",
				category: "sandbox",
				min: 1,
				max: 7,
				step: 1,
				integer: true,
				read: () => policySandbox.getConfig().evaluationSeeds ?? 3,
				write: (v) => policySandbox.updateConfig({ evaluationSeeds: v }),
				judgeMetric: "survivalRate",
				higherIsBetter: true
			},
			{
				id: "optimizer.memoryFastPathThreshold",
				label: "记忆快路径复用门槛",
				category: "memory",
				min: .7,
				max: .95,
				step: .05,
				read: () => optimizer.getConfig().memoryFastPathThreshold ?? .9,
				write: (v) => optimizer.updateConfig({ memoryFastPathThreshold: v }),
				judgeMetric: "operationalSuccessRate",
				higherIsBetter: true
			}
		],
		config: {
			homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
			maxStepMultiplier: 3,
			breakerThreshold: 2,
			globalBreakerThreshold: 3,
			proactiveEnabled: true,
			...cfg.autonomy?.metaLayer?.controller,
			persistPath: path.join(dataDir, "meta-controller-audit.json"),
			onAdjust: (entry) => {
				const { type: _kind, ...rest } = entry;
				broadcast({
					type: "meta-adjusted",
					...rest
				});
				logger.info("元认知调整: %s %s → %s（%s）", entry.knob ?? "", entry.from ?? "", entry.to ?? "", entry.reason);
			},
			onCommit: (entry) => {
				const { type: _kind, ...rest } = entry;
				broadcast({
					type: "meta-committed",
					...rest
				});
				logger.info("元认知判定保留: %s（%s）", entry.knob ?? "", entry.reason);
			},
			onRollback: (entry) => {
				const { type: _kind, ...rest } = entry;
				broadcast({
					type: "meta-rollback",
					...rest
				});
				logger.warn("元认知回滚: %s %s → %s（%s）", entry.knob ?? "", entry.from ?? "", entry.to ?? "", entry.reason);
			}
		}
	});
	/** 延迟队列（defer 决策的信号） */
	const deferredQueue = [];
	const autonomyEnabled = cfg.autonomy?.enabled ?? true;
	const goalEngine = new GoalEngine({
		...cfg.autonomy?.goal,
		decomposer: cfg.autonomy?.decomposer
	});
	const metaCognition = new MetaCognitionEngine({
		...cfg.autonomy?.metaCognition,
		applier: (action) => {
			if (action.parameter === "qualityThreshold") {
				reflectionEngine.setQualityThreshold(action.to);
				taskExecutor.updateConfig({ qualityThreshold: action.to });
			} else if (action.parameter === "maxRetries") taskExecutor.updateConfig({ maxRetries: action.to });
			else if (action.parameter === "aggregationWindow") {}
			broadcast({
				type: "meta-tuning",
				parameter: action.parameter,
				from: action.from,
				to: action.to,
				reason: action.reason
			});
			logger.info("元认知自调优: %s %s → %s（%s）", action.parameter, action.from, action.to, action.reason);
		}
	});
	const strategyEvolution = new StrategyEvolutionEngine({ ...cfg.autonomy?.evolution });
	const worldModel = new WorldModel(cfg.autonomy?.worldModel);
	const causalKernel = new CausalKernel(cfg.autonomy?.causalKernel);
	worldModel.attachCausalKernel(causalKernel);
	reflectionEngine.attachCausalKernel(causalKernel);
	metaCognition.attachCausalKernel(causalKernel);
	const curiosity = new CuriosityEngine({
		getExposure() {
			const exposure = {};
			for (const item of worldModel.getSummary().types) exposure[item.type] = item.totalCount;
			return exposure;
		},
		getExperienceCounts() {
			const counts = {};
			for (const pattern of memory.getAllTaskPatterns()) {
				const taskType = pattern.taskSummary.split(":")[0];
				counts[taskType] = (counts[taskType] ?? 0) + pattern.successfulPlans.length;
			}
			return counts;
		},
		getFailureRates() {
			const rates = {};
			for (const pattern of memory.getAllTaskPatterns()) {
				const taskType = pattern.taskSummary.split(":")[0];
				const total = pattern.successfulPlans.length + pattern.failureRecords.length;
				const rate = total > 0 ? pattern.failureRecords.length / total : 0;
				rates[taskType] = Math.max(rates[taskType] ?? 0, rate);
			}
			return rates;
		}
	}, cfg.autonomy?.curiosity);
	curiosity.attachCausalKernel(causalKernel);
	const activeInferenceEnabled = cfg.autonomy?.activeInference?.enabled === true;
	const freeEnergyEngine = new FreeEnergyEngine({ epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight });
	metaCognition.attachFreeEnergyEngine(freeEnergyEngine);
	const deliberationEngine = new DeliberationEngine({ epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight }, freeEnergyEngine);
	metaCognition.attachDeliberationEngine(deliberationEngine);
	optimizer.attachDeliberation(deliberationEngine);
	const metareasoner = new RationalMetareasoner(deliberationEngine, {
		decisivenessGap: cfg.autonomy?.metareasoning?.decisivenessGap,
		sufficientEvidence: cfg.autonomy?.metareasoning?.sufficientEvidence,
		habitPromotionSuccesses: cfg.autonomy?.metareasoning?.habitPromotionSuccesses,
		maxDepth: cfg.autonomy?.metareasoning?.maxDepth,
		natPerNode: cfg.autonomy?.metareasoning?.natPerNode,
		budgetNat: cfg.autonomy?.metareasoning?.budgetNat
	});
	metaCognition.attachMetareasoner(metareasoner);
	optimizer.attachMetareasoner(metareasoner);
	if (cfg.autonomy?.abstraction?.enabled === true) {
		const abstractionEngine = new AbstractionEngine({
			analogyStrength: cfg.autonomy?.abstraction?.analogyStrength,
			minSimilarity: cfg.autonomy?.abstraction?.minSimilarity,
			abstractSkillDomains: cfg.autonomy?.abstraction?.abstractSkillDomains
		});
		deliberationEngine.attachAbstraction(abstractionEngine);
		metaCognition.attachAbstractionEngine(abstractionEngine);
	}
	let scientistAutoRegister = false;
	const scientistCfg = cfg.autonomy?.scientist;
	const scientistMind = scientistCfg?.enabled === true ? new ScientistMind(causalKernel, freeEnergyEngine, {
		defaultCostNat: scientistCfg.defaultCostNat,
		maxConfoundingBonus: scientistCfg.maxConfoundingBonus,
		lawBonusCap: scientistCfg.lawBonusCap
	}) : void 0;
	if (scientistMind) {
		metaCognition.attachScientistMind(scientistMind);
		curiosity.attachScientistMind(scientistMind);
		scientistAutoRegister = scientistCfg?.autoRegisterQuestions === true;
	}
	const theoristCfg = cfg.autonomy?.theorist;
	const theoristEngine = theoristCfg?.enabled === true ? new TheoristEngine(causalKernel, {
		minMembers: theoristCfg.minMembers,
		zeroShotMaxArmSamples: theoristCfg.zeroShotMaxArmSamples
	}) : void 0;
	if (theoristEngine) {
		metaCognition.attachTheoristEngine(theoristEngine);
		scientistMind?.attachTheorist(theoristEngine);
	}
	if (activeInferenceEnabled) {
		modelScheduler.attachFreeEnergy(freeEnergyEngine);
		modelScheduler.updateConfig({
			freeEnergyEnabled: true,
			freeEnergyPreference: cfg.autonomy?.activeInference?.schedulingPreference
		});
	}
	const governor = new SafetyGovernor(cfg.autonomy?.governor);
	/** KPI 采集器：从真实引擎状态聚合 KPI 快照 */
	const collectKpi = () => {
		const modelStatuses = llm.getModelStatuses();
		const modelSuccessRates = {};
		let activeExecutions = 0;
		for (const status of modelStatuses) {
			modelSuccessRates[status.id] = status.totalCalls > 0 ? status.successCount / status.totalCalls : 1;
			activeExecutions += status.activeRequests;
		}
		const globalStats = memory.getGlobalStats();
		const decisionStats = decisionEngine.getStats();
		return {
			timestamp: Date.now(),
			successRate: globalStats.totalExecutions > 0 ? globalStats.totalSuccesses / globalStats.totalExecutions : 1,
			avgQuality: globalStats.averageQualityScore,
			avgLatency: globalStats.averageExecutionTime,
			cacheHitRate: decisionStats.cacheHitRate ?? 0,
			modelSuccessRates,
			activeExecutions
		};
	};
	const symbiosisEnabled = cfg.autonomy?.symbiosis?.enabled ?? false;
	const futarchyEnabled = symbiosisEnabled && (cfg.autonomy?.symbiosis?.futarchy?.enabled ?? false);
	const sankeyPath = symbiosisEnabled ? cfg.autonomy?.symbiosis?.observability?.sankeyPath : void 0;
	const sankeyEveryNTicks = cfg.autonomy?.symbiosis?.observability?.everyNTicks ?? 5;
	let symbiosisTickCount = 0;
	const symbiosisBridge = symbiosisEnabled ? new SymbiosisBridge({
		beliefHorizonTicks: cfg.autonomy?.symbiosis?.beliefHorizonTicks,
		globalSuccessThreshold: cfg.autonomy?.symbiosis?.globalSuccessThreshold,
		modelSuccessThreshold: cfg.autonomy?.symbiosis?.modelSuccessThreshold,
		modelBetBudget: cfg.autonomy?.symbiosis?.modelBetBudget,
		divergenceMargin: cfg.autonomy?.symbiosis?.divergenceMargin,
		futarchy: {
			enabled: futarchyEnabled,
			minImpliedProb: cfg.autonomy?.symbiosis?.futarchy?.minImpliedProb,
			decisionB: cfg.autonomy?.symbiosis?.futarchy?.decisionB,
			evolutionCost: cfg.autonomy?.symbiosis?.futarchy?.evolutionCost,
			evolutionBalanceThreshold: cfg.autonomy?.symbiosis?.futarchy?.evolutionBalanceThreshold,
			selfBetBudget: cfg.autonomy?.symbiosis?.futarchy?.selfBetBudget
		},
		economic: {
			reputationWeight: cfg.autonomy?.symbiosis?.schedulingFeedback?.reputationWeight,
			minMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.minMultiplier,
			maxMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.maxMultiplier,
			neutralHealth: cfg.autonomy?.symbiosis?.schedulingFeedback?.neutralHealth,
			balanceBaseline: cfg.autonomy?.symbiosis?.schedulingFeedback?.balanceBaseline
		},
		runtime: {
			causalKernel,
			freeEnergy: freeEnergyEngine,
			...scientistMind && scientistAutoRegister ? { scientist: scientistMind } : {}
		}
	}, { checkGate: () => governor.checkGate() }) : void 0;
	if (symbiosisBridge) {
		for (const model of mergedModels) symbiosisBridge.registerModel(model.id);
		const agentsCfg = cfg.autonomy?.symbiosis?.agents;
		const attached = [];
		if (agentsCfg?.memory?.enabled) {
			symbiosisBridge.attachMemory(memory, {
				listingBasePrice: agentsCfg.memory.listingBasePrice,
				listingConfidenceThreshold: agentsCfg.memory.listingConfidenceThreshold,
				listingFrequencyThreshold: agentsCfg.memory.listingFrequencyThreshold,
				maintenanceInterval: agentsCfg.memory.maintenanceInterval
			});
			attached.push("memory");
		}
		if (agentsCfg?.optimizer?.enabled) {
			symbiosisBridge.attachOptimizer({
				onPurchase: (assetId, refId, price) => {
					broadcast({
						type: "knowledge-trade",
						assetId,
						refId,
						price
					});
					logger.info("知识成交：optimizer 购入 %s（要价 %.1f）", refId, price);
				},
				config: {
					maxBudget: agentsCfg.optimizer.maxBudget,
					reserveBalance: agentsCfg.optimizer.reserveBalance,
					minClaimedQuality: agentsCfg.optimizer.minClaimedQuality,
					beliefBetBudget: agentsCfg.optimizer.beliefBetBudget
				}
			});
			attached.push("optimizer");
		}
		logger.info("共生进化融合已启用：模型智能体 ×%d，能量经济 + 信念市场并行心跳%s%s", mergedModels.length, futarchyEnabled ? "，futarchy 进化表决开启（高成本进化由市场资助）" : "", attached.length > 0 ? `，全智能体接入：${attached.join(" / ")}` : "");
	}
	/**
	* 真实进化周期（futarchy 表决的行动本体 / 直连模式的执行体，共用）：
	* ① 喂数金丝雀（决策反馈真实成败/质量 → 自动回滚/晋升）
	* ② 刷新沙盒素材（任务集/校准表/模型快照与操作环同步）
	* ③ 触发进化周期（变异/交叉 → 沙盒评估 → 择优 → 热切换）
	*/
	const runPolicyEvolutionCycle = async () => {
		const canaryNow = policyEvolver.getStatus().canary;
		if (canaryNow?.status === "active") {
			const QUALITY_BY_OUTCOME = {
				excellent: .95,
				good: .8,
				acceptable: .65,
				poor: .4,
				failed: .1
			};
			const fresh = memory.getRecentFeedback(50).filter((f) => f.timestamp >= canaryNow.deployedAt && f.timestamp > lastCanaryFeedAt);
			for (const feedback of fresh) {
				policyEvolver.reportOperationalOutcome({
					success: [
						"excellent",
						"good",
						"acceptable"
					].includes(feedback.outcome),
					quality: QUALITY_BY_OUTCOME[feedback.outcome]
				});
				lastCanaryFeedAt = Math.max(lastCanaryFeedAt, feedback.timestamp);
			}
		}
		policySandbox.setTaskSet(buildSandboxTaskSet());
		policySandbox.setCalibration(buildCalibrationFromMemory(memory));
		const cycle = await policyEvolver.runEvolutionCycle(policySandbox);
		logger.info("策略进化周期完成: %s", cycle.summary);
		return cycle;
	};
	if (symbiosisBridge && futarchyEnabled) symbiosisBridge.attachEvolver(async () => {
		const cycle = await runPolicyEvolutionCycle();
		const gains = cycle.candidates.map((c) => c.gain);
		return {
			deployed: !!cycle.deployedPolicyId,
			bestGain: gains.length > 0 ? Math.max(...gains) : 0,
			policyId: cycle.deployedPolicyId,
			summary: cycle.summary
		};
	}, { dividendWeight: () => {
		const status = policyEvolver.getStatus();
		if (status.currentPolicy.origin === "baseline") return void 0;
		const lastDeployed = status.deployedHistory[status.deployedHistory.length - 1];
		return Math.max(.2, (lastDeployed?.gain ?? 0) * 5);
	} });
	/** 子任务派发器：目标子任务注入哨兵作为信号 */
	const dispatchSubtask = (subtask, goal) => {
		const signal = sentinel.ingest({
			type: subtask.taskType,
			description: subtask.description,
			payload: {
				goalId: goal.id,
				subtaskId: subtask.id,
				autonomous: true
			},
			source: "autonomy-loop",
			urgency: Math.min(1, .5 + goal.valueScore * .3)
		});
		broadcast({
			type: "autonomy-dispatch",
			goalId: goal.id,
			subtaskId: subtask.id,
			signalId: signal.id
		});
		return signal.id;
	};
	/** 探索任务派发器：好奇心探索建议注入哨兵作为信号 */
	const dispatchExploration = (proposal) => {
		const signal = sentinel.ingest({
			type: proposal.taskType,
			description: proposal.description,
			payload: {
				exploration: true,
				noveltyScore: proposal.noveltyScore,
				expectedGain: proposal.expectedGain
			},
			source: "curiosity",
			urgency: Math.min(1, .3 + proposal.noveltyScore * .4)
		});
		broadcast({
			type: "exploration-dispatch",
			taskType: proposal.taskType,
			signalId: signal.id,
			noveltyScore: proposal.noveltyScore
		});
		return signal.id;
	};
	const autonomyLoop = new AutonomyLoop({
		config: {
			...cfg.autonomy?.loop,
			heartbeatMs: cfg.autonomy?.heartbeatMs ?? cfg.autonomy?.loop?.heartbeatMs ?? 3e4
		},
		goalEngine,
		metaCognition,
		evolution: strategyEvolution,
		collectKpi,
		dispatchSubtask,
		maintainer: {
			distillExperience: () => memory.distillExperience().length,
			applyForgettingCurve: () => memory.applyForgettingCurve(),
			distillKnowledge: async () => {
				const report = await reflector.distillKnowledge();
				return {
					semantic: report.semanticMemories.length,
					procedural: report.proceduralMemories.length
				};
			}
		},
		lessonProvider: () => reflectionEngine.getAllLessons(),
		strategyApplier: (config) => {
			decisionEngine.updateConfig(config);
			broadcast({
				type: "strategy-evolved",
				config
			});
			logger.info("策略进化落地: %s", JSON.stringify(config));
		},
		worldModel,
		curiosity,
		governor,
		dispatchExploration,
		policyEvolution: policyEvolutionEnabled && !futarchyEnabled ? { runEvolutionCycle: runPolicyEvolutionCycle } : void 0,
		metaCognitionBridge: metaLayerEnabled ? { runMetaCycle: async () => {
			const adjustment = await metaController.evaluateAndAdjust();
			broadcast({
				type: "mental-report",
				reportIndex: adjustment.reportIndex,
				status: adjustment.status,
				appliedKnobs: adjustment.applied.map((a) => a.knob),
				stabilityScore: adjustment.mentalReport.systemStability.stabilityScore
			});
			if (adjustment.applied.length > 0 || adjustment.rolledBack || adjustment.committed) logger.info("元认知周期[%s]: 报告 #%d，稳定分 %.3f，证据 %d 条，推荐 %d 项", adjustment.status, adjustment.reportIndex, adjustment.mentalReport.systemStability.stabilityScore, adjustment.mentalReport.improvementEvidence.length, adjustment.mentalReport.recommendedAdjustments.length);
			return adjustment;
		} } : void 0,
		symbiosis: symbiosisBridge ? { runSymbiosisTick: async (snapshot) => {
			const driftInsights = await symbiosisBridge.heartbeat(snapshot);
			if (schedulingFeedbackEnabled) {
				const signals = symbiosisBridge.economicSignals();
				modelScheduler.updateEconomicSignals(new Map([...signals].map(([modelId, s]) => [modelId, s.multiplier])));
			}
			symbiosisTickCount += 1;
			if (sankeyPath && symbiosisTickCount % sankeyEveryNTicks === 0) try {
				fs.writeFileSync(sankeyPath, symbiosisBridge.sankeyHtml());
				broadcast({
					type: "sankey-updated",
					path: sankeyPath,
					tick: symbiosisTickCount
				});
				logger.debug("能量 Sankey 已落盘: %s", sankeyPath);
			} catch (err) {
				logger.warn("能量 Sankey 落盘失败: %s", err instanceof Error ? err.message : err);
			}
			if (driftInsights.length > 0) {
				broadcast({
					type: "market-divergence",
					count: driftInsights.length,
					messages: driftInsights.map((i) => i.message)
				});
				logger.warn("信念市场漂移告警 ×%d（市场价 vs 统计估计显著背离）", driftInsights.length);
			}
			const decisions = symbiosisBridge.lastFutarchyDecisions();
			if (decisions.length > 0) for (const d of decisions) {
				broadcast({
					type: "futarchy-decision",
					...d
				});
				logger.info("futarchy 进化表决：%s（隐含成功概率 %.3f%s）", d.decision, d.impliedProb, d.decision === "funded" ? ` → 已资助执行，行动${d.actionSuccess ? "成功" : "失败"}` : "");
			}
			return driftInsights;
		} } : void 0
	});
	/**
	* 10 步链路编排主流程（第 3~10 步）
	*
	* 深度优化：第 3~4 步由决策引擎四级流水线完成
	* （规则快速路径 → 决策缓存 → strategist → 启发式兜底）
	*/
	async function processBatch(batch) {
		broadcast({
			type: "batch-start",
			signalCount: batch.signals.length,
			signals: batch.signals.map((s) => ({
				id: s.id,
				type: s.type
			}))
		});
		for (const signal of batch.signals) worldModel.observeArrival(signal.type, signal.receivedAt);
		const genome = strategyEvolution.selectGenome();
		decisionEngine.updateConfig({ ...genome.genes });
		broadcast({
			type: "strategist-thinking",
			step: 3,
			message: "决策引擎四级流水线评估中"
		});
		const history = buildSignalHistory(batch.signals);
		const decisions = await decisionEngine.decide(batch.signals, history);
		const sorted = [...batch.signals].sort((a, b) => (decisions.get(b.id)?.urgency ?? 0) - (decisions.get(a.id)?.urgency ?? 0));
		broadcast({
			type: "strategist-thinking",
			step: 4,
			message: "战略决策完成，按紧急度执行"
		});
		for (const signal of sorted) {
			const decision = decisions.get(signal.id);
			const action = decision?.action ?? "execute";
			signal.urgency = signal.urgency ?? decision?.urgency ?? .5;
			broadcast({
				type: "signal-received",
				signal: {
					id: signal.id,
					type: signal.type,
					urgency: signal.urgency,
					decision: action
				},
				decisionSource: decision?.source,
				confidence: decision?.confidence,
				pendingCount: sentinel.getPendingSignals().length
			});
			ctx.emit("scheduler/signal", signal);
			try {
				if (action === "execute") {
					const result = await executeSignal(signal);
					const fingerprint = decisionEngine.fingerprint(signal);
					decisionEngine.recordOutcome(signal.type, fingerprint, "good");
					strategyEvolution.recordOutcome(genome.id, "good");
					settleGoalProgress(signal.id, true);
					governor.recordOutcome(result ? result.success : false, result?.totalTokens ?? 0, 0);
					if (signal.payload?.exploration) curiosity.recordExploration(signal.type, Boolean(result?.success), result ? `质量 ${result.avgQuality.toFixed(2)}` : void 0);
				} else if (action === "defer") {
					deferredQueue.push({
						signal,
						deferUntil: Date.now() + (decision?.deferMs ?? 6e4)
					});
					recordDecision(signal, action, "acceptable", `延迟 ${Math.round((decision?.deferMs ?? 6e4) / 1e3)}s 后重审（${decision?.reason ?? ""}）`);
					strategyEvolution.recordOutcome(genome.id, "acceptable");
				} else if (action === "ask-user") {
					recordDecision(signal, action, "acceptable", decision?.reason ?? "需要人工确认");
					strategyEvolution.recordOutcome(genome.id, "acceptable");
				} else {
					recordDecision(signal, "dismiss", "good", decision?.reason ?? "战略决策忽略");
					strategyEvolution.recordOutcome(genome.id, "good");
				}
			} catch (err) {
				logger.error("信号 %s 处理失败: %s", signal.id, err.message);
				recordDecision(signal, action, "failed", err.message);
				const fingerprint = decisionEngine.fingerprint(signal);
				decisionEngine.recordOutcome(signal.type, fingerprint, "failed");
				strategyEvolution.recordOutcome(genome.id, "failed");
				settleGoalProgress(signal.id, false);
				governor.recordOutcome(false, 0, 0);
				if (signal.payload?.exploration) curiosity.recordExploration(signal.type, false, err.message);
			}
		}
		const now = Date.now();
		for (let i = deferredQueue.length - 1; i >= 0; i -= 1) {
			const item = deferredQueue[i];
			if (item.deferUntil <= now) {
				deferredQueue.splice(i, 1);
				sentinel.ingest({
					type: item.signal.type,
					description: item.signal.description,
					payload: item.signal.payload,
					source: "deferred"
				});
			}
		}
	}
	/** 目标进度回写：信号执行完成后更新绑定的目标子任务状态 */
	function settleGoalProgress(signalId, success) {
		const bound = goalEngine.findBySignal(signalId);
		if (!bound) return;
		const transition = goalEngine.recordSubtaskOutcome(bound.goal.id, bound.subtask.id, success, success ? "执行成功" : "执行失败");
		broadcast({
			type: "goal-progress",
			goalId: bound.goal.id,
			subtaskId: bound.subtask.id,
			success,
			transition
		});
		if (transition === "completed") {
			logger.info("自主目标达成: %s", bound.goal.title);
			broadcast({
				type: "goal-completed",
				goalId: bound.goal.id,
				title: bound.goal.title
			});
		} else if (transition === "abandoned") logger.warn("自主目标放弃: %s", bound.goal.title);
	}
	/** 构建信号历史统计（决策引擎上下文，来自长期记忆） */
	function buildSignalHistory(signals) {
		const history = /* @__PURE__ */ new Map();
		for (const signal of signals) {
			if (history.has(signal.type)) continue;
			const decisionStats = memory.getDecisionSuccessRate(signal.type);
			const pattern = memory.findPattern(signal.type, .5);
			history.set(signal.type, {
				totalDecisions: decisionStats.total,
				successRate: decisionStats.successRate,
				avgExecutionTime: pattern?.avgExecutionTime ?? 0,
				avgTokenCost: pattern && pattern.successfulPlans.length > 0 ? pattern.successfulPlans.reduce((sum, p) => sum + p.tokenCost, 0) / pattern.successfulPlans.length : 0
			});
		}
		return history;
	}
	/**
	* 推断信号的任务上下文（第二阶段升级）
	*
	* 此前调用 lookupExperience 时 complexity 硬编码 0.5、features 恒为空，
	* 导致程序记忆中 complexity>=0.7 / feature contains code 类条件永不满足，
	* 三层级联中最高层从未真正命中。此处在计划生成前用启发式从信号描述推断
	* features / complexity / length，让程序记忆与语义记忆的条件匹配真正生效。
	* （启发式仅影响"记忆检索"这一只读环节，不影响任何执行语义，风险可控）
	*/
	function inferTaskContext(signal) {
		const text = `${signal.type} ${signal.description}`.toLowerCase();
		const features = [...new Set([
			["code", "code"],
			["代码", "code"],
			["refactor", "code"],
			["重构", "code"],
			["review", "review"],
			["审查", "review"],
			["test", "test"],
			["测试", "test"],
			["doc", "documentation"],
			["文档", "documentation"],
			["翻译", "translation"],
			["translate", "translation"],
			["analyz", "analysis"],
			["分析", "analysis"],
			["report", "analysis"]
		].filter(([kw]) => text.includes(kw)).map(([, tag]) => tag))];
		const length = signal.description.length;
		let complexity = Math.min(.95, .4 + (Math.log10(Math.max(10, length)) - 2) * .35);
		if (features.includes("code")) complexity = Math.min(1, complexity + .15);
		if (features.length >= 3) complexity = Math.min(1, complexity + .05);
		return {
			features,
			complexity,
			length
		};
	}
	/**
	* 执行单个信号（第 5~10 步）
	* @returns 计划执行结果（共识未提交时返回 null）
	*/
	async function executeSignal(signal) {
		if (raft) {
			if (!(await raft.propose({
				type: "execute-plan",
				signalId: signal.id,
				signalDescription: signal.description,
				decision: {
					action: "execute",
					urgency: signal.urgency ?? .5,
					confidence: 1,
					reason: `共识门控提交执行：${signal.description}`,
					source: "rule",
					decidedAt: Date.now()
				},
				proposedBy: cfg.sync?.localNodeId ?? "node-dev-01"
			})).committed) {
				recordDecision(signal, "execute", "failed", "共识提案未提交");
				return null;
			}
		}
		const taskType = signal.type;
		const inferred = inferTaskContext(signal);
		const lookup = optimizer.lookupExperience(taskType, inferred.complexity, inferred.features, { length: inferred.length });
		const strategies = memory.getStrategies(taskType, 3);
		const lessons = reflectionEngine.getLessons(taskType, 3);
		broadcast({
			type: "strategist-thinking",
			step: 5,
			message: `经验检索[记忆层级:${lookup.memoryLayer}]: ${lookup.rationale}，蒸馏策略 ${strategies.length} 条，历史教训 ${lessons.length} 条`
		});
		const avoided = new Set(lookup.avoidModels ?? []);
		const effectiveRecommended = Object.fromEntries(Object.entries(lookup.recommendedModels).filter(([, model]) => !avoided.has(model)));
		if (avoided.size > 0 || (lookup.suggestedActions?.length ?? 0) > 0) broadcast({
			type: "procedural-actions-applied",
			signalId: signal.id,
			avoidedModels: [...avoided],
			actions: lookup.suggestedActions?.map((a) => ({
				type: a.type,
				params: a.params,
				rationale: a.rationale
			})) ?? []
		});
		let plan = optimizer.recallPlan(lookup, signal.description);
		if (plan) {
			broadcast({
				type: "strategist-thinking",
				step: 6,
				message: `经验快路径：复用历史成功计划（置信度 ${lookup.pattern.confidence.toFixed(2)}，${plan.nodes.length} 节点），跳过 LLM 规划`
			});
			logger.info("经验快路径命中：任务类型 %s 复用历史计划（%d 节点）", taskType, plan.nodes.length);
		} else {
			let strategistOutput;
			try {
				const aliasMap = new AliasMap();
				const strategyLines = strategies.map((s) => `${aliasMap.encode(s.id)} ${s.description}`);
				const lessonLines = lessons.map((l) => `${aliasMap.encode(l.id)} ${l.lesson}→${l.suggestion}`);
				const experienceContext = [
					lookup.pattern ? `历史经验(推荐模型): ${JSON.stringify(effectiveRecommended)}` : "",
					strategyLines.length > 0 ? `蒸馏策略(引用时仅用短索引): ${strategyLines.join("；")}` : "",
					lessonLines.length > 0 ? `历史教训(务必规避，引用时仅用短索引): ${lessonLines.join("；")}` : ""
				].filter(Boolean).join("\n");
				const response = await llm.chat(strategistId, [{
					role: "system",
					content: "你是任务规划器。将任务拆解为 DAG，输出 JSON: {\"nodes\":[{\"id\",\"description\",\"type\",\"dependsOn\"}],\"parallelismStrategy\":\"layered\"}。"
				}, {
					role: "user",
					content: `任务: ${signal.description}\n任务类型: ${taskType}${experienceContext ? `\n${experienceContext}` : ""}`
				}], {
					timeout: 3e4,
					maxRetries: 1
				});
				strategistOutput = aliasMap.decodeText(response.content);
			} catch (err) {
				logger.warn("strategist 计划生成失败，使用兜底计划: %s", err.message);
			}
			plan = taskExecutor.buildPlan(signal.description, strategistOutput, taskType);
		}
		const governance = governor.govern("autonomous-execute", lookup.pattern?.confidence ?? .8);
		if (!governance.allowed) {
			recordDecision(signal, "execute", "failed", `治理拦截：${governance.reason ?? "unknown"}`);
			broadcast({
				type: "execution-governed",
				signalId: signal.id,
				blockedBy: governance.blockedBy,
				reason: governance.reason
			});
			logger.warn("执行被安全治理器拦截 [%s]: %s", governance.blockedBy, governance.reason);
			return null;
		}
		if (hotReload) hotReload.registerTask(signal.id, taskType);
		try {
			const result = await taskExecutor.executePlan(signal, plan, effectiveRecommended, { avoidModels: [...avoided] });
			ctx.emit("scheduler/plan-complete", result, signal);
			recordDecision(signal, "execute", result.success ? result.avgQuality >= .85 ? "excellent" : "good" : "failed", result.success ? `平均质量 ${result.avgQuality.toFixed(2)}` : result.error ?? "执行失败");
			reflector.reflectOnOutcome({
				signal,
				plan,
				result,
				appliedStrategies: strategies.map((s) => s.id),
				appliedMemoryIds: {
					semantic: lookup.matchedSemanticId ? [lookup.matchedSemanticId] : [],
					procedural: lookup.matchedProceduralIds ?? []
				},
				decisionInsights: taskExecutor.getAndClearDecisionInsights()
			});
			if (symbiosisBridge) symbiosisBridge.settleTask(result);
			return result;
		} finally {
			if (hotReload) hotReload.unregisterTask(signal.id);
		}
	}
	/** 决策反馈沉淀（第 10 步组成部分） */
	function recordDecision(signal, decision, outcome, reason) {
		memory.recordDecisionFeedback({
			signalType: signal.type,
			signalDescription: signal.description,
			decision,
			outcome,
			outcomeReason: reason
		});
		sync.recordChange("feedback-created", `fb-${signal.id}`, {
			id: `fb-${signal.id}`,
			timestamp: Date.now(),
			signalType: signal.type,
			signalDescription: signal.description,
			decision,
			outcome,
			outcomeReason: reason
		});
	}
	/** 进度广播（enableProgress 关闭时为空操作） */
	function broadcast(event) {
		if (!broadcaster) return;
		broadcaster.broadcast({
			type: event.type,
			timestamp: Date.now(),
			...event
		});
	}
	if (broadcaster) {
		broadcaster.start();
		attachDashboard(broadcaster, () => llm.getModelStatuses());
	}
	sentinel.start();
	if (autonomyEnabled) {
		autonomyLoop.start();
		logger.info("自主心跳循环已启动（间隔 %dms）", cfg.autonomy?.heartbeatMs ?? 3e4);
	}
	if (raft) {
		raft.start();
		raft.onRoleChange((role, term) => broadcast({
			type: "role-change",
			role,
			term
		}));
	}
	if (hotReload) {
		hotReload.startWatching();
		hotReload.on("deploy-succeeded", (event) => broadcast({
			type: "plugin-reloaded",
			version: event.version
		}));
	}
	for (const tenant of cfg.tenants ?? []) try {
		if (!tenantManager.getTenant(tenant.id)) tenantManager.registerTenant(tenant);
	} catch (err) {
		logger.warn("租户恢复失败 %s: %s", tenant.id, err.message);
	}
	benchmark.registerBuiltinScenarios({
		memory,
		cryptoEngine: cryptoEngine ?? new CryptoEngine({
			enabled: false,
			masterKey: "benchmark-placeholder",
			algorithm: "aes-256-gcm",
			sensitiveFields: [],
			fullFileEncryption: false
		}),
		callLLM: (modelId, messages) => llm.chat(modelId, messages),
		models: mergedModels.map((m) => ({
			id: m.id,
			endpoint: m.endpoint,
			apiKey: m.apiKey ?? ""
		}))
	});
	logger.info("调度器已启动: %d 个模型, 哨兵窗口 %ss, 进度端口 %s", mergedModels.length, cfg.sentinel?.aggregationWindow ?? .5, cfg.enableProgress ? String(cfg.progressPort) : "关闭");
	const tools = new ToolRegistry();
	tools.register({
		name: "autonomous_execute",
		description: "提交一个自主任务，由调度器完成感知-决策-执行-沉淀全链路",
		parameters: {
			task: {
				type: "string",
				description: "任务描述",
				required: true
			},
			urgency: {
				type: "number",
				description: "紧急度 0~1，缺省 0.8"
			}
		},
		handler: (args) => {
			if (!args.task || typeof args.task !== "string") throw new ToolError("task 为必填字符串");
			const urgency = typeof args.urgency === "number" ? Math.max(0, Math.min(1, args.urgency)) : .8;
			return {
				signalId: sentinel.ingest({
					type: "manual-task",
					description: args.task,
					payload: { task: args.task },
					source: "manual",
					urgency
				}).id,
				urgency,
				status: "queued"
			};
		}
	});
	tools.register({
		name: "model_dashboard",
		description: "查看所有已注册模型的运行时状态（并发、成功率、延迟、token、成本）",
		parameters: {},
		handler: () => ({
			models: llm.getModelStatuses(),
			sentinel: sentinel.getStatus()
		})
	});
	tools.register({
		name: "query_memory",
		description: "查询长期记忆库（含蒸馏策略、教训、质量趋势、决策引擎统计）",
		parameters: {
			query_type: {
				type: "string",
				description: "查询类型",
				required: true,
				enum: [
					"overview",
					"patterns",
					"model-profile",
					"feedback",
					"strategies",
					"lessons",
					"trends",
					"decision-stats",
					"goals",
					"health",
					"evolution",
					"autonomy-status",
					"world-model",
					"curiosity",
					"governance",
					"introspect",
					"keys"
				]
			},
			limit: {
				type: "number",
				description: "返回条数上限，缺省 10"
			},
			task_type: {
				type: "string",
				description: "strategies/lessons 按任务类型过滤（可选）"
			}
		},
		handler: (args) => {
			const limit = typeof args.limit === "number" ? args.limit : 10;
			switch (args.query_type) {
				case "overview": return {
					globalStats: memory.getGlobalStats(),
					summary: memory.getMemorySummary()
				};
				case "patterns": return { patterns: memory.getTopPatterns(limit) };
				case "model-profile": return { profiles: memory.getAllModelProfiles() };
				case "feedback": return { feedback: memory.getRecentFeedback(limit) };
				case "strategies": return { strategies: args.task_type ? memory.getStrategies(String(args.task_type), limit) : memory.getAllStrategies().slice(0, limit) };
				case "lessons": return { lessons: args.task_type ? reflectionEngine.getLessons(String(args.task_type), limit) : reflectionEngine.getAllLessons().slice(-limit) };
				case "trends": return { trends: reflectionEngine.getTrendSummary() };
				case "decision-stats": return {
					stats: decisionEngine.getStats(),
					audit: decisionEngine.getAudit(limit)
				};
				case "goals": return {
					summary: goalEngine.getSummary(),
					goals: goalEngine.getAllGoals().slice(0, limit)
				};
				case "health": return {
					health: metaCognition.getHealthReport(),
					anomalies: metaCognition.getAnomalies().slice(-limit),
					tuning: metaCognition.getTuningHistory().slice(-limit)
				};
				case "evolution": return {
					evolution: strategyEvolution.getReport(),
					history: strategyEvolution.getEvolutionHistory().slice(-limit)
				};
				case "autonomy-status": return {
					status: autonomyLoop.getStatus(),
					reports: autonomyLoop.getReports().slice(-limit)
				};
				case "world-model": return {
					summary: worldModel.getSummary(),
					predictions: worldModel.predictArrivals().slice(0, limit)
				};
				case "curiosity": return {
					summary: curiosity.getSummary(),
					gaps: curiosity.scanKnowledgeGaps().slice(0, limit)
				};
				case "governance": return {
					status: governor.getStatus(),
					audit: governor.getAudit(limit)
				};
				case "keys": return {
					health: keyHealth.status(),
					userOrder: keyHealth.getKeyOrder(),
					sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)]))
				};
				case "introspect": return { introspection: autonomyLoop.introspect() };
				default: throw new ToolError(`未知 query_type: ${args.query_type}`);
			}
		}
	});
	tools.register({
		name: "query_experience",
		description: "按任务类型检索历史经验（相似模式、成功率、推荐模型、记忆层级）",
		parameters: {
			task_type: {
				type: "string",
				description: "任务类型（可选，缺省返回 Top 模式）"
			},
			complexity: {
				type: "number",
				description: "复杂度 0~1（可选，缺省 0.5）"
			},
			features: {
				type: "string",
				description: "特征标签逗号分隔（可选，如 code,test）"
			}
		},
		handler: (args) => {
			if (args.task_type) {
				const complexity = typeof args.complexity === "number" ? Math.max(0, Math.min(1, args.complexity)) : .5;
				const features = typeof args.features === "string" ? args.features.split(",").map((f) => f.trim()).filter(Boolean) : [];
				const lookup = optimizer.lookupExperience(String(args.task_type), complexity, features);
				return {
					taskType: args.task_type,
					...lookup
				};
			}
			return { patterns: memory.getTopPatterns(10) };
		}
	});
	tools.register({
		name: "distill_knowledge",
		description: "触发知识蒸馏：从累积情景记忆中产出语义记忆与程序记忆（三层记忆升级；强制全量蒸馏，绕过水位门控）",
		parameters: {},
		handler: async () => {
			const report = await reflector.distillKnowledge({ force: true });
			return {
				distilledAt: report.distilledAt,
				sourceEpisodicCount: report.sourceEpisodicCount,
				semanticCount: report.semanticMemories.length,
				proceduralCount: report.proceduralMemories.length,
				strategyCount: report.strategies.length,
				mergedSemanticCount: report.mergedSemanticCount ?? 0,
				mergedProceduralCount: report.mergedProceduralCount ?? 0,
				supersededCount: report.supersededCount ?? 0,
				semanticMemories: report.semanticMemories.map((m) => ({
					id: m.id,
					domain: m.domain,
					statement: m.statement,
					confidence: m.confidence,
					supportCount: m.supportCount
				})),
				proceduralMemories: report.proceduralMemories.map((p) => ({
					id: p.id,
					kind: p.kind,
					name: p.name,
					action: p.action.type,
					confidence: p.confidence,
					supportCount: p.supportCount
				})),
				summary: report.summary
			};
		}
	});
	tools.register({
		name: "mental_report",
		description: "第四阶段元认知层：生成/查询系统心智报告（策略优劣势、记忆健康趋势、进化器效率、稳定性风险、自我改进证据、推荐调整），支持人类审查与手动干预",
		parameters: {
			action: {
				type: "string",
				description: "generate 生成新报告（含保守调整推荐）/ latest 最近报告 / history 报告历史 / trend 趋势序列 / formatted 人类可读版",
				required: true,
				enum: [
					"generate",
					"latest",
					"history",
					"trend",
					"formatted"
				]
			},
			limit: {
				type: "number",
				description: "history 返回条数上限，缺省 10"
			}
		},
		handler: async (args) => {
			switch (args.action) {
				case "generate": {
					const report = await selfModel.generateMentalReport();
					broadcast({
						type: "mental-report",
						reportIndex: report.reportIndex,
						status: "generated",
						stabilityScore: report.systemStability.stabilityScore
					});
					return {
						report,
						formatted: selfModel.formatReport(report)
					};
				}
				case "latest": {
					const report = selfModel.getLatestReport();
					if (!report) throw new ToolError("暂无心智报告，先执行 action=generate");
					return { report };
				}
				case "history": return { history: selfModel.getReportHistory().slice(-Math.max(1, args.limit ?? 10)) };
				case "trend": return { trend: selfModel.getTrendSeries() };
				case "formatted": {
					const report = selfModel.getLatestReport();
					if (!report) throw new ToolError("暂无心智报告，先执行 action=generate");
					return { formatted: selfModel.formatReport(report) };
				}
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "self_knowledge",
		description: "3.0 自知之明报告：调度预测校准（Brier 分 / 残差 / 过自信-欠自信方向 / 自修正量）+ 全层证据普查（策略/语义/程序/模型画像四层的证据覆盖度、平均有效样本量、证据枯竭数、模型能力漂移）——系统知道自己哪些记忆可信、哪些在过期、预测有多准",
		parameters: {},
		handler: async () => {
			const report = reflector.getSelfKnowledge();
			return {
				generatedAt: report.generatedAt,
				calibration: report.calibration,
				census: report.census ? {
					generatedAt: report.census.generatedAt,
					layers: report.census.layers,
					driftedModels: report.census.driftedModels
				} : void 0
			};
		}
	});
	tools.register({
		name: "meta_cognition",
		description: "第四阶段元认知控制器（2.0 学习型稳态控制）：evaluate 推进保守调整状态机（应用/观察/判定/回滚）/ status 旋钮面板、学习器有效性、熔断器与审计日志 / rollback 手动回滚最近调整 / override 手动覆盖旋钮（自动调整冻结）/ freeze 全局冻结与解冻 / rearm-breaker 复位熔断器（连续回滚触发的旋钮级或全局熔断）",
		parameters: {
			action: {
				type: "string",
				description: "控制动作",
				required: true,
				enum: [
					"evaluate",
					"status",
					"rollback",
					"override",
					"unfreeze-knob",
					"freeze",
					"rearm-breaker"
				]
			},
			knob: {
				type: "string",
				description: "override / unfreeze-knob / rearm-breaker 时的旋钮 id（如 evolver.mutationRate）；rearm-breaker 缺省复位全部"
			},
			value: {
				type: "number",
				description: "override 时的目标取值"
			},
			frozen: {
				type: "boolean",
				description: "freeze 时的冻结开关（true 冻结 / false 解冻）"
			},
			limit: {
				type: "number",
				description: "status 时审计日志条数上限，缺省 20"
			}
		},
		handler: async (args) => {
			switch (args.action) {
				case "evaluate": {
					const adjustment = await metaController.evaluateAndAdjust();
					return {
						status: adjustment.status,
						reportIndex: adjustment.reportIndex,
						applied: adjustment.applied,
						rolledBack: adjustment.rolledBack,
						committed: adjustment.committed,
						observation: adjustment.observation,
						skippedReason: adjustment.skippedReason,
						stabilityScore: adjustment.mentalReport.systemStability.stabilityScore,
						improvementEvidence: adjustment.mentalReport.improvementEvidence
					};
				}
				case "status": {
					const state = metaController.getState();
					return {
						frozen: state.frozen,
						frozenByBreaker: state.frozenByBreaker,
						manuallyFrozenKnobs: state.manuallyFrozenKnobs,
						circuitBreakers: state.circuitBreakers.filter((b) => b.tripped || b.consecutiveRollbacks > 0),
						learner: state.learner,
						safeEnvelopes: state.safeEnvelopes,
						pending: state.pending,
						knobs: state.knobs,
						counters: {
							adjustments: state.totalAdjustments,
							rollbacks: state.totalRollbacks,
							commits: state.totalCommits
						},
						auditTrail: state.auditTrail.slice(-Math.max(1, args.limit ?? 20))
					};
				}
				case "rollback": return { result: await metaController.rollbackLastAdjustment() };
				case "override":
					if (!args.knob || typeof args.value !== "number") throw new ToolError("override 需要 knob 与 value 参数");
					return { result: metaController.setManualOverride(String(args.knob), args.value) };
				case "unfreeze-knob":
					if (!args.knob) throw new ToolError("unfreeze-knob 需要 knob 参数");
					return { cleared: metaController.clearManualOverride(String(args.knob)) };
				case "freeze":
					metaController.setFrozen(args.frozen !== false);
					return { frozen: args.frozen !== false };
				case "rearm-breaker": return { reArmed: metaController.reArmBreaker(args.knob ? String(args.knob) : void 0) };
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "maintain_memory",
		description: "维护长期记忆库（清理过期数据 / 查看状态）",
		parameters: {
			action: {
				type: "string",
				description: "维护动作",
				required: true,
				enum: ["prune", "status"]
			},
			maxAgeDays: {
				type: "number",
				description: "prune 时保留的天数，缺省 90"
			}
		},
		handler: (args) => {
			if (args.action === "prune") return { pruned: memory.prune(typeof args.maxAgeDays === "number" ? args.maxAgeDays : 90) };
			if (args.action === "status") return {
				globalStats: memory.getGlobalStats(),
				summary: memory.getMemorySummary()
			};
			throw new ToolError(`未知 action: ${args.action}`);
		}
	});
	tools.register({
		name: "manage_tenants",
		description: "多租户管理（列表 / 注册 / 移除 / 更新 / 统计 / 路径匹配）",
		parameters: {
			action: {
				type: "string",
				description: "管理动作",
				required: true,
				enum: [
					"list",
					"register",
					"remove",
					"update",
					"stats",
					"match"
				]
			},
			config: {
				type: "object",
				description: "register 时的租户配置"
			},
			tenantId: {
				type: "string",
				description: "目标租户 id"
			},
			updates: {
				type: "object",
				description: "update 时的更新字段"
			},
			filePath: {
				type: "string",
				description: "match 时的文件路径"
			}
		},
		handler: (args) => {
			switch (args.action) {
				case "list": return { tenants: tenantManager.getAllTenants().map((t) => ({
					id: t.config.id,
					name: t.config.name,
					enabled: t.config.enabled !== false,
					activeExecutions: t.activeExecutions
				})) };
				case "register": return { tenant: tenantManager.registerTenant(args.config).config };
				case "remove":
					tenantManager.removeTenant(String(args.tenantId), Boolean(args.deleteData));
					return { removed: args.tenantId };
				case "update":
					tenantManager.updateTenant(String(args.tenantId), args.updates ?? {});
					return { updated: args.tenantId };
				case "stats": return { stats: tenantManager.getGlobalStats() };
				case "match": {
					const matched = tenantManager.matchTenantByPath(String(args.filePath ?? ""));
					return { matched: matched ? {
						id: matched.config.id,
						name: matched.config.name
					} : null };
				}
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "manage_encryption",
		description: "加密管理（生成密钥 / 轮换密钥 / 查看状态 / 加密存量文件 / 解密文件）",
		parameters: {
			action: {
				type: "string",
				description: "加密动作",
				required: true,
				enum: [
					"generate-key",
					"rotate-key",
					"check-status",
					"encrypt-existing",
					"decrypt-file"
				]
			},
			filePath: {
				type: "string",
				description: "目标文件路径（rotate-key / decrypt-file）"
			},
			newMasterKey: {
				type: "string",
				description: "rotate-key 的新主密钥"
			}
		},
		handler: (args) => {
			if (args.action === "generate-key") return { key: CryptoEngine.generateKey() };
			if (args.action === "check-status") return {
				enabled: Boolean(cryptoEngine),
				algorithm: cfg.encryption?.algorithm ?? "aes-256-gcm",
				fingerprint: cryptoEngine?.getKeyFingerprint() ?? null
			};
			if (!cryptoEngine) throw new ToolError("加密功能未启用（encryption.enabled=false）");
			if (args.action === "rotate-key") return cryptoEngine.rotateKey(String(args.filePath), String(args.newMasterKey));
			if (args.action === "decrypt-file") {
				const { data } = cryptoEngine.readEncrypted(String(args.filePath));
				return {
					decrypted: true,
					preview: JSON.stringify(data).slice(0, 200)
				};
			}
			if (args.action === "encrypt-existing") {
				const target = String(args.filePath ?? memoryPath);
				if (!fs.existsSync(target)) throw new ToolError(`文件不存在: ${target}`);
				const raw = JSON.parse(fs.readFileSync(target, "utf-8"));
				return cryptoEngine.writeEncrypted(target, raw);
			}
			throw new ToolError(`未知 action: ${args.action}`);
		}
	});
	tools.register({
		name: "memory_migration",
		description: "记忆迁移（导出 / 导入 / 冲突预演 / 跨租户迁移）",
		parameters: {
			action: {
				type: "string",
				description: "迁移动作",
				required: true,
				enum: [
					"export",
					"import",
					"dry-run",
					"migrate-tenant"
				]
			},
			filePath: {
				type: "string",
				description: "导出/导入文件路径"
			},
			strategy: {
				type: "string",
				description: "合并策略",
				enum: [
					"overwrite",
					"merge",
					"skip",
					"newer-wins"
				]
			},
			sourceTenantId: {
				type: "string",
				description: "migrate-tenant 源租户"
			},
			targetTenantId: {
				type: "string",
				description: "migrate-tenant 目标租户"
			}
		},
		handler: (args) => {
			switch (args.action) {
				case "export": {
					const out = String(args.filePath ?? path.join(dataDir, `migration-${Date.now()}.json`));
					migrationTool.exportToFile(memory, out);
					return { exportedTo: out };
				}
				case "import": return migrationTool.importFromFile(memory, String(args.filePath), args.strategy ?? "merge");
				case "dry-run": {
					const pkg = migrationTool.exportFromFile(String(args.filePath));
					return migrationTool.dryRun(memory, pkg);
				}
				case "migrate-tenant": {
					const source = tenantManager.getTenant(String(args.sourceTenantId));
					const target = tenantManager.getTenant(String(args.targetTenantId));
					if (!source || !target) throw new ToolError("源或目标租户不存在");
					return migrationTool.migrateBetweenTenants(source.memory, target.memory);
				}
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "manage_sync",
		description: "分布式记忆同步管理（状态 / 立即同步 / 注册节点）",
		parameters: {
			action: {
				type: "string",
				description: "同步动作",
				required: true,
				enum: [
					"status",
					"sync-now",
					"register-node"
				]
			},
			peerId: {
				type: "string",
				description: "sync-now 目标节点"
			},
			node: {
				type: "object",
				description: "register-node 节点配置"
			}
		},
		handler: async (args) => {
			if (args.action === "status") return sync.getStatus();
			if (args.action === "sync-now") return sync.syncNow(String(args.peerId));
			if (args.action === "register-node") {
				sync.registerNode(args.node);
				return { registered: args.node?.nodeId };
			}
			throw new ToolError(`未知 action: ${args.action}`);
		}
	});
	tools.register({
		name: "manage_consensus",
		description: "Raft 共识管理（集群状态 / 提交提案）",
		parameters: {
			action: {
				type: "string",
				description: "共识动作",
				required: true,
				enum: ["status", "propose"]
			},
			command: {
				type: "object",
				description: "propose 的提案命令"
			}
		},
		handler: async (args) => {
			if (!raft) return {
				enabled: false,
				message: "共识功能未启用（consensus.enabled=false）"
			};
			if (args.action === "status") return raft.getClusterStatus();
			if (args.action === "propose") return raft.propose(args.command);
			throw new ToolError(`未知 action: ${args.action}`);
		}
	});
	tools.register({
		name: "run_benchmark",
		description: "性能基准测试（全量运行 / 场景列表 / 报告列表 / 对比 / 生成报告）",
		parameters: {
			action: {
				type: "string",
				description: "基准动作",
				required: true,
				enum: [
					"run-all",
					"list-scenarios",
					"list-reports",
					"compare",
					"generate-report"
				]
			},
			beforeId: {
				type: "string",
				description: "compare 的基准报告 id"
			},
			afterId: {
				type: "string",
				description: "compare 的对比报告 id"
			},
			reportId: {
				type: "string",
				description: "generate-report 的报告 id"
			}
		},
		handler: async (args) => {
			switch (args.action) {
				case "run-all": return benchmark.runAll();
				case "list-scenarios": return { scenarios: benchmark.listScenarios() };
				case "list-reports": return { reports: benchmark.loadReports().map((r) => ({
					id: r.id,
					timestamp: r.timestamp,
					overallPassed: r.overallPassed
				})) };
				case "compare": return { comparison: benchmark.compareReports(String(args.beforeId), String(args.afterId)) };
				case "generate-report": {
					const report = benchmark.loadReports().find((r) => r.id === args.reportId);
					if (!report) throw new ToolError(`报告不存在: ${args.reportId}`);
					return { markdown: benchmark.generateMarkdownReport(report) };
				}
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "manage_hot_reload",
		description: "插件热更新管理（状态 / 回滚 / 部署版本 / 启停监听）",
		parameters: {
			action: {
				type: "string",
				description: "热更新动作",
				required: true,
				enum: [
					"status",
					"rollback",
					"deploy-version",
					"stop-watching",
					"start-watching"
				]
			},
			versionId: {
				type: "string",
				description: "deploy-version 的目标版本"
			}
		},
		handler: async (args) => {
			if (!hotReload) return {
				enabled: false,
				message: "热更新未启用（hotReload.enabled=false）"
			};
			switch (args.action) {
				case "status": return hotReload.getStatus();
				case "rollback":
					await hotReload.rollback();
					return { rolledBack: true };
				case "deploy-version":
					await hotReload.manualDeploy(String(args.versionId));
					return { deployed: args.versionId };
				case "stop-watching":
					hotReload.stopWatching();
					return { watching: false };
				case "start-watching":
					hotReload.startWatching();
					return { watching: true };
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "manage_autonomy",
		description: "自主智能管理（心跳循环启停 / 手动心跳 / 注入洞察 / 目标管理 / 强制进化）",
		parameters: {
			action: {
				type: "string",
				description: "自主动作",
				required: true,
				enum: [
					"status",
					"start",
					"stop",
					"tick",
					"inject-insight",
					"list-goals",
					"abandon-goal",
					"evolve-now",
					"kill-switch",
					"revive",
					"reset-circuit",
					"introspect"
				]
			},
			insight: {
				type: "object",
				description: "inject-insight 的洞察对象（source/category/severity/message/suggestion/taskType）"
			},
			goalId: {
				type: "string",
				description: "abandon-goal 的目标 id"
			},
			engage: {
				type: "boolean",
				description: "kill-switch 的启停（true=启用紧急停止，false=解除）"
			}
		},
		handler: async (args) => {
			switch (args.action) {
				case "status": return {
					status: autonomyLoop.getStatus(),
					health: metaCognition.getHealthReport(),
					goals: goalEngine.getSummary()
				};
				case "start":
					autonomyLoop.start();
					return { running: true };
				case "stop":
					autonomyLoop.stop();
					return { running: false };
				case "tick": return { report: await autonomyLoop.tick() };
				case "inject-insight": {
					const insight = args.insight;
					if (!insight?.message || !insight?.suggestion) throw new ToolError("insight 需包含 message 与 suggestion");
					const goals = goalEngine.generateGoalsFromInsights([{
						source: insight.source ?? "user",
						category: insight.category ?? "user-request",
						severity: typeof insight.severity === "number" ? insight.severity : .6,
						message: String(insight.message),
						suggestion: String(insight.suggestion),
						taskType: insight.taskType
					}]);
					for (const goal of goals) await goalEngine.decompose(goal.id);
					return { goalsCreated: goals.map((g) => ({
						id: g.id,
						title: g.title,
						valueScore: g.valueScore
					})) };
				}
				case "list-goals": return { goals: goalEngine.getAllGoals() };
				case "abandon-goal": {
					const goal = goalEngine.getGoal(String(args.goalId));
					if (!goal) throw new ToolError(`目标不存在: ${args.goalId}`);
					goal.status = "abandoned";
					return { abandoned: args.goalId };
				}
				case "evolve-now": {
					const report = strategyEvolution.evolve(true);
					if (report) decisionEngine.updateConfig(strategyEvolution.bestGenesAsConfig());
					return {
						report,
						bestGenes: strategyEvolution.bestGenome().genes
					};
				}
				case "kill-switch":
					if (args.engage) {
						governor.engageKillSwitch();
						autonomyLoop.stop();
						broadcast({ type: "kill-switch-engaged" });
						logger.warn("紧急停止开关已启用，自主行为已冻结");
						return { engaged: true };
					}
					governor.disengageKillSwitch();
					broadcast({ type: "kill-switch-disengaged" });
					return { engaged: false };
				case "revive":
					governor.disengageKillSwitch();
					governor.resetCircuit();
					if (autonomyEnabled) autonomyLoop.start();
					return { revived: true };
				case "reset-circuit":
					governor.resetCircuit();
					return { circuitState: governor.getCircuitState() };
				case "introspect": return { introspection: autonomyLoop.introspect() };
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	tools.register({
		name: "manage_keys",
		description: "密钥管理：查看各密钥来源健康状态，或调整多密钥的使用顺序（持久化，重启保留）",
		parameters: {
			action: {
				type: "string",
				description: "密钥动作",
				required: true,
				enum: [
					"list",
					"set-order",
					"clear-order"
				]
			},
			order: {
				type: "array",
				description: "set-order 的密钥来源顺序（如 [\"local-config\", \"env:DASHSCOPE_API_KEY\"]，靠前优先）"
			}
		},
		handler: (args) => {
			switch (args.action) {
				case "list": return {
					health: keyHealth.status(),
					userOrder: keyHealth.getKeyOrder(),
					sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)]))
				};
				case "set-order":
					if (!Array.isArray(args.order) || args.order.length === 0) throw new ToolError("set-order 需要非空的 order 数组（密钥来源标识列表）");
					keyHealth.setKeyOrder(args.order);
					return { userOrder: keyHealth.getKeyOrder() };
				case "clear-order":
					keyHealth.clearKeyOrder();
					return {
						userOrder: [],
						restored: "默认顺序（环境变量序 → 本地配置）"
					};
				default: throw new ToolError(`未知 action: ${args.action}`);
			}
		}
	});
	const hostToolRegistry = ctx.get?.("tools");
	const hostToolDisposers = [];
	if (hostToolRegistry && typeof hostToolRegistry.register === "function") {
		for (const tool of tools.list()) {
			const internal = tools.get(tool.name);
			try {
				const dispose = hostToolRegistry.register({
					name: tool.name,
					description: tool.description,
					parameters: toJsonSchemaParameters(tool.parameters),
					output: {
						schema: {},
						render: (_args, value) => [{
							type: "text",
							text: JSON.stringify(value, null, 2)
						}]
					},
					execute: async (args) => internal.handler({ ...args })
				});
				if (typeof dispose === "function") hostToolDisposers.push(dispose);
			} catch (err) {
				logger.warn("官方 Tool 注册跳过 %s: %s", tool.name, err.message);
			}
		}
		if (hostToolDisposers.length > 0) logger.info("已桥接 %d 个 Tool 到 DSH 官方注册表（ctx.tools）", hostToolDisposers.length);
	}
	const selfToolNames = new Set(tools.list().map((t) => t.name));
	const hostFusion = new HostFusionLayer(cfg.hostFusion, {
		ctx,
		sentinel,
		worldModel,
		governor,
		broadcast,
		logger,
		selfToolNames,
		onLessonExtracted: (toolName, consecutiveFailures, lastError) => {
			reflectionEngine.addLesson({
				taskType: `host-tool:${toolName}`,
				rootCause: "transient",
				lesson: `宿主工具 ${toolName} 连续失败 ${consecutiveFailures} 次：${lastError.slice(0, 200)}`,
				suggestion: "检查该工具的依赖/参数，或暂时规避调用",
				signalDescription: `宿主工具 ${toolName} 连续失败升级`
			});
		}
	});
	hostFusion.activate();
	const service = {
		tools,
		sentinel,
		modelScheduler,
		taskExecutor,
		memory,
		llm,
		tenantManager,
		sync,
		raft,
		hotReload,
		broadcaster,
		benchmark,
		cryptoEngine,
		decisionEngine,
		reflectionEngine,
		optimizer,
		reflector,
		goalEngine,
		metaCognition,
		strategyEvolution,
		selfModel,
		metaController,
		autonomyLoop,
		worldModel,
		curiosity,
		governor,
		hostFusion,
		submitTask: (task, urgency = .8) => sentinel.ingest({
			type: "manual-task",
			description: task,
			payload: { task },
			source: "manual",
			urgency
		})
	};
	ctx.provide("scheduler", service);
	ctx.provide("schedulerTools", tools);
	ctx.effect(() => {
		return () => {
			logger.info("调度器卸载中，清理资源…");
			hostFusion.dispose();
			for (const dispose of hostToolDisposers) try {
				dispose();
			} catch {}
			autonomyLoop.stop();
			hotReload?.stop();
			raft?.stop();
			sync.stop();
			sentinel.stop();
			tenantManager.dispose();
			broadcaster?.stop();
			llm.dispose();
			memoryGraph.save();
			memory.dispose();
			logger.info("调度器资源已清理");
		};
	}, "scheduler-cleanup");
}
/**
* 插件导出（cordis 函数插件形态 + 静态元数据）
* - name：注册表显示名（Function.name 只读，须用 defineProperty）
* - Config：Schemastery 标准 schema，加载时由 cordis resolveConfig 校验并填充默认值
* - provide：向宿主声明本插件提供的服务（供加载器诊断，不改变运行时行为）
*/
const pluginEntry = apply;
Object.defineProperty(pluginEntry, "name", { value: name });
pluginEntry.Config = Config;
pluginEntry.provide = ["scheduler", "schedulerTools"];
//#endregion
export { AbstractionEngine, AgentBase, AliasMap, AppError, AutonomyLoop, BASELINE_POLICY_PARAMS, BAYES_PRIOR_STRENGTH, BELIEF_POOL, BeliefMarket, BenchmarkEngine, CHANNEL_GROUPS, CausalKernel, CircuitBreaker, CircuitBreakerRegistry, CognitiveMarket, Config, ConfigError, CryptoEngine, CryptoError, CuriosityEngine, DECAY_HALF_LIFE_DAYS, DEFAULT_ABSTRACTION_CONFIG, DEFAULT_AUTONOMY_LOOP_CONFIG, DEFAULT_BACKOFF_CONFIG, DEFAULT_CAUSAL_CONFIG, DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_CURIOSITY_CONFIG, DEFAULT_DECISION_ENGINE_CONFIG, DEFAULT_DELIBERATION_CONFIG, DEFAULT_FREE_ENERGY_CONFIG, DEFAULT_GOAL_ENGINE_CONFIG, DEFAULT_LLM_CLIENT_CONFIG, DEFAULT_METAREASONING_CONFIG, DEFAULT_META_COGNITION_CONFIG, DEFAULT_REFLECTION_CONFIG, DEFAULT_SAFETY_GOVERNOR_CONFIG, DEFAULT_SCIENTIST_CONFIG, DEFAULT_STRATEGY_EVOLUTION_CONFIG, DEFAULT_THEORIST_CONFIG, DEFAULT_WORLD_MODEL_CONFIG, DecisionEngine, DeliberationEngine, DistributedSync, ESCROW, EVIDENCE_MIN_SAMPLES, EVIDENCE_RANK_BLEND, EnergyLedger, EvolverAgent, ExecutionError, FreeEnergyEngine, GoalEngine, HotReloadEngine, INCINERATOR, JsonMemoryBackend, LEGACY_EVIDENCE_DISCOUNT, LLMClient, LLMError, LongTermMemory, MAX_POLICY_RULES, MIN_CALIBRATION_SAMPLES, MemoryAgent, MemoryError, MemoryGraph, MetaCognitionEngine, MetaCognitiveController, MigrationTool, ModelAgent, ModelScheduler, NetworkError, Optimizer, OptimizerAgent, POLICY_GENE_BOUNDS, POLICY_RULE_DELTA_BOUNDS, PolicyEvolver, PolicySimulator, ProgressBroadcaster, RaftEngine, RationalMetareasoner, ReflectionEngine, Reflector, SIGNAL_GLOBAL_SUCCESS, SIGNAL_GLOBAL_SUCCESS_ALIAS, SafetyGovernor, Sandbox, ScientistMind, SelfModel, Sentinel, SqliteMemoryBackend, StrategyEvolutionEngine, SymbiosisBridge, SymbiosisRuntime, TREASURY, TaskExecutor, TenantManager, TheoristEngine, TimeoutError, ToolError, ToolRegistry, WorldModel, abortableSleep, apply, attachDashboard, backoffDelayMs, bernoulliKL, betaEntropy, buildCalibrationFromMemory, buildEnergySankey, buildPatternFingerprint, classifyError, coalitionValue, computeHomeostasis, cosineSimilarity, createBaselinePolicy, createMemoryBackend, decayFactor, decompose, pluginEntry as default, digamma, emptyMemoryStore, evaluateMemoryCondition, evidenceRankScore, extractReplayTasks, generateAdversarialTasks, initEvidence, isTradeListener, lessonsToInsights, listingsOf, lnGamma, matchesMemoryConditions, modelAgentId, modelSignalKey, name, normalizePolicyParams, observeEvidence, parseJSONLoose, policyParamsWithinBounds, policyRuleMatches, readEvidence, renderSankeyHtml, resolveEffectiveParams, sampleBeta, sanitizeMemoryStore, scoreModelWithPolicy, segment, setChineseTokenizer, shapleyValues, sqliteAvailable, sqlitePathFor, toSparseVector, tokenizeChinese, wilsonLowerBound };
