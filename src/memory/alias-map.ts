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

export class AliasMap {
  private encodeMap = new Map<string, string>();
  private decodeMap = new Map<string, string>();
  private next = 1;

  /** 为完整 ID 分配短索引（幂等），返回形如 #1 */
  encode(id: string): string {
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
  resolve(alias: string): string | undefined {
    return this.decodeMap.get(alias.startsWith('#') ? alias.slice(1) : alias);
  }

  /** 将文本中的完整 ID 替换为短索引（按 ID 长度降序，避免前缀误替换） */
  encodeText(text: string): string {
    let out = text;
    for (const id of [...this.encodeMap.keys()].sort((a, b) => b.length - a.length)) {
      out = out.split(id).join(this.encodeMap.get(id)!);
    }
    return out;
  }

  /** 将文本中的短索引反向解析回完整 ID（未登记的索引原样保留） */
  decodeText(text: string): string {
    return text.replace(/#(\d+)/g, (match, n: string) => this.decodeMap.get(n) ?? match);
  }

  /** 当前映射条目（调试/日志） */
  entries(): Array<{ alias: string; id: string }> {
    return [...this.encodeMap.entries()].map(([id, alias]) => ({ alias, id }));
  }

  get size(): number {
    return this.encodeMap.size;
  }
}
