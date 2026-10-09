/**
 * `kia-converter` child entry (#136, spec §1): the parsers and the WASM
 * rasteriser, off the main process. Answers one `{ id, op, … }` request at a
 * time (the supervisor in core/converter/runner.ts sends one at a time).
 * Installs NO signal handlers: SIGTERM must kill it even mid-parse.
 */
import {
  capMarkdown,
  parseDetailed,
  parsePdfPages,
  rasterizePdf,
} from '../core/converter/parsers';
import type {
  ConverterReply,
  ConverterRequest,
} from '../core/converter/protocol';

type ParentPort = {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
};
// Electron utilityProcess has `process.parentPort`; child_process.fork has
// `process.send` / `process.on('message')` (jest, serialization 'advanced').
const { parentPort } = process as unknown as { parentPort?: ParentPort };

const send = (m: ConverterReply): void => {
  if (parentPort) parentPort.postMessage(m);
  else process.send?.(m);
};
const onMessage = (cb: (m: unknown) => void): void => {
  if (parentPort) {
    parentPort.on('message', (ev: unknown) =>
      cb(
        ev && typeof ev === 'object' && 'data' in ev
          ? (ev as { data: unknown }).data
          : ev,
      ),
    );
  } else {
    process.on('message', cb);
  }
};

// Not a signal handler: a forked (non-Electron) child leaves with its parent.
process.on('disconnect', () => process.exit(0));

async function run(req: ConverterRequest): Promise<unknown> {
  // A fresh copy: bytes arriving over IPC may be a view into a larger
  // ArrayBuffer (Node's pool slice), and pdf.js reads the whole buffer —
  // the convert.ts "bad XRef entry" workaround, kept on this side.
  const bytes = new Uint8Array(req.bytes);
  switch (req.op) {
    case 'parseDetailed': {
      const r = await parseDetailed(bytes, req.mime, req.filename);
      return r.markdown === null
        ? r
        : { ...r, markdown: capMarkdown(r.markdown).markdown };
    }
    case 'parsePdfPages':
      return parsePdfPages(bytes);
    case 'rasterizePdf':
      return rasterizePdf(bytes, req.pages, req.maxEdge);
    default:
      throw new Error(`unknown converter op ${(req as { op: string }).op}`);
  }
}

onMessage((m) => {
  const req = m as ConverterRequest;
  run(req).then(
    (result) => send({ id: req.id, ok: true, result }),
    (e: unknown) =>
      send({
        id: req.id,
        ok: false,
        name: e instanceof Error ? e.name : 'Error',
        message: e instanceof Error ? e.message : String(e),
      }),
  );
});
send({ t: 'ready' });
