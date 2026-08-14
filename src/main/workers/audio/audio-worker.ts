import { promises as fs } from 'node:fs';
import os from 'node:os';

import type {
  Change,
  Worker,
  WorkerSession,
  WorkOutcome,
} from '@shared/contracts';

import { MAX_SOURCE_BYTES, audioExt, classifyTranscribable } from './classify';
import { mp3DurationSeconds } from './mp3-duration';
import {
  AudioUnsupportedFormatError,
  prepareAudioFile,
  type PreparedAudioFile,
} from './transcode';

/** 16 kHz mono PCM16 decode rate — what whisper-cli materialises per second
 *  of audio (in its own process; see maxDecodedBytes). */
const PCM16_BYTES_PER_SEC = 32_000;
/** The true floor of mp3 (8 kbps mono ≈ 1 KB/s vs 32 KB/s PCM16): an
 *  unprobeable mp3 on a host with no transcoder is capped at
 *  maxDecodedBytes/32 of SOURCE bytes. */
const MP3_MAX_EXPANSION = 32;

/** Decoded-size cap, RAM-tiered: whisper chunks the TRANSCRIPTION into 30 s
 *  windows but first decodes the whole input to float PCM in the child
 *  (~230 MB per audio-hour) — an OOM-killed child is exit-by-signal → defer →
 *  a full re-fetch every 30 min forever, on exactly the small hosts tiered to
 *  base (spec §6). ≈ 4.5 h / 2.2 h / 1.1 h of 16 kHz mono PCM16. Chunk-feeding
 *  whisper is the named follow-up that lifts this. */
export function maxDecodedBytes(totalMemBytes: number): number {
  if (totalMemBytes >= 16 * 1024 ** 3) return 512 * 1024 * 1024;
  if (totalMemBytes >= 8 * 1024 ** 3) return 256 * 1024 * 1024;
  return 128 * 1024 * 1024;
}

/**
 * The audio transcription worker: a feed consumer that turns audio documents
 * (voice notes, `.m4a`/`.mp3`/`.opus` files, audio attachments, the audio track
 * of a video) into a text transcript written back as the document body —
 * searchable like any other text. Single pass: fetch → prepare a temp FILE →
 * hand the PATH to the bundled whisper.cpp provider → enrich. Decoded audio
 * never enters this process's heap; whisper decodes in its own child.
 *
 * Outcome discipline (the failure modes that must NOT loop forever):
 *  - the host can't decode the format (non-macOS + non-wav/mp3), whisper
 *    rejects the input deterministically, or the clip's DECODED size exceeds
 *    the RAM-tiered cap → SKIP (permanent, and an explicit branch — a throw
 *    would land in the transcode catch-all and DEFER forever instead).
 *  - no hear provider ready yet (whisper still downloading, or never
 *    approved), the processing window is closed, or a transient fault →
 *    DEFER (the scheduled re-drive retries once a model is ready / the window
 *    opens).
 */
