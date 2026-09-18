import type {
  AttentionActionWire,
  AttentionItemWire,
  AttentionPersonWire,
} from '@shared/attention';

import type { AttentionActionPolicy } from './action-policy';

// Keep this in lockstep with src/main/platform/manifest.ts's ID_RE. Attention
// producers are extension ids only; the old renderer:* namespace is not part
// of the core contract.
const PRODUCER_ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const ITEM_KEYS = new Set([
  'id',
  'producer',
  'kind',
  'title',
  'detail',
  'priority',
  'dueAt',
  'expiresAt',
  'createdAt',
  'updatedAt',
  'revision',
  'state',
  'resolvedBy',
  'actions',
  'people',
]);
const ACTION_KEYS = new Set(['id', 'label', 'target']);
const TARGET_KEYS = new Set(['view', 'params']);
const PERSON_KEYS = new Set(['kind', 'namespace', 'value']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSafeOwnDataProperties(
  value: Record<string, unknown>,
  keys: Set<string>,
  requiredKeys: Set<string>,
): boolean {
  const present = new Set<string>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
    present.add(key);
  }
  for (const key of requiredKeys) {
    if (!present.has(key)) return false;
  }
  return true;
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < 0xffffffff &&
    String(index) === key
  );
}

function hasSafeArrayShape(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  let length: number | undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
    if (key === 'length') {
      if (descriptor.enumerable || typeof descriptor.value !== 'number') {
        return false;
      }
      length = descriptor.value;
      continue;
    }
    if (!descriptor.enumerable || !isArrayIndexKey(key)) return false;
  }
  if (length === undefined || !Number.isInteger(length) || length < 0) {
    return false;
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return false;
    }
  }
  return true;
}

function stringLength(value: string): number {
  return Array.from(value).length;
}

function safeText(value: string, max: number): boolean {
  if (stringLength(value) > max) return false;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (code < 32 || code === 127 || code === 0x2028 || code === 0x2029) {
      return false;
    }
  }
  return true;
}

function validProducer(value: unknown): value is string {
  return typeof value === 'string' && PRODUCER_ID_RE.test(value);
}

function validItemId(value: unknown, producer: string): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 120 &&
    /^[a-z0-9._:-]+$/.test(value) &&
    value.startsWith(`${producer}:`)
  );
}

function validateAction(
  input: unknown,
  policy: AttentionActionPolicy,
): AttentionActionWire {
  if (
    !isPlainRecord(input) ||
    !hasSafeOwnDataProperties(
      input,
      ACTION_KEYS,
      new Set(['id', 'label', 'target']),
    )
  ) {
    throw new Error('invalid attention action');
  }
  const { target } = input;
  if (
    typeof input.id !== 'string' ||
    !/^[a-z0-9._:-]{1,64}$/.test(input.id) ||
    typeof input.label !== 'string' ||
    input.label.length === 0 ||
    !safeText(input.label, 24) ||
    !isPlainRecord(target) ||
    !hasSafeOwnDataProperties(target, TARGET_KEYS, new Set(['view'])) ||
    typeof target.view !== 'string' ||
    !policy.views.includes(target.view)
  ) {
    throw new Error('invalid attention action');
  }
  const hasParams = Object.prototype.hasOwnProperty.call(target, 'params');
  const params = hasParams ? target.params : undefined;
  let copiedParams: Record<string, string> | undefined;
  if (params !== undefined) {
    if (
      !isPlainRecord(params) ||
      !hasSafeOwnDataProperties(params, new Set(policy.paramKeys), new Set())
    ) {
      throw new Error('invalid attention params');
    }
    copiedParams = {};
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (
        !policy.paramKeys.includes(key) ||
        typeof value !== 'string' ||
        !safeText(value, 200)
      ) {
        throw new Error('invalid attention params');
      }
      copiedParams[key] = value;
    }
  }
  return {
    id: input.id,
    label: input.label,
    target: {
      view: target.view,
      ...(copiedParams ? { params: copiedParams } : {}),
    },
  };
}

function validatePerson(input: unknown): AttentionPersonWire {
  if (
    !isPlainRecord(input) ||
    !hasSafeOwnDataProperties(input, PERSON_KEYS, new Set(['kind', 'value']))
  ) {
    throw new Error('invalid attention person');
  }
  const hasNamespace = Object.prototype.hasOwnProperty.call(input, 'namespace');
  const namespace = hasNamespace ? input.namespace : undefined;
  if (
    (input.kind !== 'email' &&
      input.kind !== 'chat-handle' &&
      input.kind !== 'speaker') ||
    typeof input.value !== 'string' ||
    input.value.length === 0 ||
    !safeText(input.value, 200) ||
    (input.kind === 'email' && input.value !== input.value.toLowerCase()) ||
    (namespace !== undefined &&
      (typeof namespace !== 'string' || !safeText(namespace, 80))) ||
    (input.kind !== 'email' &&
      (typeof namespace !== 'string' ||
        namespace.length === 0 ||
        !safeText(namespace, 80)))
  ) {
    throw new Error('invalid attention person');
  }
  return {
    kind: input.kind,
    ...(namespace !== undefined ? { namespace } : {}),
    value: input.value,
  } as AttentionPersonWire;
}

