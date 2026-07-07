/** A non-privileged, ordinary "marketplace-installed" extension that
 *  happens to share its id with the ext-bundled fixture — used to exercise
 *  the shadowing path (a bundled extension discovered under the same id as
 *  an already-installed one). Never actually activated in that scenario:
 *  the bundled Entry replaces this one before the activation loop runs. */
module.exports = {
  async activate() {
    return { sources: [], tools: [] };
  },
};
