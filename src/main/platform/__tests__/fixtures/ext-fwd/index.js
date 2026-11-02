const calls = [];
module.exports = {
  async activate(host) {
    await host.ui.handle('save', async (p) => {
      calls.push(['save', p]);
      return { saved: p };
    });
    await host.ui.handle('import', async (p) => {
      calls.push(['import', p]);
      return { imported: p };
    });
    await host.ui.handle('plain', async (p) => {
      calls.push(['plain', p]);
      return { plain: p };
    });
    // Goes through the host, so it forwards like a renderer call.
    await host.ui.handle('viaCall', async (p) => ({ viaCall: await host.ui.call('save', p) }));
    await host.ui.handle('calls', async () => calls.slice());
    return { tools: [] };
  },
};
