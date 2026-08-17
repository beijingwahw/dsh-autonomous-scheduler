# dsh-proactive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.18-339933?logo=nodedotjs&logoColor=white)](#installation)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-8250df)](https://github.com/topics/dsh-plugin)

> **Proactive Intelligence scheduling plugin** — a multi-model collaborative scheduling system for the DeepSeek Harness (DSH) ecosystem: it perceives, decides, and evolves on its own, with a built-in **Scientist / Theorist dual mind** and a **cognitive energy symbiosis economy**.
>
> English | [中文](./README.md)

## What is Proactive Intelligence?

Traditional schedulers are **reactive**: they respond only when a signal arrives and idle otherwise. On top of the "perceive → decide → execute → reflect → consolidate" loop, this plugin adds an autonomy layer so the system:

- **When idle**, actively observes its own runtime state, discovers bottlenecks, and generates improvement goals
- **Facing unknown territory**, actively launches explorations, turning "unknown" into "experienced"
- **Anticipating future load**, actively predicts signal arrival trends and reserves capacity ahead of time
- **On anomalies**, actively trips circuit breakers, rate-limits, and degrades — instead of waiting to crash

## Architecture Overview

The system has three tiers: the **kernel stack** (a substrate of minds sharing one statistical language), **three-loop autonomy** (operational loop / evolution loop / meta-cognition outer loop), and the **symbiosis economy layer** (a cognitive energy market).

```
┌─ Symbiosis Economy (symbiosis/) ─────────────────────────────┐
│  Energy Ledger (double-entry · chained audit)                │
│  Knowledge Market (continuous double auction · royalties)    │
│  Belief Market (LMSR · market as mind)                       │
│  Agents (reputation · legislation/enforcement split)         │
│  Symbiosis Runtime (survive→propose→veto→match→execute)      │
├─ Three-Loop Autonomy ────────────────────────────────────────┤
│  Operational: signal→decide→execute→reflect 10-step pipeline │
│  Evolution: policy evolver + sandbox + canary (policy/)      │
│  Meta outer: self-model → conservative tune → rollback (meta/)│
├─ Kernel Stack (core/) — nine kernels, 3.0 → 11.0 ────────────┤
│  Evidence 3.0  Resilience 4.0  Causal 5.0  Free-Energy 6.0   │
│  Deliberation 7.0  Metareasoning 8.0  Abstraction 9.0        │
│  Scientist 10.0  Theorist 11.0                               │
└──────────────────────────────────────────────────────────────┘
```

## Core Features

### Proactive Perception & Autonomous Decision-Making
- Sentinel multi-source signal ingestion (webhook / filesystem watch / polling / manual injection), aggregation-window dedup and urgency ranking
- Strategic decision engine: execute / defer / dismiss / ask-user, continuously calibrated by statistical learning (time decay + Wilson lower bound + UCB cold start)
- Experience retrieval + DAG plan generation + multi-model parallel execution, a 10-step unidirectional pipeline

### Scientist / Theorist Dual Mind
- **Scientist kernel** ([core/scientist.ts](./src/core/scientist.ts)): Bayesian optimal experiment design — pricing "knowledge acquisition itself". True EIG (nats) to value an experiment's information, confounding bonus (experiment-exclusive value), budget arbitration (netValue = EIG − cost), information-ledger calibration, knowledge-frontier contraction
- **Theorist kernel** ([core/theorist.ts](./src/core/theorist.ts)): hierarchical Bayes + MDL (understanding as compression) — compressing data into laws. Same-family edges converge into laws (borrowing-strength shrinkage), compression pricing (log Bayes factor), zero-shot prediction, anomaly detection, paradigm shifts (Kuhn leap)

### Kernel Stack (core/, 3.0 → 11.0)
| Kernel | Version | In one line |
|------|------|--------|
| evidence.ts | 3.0 | Unified evidence language: Wilson bounds / time decay / evidence ranking, spread across all memory layers |
| resilience.ts | 4.0 | Resilient execution: circuit-breaker state machine / full-jitter exponential backoff / error typing |
| causal-kernel.ts | 5.0 | Causal inference: Pearl do-intervention ATE / confounding detection / counterfactual queries |
| free-energy.ts | 6.0 | Active inference: Friston free energy, one formula unifying exploit/explore/curiosity/health |
| deliberation.ts | 7.0 | Planning as inference: imagined rollouts + beam search × skill macros + dream reconciliation |
| metareasoning.ts | 8.0 | Rational metareasoning: dual-process arbitration / anytime stable stopping / thinking priced in nats |
| abstraction.ts | 9.0 | Abstraction: state-skeleton decomposition + structural analogy, cross-domain "learning by analogy" |
| scientist.ts | 10.0 | Scientist mind: Bayesian optimal experiment design (see above) |
| theorist.ts | 11.0 | Theorist mind: hierarchical Bayes + MDL law induction (see above) |

