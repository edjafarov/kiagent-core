/** Fixture whose activate() throws — for the installCommit-reports-failed-
 * activation regression test. No sources, tools or senders: the throw
 * happens before any contribution is ever returned. */
module.exports = {
  async activate() {
    throw new Error('fixture activation exploded');
  },
};
