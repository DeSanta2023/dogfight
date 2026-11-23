/**
 * GET /metrics in the Prometheus text format: one `name value` line per number, with a HELP and a
 * TYPE line above it. Prometheus (or `curl`) reads it; nothing here depends on Prometheus.
 *
 * Counters only go up (`*_total`): the monitoring system computes a rate from two readings.
 * A few rates are also published ready-made (`*_per_second`), because a person with `curl` and
 * no Prometheus wants to see "how many bytes per second" directly. A 1 s sampler computes them.
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { Config } from './config.ts';
import type { WsStats } from './ws.ts';

export interface MetricsInput {
  readonly config: Config;
  readonly version: string;
  readonly rooms: number;
  readonly players: number;
  readonly connections: number;
  readonly ws: WsStats;
  /** Step time of every running match, from Match.stepStats(). */
  readonly steps: readonly { readonly hz: number; readonly total: Step }[];
}
interface Step {
  readonly mean: number;
  readonly p99: number;
  readonly max: number;
}

export function createMetrics(read: () => MetricsInput) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let last = {
    at: performance.now(),
    elu: performance.eventLoopUtilization(),
    bytes: 0,
    messages: 0,
  };
  const rates = { bytesPerSecond: 0, messagesPerSecond: 0, eventLoopUtilization: 0 };

  const sample = () => {
    const input = read();
    const now = performance.now();
    const elu = performance.eventLoopUtilization();
    const seconds = Math.max(0.001, (now - last.at) / 1000);
    rates.bytesPerSecond = Math.round((input.ws.snapshotBytes - last.bytes) / seconds);
    rates.messagesPerSecond = Math.round((input.ws.messages - last.messages) / seconds);
    // utilization of the interval since the previous sample: 0 = idle, 1 = the loop never rests
    rates.eventLoopUtilization =
      Math.round(performance.eventLoopUtilization(elu, last.elu).utilization * 1000) /
      1000;
    last = { at: now, elu, bytes: input.ws.snapshotBytes, messages: input.ws.messages };
  };
  const timer = setInterval(sample, 1000);
  timer.unref();

  return {
    render(): string {
      const m = read();
      const mem = process.memoryUsage();
      const worst = (pick: (s: Step) => number) =>
        Math.max(0, ...m.steps.map((s) => pick(s.total)));
      const lines: string[] = [];
      const metric = (
        name: string,
        type: 'gauge' | 'counter',
        help: string,
        value: number,
        labels = '',
      ) => {
        lines.push(
          `# HELP ${name} ${help}`,
          `# TYPE ${name} ${type}`,
          `${name}${labels} ${value}`,
        );
      };
      metric(
        'dogfight_build_info',
        'gauge',
        'Build: version and git commit (the value is always 1).',
        1,
        `{version="${m.version}",git_sha="${m.config.gitSha}"}`,
      );
      metric(
        'dogfight_uptime_seconds',
        'gauge',
        'Seconds since the process started.',
        Math.round(process.uptime()),
      );
      metric(
        'dogfight_players',
        'gauge',
        'Players that are in a room right now.',
        m.players,
      );
      metric('dogfight_rooms', 'gauge', 'Rooms that exist right now.', m.rooms);
      metric(
        'dogfight_connections',
        'gauge',
        'Open WebSocket connections (also those not in a room).',
        m.connections,
      );
      metric(
        'dogfight_connections_limit',
        'gauge',
        'Configured MAX_CONNECTIONS.',
        m.config.maxConnections,
      );
      metric(
        'dogfight_ws_connections_total',
        'counter',
        'WebSocket connections accepted since start.',
        m.ws.connected,
      );
      metric(
        'dogfight_ws_messages_total',
        'counter',
        'Messages received from clients.',
        m.ws.messages,
      );
      metric(
        'dogfight_ws_messages_per_second',
        'gauge',
        'Messages received per second (last second).',
        rates.messagesPerSecond,
      );
      metric(
        'dogfight_ws_dropped_total',
        'counter',
        'Snapshots skipped for slow clients.',
        m.ws.dropped,
      );
      metric(
        'dogfight_bad_frames_total',
        'counter',
        'Game frames that failed to decode.',
        m.ws.badGameFrames,
      );
      metric('dogfight_inputs_total', 'counter', 'Player inputs received.', m.ws.inputs);
      metric(
        'dogfight_snapshots_sent_total',
        'counter',
        'Snapshots sent to players.',
        m.ws.snapshots,
      );
      metric(
        'dogfight_bytes_sent_total',
        'counter',
        'Snapshot bytes sent to players.',
        m.ws.snapshotBytes,
      );
      metric(
        'dogfight_bytes_sent_per_second',
        'gauge',
        'Snapshot bytes sent per second (last second).',
        rates.bytesPerSecond,
      );
      lines.push(
        '# HELP dogfight_ws_closes_total Connections closed, by WebSocket close code.',
        '# TYPE dogfight_ws_closes_total counter',
      );
      for (const [code, count] of Object.entries(m.ws.closes))
        lines.push(`dogfight_ws_closes_total{code="${code}"} ${count}`);
      metric(
        'dogfight_step_ms_mean',
        'gauge',
        'Server step time, mean over the last ~10 s, slowest room.',
        worst((s) => s.mean),
      );
      metric(
        'dogfight_step_ms_p99',
        'gauge',
        'Server step time, p99 over the last ~10 s, slowest room. Budget: 33.3.',
        worst((s) => s.p99),
      );
      metric(
        'dogfight_step_ms_max',
        'gauge',
        'Server step time, max over the last ~10 s, slowest room.',
        worst((s) => s.max),
      );
      metric(
        'dogfight_tick_rate_hz',
        'gauge',
        'Lowest tick rate of any running room. Target: 30.',
        m.steps.length ? Math.min(...m.steps.map((s) => s.hz)) : 0,
      );
      metric(
        'dogfight_event_loop_utilization',
        'gauge',
        'Share of the last second the event loop was busy (0..1).',
        rates.eventLoopUtilization,
      );
      metric(
        'dogfight_event_loop_delay_p99_ms',
        'gauge',
        'p99 of how late timers fire, ms.',
        Math.round((delay.percentile(99) / 1e6) * 100) / 100,
      );
      metric('process_resident_memory_bytes', 'gauge', 'Resident set size.', mem.rss);
      metric('process_heap_used_bytes', 'gauge', 'V8 heap in use.', mem.heapUsed);
      return `${lines.join('\n')}\n`;
    },
    stop() {
      clearInterval(timer);
      delay.disable();
    },
  };
}
