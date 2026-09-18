export interface AttentionActionPolicy {
  readonly views: readonly string[];
  readonly paramKeys: readonly string[];
}

// The product overlay shadows this file with its product-specific allow-list
// (design §2.1). Core must admit no navigation target by default.
export const ATTENTION_ACTION_POLICY = {
  views: [],
  paramKeys: [],
} as const satisfies AttentionActionPolicy;
