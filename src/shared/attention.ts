/** Canonical attention payloads shared by core producers and consumers. */
export type AttentionKind = 'waiting' | 'happening' | 'upcoming';
export type AttentionState = 'open' | 'resolved' | 'expired';
export type AttentionResolvedBy = 'producer' | 'user' | null;

export interface AttentionActionWire {
  id: string;
  label: string;
  target: { view: string; params?: Record<string, string> };
}

export interface AttentionPersonWire {
  kind: 'email' | 'chat-handle' | 'speaker';
  namespace?: string;
  value: string;
}

export interface AttentionItemWire {
  id: string;
  producer: string;
  kind: AttentionKind;
  title: string;
  detail: string | null;
  priority: 1 | 2 | 3;
  dueAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  revision: number;
  state: AttentionState;
  resolvedBy: AttentionResolvedBy;
  actions: AttentionActionWire[];
  people?: AttentionPersonWire[];
}
