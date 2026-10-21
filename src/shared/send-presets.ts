/** The send-later choices both the app's Send ▾ and the link page offer
 *  (spec 2026-10-21 §4, §5.3), in the local time of whoever computes them. */

/** The value a time picker starts at: the next whole hour, at least
 *  30 minutes away, as `datetime-local` wants it (local, no zone). */
export function defaultSendLater(nowMs: number): string {
  const d = new Date(nowMs + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface SendPreset {
  key: string;
  label: string;
  /** Epoch ms, local wall time. */
  at: number;
}

/** The Send ▾ choices at `nowMs` (spec 2026-10-21 §4): soon, later today
 *  while it is still ahead, tomorrow, and Monday unless that is tomorrow. */
export function sendPresets(nowMs: number): SendPreset[] {
  const now = new Date(nowMs);
  const inMin = (m: number) =>
    Math.ceil((nowMs + m * 60_000) / 60_000) * 60_000;
  const at = (days: number, hour: number) => {
    const x = new Date(now);
    x.setDate(x.getDate() + days);
    x.setHours(hour, 0, 0, 0);
    return x.getTime();
  };
  const out: SendPreset[] = [
    { key: 'in15', label: 'In 15 minutes', at: inMin(15) },
    { key: 'in60', label: 'In 1 hour', at: inMin(60) },
    { key: 'in180', label: 'In 3 hours', at: inMin(180) },
  ];
  if (now.getHours() < 13)
    out.push({ key: 'afternoon', label: 'This afternoon', at: at(0, 14) });
  if (now.getHours() < 17)
    out.push({ key: 'evening', label: 'This evening', at: at(0, 18) });
  out.push(
    { key: 'tomorrow-am', label: 'Tomorrow morning', at: at(1, 9) },
    { key: 'tomorrow-pm', label: 'Tomorrow afternoon', at: at(1, 14) },
  );
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday !== 1)
    out.push({ key: 'monday', label: 'Monday morning', at: at(toMonday, 9) });
  return out;
}