### Cognitive Energy Symbiosis Economy (symbiosis/)
- **Energy ledger** (ledger.ts): cognitive energy cannot be forged — global conservation via double-entry bookkeeping, every transfer sha256-chained for audit and replay, a Gini coefficient measures ecosystem health
- **Knowledge market** (market.ts): knowledge as a tradeable asset in a continuous double auction; listing fees burned against spam, central bank pays post-sale royalties, low-quality knowledge is naturally eliminated by evidence calibration
- **Belief market** (belief.ts): an LMSR market maker turns "judgments about the future" into tradeable assets — the market as a mind; informed agents arbitrage the wrong, settlement is the audit, incentives are compatible
- **Agent contracts** (agent.ts): perception / proposal / execution separated (legislation–enforcement split), reputation reuses the Wilson lower bound — contribution determines dividends, poor performers starve into dormancy
- **Symbiosis runtime** (runtime.ts): heartbeat orchestration (survive → perceive → propose → regulator veto → match → authorized execute), successful tasks mint dividends weighted by Wilson, balances below the survival line trigger dormancy, regulator holds a one-vote veto; **mounted in shadow mode, never taking over the main pipeline**
- **Host fusion bridge** (bridge.ts): three thin touchpoints — KPI injection into the energy economy, task settlement minting dividends, futarchy evolution voting — off by default, zero drift
- **First agents** (wrappers.ts): MemoryAgent (seller + maintainer) / OptimizerAgent (buyer) / EvolverAgent (strategy-gene seller), forming the minimal closed cognitive economy
- **Observability** (observability.ts): aggregates ledger vouchers into a Sankey panorama of energy flows, rendered offline as self-contained HTML (see [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html))

### Self-Reflection & Evolution
- Goal engine: generates goals from insights and decomposes them into subtasks
- Quality reflection engine: auto-retry / model switching below threshold, with the threshold self-calibrating against the quality distribution
- Meta-cognition layer (meta/): the self-model engine produces four-view mental reports (strategy performance / memory health / evolution efficiency / system stability); the meta-controller tunes conservatively (one step per round, observation window, rollback on regression)
- Strategy evolution: genetic algorithms evolve decision genes + the policy evolver (policy/) with population evolution, multi-seed sandbox evaluation, LCB gating, canary hot-swap, and automatic rollback
- Long-term memory: task patterns, model profiles, and lessons persisted across sessions

### Memory System & Retrieval Augmentation
- **Three-layer memory + knowledge distillation**: episodic → semantic / procedural memory, watermark-gated distillation, stable ids, evidence merging with conflict resolution
- **SQLite persistence**: zero-dependency on Node's built-in `node:sqlite` — relational tables (`task_patterns` / `model_profiles` / `decision_feedback` + `distilled_strategies` / `meta`), WAL, versioned migrations, and maintenance APIs (integrity check / hot backup / vacuum / read-only SQL channel); automatically falls back to a JSON atomic-write backend when encryption is on or the host lacks `node:sqlite` ([memory/backend.ts](./src/memory/backend.ts))
- **Hybrid retrieval**: FTS5 dual tokenization (trigram Chinese substrings + token-level) + sparse TF-vector cosine + memory-graph association, merged via four-way recall (`optimizer.hybridSearch`)
- **Memory graph**: co-occurrence network and topic tree serialized to JSON across restarts ([memory/memory-graph.ts](./src/memory/memory-graph.ts))
- **Anti-hallucination short indices**: long IDs become `#1…` short indices before LLM injection and are decoded back afterwards ([memory/alias-map.ts](./src/memory/alias-map.ts))

### Engineering Infrastructure
- Raft consensus, distributed sync, hot reload, AES-256-GCM encrypted storage
- Multi-tenancy, benchmark engine, zero-dependency WebSocket progress (native RFC 6455), visual dashboard
- 18 registered tools, plus a host-fusion layer for whole-host observability and safety governance

## Autonomy Loop

Each heartbeat runs an 11-step orchestration ([autonomy-loop.ts](./src/autonomy-loop.ts)):

