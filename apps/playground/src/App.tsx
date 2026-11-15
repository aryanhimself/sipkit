import { useEffect, useMemo, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import {
  browserNotificationsPlugin,
  callHistoryPlugin,
  contactsPlugin,
  createBrowserPushPlatform,
  createSharedSoftphone,
  createSoftphone,
  RemoteSoftphone,
  type SharedRole,
  type SharedSoftphone,
  ringtonePlugin,
  type SoftphoneApi,
  type SoftphoneConfigInput,
} from 'sipkit-core';
import { MockSoftphone } from 'sipkit-react/testing';
import {
  Softphone,
  createPseudoLocale,
  registerLocale,
  type SoftphoneExtensions,
  type SoftphoneLayout,
  type SoftphoneSlots,
  type SoftphoneTheme,
  type ThemeTokenOverrides,
} from 'sipkit-ui';

type Mode = 'mock' | 'real';
/** One softphone per browser (docs/shared-instance.md): extension host, else a leader tab. */
type InstanceMode = 'local' | 'shared';

function readInstanceMode(): InstanceMode {
  const q = new URLSearchParams(window.location.search).get('instance');
  if (q === 'shared' || q === 'local') return q;
  try {
    return localStorage.getItem('pg:instance') === 'shared' ? 'shared' : 'local';
  } catch {
    return 'local';
  }
}

/** Mock helpers the shared host lets remote tabs call (`RemoteSoftphone.debug`). */
const MOCK_DEBUG_METHODS = ['simulateIncomingCall', 'simulateRemoteHangup'];

/** Call a mock helper on a local MockSoftphone or, through the host, on a remote one. */
function simulate(phone: SoftphoneApi | null, method: string, ...args: unknown[]): void {
  if (!phone) return;
  const fn = (phone as unknown as Record<string, unknown>)[method];
  if (typeof fn === 'function' && !(phone instanceof RemoteSoftphone)) (fn as (...a: unknown[]) => unknown).apply(phone, args);
  else if (phone instanceof RemoteSoftphone) void phone.debug(method, ...args).catch(() => undefined);
}
type Brand = 'default' | 'custom';

/** "Custom brand" example: what a host passes as `themeTokens` (docs/theming.md). */
const CUSTOM_BRAND: ThemeTokenOverrides = {
  primary: '#0f766e',
  radius: '0.375rem',
  fontSans: "'Segoe UI', system-ui, sans-serif",
  callAccept: '#15803d',
  callEnd: '#b91c1c',
  accent: '#e6f4f1',
  accentForeground: '#134e4a',
  dark: {
    primary: '#2dd4bf',
    background: '#0b1416',
    card: '#101d20',
    popover: '#132427',
    muted: '#1a2c2f',
    secondary: '#1a2c2f',
    accent: '#163a36',
    accentForeground: '#ccfbf1',
    callAccept: '#22c55e',
    callEnd: '#f87171',
  },
};

// Accented right-to-left pseudo-locale for checking RTL layout (docs/i18n.md).
registerLocale(createPseudoLocale({ rtl: true }));

const DEMO_CONTACTS = [
  { name: 'Alice Johnson', number: '1002', notes: 'Sales' },
  { name: 'Bob Martinez', number: '1003', notes: 'Support' },
  { name: 'Carol Nguyen', number: '+15551234567', notes: 'Acme Corp' },
  { name: 'Dev Patel', number: '1004', notes: 'Billing' },
];

const CRM = new Map([
  ['1002', { account: 'Acme Corp', tier: 'Gold', openTickets: 2 }],
  ['5550100', { account: 'Globex', tier: 'Silver', openTickets: 0 }],
]);

declare global {
  interface Window {
    __softphone?: SoftphoneApi;
    /** Live mock instances in this tab (shared-instance e2e: only the leader has one). */
    __sipkitInstancesCreated?: number;
  }
}

/**
 * Push service for both modes (docs/push.md): localStorage `pg:push` =
 * {"serviceUrl": "http://localhost:8790", "token": "<PUSH_DEV_TOKEN or minted token>"}.
 * Set it from the "Call notifications" form in the side panel.
 */
interface PushSettingsInput {
  serviceUrl: string;
  token: string;
}

function readPushSettings(): PushSettingsInput {
  try {
    const raw = JSON.parse(localStorage.getItem('pg:push') ?? '{}') as Partial<PushSettingsInput>;
    return { serviceUrl: raw.serviceUrl ?? 'http://localhost:8790', token: raw.token ?? '' };
  } catch {
    return { serviceUrl: 'http://localhost:8790', token: '' };
  }
}

/** Push is on once a service URL was saved (off by default, so the permission prompt stays out of the way). */
function pushConfig(): SoftphoneConfigInput['push'] {
  const configured = localStorage.getItem('pg:push') !== null;
  const { serviceUrl, token } = readPushSettings();
  return { enabled: configured && Boolean(serviceUrl), serviceUrl, token };
}

/**
 * Reload-safe softphone (V2-RESUME-01, docs/resume.md). The playground keeps the
 * toggle (and, in real mode, the connect settings) in sessionStorage so a reload
 * of this tab reconnects by itself, like a host app that knows its user would.
 * DEV ONLY: the real-mode entry includes the SIP password; never do that in production.
 */
const RESUME_FLAG = 'pg:resume';
const REAL_SESSION = 'pg:session';

function readSession<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}

