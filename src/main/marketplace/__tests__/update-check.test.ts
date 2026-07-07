/** @jest-environment node */

import { checkUpdates } from '../update-check';
import type { UpdateInfo } from '@shared/ipc';

describe('update-check', () => {
  it('should call resolveLatest with bare ref (without @tag)', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: '2.0.0' });

    const installed = [{ id: 'plugin-a', version: '1.0.0', ref: 'github:owner/repo@v1.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(mockResolveLatest).toHaveBeenCalledWith('github:owner/repo');
    expect(result).toEqual([
      {
        id: 'plugin-a',
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
        ref: 'github:owner/repo@v1.0.0',
      },
    ]);
  });

  it('should report update only when semver.gt is true', async () => {
    const mockResolveLatest = jest.fn();

    // Test: latest < installed (no update)
    mockResolveLatest.mockResolvedValueOnce({ version: '1.0.0' });

    const installed = [{ id: 'plugin-a', version: '2.0.0', ref: 'github:owner/repo@v2.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(0);
  });

  it('should report update when latest > installed', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: '3.0.0' });

    const installed = [{ id: 'plugin-a', version: '2.0.0', ref: 'github:owner/repo@v2.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'plugin-a',
      installedVersion: '2.0.0',
      latestVersion: '3.0.0',
      ref: 'github:owner/repo@v2.0.0',
    });
  });

  it('should skip file: refs', async () => {
    const mockResolveLatest = jest.fn();

    const installed = [{ id: 'plugin-dev', version: '0.0.1', ref: 'file:/local/path' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(mockResolveLatest).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it('should skip refless records', async () => {
    const mockResolveLatest = jest.fn();

    const installed = [{ id: 'plugin-snapshot', version: '1.0.0' }]; // ref is optional and not provided
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(mockResolveLatest).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it('should swallow per-repo resolveLatest rejections', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockRejectedValueOnce(new Error('Network error'));

    const installed = [{ id: 'plugin-offline', version: '1.0.0', ref: 'github:owner/repo@v1.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(0);
  });

  it('should handle mixed refs: skip non-github, process github, swallow errors', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: '2.0.0' }); // github:a/b
    mockResolveLatest.mockRejectedValueOnce(new Error('Error')); // github:c/d
    // github:e/f returns null (no version available)
    mockResolveLatest.mockResolvedValueOnce(null);

    const installed = [
      { id: 'dev-plugin', version: '1.0.0', ref: 'file:/local' },
      { id: 'plugin-a', version: '1.0.0', ref: 'github:a/b@v1.0.0' },
      { id: 'plugin-c', version: '1.0.0', ref: 'github:c/d@v1.0.0' },
      { id: 'plugin-e', version: '1.0.0', ref: 'github:e/f@v1.0.0' },
      { id: 'snapshot', version: '1.0.0' },
    ];

    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('plugin-a');
  });

  it('should handle invalid semver gracefully', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: 'not-a-version' }); // Invalid semver

    const installed = [{ id: 'plugin-a', version: '1.0.0', ref: 'github:owner/repo@v1.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(0);
  });

  it('should handle invalid installed version gracefully', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: '2.0.0' });

    const installed = [{ id: 'plugin-bad', version: 'not-valid', ref: 'github:owner/repo@v1.0.0' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result).toHaveLength(0);
  });

  it('should preserve the original ref in the result', async () => {
    const mockResolveLatest = jest.fn();
    mockResolveLatest.mockResolvedValueOnce({ version: '2.0.0' });

    const installed = [{ id: 'plugin', version: '1.0.0', ref: 'github:owner/repo@v1.0.0-custom' }];
    const result = await checkUpdates({ installed, resolveLatest: mockResolveLatest });

    expect(result[0].ref).toBe('github:owner/repo@v1.0.0-custom');
  });
});
