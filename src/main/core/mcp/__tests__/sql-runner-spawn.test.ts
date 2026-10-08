/** @jest-environment node */
import { utilityRunnerChild } from '../sql-runner-spawn';

const mockFork = jest.fn();
jest.mock('electron', () => ({ utilityProcess: { fork: mockFork } }), {
  virtual: true,
});

describe('utilityRunnerChild', () => {
  const fakeChild = () => ({
    pid: 4321,
    kill: jest.fn(),
    postMessage: jest.fn(),
    on: jest.fn(),
    stdout: null,
    stderr: null,
  });

  it('forks with the db path in env, forwards messages, SIGTERM -> kill(), SIGKILL -> process.kill', () => {
    const c = fakeChild();
    mockFork.mockReturnValue(c);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = utilityRunnerChild('/app/sqlRunner.js', {
      KIA_SQL_RUNNER_DB: '/data/kiagent.db',
    });
    expect(mockFork).toHaveBeenCalledWith(
      '/app/sqlRunner.js',
      [],
      expect.objectContaining({
        serviceName: 'kia-sql-runner',
        env: expect.objectContaining({ KIA_SQL_RUNNER_DB: '/data/kiagent.db' }),
      }),
    );
    expect(runner.pid).toBe(4321);
    runner.send({ id: 1 });
    expect(c.postMessage).toHaveBeenCalledWith({ id: 1 });
    runner.kill('SIGTERM');
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
    runner.kill('SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(4321, 'SIGKILL');
    killSpy.mockRestore();
  });
});
