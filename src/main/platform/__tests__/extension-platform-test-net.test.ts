/** @jest-environment node */
/** product.json `testNetExtensionId` reaches the net guard: the platform hands
 *  it to `scopedTestNetFetch` with the extension being activated. */
import path from 'path';

import { createHarness, FIXTURES, type PlatformHarness } from './helpers/platform-harness';

jest.mock('../network-service', () => {
  const actual = jest.requireActual('../network-service');
  return { ...actual, scopedTestNetFetch: jest.fn(actual.scopedTestNetFetch) };
});
// eslint-disable-next-line import/first
import { scopedTestNetFetch } from '../network-service';

describe('testNetExtensionId', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    (scopedTestNetFetch as jest.Mock).mockClear();
    h = await createHarness();
  });
  afterEach(() => h.close());

  it('createExtensionPlatform passes it to the net guard with the id of the extension that gets the network', async () => {
    const platform = h.make({ testNetExtensionId: 'test.basic' });
    await platform.start();
    await h.install(platform, path.join(FIXTURES, 'ext-basic'));
    await platform.stop();
    const call = (scopedTestNetFetch as jest.Mock).mock.calls.find((c) => c[0] === 'test.basic');
    expect(call).toBeDefined();
    expect(call![1]).toBe('test.basic');
  });
});