export function createAudioWorker(deps: {
  laneOpen(): boolean;
  /** Demand the ASR install — no-op if installed/downloading/opted-out. */
  requestAsr(): void;
  /** Is a hear provider ready right now? Cheap pre-fetch gate. */
  hearReady(): boolean;
  /** Bundled-only file-path ASR route (spec §3) — NEVER via WorkerSession. */
  transcribeFile(
    path: string,
    opts: { format: 'wav' | 'mp3' },
  ): Promise<string>;
  prepareFile?: (
    bytes: Uint8Array,
    meta: { mime?: string; ext?: string },
    opts?: { forceWav?: boolean },
  ) => Promise<PreparedAudioFile>;
  mp3Duration?: (bytes: Uint8Array) => number | null;
  totalMemBytes?: number;
}): Worker {
  // The adapter matters: `prepareAudioFile`'s THIRD parameter is `deps`, not
  // `opts` — binding it directly would feed `{forceWav}` into the deps slot,
  // where it is silently ignored and the mp3 re-probe would do nothing.
  const prepareFile =
    deps.prepareFile ?? ((b, m, o) => prepareAudioFile(b, m, {}, o));
  const probeMp3 = deps.mp3Duration ?? mp3DurationSeconds;
  const totalMem = deps.totalMemBytes ?? os.totalmem();

  return {
    name: 'audio',
    version: 2,
    schedule: { every: '30m' }, // deferred re-drive cadence; the live tail always runs
    matches: (change: Change) =>
      change.kind === 'document' &&
      classifyTranscribable(change.document) === 'candidate',

    async work(change: Change, session: WorkerSession): Promise<WorkOutcome> {
      if (change.kind !== 'document') return 'skip';
      const doc = change.document;

      // Demand the ASR install FIRST — on every candidate, even while the lane
      // is closed or the model still downloads: the download runs during the
      // closed window so the open window is spent transcribing (spec §5).
      deps.requestAsr();
      // While whisper installs (or was never approved): park CHEAPLY — no
      // fetch, no transcode. This gate sits BEFORE fetchBytes so a machine
      // with no whisper parks each candidate for the cost of a ledger query
      // rather than materialising up to 200 MB per doc per re-drive.
      // NoProviderError inside the transcribe call remains only as the race
      // backstop.
      if (!deps.hearReady()) return 'defer';
      // Outside the processing window: park cheaply (mirrors the vision worker).
      if (!deps.laneOpen()) return 'defer';

      const bytes = await session.fetchBytes(doc);
      if (!bytes) return 'skip'; // source can't serve the audio — terminal
      // Backstop for docs whose metadata carried no size (classify gates the rest).
      if (bytes.length > MAX_SOURCE_BYTES) return 'skip';

      const { mime } = doc.metadata as { mime?: string };
      const meta = { mime, ext: audioExt(doc) };
      let prepared: PreparedAudioFile;
      try {
        prepared = await prepareFile(bytes, meta);
      } catch (err) {
        if (err instanceof AudioUnsupportedFormatError) {
          session.log('info', `audio: ${err.message} — skipping ${doc.id}`);
          return 'skip'; // this host can't decode the format — terminal
        }
        return 'defer'; // transient transcode fault (temp I/O) — retry
      }

      try {
        const cap = maxDecodedBytes(totalMem);

        if (prepared.format === 'mp3') {
          // A passthrough mp3's on-disk stat does NOT bound its decoded size
          // (spec §6): probe the duration; unprobeable → transcode and
          // re-check exactly, else fall back to the /32 floor.
          const durationSec = probeMp3(bytes);
          if (durationSec !== null) {
            if (durationSec * PCM16_BYTES_PER_SEC > cap) {
              session.log(
                'info',
                `audio: probed ${Math.round(durationSec)}s exceeds decoded cap — skipping ${doc.id}`,
              );
              return 'skip'; // explicit branch, NOT an exception (spec §6)
            }
          } else {
            try {
              const rewav = await prepareFile(bytes, meta, { forceWav: true });
              // `prepared` is about to be replaced — delete the superseded
              // mp3's whole temp DIRECTORY, which the finally below will no
              // longer see. The re-prepare got its own fresh directory, so
              // this never touches the file we just switched to.
              const superseded = prepared.dir;
              prepared = rewav; // exact WAV stat check below
              await fs
                .rm(superseded, { recursive: true, force: true })
                .catch(() => {});
            } catch (err) {
              if (!(err instanceof AudioUnsupportedFormatError)) return 'defer';
              // No transcoder: the format's true floor bounds decoded size.
              if (bytes.length * MP3_MAX_EXPANSION > cap) {
                session.log(
                  'info',
                  `audio: unprobeable mp3 over the /32 floor — skipping ${doc.id}`,
                );
                return 'skip';
              }
            }
          }
        }

        if (prepared.format === 'wav' && prepared.sizeBytes > cap) {
          session.log(
            'info',
            `audio: decoded ${prepared.sizeBytes} B exceeds cap — skipping ${doc.id}`,
          );
          return 'skip';
        }

        let transcript: string;
        try {
          transcript = await deps.transcribeFile(prepared.path, {
            format: prepared.format,
          });
        } catch (err) {
          const { status } = err as { status?: number };
          if (typeof status === 'number' && status >= 400 && status < 500) {
            // AsrInputRejectedError: whisper-cli's explicit stderr diagnostic —
            // deterministic for this input (deferring would loop every 30 min
            // forever). Everything else — spawn failure, exit-by-signal,
            // non-zero without the diagnostic, NoProviderError race, provider
            // disposed mid-request — DEFERS (§2 failure taxonomy).
            session.log(
              'info',
              `audio: input rejected (${(err as Error).message}) — skipping ${doc.id}`,
            );
            return 'skip';
          }
          return 'defer';
        }

        const text = transcript.trim();
        if (!text) {
          // Retained deliberately (spec §8): the audio path has returned empty
          // transcripts on valid speech; THROW so the engine's bounded retry
          // gets more shots and then records 'failed' — never a permanent skip.
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
      } finally {
        // Covers EVERY exit path: the caps, the transcribe failure, the empty
        // transcript throw, and success. Removes the DIRECTORY, not just the
        // file — prepare owns a fresh 0700 dir per call, so deleting the file
        // alone would leak one empty directory per transcribed document.
        await fs
          .rm(prepared.dir, { recursive: true, force: true })
          .catch(() => {});
      }
    },
  };
}