1. **Meta-cognition observation** — collect KPIs, surface anomaly insights
2. **1.5 Symbiosis heartbeat** — inject KPIs into the energy economy + belief market
3. **World-model foresight** — predict signal arrivals, capture rising trends
4. **Merge reflection lessons** — consolidate lessons from the reflection engine, skipping digested ones
5. **Goal generation** — auto-create improvement goals from insights and decompose subtasks
6. **Subtask dispatch** — inject into execution after safety governance review
7. **Curiosity exploration** — spare budget spent on knowledge-gap exploration
8. **Strategy evolution** — evolve decision strategies via genetic algorithm
9. **7.5 Policy evolver** — scheduling policies sandbox-verified, then canary hot-swapped
10. **7.7 Meta-cognition loop** — self-model → conservative adjustment → observe / rollback (low frequency)
11. **8. Memory maintenance** — experience distillation + forgetting curve (low-frequency background)

## Three Pathways to "Smarter with Use" (missing any one degrades to a static system)

1. **Experience-driven model selection**: recommended model combinations actually participate in node assignment by node type (`Optimizer.lookupExperience → ModelScheduler.assignModel`), not merely as prompt hints
2. **Strategy feedback calibration**: distilled strategies write back application success rates by execution outcome — effective strategies grow stronger with use, ineffective ones are naturally eliminated
3. **Experience fast path**: matching a high-confidence pattern (default ≥ 0.9, tunable via `memoryFastPathThreshold`) directly recalls the best historical successful plan (`Optimizer.recallPlan`), skipping LLM re-planning — faster, more stable, and cheaper on tokens with every use

Three hedging mechanisms (safety valves against "learning the wrong things"):

1. **Forgetting curve**: long-unused memories decay in confidence per an Ebbinghaus model until fully forgotten; decay is idempotent on a `lastDecayAt` baseline
2. **Confidence decay**: successes add, failures subtract; long-unverified strategies decay and are pruned
3. **Threshold self-calibration**: high quality distributions tighten the threshold, low ones relax it, avoiding futile retry storms

## Installation

Requirements: Node.js `^22.18.0 || >=24.11.0`, pnpm.

```bash
git clone https://github.com/beijingwahw/dsh-proactive.git
cd dsh-proactive
pnpm install
pnpm build
```

## Configuration (Zero Manual Setup)

**Works out of the box — no manual model or key configuration required, and the plugin itself never holds an API Key.**

- The bundled [cordis.patch.yml](./cordis.patch.yml) already packages all domestic models (DeepSeek / Qwen / Zhipu GLM / Kimi / MiniMax / iFlytek Spark / Tencent Hunyuan / Baidu ERNIE / SenseTime SenseChat); load and run;
- At runtime the plugin obtains the configured LLM client from the ctx context, and DSH automatically injects the user-configured Key (Web UI or environment variables) into request headers;
- **Automatic key pickup**: the plugin also reads host-local keys and fills them into request headers by vendor, with priority host ctx injection → process environment variables (e.g. `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`, matched by model id prefix) → DSH local config files (`~/.dsh/config.json`, etc., hot-reloaded on mtime change and re-probed periodically when absent); keys stay in memory only — never persisted or logged;
- **Multi-key failover**: when several candidate keys exist for a vendor, auth failures (401/403) or quota exhaustion (429) automatically rotate to the next candidate key, upgraded with **health-aware routing** — keys are selected by success/failure statistics, with a 1-minute cooldown for 429 and a 5-minute cooldown for 401/403, auto-recovering on success; users can reorder key usage via the `manage_keys` tool (persisted across restarts); startup logs report each model's key sources (never the key values), and runtime key health is inspectable via `query_memory keys`;
- For a single vendor only, use the per-vendor patches under `patches/domestic-models/`; regenerate with `pnpm generate:patches`.

All runtime options (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy loop `autonomy` / host fusion `hostFusion`) are likewise built into [cordis.patch.yml](./cordis.patch.yml) and need no changes; symbiosis options live under `autonomy.symbiosis` (futarchy voting, energy feedback, etc., off by default).

## Tool Catalog (18)

| Group | Tools |
|------|------|
| Execution & scheduling | `autonomous_execute` · `model_dashboard` · `run_benchmark` |
| Memory & knowledge | `query_memory` · `query_experience` · `distill_knowledge` · `maintain_memory` · `memory_migration` |
| Meta-cognition | `mental_report` · `self_knowledge` · `meta_cognition` |
| Autonomy governance | `manage_autonomy` · `manage_keys` |
| Infrastructure | `manage_tenants` · `manage_encryption` · `manage_sync` · `manage_consensus` · `manage_hot_reload` |

