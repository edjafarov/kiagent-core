import vm from 'node:vm';

import {
  ATTENTION_ACTION_POLICY,
  type AttentionActionPolicy,
} from '../action-policy';
import { validateAttentionItem, validateBatch } from '../validate';

function item(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'kiagent.expenses:draft-1',
    producer: 'kiagent.expenses',
    kind: 'waiting',
    title: 'Needs review',
    detail: 'Open the draft and review it.',
    priority: 2,
    dueAt: 2_000,
    expiresAt: null,
    createdAt: 1_000,
    updatedAt: 1_500,
    revision: 1,
    state: 'open',
    resolvedBy: null,
    actions: [],
    ...overrides,
  };
}

const policy: AttentionActionPolicy = {
  views: ['outbox', 'home'],
  paramKeys: ['anchor', 'accountId'],
};

type TrapCounts = {
  get: number;
  getOwnPropertyDescriptor: number;
  ownKeys: number;
  getPrototypeOf: number;
  has: number;
};

function proxyWithTrapCounts<T extends object>(
  source: T,
  get?: (target: T, property: PropertyKey, receiver: object) => unknown,
): { proxy: T; traps: TrapCounts } {
  const traps: TrapCounts = {
    get: 0,
    getOwnPropertyDescriptor: 0,
    ownKeys: 0,
    getPrototypeOf: 0,
    has: 0,
  };
  const proxy = new Proxy(source, {
    get(object, property, receiver) {
      traps.get += 1;
      return get
        ? get(object, property, receiver)
        : Reflect.get(object, property, receiver);
    },
    getOwnPropertyDescriptor(object, property) {
      traps.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(object, property);
    },
    ownKeys(object) {
      traps.ownKeys += 1;
      return Reflect.ownKeys(object);
    },
    getPrototypeOf(object) {
      traps.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(object);
    },
    has(object, property) {
      traps.has += 1;
      return Reflect.has(object, property);
    },
  });
  return { proxy, traps };
}

function zeroTrapCounts(): TrapCounts {
  return {
    get: 0,
    getOwnPropertyDescriptor: 0,
    ownKeys: 0,
    getPrototypeOf: 0,
    has: 0,
  };
}

