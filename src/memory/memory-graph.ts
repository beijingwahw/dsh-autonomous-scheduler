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

import fs from 'node:fs';
import path from 'node:path';

export interface MemoryNode {
  id: string;
  /**
   * 节点类型：
   * - pattern：任务模式（情景记忆叶节点）
   * - strategy：蒸馏策略（第一阶段既有）
   * - topic：主题树节点
   * - semantic：语义记忆节点（第二阶段，由知识蒸馏产出）
   * - procedural：程序记忆节点（第二阶段，由知识蒸馏产出）
   */
  kind: 'pattern' | 'strategy' | 'topic' | 'semantic' | 'procedural';
  label: string;
  createdAt: number;
}

export interface MemoryEdge {
  source: string;
  target: string;
  /** 共现次数 */
  cooccurrences: number;
  /** 归一化权重 0~1（cooccurrences / 5 封顶） */
  weight: number;
  lastAt: number;
}

export interface TopicNode {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  patternIds: string[];
}

interface GraphFile {
  version: 1;
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  topics: TopicNode[];
}

export class MemoryGraph {
  private nodes = new Map<string, MemoryNode>();
  private edges = new Map<string, MemoryEdge>();
  private topics = new Map<string, TopicNode>();
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.load();
  }

  private edgeKey(a: string, b: string): string {
    return [a, b].sort().join('::');
  }

  /** 确保节点存在（幂等） */
  ensureNode(id: string, kind: MemoryNode['kind'], label: string): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind, label, createdAt: Date.now() });
    }
  }

  /** 记录共现：边权重随共现次数增长（上限 1） */
  link(a: string, b: string): MemoryEdge {
    const key = this.edgeKey(a, b);
    let edge = this.edges.get(key);
    if (!edge) {
      edge = { source: key.split('::')[0], target: key.split('::')[1], cooccurrences: 0, weight: 0, lastAt: Date.now() };
      this.edges.set(key, edge);
    }
    edge.cooccurrences += 1;
    edge.weight = Math.min(1, edge.cooccurrences / 5);
    edge.lastAt = Date.now();
    return edge;
  }

  /** 图联想：按边权重返回相邻节点 id（混合检索的联想增强） */
  related(id: string, limit = 5): string[] {
    const neighbors: Array<{ id: string; weight: number }> = [];
    for (const edge of this.edges.values()) {
      if (edge.source === id) neighbors.push({ id: edge.target, weight: edge.weight });
      else if (edge.target === id) neighbors.push({ id: edge.source, weight: edge.weight });
    }
    return neighbors
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((n) => n.id);
  }

  /** 将模式挂到主题树（根主题 = taskType） */
  attachTopic(patternId: string, topicName: string, parentTopic?: string): TopicNode {
    let root = [...this.topics.values()].find((t) => t.name === topicName && t.parentId === null);
    if (!root) {
      root = { id: `topic:${topicName}`, name: topicName, parentId: null, childIds: [], patternIds: [] };
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
    this.ensureNode(patternId, 'pattern', patternId);
    this.ensureNode(root.id, 'topic', topicName);
    return root;
  }

  /** 主题树（仅根节点，含子主题与叶模式） */
  topicTree(): TopicNode[] {
    return [...this.topics.values()].filter((t) => t.parentId === null);
  }

  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  stats(): { nodes: number; edges: number; topics: number } {
    return { nodes: this.nodes.size, edges: this.edges.size, topics: this.topics.size };
  }

  /** 序列化到本地 JSON（原子写） */
  save(): void {
    const file: GraphFile = {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      topics: [...this.topics.values()],
    };
    const dir = path.dirname(this.persistPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.persistPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file), 'utf-8');
    fs.renameSync(tmp, this.persistPath);
  }

  /** 启动时从本地 JSON 加载（损坏/缺失时从空图开始） */
  private load(): void {
    if (!fs.existsSync(this.persistPath)) return;
    try {
      const file = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8')) as GraphFile;
      for (const node of file.nodes ?? []) this.nodes.set(node.id, node);
      for (const edge of file.edges ?? []) this.edges.set(this.edgeKey(edge.source, edge.target), edge);
      for (const topic of file.topics ?? []) this.topics.set(topic.id, topic);
    } catch {
      /* 损坏文件不阻塞启动 */
    }
  }
}
