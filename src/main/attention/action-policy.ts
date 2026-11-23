export interface AttentionActionPolicy {
  readonly views: readonly string[];
  readonly paramKeys: readonly string[];
}

// The allow-list is the product's (src/shared/composition.ts). Core admits no
// navigation target by default.
export { ATTENTION_ACTION_POLICY } from '@shared/composition';
