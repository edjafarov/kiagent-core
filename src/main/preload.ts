import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { INVOKE_CHANNELS, PUSH_CHANNELS } from '@shared/ipc';
import type { RendererApi } from '@shared/ipc';

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const pushSet = new Set<string>(PUSH_CHANNELS);

const api: RendererApi = {
  invoke(channel, payload) {
    if (!invokeSet.has(channel)) {
      return Promise.reject(new Error(`unknown invoke channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!pushSet.has(channel)) {
      throw new Error(`unknown push channel: ${channel}`);
    }
    const listener = (_e: IpcRendererEvent, payload: unknown) => {
      cb(payload as never);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('kiagent', api);

export type { RendererApi };
