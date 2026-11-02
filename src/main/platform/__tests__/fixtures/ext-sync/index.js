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
    };
    fs.writeFileSync(process.env.KIA_SYNC_FIXTURE_OUT, JSON.stringify(calls));
  },
};
