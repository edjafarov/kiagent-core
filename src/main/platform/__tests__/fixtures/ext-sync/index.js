const fs = require('fs');

const LEASE = {
  isMaster: true,
  reason: 'holder',
  multiDevice: true,
  approved: true,
  holder: 'dev',
  epoch: 2,
  priorRenewedAt: null,
};

module.exports = {
  async activate(host) {
    const c = { seq: 1, cursor: 2 };
    const calls = {
      status: await host.sync.status(),
      buildDelta: await host.sync.buildDelta(c, 'out', 5, 3),
      buildSnapshot: await host.sync.buildSnapshot('snap'),
      applyDelta: await host.sync.applyDelta('stage', { pullStartedAt: 5 }),
      repairSearchIndex: await host.sync.repairSearchIndex(),
      prepareSwap: await host.sync.prepareSwap('f', 'h', 'm', { keepArchive: true, markId: 'k', attempt: 1 }),
      prepareRestore: await host.sync.prepareRestore(),
      swapStatus: await host.sync.swapStatus(),
      discardForeignPending: await host.sync.discardForeignPending('k', 1),
      clearSwapStatus: await host.sync.clearSwapStatus('k', 1),
      findPassedOverArchive: await host.sync.findPassedOverArchive('k', 1),
      setDeviceId: await host.sync.setDeviceId('dev'),
      beginJoin: await host.sync.beginJoin(),
      exportSources: await host.sync.exportSources('seed'),
      hasMoveableLogins: await host.sync.hasMoveableLogins(),
      exportSettings: await host.sync.exportSettings(),
      importSettings: await host.sync.importSettings('offer', { prefs: { 'a.b': 1 }, extensions: {} }),
      finishJoin: await host.sync.finishJoin(),
      leaveJoin: await host.sync.leaveJoin(),
      forgetMoved: await host.sync.forgetMoved(),
      canAcceptSources: await host.sync.canAcceptSources(),
      importSources: await host.sync.importSources('offer', [], 'from'),
      isBusy: await host.sync.isBusy(),
      exportSecrets: await host.sync.exportSecrets({ epoch: 1, n: 2 }),
      importSecrets: await host.sync.importSecrets([{ accountId: 'a', epoch: 1, n: 3, value: null }]),
      setLease: await host.sync.setLease(LEASE),
      lead: await host.sync.lead({ epoch: 2 }),
      open: await host.sync.open('head-acked'),
      demote: await host.sync.demote('m1'),
      readOnly: await host.sync.readOnly(),
      queuedSettings: await host.sync.queuedSettings(),
      discardQueued: await host.sync.discardQueued(7),
      setDeviceNames: await host.sync.setDeviceNames([{ deviceId: 'd', label: 'L' }]),
      deleteArchive: await host.sync.deleteArchive(),
      setForwarder: await host.sync.setForwarder(null),
      runForwarded: await host.sync.runForwarded({ kind: 'k' }),
      drainOutbound: await host.sync.drainOutbound(),
      retained: await host.sync.retained('t'),
    };
    fs.writeFileSync(process.env.KIA_SYNC_FIXTURE_OUT, JSON.stringify(calls));
  },
};
