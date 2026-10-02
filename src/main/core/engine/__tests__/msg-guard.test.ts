import { guardCfbReader } from '../msg-guard';

const fakeReader = () => ({
  ds: { byteLength: 1000 },
  getNextBlockInner: jest.fn(() => 0),
  readProperty: jest.fn((_p: { sizeBlock: number }) => new Uint8Array(0)),
  createPropertyHierarchy: jest.fn(),
});

it('refuses a stream larger than the file BEFORE msgreader allocates it', () => {
  const r = fakeReader();
  const { readProperty } = r;
  guardCfbReader(r);
  expect(() => r.readProperty({ sizeBlock: 1001 })).toThrow(
    'msg: stream larger than the file',
  );
  expect(readProperty).not.toHaveBeenCalled();
  r.readProperty({ sizeBlock: 1000 });
  expect(readProperty).toHaveBeenCalledTimes(1);
});
