import fs from 'node:fs';
import fsp from 'node:fs/promises';

/** Makes the synchronous fs calls behave like Windows for fsync: flushing a
 *  handle opened read-only, or a directory handle, fails with EPERM
 *  (FlushFileBuffers needs write access). Covers fs/promises handles too.
 *  Also reports process.platform as
 *  win32. Returns a restore function. */
export function simulateWindowsFsync(): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const unflushable = new Set<number>();
  const cannotFlush = (fd: number, flags: fs.OpenMode | undefined) =>
    flags === undefined ||
    flags === 'r' ||
    (typeof flags === 'number' &&
      (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) ||
    fs.fstatSync(fd).isDirectory();
  const eperm = () =>
    Object.assign(new Error('EPERM: operation not permitted, fsync'), {
      code: 'EPERM',
    });
  const { openSync, fsyncSync, closeSync } = fs;
  const open = jest
    .spyOn(fs, 'openSync')
    .mockImplementation((file, flags, mode) => {
      const fd = openSync(file, flags, mode);
      if (cannotFlush(fd, flags)) unflushable.add(fd);
      return fd;
    });
  const openAsync = fsp.open;
  const openHandle = jest
    .spyOn(fsp, 'open')
    .mockImplementation(async (file, flags, mode) => {
      const handle = await openAsync(file, flags, mode);
      if (cannotFlush(handle.fd, flags))
        handle.sync = () => Promise.reject(eperm());
      return handle;
    });
  const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (unflushable.has(fd)) throw eperm();
    fsyncSync(fd);
  });
  const close = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    unflushable.delete(fd);
    closeSync(fd);
  });
  return () => {
    open.mockRestore();
    openHandle.mockRestore();
    fsync.mockRestore();
    close.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  };
}
