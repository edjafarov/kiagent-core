/** The ONE AbortError shape admission and the converter reject with. Checked
 *  by name, never instanceof (it crosses no boundary today, but DOMException
 *  and Error both satisfy the name check). */
export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
