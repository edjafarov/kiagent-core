/** Privileged fixture: reports whether extras.mainProcess arrived, how
 *  often THIS module instance was activated (probes require-cache busting —
 *  a fresh instance always reports 1), and its host.self.dataDir (probes
 *  the bundled dataDir convention — must live outside this fixture's own
 *  install dir). */
let activations = 0;

module.exports = {
  async activate(host, extras) {
    activations += 1;
    const marker =
      extras && extras.mainProcess ? extras.mainProcess.marker : null;
    const count = activations;
    const { dataDir } = host.self;
    return {
      sources: [],
      tools: [
        {
          name: 'bundled.probe',
          description: 'returns the mainApi marker and activation count',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return { marker, activations: count };
          },
        },
        {
          name: 'bundled.dataDir',
          description: 'returns this extension host.self.dataDir',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return { dataDir };
          },
        },
      ],
    };
  },
};
