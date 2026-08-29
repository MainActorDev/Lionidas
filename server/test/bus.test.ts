import { describe, expect, it } from 'vitest';
import { createEventBus, type AppEvents } from '../src/ws/bus.ts';

describe('TypedEventBus', () => {
  it('emit reaches subscribers with payload', () => {
    const bus = createEventBus<AppEvents>();
    const seen: string[] = [];
    bus.on('app.ready', (p) => seen.push(p.version));
    bus.emit('app.ready', { version: '0.1.0' });
    expect(seen).toEqual(['0.1.0']);
  });
  it('unsubscribe stops delivery', () => {
    const bus = createEventBus<AppEvents>();
    const seen: string[] = [];
    const off = bus.on('app.ready', (p) => seen.push(p.version));
    off();
    bus.emit('app.ready', { version: 'x' });
    expect(seen).toEqual([]);
  });
  it('emit with no listeners is a no-op', () => {
    const bus = createEventBus<AppEvents>();
    expect(() => bus.emit('app.ready', { version: 'x' })).not.toThrow();
  });
});
