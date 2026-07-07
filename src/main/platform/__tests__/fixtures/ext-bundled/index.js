/** Privileged fixture: reports whether extras.mainProcess arrived, and how
 *  often THIS module instance was activated (probes require-cache busting —
 *  a fresh instance always reports 1). */
let activations = 0;

module.exports = {
  async activate(host, extras) {
    activations += 1;
    const marker =
      extras && extras.mainProcess ? extras.mainProcess.marker : null;
    const count = activations;
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
      ],
    };
  },
};
