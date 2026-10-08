import os from 'node:os';

import {
  __resetChildPriorityLog,
  demoteHost,
  launch,
  setChildPriorityLog,
  TASKPOLICY,
} from '../child-priority';

const LOW = os.constants.priority.PRIORITY_LOW;
const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;

function harness(platform: NodeJS.Platform, hasTaskpolicy = true) {
  const started: Array<{ cmd: string; args: string[] }> = [];
  const setPriority = jest.fn();
  const start = (cmd: string, args: string[]) => {
    started.push({ cmd, args });
    return { pid: 4242 };
  };
  const deps = { platform, exists: () => hasTaskpolicy, setPriority };
  return { started, setPriority, start, deps };
}

beforeEach(() => __resetChildPriorityLog());

it('interactive runs the command untouched', () => {
  const h = harness('darwin');
  launch('interactive', '/bin/x', ['-a'], h.start, h.deps);
  expect(h.started).toEqual([{ cmd: '/bin/x', args: ['-a'] }]);
  expect(h.setPriority).not.toHaveBeenCalled();
});

it('background on macOS execs through taskpolicy -b (same pid, no setPriority)', () => {
  const h = harness('darwin');
  const child = launch('background', '/bin/x', ['-a'], h.start, h.deps);
  expect(h.started).toEqual([
    { cmd: TASKPOLICY, args: ['-b', '/bin/x', '-a'] },
  ]);
  expect(child.pid).toBe(4242);
  expect(h.setPriority).not.toHaveBeenCalled();
});

it('background on macOS without taskpolicy falls back to PRIORITY_LOW', () => {
  const h = harness('darwin', false);
  launch('background', '/bin/x', [], h.start, h.deps);
  expect(h.started[0].cmd).toBe('/bin/x');
  expect(h.setPriority).toHaveBeenCalledWith(4242, LOW);
});

it('background on Windows sets PRIORITY_LOW after spawn', () => {
  const h = harness('win32');
  launch('background', 'C:\\x.exe', [], h.start, h.deps);
  expect(h.started[0].cmd).toBe('C:\\x.exe');
  expect(h.setPriority).toHaveBeenCalledWith(4242, LOW);
});

it('a start returning no pid (void execFile fake) is a no-op demotion', () => {
  const setPriority = jest.fn();
  launch('background', '/bin/x', [], () => undefined, {
    platform: 'win32',
    setPriority,
  });
  expect(setPriority).not.toHaveBeenCalled();
});

it('setPriority errors (child already exited) are swallowed', () => {
  const setPriority = jest.fn(() => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  });
  expect(() =>
    launch('background', '/bin/x', [], () => ({ pid: 1 }), {
      platform: 'win32',
      setPriority,
    }),
  ).not.toThrow();
});

it('demoteHost sets below-normal, tolerates undefined pid, logs once', () => {
  const lines: string[] = [];
  setChildPriorityLog((m) => lines.push(m));
  const setPriority = jest.fn();
  demoteHost(undefined, { setPriority });
  demoteHost(7, { setPriority });
  demoteHost(8, { setPriority });
  expect(setPriority).toHaveBeenCalledTimes(2);
  expect(setPriority).toHaveBeenCalledWith(7, BELOW);
  expect(lines).toEqual([
    '[priority] extension-host below-normal via setPriority',
  ]);
});

it('logs once per (binary, class)', () => {
  const lines: string[] = [];
  setChildPriorityLog((m) => lines.push(m));
  const h = harness('darwin');
  launch('background', '/a/whisper-cli', [], h.start, h.deps);
  launch('background', '/b/whisper-cli', [], h.start, h.deps);
  launch('interactive', '/a/whisper-cli', [], h.start, h.deps);
  expect(lines).toEqual(['[priority] whisper-cli background via taskpolicy']);
});

it('logs the demotion outcome: a failed setPriority is reported with its code', () => {
  const lines: string[] = [];
  setChildPriorityLog((m) => lines.push(m));
  const setPriority = jest.fn(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  launch('background', '/a/ocr', [], () => ({ pid: 5 }), {
    platform: 'win32',
    setPriority,
  });
  demoteHost(6, { setPriority });
  expect(lines).toEqual([
    '[priority] ocr background setPriority failed: EPERM',
    '[priority] extension-host below-normal setPriority failed: EPERM',
  ]);
});
