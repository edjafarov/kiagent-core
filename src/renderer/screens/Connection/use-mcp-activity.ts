import { useEffect, useState } from 'react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';

/** Where a caller keeps the trail between mounts (Home's session cache). */
export interface McpActivityCache {
  read(): McpActivityRecord[] | undefined;
  write(records: McpActivityRecord[]): void;
}

/**
 * The MCP request trail, oldest first: mcp-activity:recent seeds it, every
 * push:mcp-activity batch appends, and it stays capped like the file. A
 * failed seed leaves the live batches flowing. With a cache the first paint
 * uses the last trail and every change is written back.
 */
export function useMcpActivity(cache?: McpActivityCache): McpActivityRecord[] {
  const [recs, setRecsState] = useState<McpActivityRecord[]>(
    () => cache?.read() ?? [],
  );
  useEffect(() => {
    let cancelled = false;
    const setRecs = (
      next: (prev: McpActivityRecord[]) => McpActivityRecord[],
    ) =>
      setRecsState((prev) => {
        const value = next(prev);
        cache?.write(value);
        return value;
      });
    window.kiagent
      .invoke('mcp-activity:recent', undefined)
      .then((recent) => {
        if (!cancelled && Array.isArray(recent))
          setRecs(() => recent.slice(-MCP_ACTIVITY_RECENT_MAX));
      })
      .catch(() => {
        /* seed failure must not block the live push below */
      });
    const off = window.kiagent.on('push:mcp-activity', (batch) => {
      if (!Array.isArray(batch)) return;
      setRecs((prev) => prev.concat(batch).slice(-MCP_ACTIVITY_RECENT_MAX));
    });
    return () => {
      cancelled = true;
      off();
    };
    // The cache is read once and written through; a new object each render
    // must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return recs;
}
