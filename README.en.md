# dsh-autonomous-scheduler

> **Proactive Intelligence scheduling plugin** — the system no longer waits passively for instructions; it perceives, decides, and evolves on its own.
>
> English | [中文](./README.md)

## What is Proactive Intelligence?

Traditional schedulers are **reactive**: they respond only when a signal arrives and idle otherwise. This plugin gives the system **proactive intelligence**:

- **When idle**, the system actively observes its own runtime state, discovers bottlenecks, and generates improvement goals
- **Facing unknown territory**, the system actively launches explorations, turning "unknown" into "experienced"
- **Anticipating future load**, the system actively predicts signal arrival trends and reserves capacity ahead of time
- **On anomalies**, the system actively trips circuit breakers, rate-limits, and degrades — instead of waiting to crash

Proactive Intelligence = the perpetual loop of **perceive → decide → execute → reflect → consolidate**, plus three proactive pillars:

| Pillar | Module | Proactive Capability |
|--------|--------|----------------------|
| Foreseeing | `world-model.ts` | Learns signal arrival patterns, predicts future load, detects rising trends |
| Curiosity | `curiosity-engine.ts` | Scans knowledge gaps, autonomously generates exploration tasks |
| Boundaries | `safety-governor.ts` | Rate limiting, budgeting, circuit breaking, confidence gating, kill switch |

## Core Features

### Proactive Perception
- Sentinel multi-source signal ingestion (webhook / filesystem watch / polling / manual injection)
- Aggregation window deduplication & merging, urgency-based ranking

### Autonomous Decision-Making
- Strategic decision engine: execute / defer / dismiss / ask-user
- Experience retrieval + DAG plan generation + multi-model parallel execution
- Decision caching and feedback loop

### Self-Reflection & Evolution
- Goal engine: generates goals from insights and decomposes them into subtasks
- Reflection engine: auto-retry / model switching when quality falls below threshold
- Meta-cognition engine: continuous KPI health monitoring with self-tuning
- Strategy evolution engine: genetic algorithm evolving optimal decision genes
- Long-term memory: task patterns, model profiles, and lessons persisted across sessions

### The Three Pillars of Proactive Intelligence
- **World Model**: arrival rate statistics, hourly histograms, arrival prediction (with confidence intervals), trend detection, prediction calibration (MAE)
- **Curiosity Engine**: knowledge gap scanning (unexplored / low-experience / high-failure), novelty scoring, health-adaptive exploration budget
- **Safety Governor**: per-minute rate limiting, token/cost budgets, circuit breaker (consecutive failures → cooldown → half-open), confidence gating, kill switch, audit logging

### Engineering Infrastructure
- Raft consensus, distributed sync, hot reload, AES-256 encrypted storage
- Multi-tenancy, benchmark engine, real-time progress WebSocket, visual dashboard
- 13 registered tools, including `introspect` seven-dimension self-awareness report

## Autonomy Loop

Each heartbeat executes an 8-step orchestration:

1. Meta-cognition observation — collect KPIs, surface anomaly insights
2. World model forecasting — predict signal arrivals, capture rising trends
3. Insight aggregation — merge lessons from the reflection engine
4. Goal generation — auto-create improvement goals from insights and decompose subtasks
5. Subtask dispatch — inject into execution after safety governance review
6. Curiosity exploration — spare capacity spent on knowledge gap exploration
7. Strategy evolution — evolve decision strategies via genetic algorithm
8. Memory maintenance — experience distillation + forgetting curve

## Quick Start

```bash
npm install
npm run build
```

Configure models and signal sources in `cordis.yml`, then load the plugin. Control the autonomy loop via the `manage_autonomy` tool:

- `start` / `stop` — start/stop the autonomy loop
- `tick` — manually execute one heartbeat
- `introspect` — get the seven-dimension introspection report
- `kill-switch` / `revive` — emergency stop / recovery
- `reset-circuit` — reset the circuit breaker

Query via the `query_memory` tool: `world-model` / `curiosity` / `governance` / `introspect`, etc.

## Project Structure

```
src/
├── index.ts                  # Plugin entry & 10-step pipeline orchestration
├── sentinel.ts               # Signal perception
├── decision-engine.ts        # Strategic decision-making
├── executor.ts               # Plan generation & parallel execution
├── reflection-engine.ts      # Quality reflection
├── goal-engine.ts            # Goal engine
├── meta-cognition.ts         # Meta-cognition monitoring
├── strategy-evolution.ts     # Strategy evolution
├── world-model.ts            # World model (foreseeing)
├── curiosity-engine.ts       # Curiosity engine (intrinsic motivation)
├── safety-governor.ts        # Safety governor (boundaries)
├── autonomy-loop.ts          # Autonomy loop orchestration
├── memory/                   # Long-term memory & migration
├── consensus/                # Raft consensus
├── sync/                     # Distributed sync
├── hot-reload/               # Hot reload
├── security/                 # Crypto engine
├── tenant/                   # Multi-tenancy
├── benchmark/                # Benchmark engine
└── dashboard/                # Visual dashboard
```

## License

MIT
