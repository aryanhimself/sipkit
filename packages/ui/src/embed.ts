/**
 * <sipkit-phone> custom element.
 *
 * Renders the React softphone into a Shadow DOM with the compiled CSS
 * injected, so it works on any page (no React, no Tailwind needed) and never
 * clashes with host styles.
 *
 *   <script src="sipkit.iife.js"></script>
 *   <sipkit-phone username="1001" password="…" ws-url="wss://pbx:8089/ws" brand-name="Acme"></sipkit-phone>
 *
 * Config: attributes (see ATTRIBUTE_MAP) and/or the `config` property (merged on top).
 * Theme: `theme="light|dark|system"`, `brand-color`, `theme-tokens='{"primary":"#0a7"}'`
 * (JSON) and/or the `themeTokens` property, or `--sipkit-*` CSS variables on the element.
 * Language: `locale="ne"` attribute (reactive; 'auto' = browser), `messages` property for
 * overrides, `window.Sipkit.registerLocale({...})` for extra languages.
 * Factory: `element.factory`, `window.Sipkit.setFactory(fn)`, or core `createSoftphone`.
 * Events (bubbling, composed): sipkit:ready, sipkit:registration, sipkit:call, sipkit:cdr, sipkit:notification, sipkit:error.
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SoftphoneApi, SoftphoneConfigInput, Unsubscribe } from 'sipkit-core';
import { createMockSoftphone } from 'sipkit-react/testing';
import css from './styles.css?inline';
import { Softphone } from './softphone';
import type { SoftphoneLayout, SoftphoneTheme } from './context';
import type { Contact, SoftphoneExtensions, SoftphoneSlots } from './extensions';
import { parseThemeTokens, type ThemeTokenOverrides } from './theme/tokens';
import type { Messages } from './i18n/en';
import { registerLocale } from './i18n/locales';

export type SoftphoneFactory = (
  config: SoftphoneConfigInput,
) => SoftphoneApi | Promise<SoftphoneApi>;

export const TAG_NAME = 'sipkit-phone';
export const VERSION = '0.1.0';

/** attribute -> config key. */
const ATTRIBUTE_MAP = {
  username: 'username',
  password: 'password',
  'auth-username': 'authUsername',
  'display-name': 'displayName',
  'ws-url': 'websocketUrls',
  domain: 'domain',
  'tech-prefix': 'techPrefix',
  'brand-name': 'brandName',
  'auto-register': 'autoRegister',
  'auto-answer': 'autoAnswer',
  'max-lines': 'maxLines',
  'disabled-features': 'disabledFeatures',
  'log-level': 'logLevel',
} as const satisfies Record<string, keyof SoftphoneConfigInput>;

const UI_ATTRIBUTES = ['theme', 'layout', 'brand-color', 'theme-tokens', 'hotkeys', 'locale'] as const;

type ConfigAttr = keyof typeof ATTRIBUTE_MAP;