function validTimestamp(
  value: unknown,
  nullable: boolean,
): value is number | null {
  return (
    (value === null && nullable) ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

export function validateAttentionItem(
  input: unknown,
  policy: AttentionActionPolicy,
): AttentionItemWire {
  if (
    !isPlainRecord(input) ||
    !hasSafeOwnDataProperties(
      input,
      ITEM_KEYS,
      new Set([
        'id',
        'producer',
        'kind',
        'title',
        'detail',
        'priority',
        'dueAt',
        'expiresAt',
        'createdAt',
        'updatedAt',
        'revision',
        'state',
        'resolvedBy',
        'actions',
      ]),
    )
  ) {
    throw new Error('invalid attention item');
  }
  const { actions } = input;
  const hasPeople = Object.prototype.hasOwnProperty.call(input, 'people');
  const people = hasPeople ? input.people : undefined;
  if (
    typeof input.id !== 'string' ||
    typeof input.producer !== 'string' ||
    !validProducer(input.producer) ||
    !validItemId(input.id, input.producer) ||
    (input.kind !== 'waiting' &&
      input.kind !== 'happening' &&
      input.kind !== 'upcoming') ||
    typeof input.title !== 'string' ||
    input.title.length === 0 ||
    !safeText(input.title, 80) ||
    (input.detail !== null &&
      (typeof input.detail !== 'string' || !safeText(input.detail, 160))) ||
    (input.priority !== 1 && input.priority !== 2 && input.priority !== 3) ||
    !validTimestamp(input.dueAt, true) ||
    !validTimestamp(input.expiresAt, true) ||
    !validTimestamp(input.createdAt, false) ||
    !validTimestamp(input.updatedAt, false) ||
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision <= 0 ||
    (input.state !== 'open' &&
      input.state !== 'resolved' &&
      input.state !== 'expired') ||
    (input.state === 'open' && input.resolvedBy !== null) ||
    (input.state === 'resolved' &&
      input.resolvedBy !== 'producer' &&
      input.resolvedBy !== 'user') ||
    (input.state === 'expired' && input.resolvedBy !== null) ||
    !hasSafeArrayShape(actions) ||
    actions.length > 3 ||
    (people !== undefined && (!hasSafeArrayShape(people) || people.length > 8))
  ) {
    throw new Error('invalid attention item');
  }
  const copiedActions: AttentionActionWire[] = [];
  const actionIds = new Set<string>();
  for (let index = 0; index < actions.length; index += 1) {
    const action = validateAction(actions[index], policy);
    if (actionIds.has(action.id)) {
      throw new Error('duplicate attention action');
    }
    actionIds.add(action.id);
    copiedActions.push(action);
  }
  let copiedPeople: AttentionPersonWire[] | undefined;
  if (people !== undefined) {
    copiedPeople = [];
    for (let index = 0; index < people.length; index += 1) {
      copiedPeople.push(validatePerson(people[index]));
    }
  }
  return {
    id: input.id,
    producer: input.producer,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    priority: input.priority,
    dueAt: input.dueAt,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    revision: input.revision,
    state: input.state,
    resolvedBy: input.resolvedBy,
    actions: copiedActions,
    ...(copiedPeople ? { people: copiedPeople } : {}),
  } as AttentionItemWire;
}

function safeItemId(raw: unknown): string {
  if (!isPlainRecord(raw)) return '';
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'id');
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'string'
    ? descriptor.value
    : '';
}

function hasSafeArrayInput(value: unknown): value is unknown[] {
  return hasSafeArrayShape(value);
}

export function validateBatch(
  producer: string,
  rawItems: unknown,
  policy: AttentionActionPolicy,
): {
  valid: AttentionItemWire[];
  rejected: { id: string; reason: string }[];
} {
  if (!hasSafeArrayInput(rawItems)) {
    return {
      valid: [],
      rejected: [{ id: '', reason: 'invalid attention batch' }],
    };
  }
  if (!validProducer(producer)) {
    return {
      valid: [],
      rejected: [{ id: '', reason: 'invalid producer or batch' }],
    };
  }
  const valid: AttentionItemWire[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const id = safeItemId(raw);
    try {
      const item = validateAttentionItem(raw, policy);
      if (item.producer !== producer || seen.has(item.id)) {
        throw new Error('producer or duplicate id mismatch');
      }
      seen.add(item.id);
      valid.push(item);
    } catch (error) {
      rejected.push({
        id,
        reason:
          error instanceof Error ? error.message : 'invalid attention item',
      });
    }
  }
  return { valid, rejected };
}