Get the seven-dimension introspection report via `manage_autonomy`:

```jsonc
// Call: manage_autonomy { "action": "introspect" }
// Response (excerpted example):
{
  "loop":      { "running": true, "tickCount": 42 },
  "health":    { "score": 0.86 },
  "goals":     { "active": 3 },
  "exploration": { "totalExplorations": 5 },
  "governance":  { "circuitState": "closed" },
  "worldModel":  { "types": 4 },
  "evolution":   { "generation": 7 }
}
```

Other common operations:

- `manage_autonomy`: `start` / `stop` / `tick` / `kill-switch` / `revive` / `reset-circuit`
- `query_memory`: `world-model` / `curiosity` / `governance` / `patterns` / `lessons` / `keys`, etc.

## Offline Verification (24, zero API keys)

Every kernel and subsystem has an offline end-to-end verification script (`node scripts/verify-*.mjs`):

```bash
node scripts/verify-scientist.mjs      # Scientist: EIG pricing / budget arbitration / frontier contraction
node scripts/verify-theorist.mjs       # Theorist: law induction / zero-shot prediction / paradigm shift
node scripts/verify-symbiosis.mjs      # Symbiosis: ledger / market / 3-agent 6-heartbeat closed loop
node scripts/verify-self-evolution.mjs # Self-evolution: adoption / fast path / three hedging mechanisms
```

| Group | Scripts |
|------|------|
| Dual mind | verify-scientist · verify-theorist |
| Kernel stack | verify-unified-evidence · verify-resilience-governance · verify-causal-kernel · verify-active-inference · verify-deliberation · verify-metareasoning · verify-abstraction |
| Symbiosis economy | verify-symbiosis · verify-symbiosis-bridge · verify-belief-market · verify-futarchy · verify-energy-feedback · verify-full-agents · verify-observability |
| Learning & evolution | verify-self-evolution · verify-self-evolution-v2 · verify-knowledge-distillation · verify-policy-evolution · verify-meta-cognition · verify-meta-cognition-v2 · verify-meta-edge · verify-consensus-sync |

Energy-flow visualization: open [symbiosis-sankey-demo.html](./symbiosis-sankey-demo.html) in a browser (zero-dependency, self-contained page).

## DSH Plugin Spec Compliance

This plugin follows the DeepSeek Harness (cordis) plugin development spec, with the following spec-compliance improvements made without impacting performance:

- **Function plugin shape + static metadata**: the default export is an `apply(ctx, config)` function plugin carrying `name` / `Config` / `provide` static metadata for the registry and loaders;
- **Schemastery Config schema**: `Config` is a standard schema; on load, cordis `resolveConfig` validates types and fills defaults automatically (sentinel / encryption / sync / consensus / hot reload / tenants / autonomy sections). Function-typed injection fields (`nodeRunner` / `judge` / `llm.fetchImpl`, etc.) and nested symbiosis config pass through as extra properties, unaffected by validation;
- **Official Tool registration path**: when the host loads `@deepseek-ai/dsh-tools` (the `ctx.tools` service), the 18 tools are bridged via duck-typing into the official ToolRegistry, joining the pre/around/post execution pipeline and the model-visible surface (parameters converted to the official JSON Schema subset); when the host does not provide it, the plugin silently degrades to the internal ToolRegistry + `ctx.provide('schedulerTools')`, without pulling in the full agent stack;
- **Dependency injection & service declaration**: services are exposed via `ctx.provide('scheduler' / 'schedulerTools')`, with TypeScript declaration merging (`declare module '@deepseek-ai/cordis'`) typing the `Context`;
- **Lifecycle cleanup**: all resources are cleaned up in reverse dependency order via `ctx.effect` on fiber unload (including official tool unregistration);
- **Publish manifest**: `package.json` declares `dsh.bundle.patch` pointing to the [cordis.patch.yml](./cordis.patch.yml) bundle config layer, with complete `exports` / `files` / `engines` / `keywords`, and a `prepare` script ensuring install-time build.

## Host Fusion Layer

Beyond spec compliance, the plugin fuses deeply into the host runtime via cordis cross-fiber events, elevating from a "passive plugin" to a **host-level cognitive & safety layer** (auto-activates when the host loads `@deepseek-ai/dsh-tools`, silently degrades otherwise):

