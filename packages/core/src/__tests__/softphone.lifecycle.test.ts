import { describe, expect, it, vi } from 'vitest';
import { createTestSoftphone, FakeEngine } from '../testing';
import { createSoftphone } from '../softphone';
import { createMemoryStorage } from '../storage';
import { ConfigError } from '../config';
import { isSoftphoneError } from '../errors';
import type { AppState } from '../types';

describe('Softphone lifecycle', () => {
  it('goes loading -> ready -> started and auto-registers', async () => {
    const engine = new FakeEngine();
    const softphone = createSoftphone({
      config: { username: '1001', websocketUrls: ['wss://pbx.test/ws'] },
      engine: () => engine,
      storage: createMemoryStorage(),
      mediaDevices: null,
      console: false,
    });
    const states: AppState[] = [];
    softphone.on('app:state', ({ state }) => states.push(state));
    expect(softphone.getSnapshot().app).toBe('loading');
    await softphone.start();
    expect(states).toEqual(['ready', 'started']);
    expect(softphone.getSnapshot().registration.state).toBe('registered');
    expect(softphone.getSnapshot().engine).toBe('fake');
    expect(engine.commandsFor('register')).toHaveLength(1);
    expect(softphone.config.domain).toBe('pbx.test');
  });

  it('does not register when autoRegister is false', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { autoRegister: false } });
    expect(engine.commandsFor('register')).toHaveLength(0);
    expect(softphone.getSnapshot().registration.state).toBe('connecting');
    await softphone.register();
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('getSnapshot is referentially stable until state changes', async () => {
    const { softphone } = await createTestSoftphone();
    const a = softphone.getSnapshot();
    expect(softphone.getSnapshot()).toBe(a);
    expect(softphone.getSnapshot()).toBe(a);
    await softphone.call('1002');
    expect(softphone.getSnapshot()).not.toBe(a);
    expect(Object.isFrozen(softphone.getSnapshot())).toBe(true);
  });

  it('subscribe notifies with new snapshots and can unsubscribe', async () => {
    const { softphone } = await createTestSoftphone();
    const listener = vi.fn();
    const off = softphone.subscribe(listener);
    await softphone.call('1002');
    expect(listener).toHaveBeenCalled();
    expect(listener.mock.lastCall?.[0]).toBe(softphone.getSnapshot());
    off();
    listener.mockClear();
    await softphone.hangup();
    expect(listener).not.toHaveBeenCalled();
  });

  it('starts without credentials and connects after updateConfig supplies them', async () => {
    const { softphone, engine } = await createTestSoftphone({
      config: { username: '', websocketUrls: [] },
    });
    expect(softphone.getSnapshot().app).toBe('started');
    expect(engine.started).toBe(false);
    await expect(softphone.register()).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS' });
    await softphone.updateConfig({ username: '1001', websocketUrls: ['wss://pbx.test/ws'] });
    expect(engine.started).toBe(true);
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('stop() hangs up calls, unregisters and stops the engine', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await softphone.call('1002');
    await softphone.stop();
    expect(engine.commandsFor('hangup')).toHaveLength(1);
    expect(engine.commandsFor('unregister')).toHaveLength(1);
    expect(engine.commandsFor('stop')).toHaveLength(1);
    expect(softphone.getSnapshot()).toMatchObject({ app: 'stopped', calls: [], registration: { state: 'idle' } });
    await expect(softphone.call('1')).rejects.toMatchObject({ code: 'NOT_STARTED' });
    await softphone.start();
    expect(softphone.getSnapshot().app).toBe('started');
  });

  it('destroy() stops, disposes plugins and rejects further use', async () => {
    const dispose = vi.fn();
    const { softphone } = await createTestSoftphone({
      plugins: [{ id: 'p', setup: () => ({ dispose }) }],
    });
    await softphone.destroy();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(softphone.start()).rejects.toMatchObject({ code: 'DESTROYED' });
    expect(() => softphone.setActiveCall('x')).toThrowError(/destroyed/);
    await softphone.destroy(); // idempotent
  });

  it('throws ConfigError for invalid config', () => {
    expect(() =>
      createSoftphone({ config: { websocketUrls: ['not a url'] }, engine: () => new FakeEngine(), console: false }),
    ).toThrow(ConfigError);
  });

  it('reports engine start failures as ENGINE_ERROR and app error', async () => {
    const engine = new FakeEngine();
    engine.failNext('start', new Error('boom'));
    const { softphone } = await createTestSoftphone({ engine, start: false });
    const err = await softphone.start().catch((e: unknown) => e);
    expect(isSoftphoneError(err, 'ENGINE_ERROR')).toBe(true);
    expect(softphone.getSnapshot().app).toBe('error');
    expect(softphone.getSnapshot().registration.state).toBe('failed');
  });

  it('forwards log entries as events', async () => {
    const { softphone, engine } = await createTestSoftphone({ start: false });
    const logs = vi.fn();
    softphone.on('log', logs);
    await softphone.start();
    engine.simulateRegistrationFailure();
    expect(logs).toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('reflects engine registration failures and emits a notification', async () => {
    const { softphone, engine } = await createTestSoftphone();
    const notification = vi.fn();
    const regEvents = vi.fn();
    softphone.on('notification', notification);
    softphone.on('registration:state', regEvents);
    engine.simulateRegistrationFailure(403, 'Forbidden');
    expect(softphone.getSnapshot().registration).toEqual({ state: 'failed', code: 403, reason: 'Forbidden' });
    expect(notification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', title: 'Registration failed', code: 'registrationFailed' }));
    expect(regEvents).toHaveBeenCalledWith({ state: 'failed', code: 403, reason: 'Forbidden' });
  });

  it('maps transport state to registration state', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.simulateTransportState('disconnected', 'socket closed');
    expect(softphone.getSnapshot().registration).toEqual({ state: 'unregistered', reason: 'socket closed' });
    engine.simulateTransportState('connecting');
    expect(softphone.getSnapshot().registration.state).toBe('connecting');
    engine.simulateRegistered();
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('register failure from the engine throws ENGINE_ERROR', async () => {
    const { softphone, engine } = await createTestSoftphone({ config: { autoRegister: false } });
    engine.failNext('register');
    await expect(softphone.register()).rejects.toMatchObject({ code: 'ENGINE_ERROR' });
    expect(softphone.getSnapshot().registration.state).toBe('failed');
  });

  it('unregister calls the engine', async () => {
    const { softphone, engine } = await createTestSoftphone();
    await softphone.unregister();
    expect(engine.commandsFor('unregister')).toHaveLength(1);
    expect(softphone.getSnapshot().registration.state).toBe('unregistered');
  });

  it('requires start() before register()', async () => {
    const { softphone } = await createTestSoftphone({ start: false });
    await expect(softphone.register()).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });
});

describe('updateConfig', () => {
  it('restarts the engine and re-registers when credentials change', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.clearCommands();
    await softphone.updateConfig({ password: 'new' });
    expect(engine.commands.map((c) => c.method)).toEqual(['unregister', 'stop', 'start', 'register']);
    expect(softphone.config.password).toBe('new');
    expect(softphone.getSnapshot().registration.state).toBe('registered');
  });

  it('treats registerHeaders as credentials: a new token re-registers', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.clearCommands();
    await softphone.updateConfig({ registerHeaders: ['Authorization: Bearer t2'] });
    expect(engine.commands.map((c) => c.method)).toEqual(['unregister', 'stop', 'start', 'register']);
  });

  it('does not restart for behavioural options', async () => {
    const { softphone, engine } = await createTestSoftphone();
    engine.clearCommands();
    await softphone.updateConfig({ techPrefix: '9', autoAnswer: true, logLevel: 'warn' });
    expect(engine.commands).toHaveLength(0);
    expect(softphone.config.techPrefix).toBe('9');
  });

  it('validates the merged config and keeps the old one on error', async () => {
    const { softphone } = await createTestSoftphone();
    await expect(softphone.updateConfig({ maxLines: 99 })).rejects.toBeInstanceOf(ConfigError);
    expect(softphone.config.maxLines).toBe(2);
  });

  it('refuses transport changes during a call', async () => {
    const { softphone } = await createTestSoftphone();
    await softphone.call('1002');
    await expect(softphone.updateConfig({ websocketUrls: ['wss://other.test/ws'] })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('exposes the latest config to plugins', async () => {
    let ctxConfig: () => unknown = () => undefined;
    const { softphone } = await createTestSoftphone({
      plugins: [{ id: 'cfg', setup: (ctx) => ((ctxConfig = () => ctx.config.techPrefix), {}) }],
    });
    await softphone.updateConfig({ techPrefix: '7' });
    expect(ctxConfig()).toBe('7');
  });
});
