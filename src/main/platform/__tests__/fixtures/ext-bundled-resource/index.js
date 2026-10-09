/** In-process fixture that acquires a main-process resource across an
 *  asynchronous activation and releases it in deactivate(). The control
 *  object arrives as `extras.mainProcess.resource` (the platform's `mainApi`
 *  dep), shared by reference with the test — like ext-bundled-slow, module
 *  state cannot outlive an incarnation. A second acquire while the resource
 *  is still held fails, the way a duplicate ipcMain.handle would. */
let ctl = null;
module.exports = {
  async activate(_host, extras) {
    ctl = extras.mainProcess.resource;
    await ctl.gate;
    if (ctl.held) throw new Error('duplicate resource');
    ctl.held = true;
    ctl.activations += 1;
    return {
      sources: [],
      tools: [
        {
          name: 'resource.probe',
          description: 'probe',
          inputSchema: { type: 'object' },
          async call() {
            return { ok: true };
          },
        },
      ],
    };
  },
  async deactivate() {
    ctl.deactivations += 1;
    ctl.held = false;
  },
};
