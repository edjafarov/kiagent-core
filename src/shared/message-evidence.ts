export interface MessageEvidenceV1 {
  version: 1;
  messageKey: string;
  author: string;
  at: string | null;
  signature: string | null;
  excerpt: string;
  fingerprint: string;
}
