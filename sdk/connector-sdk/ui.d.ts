/** Props the app passes to a contributed page's default export. */
export interface PageProps {
  params: Record<string, string | undefined>;
  navigate(view: string, params?: Record<string, string>): void;
}

/** The window.kiagent channels a contributed page may call. */
export interface PageKiagent {
  invoke(
    channel: 'search:query',
    req: {
      text?: string;
      type?: string;
      account?: string;
      fromDate?: string;
      toDate?: string;
      orderBy?: 'relevance' | 'newest';
      limit?: number;
      offset?: number;
      includeArchived?: boolean;
      people?: { from?: string[]; to?: string[]; participant?: string[] };
      label?: string[];
      hasAttachment?: boolean;
      filename?: string[];
      ext?: string[];
    },
  ): Promise<Array<Record<string, any>>>;
  invoke(channel: 'app:get-state', req?: undefined): Promise<PageAppState>;
  on(channel: 'push:app-state', cb: (push: PageAppState) => void): () => void;
}

/** What `app:get-state` resolves to and `push:app-state` delivers: the app
 *  state wrapped in an envelope — read accounts from `.state.accounts`. */
export interface PageAppState {
  state: {
    accounts: Array<{
      account: {
        id: string;
        source: string;
        identifier: string;
        config?: Record<string, unknown>;
      };
    }>;
  };
  seq: number;
  rev: number;
}

declare global {
  interface Window {
    kiagent: PageKiagent;
  }
}
