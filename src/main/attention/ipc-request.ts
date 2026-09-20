import type { AttentionItemWire } from '@shared/attention';

interface AttentionRequestError extends Error {
  code: 'ATTENTION_INVALID_REQUEST';
}

function requestError(): AttentionRequestError {
  return Object.assign(new Error('invalid attention request'), {
    code: 'ATTENTION_INVALID_REQUEST' as const,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownDataRecord(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const accepted = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !accepted.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return false;
  }
  return true;
}

function copyArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw requestError();
  const { length } = value;
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key)))
      throw requestError();
    if (typeof key === 'string') {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw requestError();
    }
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw requestError();
    copy.push(descriptor.value);
  }
  return copy;
}

export function validateAttentionListRequest(
  request: unknown,
): AttentionItemWire['kind'][] | undefined {
  if (request === undefined) return undefined;
  if (!ownDataRecord(request, ['kinds'])) throw requestError();
  if (request.kinds === undefined) return undefined;
  const kinds = copyArray(request.kinds);
  if (
    kinds.some(
      (kind) =>
        kind !== 'waiting' && kind !== 'happening' && kind !== 'upcoming',
    )
  )
    throw requestError();
  return kinds as AttentionItemWire['kind'][];
}

export function validateAttentionActRequest(request: unknown): {
  id: string;
  action: 'dismiss';
} {
  if (
    !ownDataRecord(request, ['id', 'action']) ||
    typeof request.id !== 'string' ||
    request.action !== 'dismiss'
  )
    throw requestError();
  return { id: request.id, action: 'dismiss' };
}
