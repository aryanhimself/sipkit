import { describe, expect, it, vi } from 'vitest';
import { createLogger, redact, REDACTED } from './logger';

describe('createLogger', () => {
  it('filters by level, forwards to the sink and calls console methods safely', () => {
    const sink = vi.fn();
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const log = createLogger('t', { level: 'debug', sink });
    log.child('c').debug('hi', { a: 1 });
    expect(spy).toHaveBeenCalledWith('[t:c] hi', { a: 1 });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ level: 'debug', scope: 't:c', message: 'hi' }));
    const quiet = createLogger('q', { level: 'warn', sink, console: false });
    quiet.info('nope');
    expect(sink).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('redacts secret-looking keys in log data, deeply, without mutating input', () => {
    const sink = vi.fn();
    const input = { username: '1001', password: 'hunter2', ice: [{ urls: 'turn:x', credential: 'c' }] };
    createLogger('t', { level: 'info', sink, console: false }).info('cfg', input);
    const data = sink.mock.calls[0]![0].data;
    expect(data).toEqual({ username: '1001', password: REDACTED, ice: [{ urls: 'turn:x', credential: REDACTED }] });
    expect(input.password).toBe('hunter2');
    createLogger('t', { level: 'info', sink, console: false }).info('cfg', { registerHeaders: ['Authorization: Bearer abc'] });
    expect(sink.mock.calls[1]![0].data).toEqual({ registerHeaders: REDACTED });
    const err = new Error('x');
    expect(redact(err)).toBe(err);
  });
});
