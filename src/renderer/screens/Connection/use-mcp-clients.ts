import { useCallback, useEffect, useState } from 'react';
import type { McpInfo } from '@shared/ipc';

export type ClientInfo = McpInfo['clients'][number];

/** The apps on this computer that can take the local server, and whether
 *  each is connected — one read for the page meta and the apps card; null
 *  while the first read is out. A failed read shows none. */
export function useMcpClients(): {
  clients: ClientInfo[] | null;
  refresh: () => void;
} {
  const [clients, setClients] = useState<ClientInfo[] | null>(null);
  const refresh = useCallback(() => {
    void window.kiagent
      .invoke('mcp:info', undefined)
      .then((info) => setClients(info.clients))
      .catch(() => setClients([]));
  }, []);
  useEffect(() => refresh(), [refresh]);
  return { clients, refresh };
}
