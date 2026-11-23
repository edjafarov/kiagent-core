import type {
  DocumentInput,
  EnrichInput,
  InferenceKind,
  LentJob,
  LentJobIo,
  LentJobResult,
  LogLevel,
  WorkFitness,
  Worker,
  WorkerSession,
} from '@shared/contracts';
import { LaneClosedError } from '@shared/contracts';

import type { Admission } from './admission';
import type { InferencePlane } from './inference';

/** Whole jobs on a helping device (spec 2026-11-23, lend whole jobs).
 *
 *  Every device builds the same bundled workers at boot. This registry holds
 *  the lendable ones, says what each can do here, and runs one for a leader:
 *  the unchanged worker against a session whose bytes and attempt counter come
 *  from the leader and whose results go back to it. Nothing is written here. */

/** What a lendable worker is able to do on this device. */
export interface WorkAbilities {
  ready: boolean;
  can: string[];
  now: string[];
}

/** The job names a worker this device does not have at that version. */
export class WorkVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkVersionError';
  }
}

export interface LentWork {
  register(worker: Worker, abilities: () => WorkAbilities): void;
  get(name: string): Worker | undefined;
  fitness(): WorkFitness[];
  run(job: LentJob, io: LentJobIo): Promise<LentJobResult>;
}

export function createLentWork(deps: {
  /** This device's plane. Model calls of a lent job go through `runLent`:
   *  the first ready LOCAL provider, never a task route (a helper's route
   *  would send the leader's content to a provider the leader never chose)
   *  and never a lender. */
  inference: Pick<InferencePlane, 'runLent'> &
    Partial<Pick<InferencePlane, 'mayBecomeReady' | 'hasProvider'>>;
  admission?: Pick<Admission, 'acquire'>;
  /** This device's own background lane. */
  laneOpen(): boolean;
  log(scope: string, level: LogLevel, msg: string): void;
}): LentWork {
  const workers = new Map<
    string,
    { worker: Worker; abilities: () => WorkAbilities }
  >();

  return {
    register(worker, abilities) {
      if (!worker.lendable) throw new Error(`${worker.name} is not lendable`);
      workers.set(worker.name, { worker, abilities });
    },
    get: (name) => workers.get(name)?.worker,
    fitness: () =>
      [...workers.values()].map(({ worker, abilities }) => ({
        worker: worker.name,
        version: worker.version,
        ...abilities(),
      })),
    async run(job, io) {
      const entry = workers.get(job.worker);
      if (!entry || entry.worker.version !== job.version)
        throw new WorkVersionError(
          `this device has no '${job.worker}' worker at version ${job.version}`,
        );
      const { worker } = entry;
      const { change } = job;
      if (change.kind !== 'document' || !worker.matches(change))
        throw new Error(`'${job.worker}' does not take this change`);
      // The leader's lane is its own business; this device's is checked here
      // and again by every model call the worker makes.
      if (!deps.laneOpen()) throw new LaneClosedError();
      const scope = `worker:${worker.name}`;
      const { signal } = io;
      const local = (kind: InferenceKind, payload: unknown) =>
        deps.inference.runLent({ kind, payload, signal });
      const docs: DocumentInput[] = [];
      const enrich: EnrichInput[] = [];
      const session: WorkerSession = {
        signal,
        async inference(prompt, opts) {
          const { value } = await local('complete', {
            prompt,
            maxTokens: opts?.maxTokens,
            profile: 'default',
          });
          return typeof value === 'string'
            ? value
            : String((value as { text?: unknown } | null)?.text ?? '');
        },
        async see(image, prompt, opts) {
          return String(
            (await local('see', { image, prompt, mime: opts?.mime })).value,
          );
        },
        async seeWithMeta(image, prompt, opts) {
          const r = await local('see', {
            image,
            prompt,
            mime: opts?.mime,
            task: opts?.task,
          });
          return {
            text: String(r.value),
            providerId: r.providerId,
            modelId: r.modelId,
          };
        },
        async read(image, opts) {
          return String(
            (await local('read', { image, mime: opts?.mime })).value,
          );
        },
        async hear(audio, opts) {
          return String(
            (await local('hear', { audio, format: opts?.format })).value,
          );
        },
        // Only the job's own document: the leader serves nothing else.
        fetchBytes: (doc) =>
          doc.id === change.document.id
            ? io.fetchBytes(doc.id)
            : Promise.resolve(null),
        bump: (key) => io.bump(key),
        mayBecomeReady: (kind) =>
          deps.inference.mayBecomeReady?.(kind) ?? false,
        hasProvider: (kind) => deps.inference.hasProvider?.(kind) ?? true,
        admit: () =>
          deps.admission
            ? deps.admission.acquire('redrive', signal)
            : Promise.resolve(() => {}),
        emit(doc) {
          docs.push(doc);
        },
        enrich(e) {
          enrich.push(e);
        },
        log(level, msg) {
          deps.log(scope, level, msg);
        },
      };
      const outcome = (await worker.work(change, session)) ?? 'done';
      return { outcome, docs, enrich };
    },
  };
}
