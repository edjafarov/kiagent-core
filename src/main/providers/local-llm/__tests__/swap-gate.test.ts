import {
  CAP_COOLDOWN_MS,
  createSwapGate,
  HOLD_CAP_MS,
  HOLD_IDLE_MS,
  INTERACTIVE_QUIET_MS,
} from '../swap-gate';

const clock = () => {
  let t = 1_000_000;
  return {
    now: () => t,
    add: (ms: number) => {
      t += ms;
    },
  };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const closed = { name: 'LaneClosedError' };

describe('swap gate', () => {
  it('embed waits for in-flight chat, then holds: background chat is refused', async () => {
    const g = createSwapGate(clock());
    const chatDone = await g.enter('chat', 'background');
    let embedIn = false;
    const e = g.enter('embed', 'background').then((r) => {
      embedIn = true;
      return r;
    });
    await flush();
    expect(embedIn).toBe(false);
    await expect(g.enter('chat', 'background')).rejects.toMatchObject(closed);
    chatDone();
    (await e)();
    expect(embedIn).toBe(true);
    expect(g.held()).toBe(true);
  });

  it('chat waiting behind an embed batch never overlaps it', async () => {
    const c = clock();
    const g = createSwapGate(c);
    const batch = await g.enter('embed', 'background');
    let chatIn = false;
    const chat = g.enter('chat', 'interactive').then((r) => {
      chatIn = true;
      return r;
    });
    await flush();
    expect(chatIn).toBe(false);
    batch();
    (await chat)();
    expect(chatIn).toBe(true);
  });

  it('the hold releases after 2 min without embed; background chat then runs', async () => {
    const c = clock();
    const g = createSwapGate(c);
    (await g.enter('embed', 'background'))();
    c.add(HOLD_IDLE_MS - 1);
    await expect(g.enter('chat', 'background')).rejects.toMatchObject(closed);
    c.add(1);
    (await g.enter('chat', 'background'))();
    expect(g.held()).toBe(false);
  });

  it('a long in-flight batch does not count as idle', async () => {
    const c = clock();
    const g = createSwapGate(c);
    const batch = await g.enter('embed', 'background');
    c.add(HOLD_IDLE_MS + 1);
    expect(g.held()).toBe(true);
    batch();
  });

  it('the 60-min cap ends the hold and refuses embed for 10 min', async () => {
    const c = clock();
    const g = createSwapGate(c);
    for (let t = 0; t < HOLD_CAP_MS; t += 60_000) {
      (await g.enter('embed', 'background'))();
      c.add(60_000);
    }
    await expect(g.enter('embed', 'background')).rejects.toMatchObject(closed);
    (await g.enter('chat', 'background'))();
    c.add(CAP_COOLDOWN_MS - 1);
    await expect(g.enter('embed', 'background')).rejects.toMatchObject(closed);
    c.add(1);
    (await g.enter('embed', 'background'))();
  });

  it('interactive breaks the hold after the in-flight batch and suspends embed for 2 min', async () => {
    const c = clock();
    const g = createSwapGate(c);
    const batch = await g.enter('embed', 'background');
    let served = false;
    const chat = g.enter('chat', 'interactive').then((r) => {
      served = true;
      return r;
    });
    await flush();
    expect(served).toBe(false);
    batch();
    (await chat)();
    expect(served).toBe(true);
    expect(g.held()).toBe(false);
    c.add(INTERACTIVE_QUIET_MS - 1);
    await expect(g.enter('embed', 'background')).rejects.toMatchObject(closed);
    c.add(1);
    (await g.enter('embed', 'background'))();
  });

  it('an interactive call cancels an embed waiting for chat to drain', async () => {
    const g = createSwapGate(clock());
    const bg = await g.enter('chat', 'background');
    const pending = g.enter('embed', 'background');
    const inter = g.enter('chat', 'interactive');
    await expect(pending).rejects.toMatchObject(closed);
    (await inter)();
    bg();
  });

  it('release is idempotent and chat calls run concurrently', async () => {
    const g = createSwapGate(clock());
    const a = await g.enter('chat', 'background');
    const b = await g.enter('chat', 'background');
    a();
    a();
    b();
    (await g.enter('embed', 'background'))();
  });
});
