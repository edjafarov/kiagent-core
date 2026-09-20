const fs = require('fs');

let activationAck;
let activationHost;

function item(id, producer = 'test.attention') {
  return {
    id: `${producer}:${id}`,
    producer,
    kind: 'upcoming',
    title: id,
    detail: null,
    priority: 1,
    dueAt: null,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    state: 'open',
    resolvedBy: null,
    actions: [],
  };
}

module.exports = {
  async activate(host) {
    activationHost = host;
    activationAck = await host.attention.publish([item('activate')]);
    const acked = process.env.KIA_ATTENTION_ACTIVATION_ACKED;
    if (acked) fs.writeFileSync(acked, 'acked');
    const barrier = process.env.KIA_ATTENTION_ACTIVATION_BARRIER;
    if (barrier) {
      while (!fs.existsSync(barrier))
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      tools: [
        {
          name: 'attention.activationAck',
          description: 'returns the activation publication acknowledgement',
          inputSchema: { type: 'object' },
          async call() {
            return activationAck;
          },
        },
        {
          name: 'attention.publish',
          description: 'publishes a valid or deliberately invalid item',
          inputSchema: { type: 'object' },
          async call(args) {
            try {
              const id = args.id || 'published';
              const producer = args.invalid ? 'test.foreign' : 'test.attention';
              const items = [item('activate')];
              if (id !== 'activate') items.push(item(id, producer));
              return await host.attention.publish(items);
            } catch (error) {
              return {
                code: error && error.code,
                message: error && error.message,
              };
            }
          },
        },
        {
          name: 'attention.resolve',
          description: 'resolves an item by id',
          inputSchema: { type: 'object' },
          async call(args) {
            return host.attention.resolve(args.id, args.revision);
          },
        },
      ],
    };
  },
  async deactivate() {
    let result;
    try {
      result = await activationHost.attention.publish([item('shutdown')]);
    } catch (error) {
      result = { code: error && error.code, message: error && error.message };
    }
    const resultPath = process.env.KIA_ATTENTION_DEACTIVATE_RESULT;
    if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result));
  },
};