function createMock(extra: SoftphoneConfigInput = {}, resume = false): MockSoftphone {
  const mock = new MockSoftphone(
    {
      // Credentials handed over by a previous leader tab (shared instance).
      ...extra,
      brandName: 'SipKit',
      // Survive a reload (playground "Survive reload" toggle).
      resume: { ...extra.resume, enabled: resume },
      domain: 'demo.sipkit.local',
      // Voicemail list (V2-VM-02): the mock answers from an in-memory mailbox instead of services/voicemail-api.
      voicemail: { enabled: true, number: '*97', api: { baseUrl: 'mock://voicemail', token: 'demo' } },
      chat: { enabled: true },
      video: { enabled: true },
      // BLF lamps for the demo contacts (docs/presence.md).
      presence: { enabled: true, watch: ['1002', '1003', '1004'] },
      // Call notifications: the real service worker + push service (docs/push.md).
      push: pushConfig(),
    },
    {
      pushPlatform: createBrowserPushPlatform(),
      // Chat demo: replies to every message; 9999 is unreachable (404).
      chatAutoReply: true,
      unreachableChatNumbers: ['9999'],
      plugins: [callHistoryPlugin(), contactsPlugin({ initial: DEMO_CONTACTS })],
      engineName: 'mock-engine',
      // Long enough to see the "Reconnecting call…" banner after a reload.
      resumeDelayMs: 1500,
    },
  );
  // Count live instances (React StrictMode mounts twice in dev and disposes the first).
  window.__sipkitInstancesCreated = (window.__sipkitInstancesCreated ?? 0) + 1;
  const destroy = mock.destroy.bind(mock);
  mock.destroy = async () => {
    window.__sipkitInstancesCreated = (window.__sipkitInstancesCreated ?? 1) - 1;
    await destroy();
  };
  return mock;
}

function createReal(config: SoftphoneConfigInput): SoftphoneApi {
  return createSoftphone({
    config,
    plugins: [
      callHistoryPlugin(),
      contactsPlugin({ initial: DEMO_CONTACTS }),
      ringtonePlugin(),
      browserNotificationsPlugin(),
    ],
  });
}

