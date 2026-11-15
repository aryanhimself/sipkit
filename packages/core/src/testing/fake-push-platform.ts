import type {
  PushLaunch,
  PushPermission,
  PushPlatform,
  PushSubscriptionData,
  PushWorkerConfig,
} from '../push/types';

export interface FakePushPlatformOptions {
  supported?: boolean;
  /** Initial permission (default 'default'). */
  permission?: PushPermission;
  /** Answer to `requestPermission()` (default 'granted'). */
  grant?: PushPermission;
  /** Endpoint of created subscriptions (default https://push.test/sub/<n>). */
  endpoint?: string;
  /** A launch in the "page URL". */
  launch?: Omit<PushLaunch, 'at'> & { at?: number };
}

/**
 * In-memory {@link PushPlatform}: permission prompt, subscription, worker
 * messages and the deep link, all scriptable. For unit tests and mock UIs.
 */
export class FakePushPlatform implements PushPlatform {
  supported: boolean;
  currentPermission: PushPermission;
  grant: PushPermission;
  subscription: PushSubscriptionData | null = null;
  launch: (Omit<PushLaunch, 'at'> & { at?: number }) | null;
  workerConfig?: PushWorkerConfig;
  closed: Array<string | undefined> = [];
  permissionRequests = 0;
  failSubscribe = false;
  private seq = 0;
  private readonly endpoint?: string;
  private readonly workerHandlers = new Set<(launch: Omit<PushLaunch, 'at'>) => void>();

  constructor(options: FakePushPlatformOptions = {}) {
    this.supported = options.supported ?? true;
    this.currentPermission = this.supported ? (options.permission ?? 'default') : 'unsupported';
    this.grant = options.grant ?? 'granted';
    this.endpoint = options.endpoint;
    this.launch = options.launch ?? null;
  }

  isSupported(): boolean {
    return this.supported;
  }

  permission(): PushPermission {
    return this.supported ? this.currentPermission : 'unsupported';
  }

  async requestPermission(): Promise<PushPermission> {
    this.permissionRequests++;
    this.currentPermission = this.grant;
    return this.grant;
  }

  async getSubscription(): Promise<PushSubscriptionData | null> {
    return this.subscription;
  }

  async subscribe(_workerUrl: string, _scope: string | undefined, vapidPublicKey: string): Promise<PushSubscriptionData> {
    if (this.failSubscribe) throw new Error('push service not available');
    if (!vapidPublicKey) throw new Error('missing VAPID key');
    this.subscription ??= {
      endpoint: this.endpoint ?? `https://push.test/sub/${++this.seq}`,
      expirationTime: null,
      keys: {
        p256dh: 'BOr6dFqbgY4f0kZb1s0mN3Q2bqvHkqzFvVd4o0S8PZb8n5k7Ae8l5mJxLwFz2cQyR7i3jT9uXo1pWmK4sHqEaZ0',
        auth: 'c2VjcmV0LWF1dGgta2V5IQ',
      },
    };
    return this.subscription;
  }

  async unsubscribe(): Promise<string | null> {
    const endpoint = this.subscription?.endpoint ?? null;
    this.subscription = null;
    return endpoint;
  }

  async configureWorker(_workerUrl: string, _scope: string | undefined, config: PushWorkerConfig): Promise<void> {
    this.workerConfig = config;
  }

  async closeNotifications(_workerUrl: string, _scope: string | undefined, pushCallId?: string): Promise<void> {
    this.closed.push(pushCallId);
  }

  readLaunch() {
    return this.launch;
  }

  clearLaunch(): void {
    this.launch = null;
  }

  onWorkerLaunch(handler: (launch: Omit<PushLaunch, 'at'>) => void): () => void {
    this.workerHandlers.add(handler);
    return () => this.workerHandlers.delete(handler);
  }

  /** Simulate the service worker posting a notification click to the open page. */
  simulateWorkerLaunch(launch: Omit<PushLaunch, 'at'>): void {
    for (const h of this.workerHandlers) h(launch);
  }

  appUrl(): string {
    return 'https://app.test/softphone';
  }

  userAgent(): string {
    return 'FakePushPlatform';
  }
}