function parseList(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function attrToConfig(name: ConfigAttr, value: string | null): Partial<SoftphoneConfigInput> {
  const key = ATTRIBUTE_MAP[name];
  if (value === null) return {};
  switch (key) {
    case 'websocketUrls':
    case 'disabledFeatures':
      return { [key]: parseList(value) };
    case 'autoRegister':
    case 'autoAnswer':
      return { [key]: value !== 'false' && value !== '0' };
    case 'maxLines':
      return Number.isFinite(Number(value)) ? { maxLines: Number(value) } : {};
    default:
      return { [key]: value } as Partial<SoftphoneConfigInput>;
  }
}

// ---------------------------------------------------------------------------
// Global API: window.Sipkit
// ---------------------------------------------------------------------------

export interface SipkitGlobal {
  /** Factory used by elements that don't have their own `factory` property. */
  factory?: SoftphoneFactory;
  setFactory(factory: SoftphoneFactory): void;
  /** In-memory demo/testing softphone (no server needed). */
  createMockSoftphone: typeof createMockSoftphone;
  /** Define the custom element (done automatically on load). */
  define(tagName?: string): void;
  /** Add a UI language or override messages (see docs/i18n.md). */
  registerLocale: typeof registerLocale;
  version: string;
}

const waiting = new Set<SipkitPhoneElement>();
let globalFactory: SoftphoneFactory | undefined;

export function setFactory(factory: SoftphoneFactory): void {
  globalFactory = factory;
  for (const el of [...waiting]) el.refresh();
}

export function getFactory(): SoftphoneFactory | undefined {
  return globalFactory;
}

type CoreModule = Record<string, unknown>;
type PluginFactory = () => unknown;

/**
 * Default factory: core `createSoftphone({ config, plugins })` with the
 * built-in call history, contacts and ringtone plugins, when core provides it.
 * Guarded so this package builds/runs even before core exports it.
 */
export async function loadCoreFactory(): Promise<SoftphoneFactory | undefined> {
  let mod: CoreModule;
  try {
    mod = (await import('sipkit-core')) as CoreModule;
  } catch {
    return undefined;
  }
  const key = 'createSoftphone';
  const create = mod[key];
  if (typeof create !== 'function') return undefined;
  const plugins = ['callHistoryPlugin', 'contactsPlugin', 'ringtonePlugin']
    .map((name) => mod[name])
    .filter((f): f is PluginFactory => typeof f === 'function')
    .map((f) => f());
  const createLocal = (config: SoftphoneConfigInput) =>
    (create as (options: { config: SoftphoneConfigInput; plugins: unknown[] }) => SoftphoneApi)({
      config,
      plugins,
    });
  // `config.instance.mode: 'shared'`: one instance per browser (extension, else a leader tab). docs/shared-instance.md
  const shared = mod['createSharedSoftphone'];
  return (config) =>
    config.instance?.mode === 'shared' && typeof shared === 'function'
      ? (shared as (o: { config: SoftphoneConfigInput; createLocal: typeof createLocal }) => Promise<SoftphoneApi>)({
          config,
          createLocal,
        })
      : createLocal(config);
}

/** Shadow DOM ignores @property rules; Tailwind needs them, so register them on the document once. */
function hoistPropertyRules(source: string): void {
  if (typeof document === 'undefined' || document.getElementById('sipkit-phone-properties')) return;
  const rules = source.match(/@property\s+[^{]+\{[^}]*\}/g);
  if (!rules?.length) return;
  const style = document.createElement('style');
  style.id = 'sipkit-phone-properties';
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}

const HOST_CSS = `:host{display:block;font-size:14px}:host([hidden]){display:none}
.sipkit-mount{height:100%;display:flex;justify-content:center}
.sipkit-status{font:14px/1.5 system-ui,sans-serif;color:var(--sipkit-muted-foreground,#64748b);padding:16px;border:1px dashed var(--sipkit-border,#cbd5e1);border-radius:var(--sipkit-radius,12px);text-align:center}`;

function domReady(): Promise<void> {
  if (typeof document === 'undefined' || document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

const BaseElement: typeof HTMLElement =
  typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

export class SipkitPhoneElement extends BaseElement {
  static get observedAttributes(): string[] {
    return [...Object.keys(ATTRIBUTE_MAP), ...UI_ATTRIBUTES];
  }

  private reactRoot: Root | null = null;
  private mountEl: HTMLDivElement | null = null;
  private api: SoftphoneApi | null = null;
  private owned = false;
  private externalApi: SoftphoneApi | null = null;
  private ownFactory: SoftphoneFactory | undefined;
  private extraConfig: SoftphoneConfigInput = {};
  private offs: Unsubscribe[] = [];
  private generation = 0;
  private uiProps: {
    extensions?: SoftphoneExtensions;
    slots?: SoftphoneSlots;
    contacts?: Contact[];
    messages?: Partial<Messages>;
  } = {};
  private themeTokensProp: ThemeTokenOverrides | undefined;
  private warnedTokens: string | null = null;

  /** The softphone instance once ready (null before). */
  get softphone(): SoftphoneApi | null {
    return this.api;
  }
  /** Use an existing instance instead of creating one. Not stopped when the element is removed. */
  set softphone(api: SoftphoneApi | null) {
    this.externalApi = api;
    this.refresh();
  }

  /** Factory for this element (overrides `window.Sipkit.setFactory`). */
  get factory(): SoftphoneFactory | undefined {
    return this.ownFactory;
  }
  set factory(f: SoftphoneFactory | undefined) {
    this.ownFactory = f;
    this.refresh();
  }

  /** Full config object, merged over attribute values. */
  get config(): SoftphoneConfigInput {
    return this.collectConfig();
  }
  set config(value: SoftphoneConfigInput) {
    this.extraConfig = value ?? {};
    if (this.api) void this.api.updateConfig(this.collectConfig()).catch((e: unknown) => this.fail(e));
    this.render();
  }

  get extensions(): SoftphoneExtensions | undefined {
    return this.uiProps.extensions;
  }
  set extensions(v: SoftphoneExtensions | undefined) {
    this.uiProps = { ...this.uiProps, extensions: v };
    this.render();
  }
  get slots(): SoftphoneSlots | undefined {
    return this.uiProps.slots;
  }
  set slots(v: SoftphoneSlots | undefined) {
    this.uiProps = { ...this.uiProps, slots: v };
    this.render();
  }
  get contacts(): Contact[] | undefined {
    return this.uiProps.contacts;
  }
  set contacts(v: Contact[] | undefined) {
    this.uiProps = { ...this.uiProps, contacts: v };
    this.render();
  }
  /** Message overrides for the current locale, e.g. `{ 'tab.contacts': 'Customers' }`. */
  get messages(): Partial<Messages> | undefined {
    return this.uiProps.messages;
  }
  set messages(v: Partial<Messages> | undefined) {
    this.uiProps = { ...this.uiProps, messages: v };
    this.render();
  }

  /**
   * Runtime theme overrides, merged over the `theme-tokens` attribute.
   * `el.themeTokens = { primary: '#0a7', dark: { primary: '#3dd6a0' } }`
   */
  get themeTokens(): ThemeTokenOverrides | undefined {
    return this.themeTokensProp;
  }
  set themeTokens(v: ThemeTokenOverrides | undefined) {
    this.themeTokensProp = v ?? undefined;
    this.render();
  }

  connectedCallback(): void {
    // Properties set before the element was upgraded shadow the accessors; re-apply them.
    for (const prop of ['softphone', 'factory', 'config', 'extensions', 'slots', 'contacts', 'themeTokens', 'messages'] as const) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = (this as Record<string, unknown>)[prop];
        delete (this as Record<string, unknown>)[prop];
        (this as Record<string, unknown>)[prop] = value;
      }
    }
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = HOST_CSS + '\n' + css;
      shadow.appendChild(style);
      this.mountEl = document.createElement('div');
      this.mountEl.className = 'sipkit-mount';
      shadow.appendChild(this.mountEl);
      hoistPropertyRules(css);
    }
    if (!this.api) this.refresh();
  }

  disconnectedCallback(): void {
    // Defer so that moving the element in the DOM doesn't tear it down.
    queueMicrotask(() => {
      if (!this.isConnected) this.teardown();
    });
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if ((UI_ATTRIBUTES as readonly string[]).includes(name)) {
      this.render();
      return;
    }
    if (this.api && name in ATTRIBUTE_MAP) {
      const patch = attrToConfig(name as ConfigAttr, newValue);
      if (Object.keys(patch).length) void this.api.updateConfig(patch).catch((e: unknown) => this.fail(e));
      this.render();
    }
  }

  /** (Re)create the softphone with the current factory/config. */
  refresh(): void {
    if (!this.isConnected || !this.mountEl) return;
    void this.init();
  }

  private collectConfig(): SoftphoneConfigInput {
    const fromAttrs: SoftphoneConfigInput = {};
    for (const name of Object.keys(ATTRIBUTE_MAP) as ConfigAttr[]) {
      Object.assign(fromAttrs, attrToConfig(name, this.getAttribute(name)));
    }
    return { ...fromAttrs, ...this.extraConfig };
  }

  private async init(): Promise<void> {
    const gen = ++this.generation;
    await domReady();
    await Promise.resolve();
    if (gen !== this.generation || !this.isConnected) return;
    this.disposeInstance();

    let api: SoftphoneApi;
    try {
      if (this.externalApi) {
        api = this.externalApi;
        this.owned = false;
      } else {
        const factory = this.ownFactory ?? globalFactory ?? (await loadCoreFactory());
        if (gen !== this.generation) return;
        if (!factory) {
          waiting.add(this);
          this.renderStatus('Waiting for a softphone factory (Sipkit.setFactory)…');
          return;
        }
        waiting.delete(this);
        api = await factory(this.collectConfig());
        if (gen !== this.generation) {
          void stopInstance(api);
          return;
        }
        this.owned = true;
      }
    } catch (error) {
      this.fail(error);
      return;
    }

    this.api = api;
    this.bindEvents(api);
    this.render();
    this.dispatch('sipkit:ready', { softphone: api });
  }

  private bindEvents(api: SoftphoneApi): void {
    this.offs.push(
      api.on('registration:state', (status) => this.dispatch('sipkit:registration', status)),
      api.on('call:created', ({ call }) => this.dispatch('sipkit:call', { type: 'created', call })),
      api.on('call:updated', ({ call, previous }) => this.dispatch('sipkit:call', { type: 'updated', call, previous })),
      api.on('call:ended', ({ call }) => this.dispatch('sipkit:call', { type: 'ended', call })),
      api.on('cdr', (cdr) => this.dispatch('sipkit:cdr', cdr)),
      api.on('notification', (n) => this.dispatch('sipkit:notification', n)),
    );
  }

  private dispatch(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private fail(error: unknown): void {
    console.error('[sipkit]', error);
    this.dispatch('sipkit:error', { error });
    if (!this.api) this.renderStatus(`Softphone failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }

  private ensureRoot(): Root | null {
    if (!this.mountEl) return null;
    this.reactRoot ??= createRoot(this.mountEl);
    return this.reactRoot;
  }

  private renderStatus(message: string): void {
    this.ensureRoot()?.render(createElement('div', { className: 'sipkit-status', role: 'status' }, message));
  }

  private render(): void {
    if (!this.api) return;
    const theme = (this.getAttribute('theme') as SoftphoneTheme | null) ?? 'system';
    const layout = (this.getAttribute('layout') as SoftphoneLayout | null) ?? 'compact';
    const hotkeysAttr = this.getAttribute('hotkeys');
    const tokensAttr = this.getAttribute('theme-tokens');
    const attrTokens = parseThemeTokens(tokensAttr);
    if (tokensAttr && !attrTokens && tokensAttr !== this.warnedTokens) {
      this.warnedTokens = tokensAttr;
      console.warn('[sipkit] theme-tokens is not a JSON object; ignored');
    }
    const themeTokens =
      attrTokens || this.themeTokensProp
        ? {
            ...attrTokens,
            ...this.themeTokensProp,
            dark: { ...attrTokens?.dark, ...this.themeTokensProp?.dark },
          }
        : undefined;
    this.ensureRoot()?.render(
      createElement(Softphone, {
        softphone: this.api,
        theme: ['light', 'dark', 'system'].includes(theme) ? theme : 'system',
        layout: layout === 'full' ? 'full' : 'compact',
        brandColor: this.getAttribute('brand-color') ?? undefined,
        themeTokens,
        hotkeys: hotkeysAttr === 'global' ? 'global' : hotkeysAttr !== 'false',
        locale: this.getAttribute('locale') || undefined,
        ...this.uiProps,
      }),
    );
  }

  private disposeInstance(): void {
    for (const off of this.offs.splice(0)) off();
    const api = this.api;
    this.api = null;
    if (api && this.owned) void stopInstance(api);
    this.owned = false;
  }

  private teardown(): void {
    this.generation++;
    waiting.delete(this);
    this.disposeInstance();
    this.reactRoot?.unmount();
    this.reactRoot = null;
  }
}

async function stopInstance(api: SoftphoneApi): Promise<void> {
  try {
    const d = api as SoftphoneApi & { destroy?: () => Promise<void> | void };
    if (typeof d.destroy === 'function') await d.destroy();
    else await api.stop();
  } catch {
    /* ignore */
  }
}

export function defineSipkitPhone(tagName: string = TAG_NAME): void {
  if (typeof customElements === 'undefined' || customElements.get(tagName)) return;
  // A subclass per extra tag name (a constructor can only be registered once).
  const ctor = tagName === TAG_NAME ? SipkitPhoneElement : class extends SipkitPhoneElement {};
  customElements.define(tagName, ctor);
}

// ---------------------------------------------------------------------------
// Auto-setup on import
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    Sipkit?: Partial<SipkitGlobal>;
  }
  interface HTMLElementTagNameMap {
    'sipkit-phone': SipkitPhoneElement;
  }
}

if (typeof window !== 'undefined') {
  const existing = window.Sipkit;
  if (typeof existing?.factory === 'function') globalFactory = existing.factory;
  const globalApi: SipkitGlobal = {
    get factory() {
      return globalFactory;
    },
    set factory(f: SoftphoneFactory | undefined) {
      if (f) setFactory(f);
    },
    setFactory,
    createMockSoftphone,
    define: defineSipkitPhone,
    registerLocale,
    version: VERSION,
  };
  window.Sipkit = globalApi;
  defineSipkitPhone();
}

export { createMockSoftphone };