describe('attention validation', () => {
  it('C11 default policy rejects every navigation target', () => {
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            {
              id: 'open',
              label: 'Open',
              target: { view: 'outbox' },
            },
          ],
        }),
        ATTENTION_ACTION_POLICY,
      ),
    ).toThrow();
  });

  it('C11 injected policy admits exactly its views and parameter keys in both directions', () => {
    const output = validateAttentionItem(
      item({
        actions: [
          {
            id: 'open',
            label: 'Open',
            target: { view: 'outbox', params: { anchor: 'draft-1' } },
          },
        ],
      }),
      policy,
    );
    expect(output.actions[0].target).toEqual({
      view: 'outbox',
      params: { anchor: 'draft-1' },
    });

    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            {
              id: 'bad-view',
              label: 'Bad view',
              target: { view: 'calendar' },
            },
          ],
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            {
              id: 'bad-param',
              label: 'Bad param',
              target: { view: 'outbox', params: { month: '2026-01' } },
            },
          ],
        }),
        policy,
      ),
    ).toThrow();
  });

  it('C16 validates and deep-copies canonical wire data', () => {
    const input = item({
      actions: [
        {
          id: 'open',
          label: 'Open',
          target: { view: 'outbox', params: { anchor: 'draft-1' } },
        },
      ],
      people: [{ kind: 'email', value: 'person@example.com' }],
    });
    const output = validateAttentionItem(input, policy);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(output.actions).not.toBe(input.actions);
    expect(output.people).not.toBe(input.people);
  });

  it.each([
    ['invalid producer', { producer: 'renderer:outbox' }],
    ['wrong id prefix', { id: 'kiagent.other:draft-1' }],
    ['bad title length', { title: 'x'.repeat(81) }],
    ['bad detail length', { detail: 'x'.repeat(161) }],
    ['bad priority', { priority: 4 }],
    ['negative timestamp', { createdAt: -1 }],
    ['non-finite timestamp', { updatedAt: Infinity }],
    ['zero revision', { revision: 0 }],
    ['open with resolver', { resolvedBy: 'user' }],
    ['expired with resolver', { state: 'expired', resolvedBy: 'producer' }],
    ['unknown kind', { kind: 'other' }],
    [
      'unknown view',
      {
        actions: [{ id: 'open', label: 'Open', target: { view: 'calendar' } }],
      },
    ],
    [
      'unknown param',
      {
        actions: [
          {
            id: 'open',
            label: 'Open',
            target: { view: 'outbox', params: { month: '2026-01' } },
          },
        ],
      },
    ],
    [
      'duplicate action ids',
      {
        actions: [
          { id: 'open', label: 'Open', target: { view: 'outbox' } },
          { id: 'open', label: 'Again', target: { view: 'home' } },
        ],
      },
    ],
    ['uppercase email', { people: [{ kind: 'email', value: 'Person@x.com' }] }],
    [
      'namespaceless chat handle',
      { people: [{ kind: 'chat-handle', value: 'person' }] },
    ],
    [
      'empty speaker namespace',
      { people: [{ kind: 'speaker', namespace: '', value: 'person' }] },
    ],
  ])('C16 rejects %s', (_name, overrides) => {
    expect(() => validateAttentionItem(item(overrides), policy)).toThrow();
  });

  it('C16 rejects executable, inherited, accessor, and nested unsafe shapes without executing them', () => {
    let executions = 0;
    const withFunction = item({ toJSON: () => executions++ });
    expect(() => validateAttentionItem(withFunction, policy)).toThrow();
    expect(executions).toBe(0);

    const inherited = Object.create({ title: 'inherited' }) as Record<
      string,
      unknown
    >;
    Object.assign(inherited, item());
    delete inherited.title;
    expect(() => validateAttentionItem(inherited, policy)).toThrow();

    const getter = item();
    Object.defineProperty(getter, 'title', {
      enumerable: true,
      get: () => {
        executions += 1;
        return 'executed';
      },
    });
    expect(() => validateAttentionItem(getter, policy)).toThrow();
    expect(executions).toBe(0);

    const nested = item({
      actions: [
        {
          id: 'open',
          label: 'Open',
          target: { view: 'outbox' },
        },
      ],
    });
    Object.defineProperty((nested.actions as unknown[])[0], 'toJSON', {
      enumerable: false,
      value: () => executions++,
    });
    expect(() => validateAttentionItem(nested, policy)).toThrow();
    expect(executions).toBe(0);
  });

  it('C16 plain-object: rejects a non-plain object even when every required field is its own property', () => {
    class AttentionItemFixture {}
    const nonPlain = Object.assign(new AttentionItemFixture(), item());

    expect(() => validateAttentionItem(nonPlain, policy)).toThrow();
  });

  it('C16 person descriptor: rejects a person value getter without executing it', () => {
    let executions = 0;
    const person: Record<string, unknown> = { kind: 'email' };
    Object.defineProperty(person, 'value', {
      enumerable: true,
      get: () => {
        executions += 1;
        return 'person@example.com';
      },
    });

    expect(() =>
      validateAttentionItem(item({ people: [person] }), policy),
    ).toThrow();
    expect(executions).toBe(0);
  });

  it('V2a rejects a Proxy item before the flip-flopping title trap can run', () => {
    let titleReads = 0;
    const { proxy, traps } = proxyWithTrapCounts(item(), (target, property) => {
      if (property === 'title') {
        titleReads += 1;
        return titleReads <= 3 ? 'clean' : `evil\0${'x'.repeat(500)}`;
      }
      return Reflect.get(target, property);
    });

    expect(() => validateAttentionItem(proxy, policy)).toThrow();
    expect(titleReads).toBe(0);
    expect(traps).toEqual(zeroTrapCounts());
  });

  it('V2b rejects a Proxy over a null-prototype item without running traps', () => {
    const target = Object.assign(Object.create(null), item());
    const { proxy, traps } = proxyWithTrapCounts(target);

    expect(() => validateAttentionItem(proxy, policy)).toThrow();
    expect(traps).toEqual(zeroTrapCounts());
  });

  it('V2c rejects an item with a Proxy prototype without querying that prototype', () => {
    const { proxy: prototype, traps } = proxyWithTrapCounts(
      Object.create(null) as Record<string, unknown>,
    );
    const target = Object.assign(Object.create(prototype), item());

    expect(() => validateAttentionItem(target, policy)).toThrow();
    expect(traps).toEqual(zeroTrapCounts());
  });

  it('V3 reads batch items by own index and never through an inherited iterator', () => {
    // An own-shape-valid array whose PROTOTYPE supplies the iterator: for...of
    // would see an EMPTY snapshot (which resolves the producer's open rows).
    let iteratorReads = 0;
    const hostile: unknown[] = [item()];
    Object.setPrototypeOf(
      hostile,
      Object.create(Array.prototype, {
        [Symbol.iterator]: {
          get() {
            iteratorReads += 1;
            return function* empty() {};
          },
        },
      }),
    );
    const result = validateBatch('kiagent.expenses', hostile, policy);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(iteratorReads).toBe(0);

    let proxyTraps = 0;
    const viaProxy: unknown[] = [item()];
    Object.setPrototypeOf(
      viaProxy,
      new Proxy(Array.prototype, {
        get(target, key, receiver) {
          proxyTraps += 1;
          return Reflect.get(target, key, receiver);
        },
      }),
    );
    expect(
      validateBatch('kiagent.expenses', viaProxy, policy).valid,
    ).toHaveLength(1);
    expect(proxyTraps).toBe(0);

    const revocable = Proxy.revocable(Array.prototype, {});
    const viaRevoked: unknown[] = [item()];
    Object.setPrototypeOf(viaRevoked, revocable.proxy);
    revocable.revoke();
    expect(
      validateBatch('kiagent.expenses', viaRevoked, policy).valid,
    ).toHaveLength(1);
  });

  it('V2d rejects a Proxy batch before Array.isArray or key enumeration', () => {
    const { proxy, traps } = proxyWithTrapCounts([item()]);

    expect(validateBatch('kiagent.expenses', proxy, policy)).toEqual({
      valid: [],
      rejected: [{ id: '', reason: 'invalid attention batch' }],
    });
    expect(traps).toEqual(zeroTrapCounts());
  });

  it.each([
    [
      'actions[0]',
      () => {
        const nested = proxyWithTrapCounts({
          id: 'open',
          label: 'Open',
          target: { view: 'outbox' },
        });
        return {
          input: item({ actions: [nested.proxy] }),
          traps: nested.traps,
        };
      },
    ],
    [
      'actions[0].target',
      () => {
        const nested = proxyWithTrapCounts({ view: 'outbox' });
        return {
          input: item({
            actions: [{ id: 'open', label: 'Open', target: nested.proxy }],
          }),
          traps: nested.traps,
        };
      },
    ],
    [
      'target.params',
      () => {
        const nested = proxyWithTrapCounts({ anchor: 'draft-1' });
        return {
          input: item({
            actions: [
              {
                id: 'open',
                label: 'Open',
                target: { view: 'outbox', params: nested.proxy },
              },
            ],
          }),
          traps: nested.traps,
        };
      },
    ],
    [
      'people[0]',
      () => {
        const nested = proxyWithTrapCounts({
          kind: 'email',
          value: 'person@example.com',
        });
        return { input: item({ people: [nested.proxy] }), traps: nested.traps };
      },
    ],
  ])('V2e rejects nested Proxy %s without running traps', (_name, makeCase) => {
    const { input, traps } = makeCase();
    expect(() => validateAttentionItem(input, policy)).toThrow();
    expect(traps).toEqual(zeroTrapCounts());
  });

  it('C16 enforces action/person counts and safe text limits', () => {
    expect(() =>
      validateAttentionItem(
        item({
          title: 'line\nbreak',
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: Array.from({ length: 4 }, (_, index) => ({
            id: `a${index}`,
            label: 'Open',
            target: { view: 'outbox' },
          })),
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          people: Array.from({ length: 9 }, () => ({
            kind: 'email',
            value: 'person@example.com',
          })),
        }),
        policy,
      ),
    ).toThrow();
  });

  it('C16 validateBatch rejects invalid producers at batch level even when empty', () => {
    expect(validateBatch('renderer:outbox', [], policy)).toEqual({
      valid: [],
      rejected: [{ id: '', reason: 'invalid producer or batch' }],
    });
  });

  it('C16 validateBatch reports duplicates while preserving the earlier valid item', () => {
    const first = item();
    const result = validateBatch('kiagent.expenses', [first, first], policy);
    expect(result.valid).toEqual([expect.objectContaining({ id: first.id })]);
    expect(result.rejected).toEqual([
      { id: first.id, reason: 'producer or duplicate id mismatch' },
    ]);

    const mismatch = validateBatch(
      'kiagent.expenses',
      [item({ producer: 'kiagent.other', id: 'kiagent.other:x' })],
      policy,
    );
    expect(mismatch).toEqual({
      valid: [],
      rejected: [
        { id: 'kiagent.other:x', reason: 'producer or duplicate id mismatch' },
      ],
    });
  });

  it('r: injected multi-entry policy admits every configured view and parameter key', () => {
    for (const view of policy.views) {
      expect(() =>
        validateAttentionItem(
          item({
            actions: [{ id: `view-${view}`, label: 'Open', target: { view } }],
          }),
          policy,
        ),
      ).not.toThrow();
    }
    for (const key of policy.paramKeys) {
      expect(() =>
        validateAttentionItem(
          item({
            actions: [
              {
                id: 'param',
                label: 'Open',
                target: { view: 'outbox', params: { [key]: 'value' } },
              },
            ],
          }),
          policy,
        ),
      ).not.toThrow();
    }
  });

  it('s: validateBatch accepts 501 items and a valid snapshot larger than one MiB', () => {
    const items = Array.from({ length: 501 }, (_, index) =>
      item({ id: `kiagent.expenses:bulk-${index}` }),
    );
    expect(validateBatch('kiagent.expenses', items, policy).valid).toHaveLength(
      501,
    );
    const largeSnapshot = Array.from({ length: 3_000 }, (_, index) =>
      item({ id: `kiagent.expenses:large-${index}`, detail: 'x'.repeat(160) }),
    );
    expect(JSON.stringify(largeSnapshot).length).toBeGreaterThan(1_000_000);
    expect(
      validateBatch('kiagent.expenses', largeSnapshot, policy).valid,
    ).toHaveLength(3_000);
  });

  it('t: unsafe accessors and custom array protocol inputs execute zero user code', () => {
    let executions = 0;
    const actionTarget = { view: 'outbox' } as Record<string, unknown>;
    Object.defineProperty(actionTarget, 'view', {
      enumerable: true,
      get: () => {
        executions += 1;
        return 'outbox';
      },
    });
    expect(() =>
      validateAttentionItem(
        item({
          actions: [{ id: 'open', label: 'Open', target: actionTarget }],
        }),
        policy,
      ),
    ).toThrow();

    const actions = [{ id: 'open', label: 'Open', target: { view: 'outbox' } }];
    Object.defineProperty(actions, 'toJSON', {
      enumerable: false,
      value: () => executions++,
    });
    expect(() => validateAttentionItem(item({ actions }), policy)).toThrow();

    const indexed = [item()];
    Object.defineProperty(indexed, '0', {
      enumerable: true,
      get: () => {
        executions += 1;
        return item();
      },
    });
    expect(validateBatch('renderer:outbox', indexed, policy).rejected).toEqual([
      { id: '', reason: 'invalid attention batch' },
    ]);
    expect(executions).toBe(0);
    expect(validateBatch('renderer:outbox', [], policy).rejected).toEqual([
      { id: '', reason: 'invalid producer or batch' },
    ]);

    const iterated = [item()];
    Object.defineProperty(iterated, Symbol.iterator, {
      enumerable: false,
      get: () => {
        executions += 1;
        return Array.prototype[Symbol.iterator].call(iterated);
      },
    });
    expect(validateBatch('kiagent.expenses', iterated, policy)).toEqual({
      valid: [],
      rejected: [{ id: '', reason: 'invalid attention batch' }],
    });
    expect(executions).toBe(0);
  });

  it('u: validator boundaries are independent for text, identity, revision, and producer shape', () => {
    expect(() =>
      validateAttentionItem(item({ title: 'x'.repeat(80) }), policy),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(item({ title: 'x'.repeat(81) }), policy),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            { id: 'open', label: 'x'.repeat(24), target: { view: 'outbox' } },
          ],
        }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            { id: 'open', label: 'x'.repeat(25), target: { view: 'outbox' } },
          ],
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            {
              id: 'open',
              label: 'Open',
              target: { view: 'outbox', params: { anchor: 'x'.repeat(200) } },
            },
          ],
        }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          actions: [
            {
              id: 'open',
              label: 'Open',
              target: { view: 'outbox', params: { anchor: 'x'.repeat(201) } },
            },
          ],
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          people: [{ kind: 'email', value: `${'x'.repeat(194)}@x.com` }],
        }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          people: [{ kind: 'email', value: `${'x'.repeat(195)}@x.com` }],
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          people: [
            { kind: 'chat-handle', namespace: 'x'.repeat(80), value: 'person' },
          ],
        }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({
          people: [
            { kind: 'chat-handle', namespace: 'x'.repeat(81), value: 'person' },
          ],
        }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({ id: `kiagent.expenses:${'x'.repeat(103)}` }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({ id: `kiagent.expenses:${'x'.repeat(104)}` }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({ revision: Number.MAX_SAFE_INTEGER }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({ revision: Number.MAX_SAFE_INTEGER + 1 }),
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateAttentionItem(
        item({ producer: 'acme.widget', id: 'acme.widget:item' }),
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateAttentionItem(
        item({ producer: 'kiagent.foo_bar', id: 'kiagent.foo_bar:item' }),
        policy,
      ),
    ).toThrow();
  });

  it('v: validation output is detached so caller mutation after publication cannot alter canonical content', () => {
    const input = item({
      actions: [
        {
          id: 'open',
          label: 'Open',
          target: { view: 'outbox', params: { anchor: 'before' } },
        },
      ],
    });
    const output = validateAttentionItem(input, policy);
    (
      input.actions as Array<{ target: { params: { anchor: string } } }>
    )[0].target.params.anchor = 'after';
    expect(output.actions[0].target.params).toEqual({ anchor: 'before' });
  });

  it('V1 accepts cross-realm plain records and arrays but rejects non-root prototypes', () => {
    const crossRealmItem = vm.runInNewContext(`(${JSON.stringify(item())})`);
    expect(() => validateAttentionItem(crossRealmItem, policy)).not.toThrow();

    const crossRealmItems = vm.runInNewContext(`([${JSON.stringify(item())}])`);
    expect(
      validateBatch('kiagent.expenses', crossRealmItems, policy).valid,
    ).toHaveLength(1);

    class AttentionItemFixture {}
    const classInstance = Object.assign(new AttentionItemFixture(), item());
    expect(() => validateAttentionItem(classInstance, policy)).toThrow();

    const objectWithPrototype = Object.assign(Object.create({}), item());
    expect(() => validateAttentionItem(objectWithPrototype, policy)).toThrow();

    const foreignPrototype = vm.runInNewContext('({})');
    const foreignPrototypeObject = Object.assign(
      Object.create(foreignPrototype),
      item(),
    );
    expect(() =>
      validateAttentionItem(foreignPrototypeObject, policy),
    ).toThrow();
  });
});
