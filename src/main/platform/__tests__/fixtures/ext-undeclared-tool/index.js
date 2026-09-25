/** activate() contributes a tool NOT listed in the manifest's
 *  `contributes.tools` (only 'declared_tool' is declared) — the platform
 *  must skip the undeclared one (warn) and still register the declared one.
 *  Same shape as ext-undeclared-source, for tools. */
module.exports = {
  async activate() {
    const makeTool = (name) => ({
      name,
      description: `${name} fixture tool`,
      inputSchema: { type: 'object', properties: {} },
      async call() {
        return { name };
      },
    });
    return {
      sources: [],
      tools: [makeTool('declared_tool'), makeTool('sneaky_tool')],
    };
  },
};
