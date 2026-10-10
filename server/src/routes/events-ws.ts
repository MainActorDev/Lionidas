/** WS /api/events — the live channel (PLAN §5). Bridges the TypedEventBus to
 *  connected clients: every bus event fans out as {type, payload} JSON.
 *  Pages subscribe by type; state derives from events (no polling). */
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';

export async function registerEventsWs(app: FastifyInstance, bus: TypedEventBus<AppEvents>): Promise<void> {
  // MUST await: routes declared with `websocket: true` only gain upgrade
  // handling from the plugin context once it has registered (official pattern).
  await app.register(websocket);

  app.get('/api/events', { websocket: true }, (connection) => {
    // @fastify/websocket handler receives SocketStream; raw ws lives on .socket
    const socket = ((connection as unknown as { socket?: WebSocket }).socket ??
      connection) as unknown as WebSocket & { on(event: 'close', cb: () => void): void };

    const OFF: Array<() => void> = [];
    const forward = <K extends keyof AppEvents & string>(type: K): void => {
      OFF.push(
        bus.on(type, (payload) => {
          try {
            socket.send(JSON.stringify({ type, payload }));
          } catch {
            // client gone — close handler unsubscribes
          }
        }),
      );
    };

    for (const t of [
      'device.changed',
      'queue.changed',
      'run.started',
      'run.freshness.checked',
      'run.phase',
      'run.plan',
      'step.started',
      'step.tap',
      'step.finished',
      'run.finished',
      'run.aborted',
      'batch.started',
      'batch.finished',
      'baseline.diff.pending',
      'baseline.diff.decided',
      'manual.session.open',
      'manual.session.tap',
      'manual.session.scroll',
      'manual.session.snapshot',
      'manual.session.finish',
      'flow.quarantined',
      'forge.traffic.hit',
      // agent surface (P3): live turn lifecycle + streaming deltas, run panel
      'agent.turn',
      'agent.workflow',
    ] as const) {
      forward(t);
    }

    socket.on('close', () => {
      for (const off of OFF) off();
    });
  });
}
