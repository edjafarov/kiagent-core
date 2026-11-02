const fs = require('fs');

module.exports = {
  async activate(host) {
    const c = { seq: 1, cursor: 2 };
    const calls = {
      status: await host.sync.status(),
      enableTracking: await host.sync.enableTracking(),
      disableTracking: await host.sync.disableTracking(),
      buildDelta: await host.sync.buildDelta(c, 'out', 5),
      buildSnapshot: await host.sync.buildSnapshot('snap'),
      applyDelta: await host.sync.applyDelta('stage'),
      prepareSwap: await host.sync.prepareSwap('f', 'h', 'm'),
      prepareRestore: await host.sync.prepareRestore(),
      setDeviceId: await host.sync.setDeviceId('dev'),
      beginJoin: await host.sync.beginJoin(),
      exportSources: await host.sync.exportSources('seed'),
      finishJoin: await host.sync.finishJoin(),
      leaveJoin: await host.sync.leaveJoin(),
      forgetMoved: await host.sync.forgetMoved(),
      canAcceptSources: await host.sync.canAcceptSources(),
      importSources: await host.sync.importSources('offer', [], 'from'),
      isBusy: await host.sync.isBusy(),
    };
    fs.writeFileSync(process.env.KIA_SYNC_FIXTURE_OUT, JSON.stringify(calls));
  },
};
