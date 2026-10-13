/** Source options gate: 'goodopts' declares a valid option and registers;
 *  'badopts' declares an invalid one and is skipped with a warning. */
module.exports = {
  async activate() {
    const makeSource = (id, options) => ({
      descriptor: {
        id,
        name: id,
        documentTypes: ['basic.item'],
        auth: 'none',
        options,
      },
      async connect() {
        return { identifier: 'acct', config: {} };
      },
      async *pull() {},
      toDocument(item) {
        return item;
      },
    });
    return {
      sources: [
        makeSource('goodopts', [
          { key: 'skipThings', label: 'Skip things', type: 'boolean', default: true },
        ]),
        makeSource('badopts', [
          { key: 'Bad Key', label: 'x', type: 'boolean', default: true },
        ]),
      ],
      tools: [],
    };
  },
};
