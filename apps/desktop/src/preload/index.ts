/**
 * Preload (sandboxed, context-isolated): exposes `window.sipkitDesktop`, a narrow
 * typed API over IPC. No Node/Electron objects reach the page; callbacks get
 * plain data, never the IpcRendererEvent.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopBridge, DesktopCommand, EngineIpcEvent, UpdateState } from '../shared/ipc';
import { IPC } from '../shared/ipc';

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

let nativeEngineAvailable = false;

const bridge: DesktopBridge = {
  isDesktop: true,
  bootstrap: async () => {
    const boot = await ipcRenderer.invoke(IPC.bootstrap);
    nativeEngineAvailable = Boolean(boot?.nativeEngineAvailable);
    return boot;
  },
  saveSettings: (patch) => ipcRenderer.invoke(IPC.saveSettings, patch),
  savePassword: (password) => ipcRenderer.invoke(IPC.savePassword, password),
  getPassword: () => ipcRenderer.invoke(IPC.getPassword),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  applyHotkeys: (hotkeys) => ipcRenderer.invoke(IPC.applyHotkeys, hotkeys),
  ready: () => ipcRenderer.send(IPC.ready),
  reportStatus: (status) => ipcRenderer.send(IPC.status, status),
  notifyIncomingCall: (call) => ipcRenderer.send(IPC.incomingCall, call),
  notifyIncomingCallEnded: (callId) => ipcRenderer.send(IPC.incomingCallEnded, callId),
  notifyMissedCall: (call) => ipcRenderer.send(IPC.missedCall, call),
  onCommand: (handler) => subscribe<DesktopCommand>(IPC.command, handler),
  onUpdate: (handler) => subscribe<UpdateState>(IPC.update, handler),
  engine: {
    available: () => nativeEngineAvailable,
    invoke: (method, args) => ipcRenderer.invoke(IPC.engineInvoke, method, args),
    onEvent: (handler) => subscribe<EngineIpcEvent>(IPC.engineEvent, handler),
  },
};

contextBridge.exposeInMainWorld('sipkitDesktop', bridge);