- **Whole-host observability** (`tools/result`, emit): observes every host tool call outcome — each call feeds the world model's `observeArrival` to learn host behavior rhythms (enhanced foresight); tool failures inject a `host-tool-failure` signal into the sentinel, triggering the decision pipeline's self-healing; when the same tool fails consecutively past a threshold (default 3), it auto-escalates: a high-urgency signal plus a lesson persisted to the reflection engine;
- **Whole-host safety governance** (`tools/pre-execute`, waterfall): the scheduler's safety governor gains veto power over the host pipeline — when the kill switch is engaged it freezes all host tool calls (emergency stop escalates from "freezing itself" to "freezing the host"); when the scheduler's own failure spiral trips the circuit breaker it fail-closed rejects host actions; read-only gating (`checkGate`) that consumes no rate-limit/budget;
- **Safety design**: observation is fail-open (its own errors never break the host pipeline), governance is fail-closed (rejects only in explicit unsafe states); self-excludes the scheduler's own 18 bridged tools to avoid feedback loops; zero new dependencies (structural types + declaration merging).

Config section `hostFusion`: `enabled` / `observeToolResults` / `governToolCalls` / `failureEscalationThreshold` (defaults `true / true / true / 3`).

## Project Structure

```
├── cordis.patch.yml              # Bundle config layer (dsh.bundle.patch target, all domestic models, zero keys)
├── symbiosis-sankey-demo.html    # Cognitive-ecosystem energy-flow Sankey panorama (zero-dependency, self-contained)
├── patches/domestic-models/      # Optional per-vendor patches (9 vendors + all-domestic.yml)
├── scripts/                      # Patch generator + 24 offline verification scripts
└── src/
    ├── index.ts                  # Plugin entry: 10-step pipeline orchestration + 18 tool registrations
    ├── types.ts / errors.ts      # Shared type layer / unified error hierarchy (stable machine-readable codes)
    ├── contracts.ts              # Three-pillar interface contracts (IMemoryStore / IReflector / IOptimizer)
    ├── llm-client.ts             # Unified LLM calls: timeout / exponential backoff / concurrency semaphores / cost stats
    ├── progress-ws.ts            # Zero-dependency WebSocket progress broadcast (native RFC 6455)
    ├── sentinel.ts               # Signal perception: multi-source ingestion + aggregation window
    ├── decision-engine.ts        # Strategic decisions: four-level decisions + statistical-learning calibration
    ├── model-scheduler.ts        # Model scheduling: capability × memory weighting × cost awareness × energy feedback
    ├── task-executor.ts          # Task execution: DAG parallelism + quality-reflection retry + cascading
    ├── optimizer.ts              # Optimizer: experience retrieval + hybrid search + fast-path plan recall
    ├── reflector.ts              # Reflector: review + memory update + strategy feedback + distillation
    ├── reflection-engine.ts      # Quality reflection engine: threshold self-calibration / lesson extraction
    ├── goal-engine.ts            # Goal engine: insights → goals → subtasks
    ├── world-model.ts            # World model: arrival prediction / trend detection / calibration (MAE)
    ├── curiosity-engine.ts       # Curiosity engine: knowledge-gap scanning / adaptive exploration budget
    ├── safety-governor.ts        # Safety governor: rate limiting / budgets / circuit breaker / confidence gating / kill switch
    ├── meta-cognition.ts         # Meta-cognition monitoring
    ├── strategy-evolution.ts     # Strategy evolution: genetic algorithms evolving decision genes
    ├── autonomy-loop.ts          # Autonomy loop: 11-step heartbeat orchestration
    ├── host-fusion.ts            # Host fusion layer: whole-host observability + safety governance
    ├── dsh-host.ts               # DSH host integration: LLM client / model catalog / key injection
    ├── core/                     # Kernel stack: nine kernels from evidence 3.0 to theorist 11.0
    ├── meta/                     # Meta-cognition layer: self-model + meta-controller (dual-loop outer ring)
    ├── policy/                   # Policy evolver + sandbox: population evolution / canary deployment
    ├── symbiosis/                # Cognitive energy symbiosis: ledger / market / belief market / agents / runtime / Sankey
    ├── memory/                   # Long-term memory: SQLite/JSON dual backend + memory graph + alias map + migration
    ├── consensus/                # Raft consensus
    ├── sync/                     # Distributed sync
    ├── hot-reload/               # Hot reload
    ├── security/                 # Crypto engine (AES-256-GCM)
    ├── tenant/                   # Multi-tenancy
    ├── benchmark/                # Benchmark engine
    └── dashboard/                # Visual dashboard
```

## License

[MIT](./LICENSE)
