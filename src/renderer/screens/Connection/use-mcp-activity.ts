import { useEffect, useState } from 'react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';

/**
 * The MCP request trail, oldest first: mcp-activity:recent seeds it, every
 * push:mcp-activity batch appends, and it stays capped like the file. A
 * failed seed leaves the live batches flowing.
 */
export function useMcpActivity(): McpActivityRecord[] {
  const [recs, setRecs] = useState<McpActivityRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('mcp-activity:recent', undefined)
      .then((recent) => {
        if (!cancelled) setRecs(recent.slice(-MCP_ACTIVITY_RECENT_MAX));
      })
      .catch(() => {
        /* seed failure must not block the live push below */
      });
    const off = window.kiagent.on('push:mcp-activity', (batch) => {
      setRecs((prev) => prev.concat(batch).slice(-MCP_ACTIVITY_RECENT_MAX));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return recs;
}
