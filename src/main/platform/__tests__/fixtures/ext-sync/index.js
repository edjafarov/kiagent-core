const fs = require('fs');

module.exports = {
  async activate(host) {
    const c = { seq: 1, cursor: 2 };
    const calls = {
      status: await host.sync.status(),
      enableTracking: await host.sync.enableTracking(),
      disableTracking: await host.sync.disableTracking(),
      buildDelta: await host.sync.buildDelta(c, 'out', 5, 3),
      buildSnapshot: await host.sync.buildSnapshot('snap'),
      applyDelta: await host.sync.applyDelta('stage', { pullStartedAt: 5 }),
      prepareSwap: await host.sync.prepareSwap('f', 'h', 'm'),
      prepareRestore: await host.sync.prepareRestore(),
      setDeviceId: await host.sync.setDeviceId('dev'),
      beginJoin: await host.sync.beginJoin(),
      exportSources: await host.sync.exportSources('seed'),
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
      promote: await host.sync.promote(2),
      demote: await host.sync.demote('m1'),
      setFenced: await host.sync.setFenced(true),
      readOnly: await host.sync.readOnly(),
      queuedSettings: await host.sync.queuedSettings(),
      discardQueued: await host.sync.discardQueued(7),
    };
    fs.writeFileSync(process.env.KIA_SYNC_FIXTURE_OUT, JSON.stringify(calls));
  },
};