export function App() {
  const [mode, setMode] = useState<Mode>(() => (readSession(REAL_SESSION) ? 'real' : 'mock'));
  const [mockResume, setMockResume] = useState(() => readSession<boolean>(RESUME_FLAG) === true);
  const [layout, setLayout] = useState<SoftphoneLayout>('compact');
  const [theme, setTheme] = useState<SoftphoneTheme>('light');
  const [locale, setLocale] = useState('en');
  const [brandColor, setBrandColor] = useState('#2563eb');
  const [brand, setBrand] = useState<Brand>('default');
  // A reloaded tab with "Survive reload" on reconnects with the same settings.
  const [realConfig, setRealConfig] = useState<SoftphoneConfigInput | null>(() => readSession(REAL_SESSION));
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const [phone, setPhone] = useState<SoftphoneApi | null>(null);
  const [instanceMode, setInstanceMode] = useState<InstanceMode>(readInstanceMode);
  const [role, setRole] = useState<SharedRole | 'local'>('local');

  // Create / dispose the softphone when the engine mode or server config changes.
  useEffect(() => {
    setError(null);
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    const createLocal = (config: SoftphoneConfigInput): SoftphoneApi =>
      mode === 'mock' ? createMock(config, mockResume) : createReal({ ...realConfig, ...config });
    const make = async (): Promise<SoftphoneApi | null> => {
      if (mode === 'real' && !realConfig) return null;
      if (instanceMode === 'local') return mode === 'mock' ? createMock({}, mockResume) : createReal(realConfig!);
      // One instance per browser: the extension's, else a leader tab's (docs/shared-instance.md).
      return createSharedSoftphone({
        config: { ...(mode === 'real' ? realConfig : {}), instance: { mode: 'shared', preferExtension: true } },
        createLocal: (config) => createLocal(mode === 'mock' ? config : { ...config, instance: { mode: 'local' } }),
        debugMethods: mode === 'mock' ? MOCK_DEBUG_METHODS : [],
      });
    };
    make().then(
      (instance) => {
        if (cancelled) {
          if (instance) disposePhone(instance);
          return;
        }
        setPhone(instance);
        if (instance) cleanup = wire(instance);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [mode, realConfig, instanceMode, mockResume]);

  function disposePhone(p: SoftphoneApi): void {
    const d = p as SoftphoneApi & { destroy?: () => Promise<void> };
    void (d.destroy ? d.destroy() : p.stop()).catch(() => undefined);
  }

  function wire(p: SoftphoneApi): () => void {
    window.__softphone = p;
    const shared = 'onRoleChange' in p ? (p as SharedSoftphone) : null;
    setRole(shared ? shared.role : 'local');
    const offRole = shared?.onRoleChange((r) => setRole(r));
    const qualityLevels = new Map<string, string>();
    const add = (line: string) =>
      setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 60));
    const offs = [
      p.on('registration:state', (s) => add(`registration → ${s.state}${s.code ? ` (${s.code})` : ''}`)),
      p.on('call:created', ({ call }) => add(`call:created L${call.line} ${call.direction} ${call.remoteNumber}`)),
      p.on('call:updated', ({ call, previous }) => {
        if (call.state !== previous.state) add(`call L${call.line}: ${previous.state} → ${call.state}`);
      }),
      p.on('cdr', (c) =>
        add(
          `cdr ${c.direction} ${c.called} ${Math.round(c.durationMs / 1000)}s (${c.reason})${c.code ? ` SIP ${c.code}` : ''}${
            c.quality ? ` quality ${c.quality.worstLevel} minMOS ${c.quality.minMos}` : ''
          }`,
        ),
      ),
      p.on('call:quality', ({ callId, quality }) => {
        if (qualityLevels.get(callId) === quality.level) return;
        qualityLevels.set(callId, quality.level);
        add(`quality → ${quality.level} (MOS ${quality.mos})`);
      }),
      p.on('voicemail:updated', ({ voicemail: vm }) => add(`voicemail ${vm.new} new / ${vm.old} old`)),
      p.on('dnd:changed', ({ dnd }) => add(`dnd → ${dnd ? 'on' : 'off'}`)),
      p.on('presence:changed', ({ target, presence }) =>
        add(`presence ${target} → ${presence ? presence.state : 'unwatched'}${presence?.remoteNumber ? ` (${presence.remoteNumber})` : ''}`),
      ),
      p.on('message:received', ({ message }) => add(`chat ← ${message.peer}: ${message.body}`)),
      p.on('message:status', ({ message }) =>
        add(`chat → ${message.peer} ${message.status}${message.code ? ` (${message.code})` : ''}`),
      ),
      p.on('call:video', (v) =>
        add(`video ${v.hasVideo ? 'on' : 'off'} · camera ${v.cameraOn ? 'on' : 'off'} · remote ${v.remoteVideo ? 'on' : 'off'}`),
      ),
      p.on('push:changed', ({ push }) =>
        add(`push ${push.subscribed ? 'subscribed' : 'not subscribed'} · permission ${push.permission}${push.error ? ` · ${push.error}` : ''}`),
      ),
      p.on('push:action', ({ launch, callId }) =>
        add(`push click ${launch.action}${launch.pushCallId ? ` ${launch.pushCallId}` : ''}${callId ? ` → ${callId}` : ''}`),
      ),
      p.on('registration:resuming', ({ calls }) => add(`resuming ${calls.length} call(s)`)),
      p.on('call:resumed', ({ call }) => add(`call:resumed ${call.id} ${call.remoteNumber}`)),
    ];
    return () => {
      offRole?.();
      offs.forEach((off) => off());
      setPhone(null);
      disposePhone(p);
    };
  }

  const extensions = useMemo<SoftphoneExtensions>(
    () => ({
      tabs: [
        {
          id: 'crm',
          label: 'CRM',
          order: 25,
          icon: <BuildingIcon />,
          render: ({ activeCall }) => <CrmTab number={activeCall?.remoteNumber} />,
        },
      ],
      callActions: [
        {
          id: 'ticket',
          label: 'Ticket',
          icon: <TicketIcon />,
          onSelect: (call) => alert(`Create ticket for ${call.remoteNumber}`),
        },
      ],
      panels: [
        {
          id: 'customer',
          title: 'Customer',
          when: 'in-call',
          render: ({ activeCall }) => <CrmTab number={activeCall?.remoteNumber} compact />,
        },
      ],
    }),
    [],
  );

  const slots = useMemo<SoftphoneSlots>(
    () => ({
      callInfo: (call) => {
        const rec = CRM.get(call.remoteNumber);
        return rec ? (
          <span className="mx-auto mt-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            {rec.account} · {rec.tier}
          </span>
        ) : null;
      },
    }),
    [],
  );

  const mock = phone instanceof MockSoftphone ? phone : null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <div className="mr-auto">
            <h1 className="text-base font-semibold">SipKit</h1>
            <p className="text-xs text-slate-500">Playground · sipkit-ui</p>
          </div>
          <Segmented
            label="Engine"
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[
              ['mock', 'Mock engine'],
              ['real', 'Real Asterisk'],
            ]}
          />
          <Segmented
            label="Layout"
            value={layout}
            onChange={(v) => setLayout(v as SoftphoneLayout)}
            options={[
              ['compact', 'Compact'],
              ['full', 'Full width'],
            ]}
          />
          <Segmented
            label="Theme"
            value={theme}
            onChange={(v) => setTheme(v as SoftphoneTheme)}
            options={[
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['system', 'System'],
            ]}
          />
          <Segmented
            label="Brand"
            value={brand}
            onChange={(v) => setBrand(v as Brand)}
            options={[
              ['default', 'Default'],
              ['custom', 'Custom brand'],
            ]}
          />
          <Segmented
            label="Language"
            value={locale}
            onChange={setLocale}
            options={[
              ['en', 'English'],
              ['ne', 'नेपाली'],
              ['ar-XB', 'RTL (pseudo)'],
            ]}
          />
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            Colour
            <input
              type="color"
              aria-label="Brand color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-slate-300"
            />
          </label>
          <Segmented
            label="Instance"
            value={instanceMode}
            onChange={(v) => {
              setInstanceMode(v as InstanceMode);
              try {
                localStorage.setItem('pg:instance', v);
              } catch {
                /* storage blocked */
              }
            }}
            options={[
              ['local', 'This tab'],
              ['shared', 'Shared (extension / leader tab)'],
            ]}
          />
          <span
            className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600"
            data-testid="instance-role"
            data-role={role}
            title="Where the softphone instance runs"
          >
            {role}
          </span>
          <a className="text-xs font-medium text-blue-600 hover:underline" href="/embed-demo.html">
            Plain-HTML embed demo →
          </a>
        </div>
      </header>

      <main
        className={
          layout === 'full'
            ? 'mx-auto flex max-w-7xl flex-col gap-5 p-5'
            : 'mx-auto grid max-w-7xl gap-6 p-5 lg:grid-cols-[420px_1fr]'
        }
      >
        <div className={layout === 'full' ? 'flex h-[720px] flex-col gap-2' : 'flex flex-col gap-2'}>
          {mode === 'mock' && (
            // The widget header shows "user@domain · Online" in mock mode too: say plainly that nothing is real.
            <p
              role="note"
              data-testid="mock-badge"
              className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950"
            >
              <span className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase">
                Mock
              </span>
              <span>
                Simulated phone: calls, sign-in and audio are fake. Not connected to any SIP server. Pick{' '}
                <b>Real Asterisk</b> to use a real one.
              </span>
            </p>
          )}
          {phone ? (
            <Softphone
              key={mode}
              className={layout === 'full' ? 'min-h-0 flex-1' : undefined}
              softphone={phone}
              layout={layout}
              theme={theme}
              locale={locale}
              brandColor={brand === 'default' ? brandColor : undefined}
              themeTokens={brand === 'custom' ? CUSTOM_BRAND : undefined}
              extensions={extensions}
              slots={slots}
            />
          ) : (
            <RealConfigForm onConnect={setRealConfig} error={error} />
          )}
        </div>

        <aside className="flex flex-col gap-4">
          {mode === 'mock' ? (
            <Panel title="Mock controls">
              <p className="mb-3 text-xs text-slate-500">
                Sign in with any extension (password <code>wrong</code> simulates a 403). Outgoing calls
                ring and connect after 1.5s.
              </p>
              <div className="flex flex-wrap gap-2">
                <Btn
                  onClick={() => simulate(phone, 'simulateIncomingCall', '5550100', 'Jane Customer')}
                  data-testid="simulate-incoming"
                >
                  Simulate incoming call
                </Btn>
                <Btn onClick={() => mock?.simulateIncomingCall('1003')}>Incoming from 1003</Btn>
                <Btn
                  onClick={() => mock?.simulateIncomingCall('1004', 'Dev Patel', { video: true })}
                  data-testid="simulate-incoming-video"
                >
                  Incoming video call
                </Btn>
                <Btn onClick={() => mock?.simulateRemoteVideo(false)} data-testid="simulate-remote-camera-off">
                  Remote camera off
                </Btn>
                <Btn onClick={() => mock?.simulateRemoteVideo(true)} data-testid="simulate-remote-camera-on">
                  Remote camera on
                </Btn>
                <Btn onClick={() => simulate(phone, 'simulateRemoteHangup')} data-testid="simulate-remote-hangup">
                  Remote hangup
                </Btn>
                <Btn onClick={() => mock?.simulateCallFailure('failed', 404)} data-testid="simulate-call-404">
                  Fail call (404)
                </Btn>
                <Btn onClick={() => mock?.simulateCallFailure('media-error')} data-testid="simulate-mic-blocked">
                  Fail call (mic blocked)
                </Btn>
                <Btn
                  onClick={() => {
                    // Leaves a message in the mock mailbox: MWI +1 and it shows in the Voicemail tab (V2-VM-02).
                    const n = (mock?.voicemailBackend.messages().length ?? 0) + 1;
                    mock?.simulateVoicemailMessage(
                      n % 2 ? { callerNumber: '5550100', callerName: 'Jane Customer', duration: 14 } : { callerNumber: '1002', duration: 6 },
                    );
                  }}
                  data-testid="simulate-voicemail"
                >
                  New voicemail
                </Btn>
                <Btn onClick={() => mock?.voicemailBackend.failNext(503)} data-testid="simulate-voicemail-error">
                  Voicemail API error
                </Btn>
                <Btn
                  onClick={() => mock?.simulateIncomingMessage('1002', 'Hi! Can you call me back?', 'Agent 1002')}
                  data-testid="simulate-chat"
                >
                  Incoming chat
                </Btn>
                <Btn onClick={() => mock?.simulateNotification('warning', 'Network unstable', 'Simulated warning toast')}>
                  Toast
                </Btn>
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={mockResume}
                  onChange={(e) => {
                    writeSession(RESUME_FLAG, e.target.checked);
                    setMockResume(e.target.checked);
                  }}
                />
                Survive reload (resume): calls and sign-in come back after a page reload
              </label>
              <ServerFeatureControls phone={mock} />
              <PushControls phone={mock} />
              <div role="group" aria-label="Simulated BLF" className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">BLF 1002:</span>
                {(['idle', 'ringing', 'busy', 'held', 'unavailable'] as const).map((st) => (
                  <Btn
                    key={st}
                    onClick={() =>
                      mock?.simulatePresence(
                        '1002',
                        st,
                        st === 'ringing' ? { remoteNumber: '5550100', remoteDisplayName: 'Jane Customer', direction: 'incoming' } : {},
                      )
                    }
                    data-testid={`blf-1002-${st}`}
                  >
                    {st}
                  </Btn>
                ))}
              </div>
              <div role="group" aria-label="Simulated network" className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">Network (call quality):</span>
                {(['good', 'fair', 'poor'] as const).map((n) => (
                  <Btn key={n} onClick={() => mock?.simulateNetwork(n)} data-testid={`network-${n}`}>
                    {n[0]!.toUpperCase() + n.slice(1)}
                  </Btn>
                ))}
              </div>
            </Panel>
          ) : (
            phone && (
              <Panel title="Real Asterisk">
                <p className="mb-3 text-xs text-slate-500">
                  Using <code>createSoftphone()</code> from sipkit-core with call history, contacts,
                  ringtone and browser notification plugins.
                </p>
                <Btn
                  onClick={() => {
                    writeSession(REAL_SESSION, null);
                    setRealConfig(null);
                  }}
                >
                  Change server
                </Btn>
              </Panel>
            )
          )}
          <Panel title="Events">
            {/* Long lines wrap (SIP codes at the end stay visible); no horizontal scrolling. */}
            <ol
              className="max-h-80 overflow-x-hidden overflow-y-auto font-mono text-[11px] leading-5 text-slate-600"
              data-testid="event-log"
            >
              {log.length === 0 && <li className="text-slate-500">No events yet</li>}
              {log.map((l, i) => (
                <li key={i} className="border-b border-slate-100 py-0.5 break-words whitespace-pre-wrap last:border-0 [overflow-wrap:anywhere]">
                  {l}
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </main>
    </div>
  );
}

function RealConfigForm({
  onConnect,
  error,
}: {
  onConnect: (config: SoftphoneConfigInput) => void;
  error: string | null;
}) {
  const [ws, setWs] = useState(() => localStorage.getItem('pg:ws') ?? 'wss://localhost:8089/ws');
  const [user, setUser] = useState(() => localStorage.getItem('pg:user') ?? '1001');
  const [pass, setPass] = useState('');
  const [domain, setDomain] = useState(() => localStorage.getItem('pg:domain') ?? '');
  const [prefix, setPrefix] = useState(() => localStorage.getItem('pg:prefix') ?? '');
  const [dndMode, setDndMode] = useState<DndMode>('local');
  const [conferenceMode, setConferenceMode] = useState<ConferenceMode>('local');
  const [watch, setWatch] = useState(() => localStorage.getItem('pg:watch') ?? '');
  const [vmApi, setVmApi] = useState(() => localStorage.getItem('pg:vmApi') ?? '');
  const [vmToken, setVmToken] = useState('');
  const [resume, setResume] = useState(() => localStorage.getItem('pg:resume') === '1');

  function submit(e: FormEvent) {
    e.preventDefault();
    localStorage.setItem('pg:resume', resume ? '1' : '0');
    localStorage.setItem('pg:ws', ws);
    localStorage.setItem('pg:user', user);
    localStorage.setItem('pg:domain', domain);
    localStorage.setItem('pg:prefix', prefix);
    localStorage.setItem('pg:watch', watch);
    localStorage.setItem('pg:vmApi', vmApi);
    const watched = watch.split(/[\s,]+/).filter(Boolean);
    const config: SoftphoneConfigInput = {
      websocketUrls: [ws],
      username: user,
      password: pass,
      domain,
      // Outside-line prefix, skipped for short internal extensions (also editable in Settings → Dialing).
      ...(prefix ? { techPrefix: prefix, techPrefixMinDigits: 7 } : {}),
      brandName: 'SipKit',
      // Dev PBX: *97 = VoiceMailMain, MWI via SUBSCRIBE (infra/asterisk/README.md).
      // Voicemail list (V2-VM-02): services/voicemail-api, e.g. http://localhost:8090 (docs/voicemail.md).
      voicemail: { enabled: true, number: '*97', api: { baseUrl: vmApi.trim(), token: vmToken.trim() } },
      // Server-side DND (*78/*79, query *76) and ConfBridge rooms (7 + ext): docs/server-features.md.
      dnd: { mode: dndMode, serverQuery: dndMode === 'local' ? '' : '*76' },
      conference: { mode: conferenceMode },
      // BLF: the dev PBX has hints for its extensions and directed pickup on **<ext> (docs/presence.md).
      presence: { enabled: watched.length > 0, watch: watched },
      // Dev PBX routes SIP MESSAGE through [messages] (res_pjsip_messaging).
      chat: { enabled: true },
      // Dev PBX WebRTC endpoints allow VP8/H.264 (docs/video.md).
      video: { enabled: true },
      // Call notifications with the tab closed (docs/push.md): settings in the side panel.
      push: pushConfig(),
      // Reload-safe calls (docs/resume.md): anchored in ConfBridge, rejoined after a reload.
      // localStorage pg:resumeTimeoutMs shortens the PBX rejoin timeout (e2e of the fallback).
      resume: { enabled: resume, rejoinTimeoutMs: Number(localStorage.getItem('pg:resumeTimeoutMs')) || 30_000 },
    };
    // DEV ONLY: lets a reload of this tab reconnect by itself (includes the password).
    writeSession(REAL_SESSION, resume ? config : null);
    onConnect(config);
  }

  const field = 'mt-1 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200';
  return (
    <form onSubmit={submit} className="w-full max-w-[420px] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold">Connect to Asterisk</h2>
      <p className="mb-4 text-xs text-slate-500">PJSIP endpoint with webrtc=yes, reachable over WSS.</p>
      {error && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <label className="mb-3 block text-xs font-medium">
        WebSocket URL
        <input className={field} value={ws} onChange={(e) => setWs(e.target.value)} />
      </label>
      <label className="mb-3 block text-xs font-medium">
        Username
        <input className={field} value={user} onChange={(e) => setUser(e.target.value)} />
      </label>
      <label className="mb-3 block text-xs font-medium">
        Password
        <input className={field} type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      <label className="mb-3 block text-xs font-medium">
        Domain (optional)
        <input className={field} value={domain} placeholder="derived from URL" onChange={(e) => setDomain(e.target.value)} />
      </label>
      <label className="mb-3 block text-xs font-medium">
        Dial prefix (optional)
        <input
          className={field}
          value={prefix}
          inputMode="tel"
          placeholder="e.g. 9 for an outside line"
          onChange={(e) => setPrefix(e.target.value.replace(/[^0-9*#+]/g, '').slice(0, 8))}
        />
      </label>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium">
          DND mode
          <select className={field} value={dndMode} onChange={(e) => setDndMode(e.target.value as DndMode)}>
            <option value="local">Local (browser rejects)</option>
            <option value="server">Server (*78 / *79)</option>
            <option value="both">Both</option>
          </select>
        </label>
        <label className="block text-xs font-medium">
          Conference mode
          <select
            className={field}
            value={conferenceMode}
            onChange={(e) => setConferenceMode(e.target.value as ConferenceMode)}
          >
            <option value="local">Local mixer</option>
            <option value="server">Asterisk ConfBridge</option>
          </select>
        </label>
      </div>
      <label className="mb-4 flex items-center gap-2 text-xs font-medium">
        <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
        Survive reload (resume)
      </label>
      <label className="mb-4 block text-xs font-medium">
        Watch extensions (BLF, optional)
        <input className={field} value={watch} placeholder="e.g. 1001, 1002" onChange={(e) => setWatch(e.target.value)} />
      </label>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium">
          Voicemail API (optional)
          <input className={field} value={vmApi} placeholder="http://localhost:8090" onChange={(e) => setVmApi(e.target.value)} />
        </label>
        <label className="block text-xs font-medium">
          Voicemail token
          <input className={field} type="password" value={vmToken} onChange={(e) => setVmToken(e.target.value)} />
        </label>
      </div>
      <button className="h-9 w-full rounded-md bg-blue-600 text-sm font-medium text-white hover:bg-blue-700" type="submit">
        Connect
      </button>
    </form>
  );
}

type DndMode = 'local' | 'server' | 'both';
type ConferenceMode = 'local' | 'server';

/**
 * Call notifications (V2-PUSH-01): push service settings (both modes; applied
 * on the next connect / mock reload) and, in mock mode, a simulated
 * notification click followed by the matching incoming call.
 */
function PushControls({ phone }: { phone: MockSoftphone | null }) {
  const [settings, setSettings] = useState(readPushSettings);
  const [seq, setSeq] = useState(1);
  const save = (next: PushSettingsInput) => {
    setSettings(next);
    localStorage.setItem('pg:push', JSON.stringify(next));
  };
  const field = 'h-7 min-w-0 flex-1 rounded border border-slate-300 px-2 text-xs';
  return (
    <div role="group" aria-label="Call notifications" className="mt-3 grid gap-2">
      <span className="text-xs text-slate-500">
        Call notifications (push service, <code>services/push</code>). Reload to apply.
      </span>
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Push service URL"
          className={field}
          value={settings.serviceUrl}
          placeholder="http://localhost:8790"
          onChange={(e) => save({ ...settings, serviceUrl: e.target.value })}
        />
        <input
          aria-label="Push token"
          className={field}
          value={settings.token}
          placeholder="PUSH_DEV_TOKEN"
          onChange={(e) => save({ ...settings, token: e.target.value })}
        />
      </div>
      {phone && (
        <div className="flex flex-wrap gap-2">
          <Btn
            data-testid="simulate-push-call"
            onClick={() => {
              const pushId = `demo-push-${seq}`;
              setSeq(seq + 1);
              // As if the agent clicked "Answer" on the notification, then the PBX rang the tab.
              phone.simulatePushLaunch({ action: 'answer', pushCallId: pushId, caller: '5550100' });
              setTimeout(() => phone.simulateIncomingCall('5550100', 'Jane Customer', { pushId }), 800);
            }}
          >
            Simulate push call (notification click)
          </Btn>
          <Btn
            data-testid="simulate-push-incoming"
            onClick={() => {
              const pending = phone.getSnapshot().push?.pending;
              phone.simulateIncomingCall(pending?.caller ?? '5550100', 'Jane Customer', { pushId: pending?.pushCallId });
            }}
          >
            Ring the pending push call
          </Btn>
        </div>
      )}
    </div>
  );
}

/** Mock engine: switch DND / conference to their server (Asterisk) modes and simulate failures. */
function ServerFeatureControls({ phone }: { phone: MockSoftphone | null }) {
  const [dndMode, setDndMode] = useState<DndMode>('local');
  const [conferenceMode, setConferenceMode] = useState<ConferenceMode>('local');
  if (!phone) return null;
  return (
    <div role="group" aria-label="Server features" className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-500">Server features:</span>
      <Segmented
        label="DND mode"
        value={dndMode}
        onChange={(v) => {
          setDndMode(v as DndMode);
          void phone.updateConfig({ dnd: { ...phone.config.dnd, mode: v as DndMode } });
        }}
        options={[
          ['local', 'Local'],
          ['server', 'Server'],
          ['both', 'Both'],
        ]}
      />
      <Segmented
        label="Conference mode"
        value={conferenceMode}
        onChange={(v) => {
          setConferenceMode(v as ConferenceMode);
          void phone.updateConfig({ conference: { ...phone.config.conference, mode: v as ConferenceMode } });
        }}
        options={[
          ['local', 'Local'],
          ['server', 'ConfBridge'],
        ]}
      />
      <Btn onClick={() => phone.failNextServerDnd()} data-testid="fail-next-dnd">
        Fail next DND feature code
      </Btn>
    </div>
  );
}

function CrmTab({ number, compact }: { number?: string; compact?: boolean }) {
  const rec = number ? CRM.get(number) : undefined;
  if (!number) {
    return <p className="p-4 text-sm text-slate-500">CRM details for the current caller appear here.</p>;
  }
  return (
    <div className={compact ? 'text-sm' : 'p-4 text-sm'}>
      {!compact && <h3 className="mb-2 font-semibold">Caller {number}</h3>}
      {rec ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="opacity-60">Account</dt>
          <dd>{rec.account}</dd>
          <dt className="opacity-60">Tier</dt>
          <dd>{rec.tier}</dd>
          <dt className="opacity-60">Open tickets</dt>
          <dd>{rec.openTickets}</dd>
        </dl>
      ) : (
        <p className="opacity-60">No CRM record for {number}.</p>
      )}
    </div>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
      {label}
      <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-slate-100 p-0.5">
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={`rounded-md px-2.5 py-1 ${value === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Btn(props: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
    />
  );
}

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="2" />
      <path d="M9 22v-4h6v4M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}
