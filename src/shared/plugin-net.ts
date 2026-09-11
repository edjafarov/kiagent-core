export interface PluginNetInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PluginNetResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface PluginNet {
  fetch(url: string, init?: PluginNetInit): Promise<PluginNetResult>;
}
