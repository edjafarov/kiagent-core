import type {
  Change,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';

import { CapabilityUnsupportedError } from '@main/core/inference';

import { AUDIO_MAX_BYTES, audioExt, classifyAudio } from './classify';
import {
  AudioUnsupportedFormatError,
  prepareAudio,
  type PreparedAudio,
} from './transcode';

/**
 * The audio transcription worker: a feed consumer that turns audio documents
 * (voice notes, `.m4a`/`.mp3`/`.opus` files, audio attachments) into a text
 * transcript written back as the document body — searchable like any other
 * text. Single pass (fetch → transcode → transcribe → enrich), mirroring the
 * vision worker's shape but with a transcode step instead of rasterization.
 *
 * Outcome discipline (the two failure modes that must NOT loop forever):
 *  - the host can't decode the format (non-macOS + non-wav/mp3), or the
 *    selected model has no audio encoder (12B tier) → SKIP (permanent).
 *  - no audio provider ready yet (model still installing), the processing
 *    window is closed, or a transient server fault → DEFER (the scheduled
 *    re-drive retries once a model is ready / the window opens).
 */
export function createAudioWorker(deps: {
  laneOpen(): boolean;
  /** Overridable for tests; defaults to the platform transcoder (afconvert on
   *  macOS). Turns source bytes into wav/mp3 for `input_audio`. */
  prepare?: (
    bytes: Uint8Array,
    meta: { mime?: string; ext?: string },
  ) => Promise<PreparedAudio>;
}): Worker {
  const prepare = deps.prepare ?? ((bytes, meta) => prepareAudio(bytes, meta));
  return {
    name: 'audio',
    version: 1,
    schedule: { every: '30m' }, // deferred re-drive cadence; the live tail always runs
    matches: (change: Change) =>
      change.kind === 'document' &&
      classifyAudio(change.document) === 'candidate',

    async work(change: Change, session: WorkerSession): Promise<WorkOutcome> {
      if (change.kind !== 'document') return 'skip';
      const doc = change.document;
      // Outside the processing window: park cheaply instead of blocking on the
      // lane gate (mirrors the vision worker).
      if (!deps.laneOpen()) return 'defer';

      const bytes = await session.fetchBytes(doc);
      if (!bytes) return 'skip'; // source can't serve the audio — terminal
      if (bytes.length > AUDIO_MAX_BYTES) return 'skip'; // too large for one pass

      const { mime } = doc.metadata as { mime?: string };
      let prepared;
      try {
        prepared = await prepare(bytes, { mime, ext: audioExt(doc) });
      } catch (err) {
        if (err instanceof AudioUnsupportedFormatError) {
          session.log('info', `audio: ${err.message} — skipping ${doc.id}`);
          return 'skip'; // this host can't decode the format — terminal
        }
        return 'defer'; // transient transcode fault (temp I/O) — retry
      }

      let transcript: string;
      try {
        transcript = await session.hear(prepared.data, {
          format: prepared.format,
        });
      } catch (err) {
        if (err instanceof CapabilityUnsupportedError) {
          session.log('info', `audio: ${err.message} — skipping ${doc.id}`);
          return 'skip'; // model has no audio encoder — terminal for this model
        }
        const { status } = err as { status?: number };
        if (typeof status === 'number' && status >= 400 && status < 500) {
          // The server rejected the request as invalid — most importantly a
          // clip that exceeds the context window (a too-long recording).
          // Permanent for this input: SKIP, or it would re-drive (re-transcode
          // + re-send) every window forever. Chunking long audio is a
          // follow-up.
          session.log(
            'info',
            `audio: server rejected input (HTTP ${status}) — skipping ${doc.id}`,
          );
          return 'skip';
        }
        // NoProviderError (model still installing), LaneClosedError (window
        // closed mid-run), or a transient (5xx / network) server fault — DEFER
        // so the scheduled re-drive retries once a model is ready / the window
        // opens.
        return 'defer';
      }

      const text = transcript.trim();
      if (!text) {
        // The experimental audio path occasionally returns an empty transcript
        // on valid speech — a transient glitch that an immediate retry of the
        // same clip recovers (observed empirically). THROW so the engine's
        // bounded retry (maxAttempts) gets more shots and then records 'failed'
        // and moves on, rather than permanently skipping a doc a retry would
        // transcribe. Genuinely silent / non-speech audio simply exhausts the
        // retries and is dropped — no infinite loop.
        throw new Error('empty transcript');
      }

      session.enrich({
        documentId: doc.id,
        markdown: text,
        metadata: {
          extraction: { engine: 'local-asr', at: new Date().toISOString() },
        },
      });
      return 'done';
    },
  };
}
