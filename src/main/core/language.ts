import { franc } from 'franc-min';

/** Cheap, universal ingest-time enrichment: ISO-639-3 codes feeding
 *  language-aware search stemming. */
export function detectLanguages(text: string): string[] {
  const sample = text.slice(0, 2_000);
  if (sample.trim().length < 20) return [];
  const code = franc(sample);
  return code === 'und' ? [] : [code];
}
