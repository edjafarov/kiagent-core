/**
 * The event review page's day view as HTML (spec 2026-10-22-event-review-day-view-design.md
 * §Rendering). Pure: `DayModel` in, markup out. Styles are ported from the
 * app Calendar (alpha-cent Calendar/styles.ts + week.tsx): 60 px per hour,
 * 52 px gutter, tinted blocks with a 3 px full-colour left edge, square
 * corners. Every text goes through `esc`; every value inside a `style`
 * attribute is a number this file formats or a colour that passed `safeColor`.
 */
import { esc } from '@shared/web-ui';
import type { EventCategory } from '@shared/contracts';

import {
  BUSY_GREY,
  safeColor,
  type Block,
  type Chip,
  type DayModel,
} from './day-model';

const CATEGORY_DOT: Record<EventCategory, string> = {
  work: '#3f51b5',
  personal: '#33b679',
  kids: '#f4511e',
};

export const DAY_VIEW_CSS = `<style>
.dv { border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-primary); }
.dv-head { display: flex; align-items: baseline; gap: 6px; padding: 10px 8px 8px 12px; border-bottom: 1px solid var(--border-subtle); }
.dv-dow { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-secondary); }
.dv-num { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dv-tz { margin-left: auto; font-size: 11px; color: var(--text-tertiary); overflow-wrap: anywhere; text-align: right; }
.dv-allday { display: flex; border-bottom: 1px solid var(--border-subtle); min-height: 30px; }
.dv-allday-label { width: 52px; flex-shrink: 0; box-sizing: border-box; font-size: 10px; color: var(--text-tertiary); padding: 8px 8px 0 0; text-align: right; }
.dv-allday-cell { flex: 1 1 0; min-width: 0; padding: 3px; display: flex; flex-direction: column; gap: 2px; }
.dv-chip { font-size: 11px; font-weight: 500; padding: 3px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: color-mix(in srgb, var(--c) 16%, var(--bg-surface)); border-left: 3px solid var(--c); }
.dv-chip.dv-declined { opacity: 0.5; text-decoration: line-through; }
.dv-chip.dv-prop { background: var(--accent-subtle); color: var(--accent-text); border: 2px dashed var(--accent-solid); border-left: 4px solid var(--accent-solid); font-weight: 600; }
.dv-scroll { height: 360px; overflow-y: auto; position: relative; }
.dv-grid { display: flex; position: relative; }
.dv-gutter { width: 52px; flex-shrink: 0; position: relative; }
.dv-hour { position: absolute; right: 8px; font-size: 10px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; transform: translateY(-50%); }
.dv-col { flex: 1 1 0; min-width: 0; position: relative; border-left: 1px solid var(--border-subtle); }
.dv-line { position: absolute; left: 0; right: 0; border-top: 1px solid var(--border-subtle); }
.dv-band { position: absolute; left: 0; right: 0; background: var(--accent-subtle); opacity: 0.55; pointer-events: none; }
.dv-ev { position: absolute; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; gap: 1px;
  color: var(--text-primary); background: color-mix(in srgb, var(--c) 16%, var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--c) 60%, var(--bg-surface)); border-left: 3px solid var(--c); }
.dv-ev.dv-declined { opacity: 0.5; text-decoration: line-through; }
.dv-ev.dv-draft { border-style: dashed; border-left-style: solid; }
.dv-ev.dv-busy { outline: 2px solid var(--error-solid); outline-offset: -1px; z-index: 1; }
.dv-ev.dv-maybe { outline: 2px solid var(--paused-solid); outline-offset: -1px; z-index: 1; }
.dv-ev.dv-prop { background: var(--accent-subtle); color: var(--accent-text); border: 2px dashed var(--accent-solid);
  border-left: 4px solid var(--accent-solid); z-index: 2; }
.dv-row { display: flex; align-items: center; width: 100%; }
.dv-dot { width: 6px; height: 6px; flex-shrink: 0; margin-right: 4px; background: var(--d); }
.dv-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dv-time { font-size: 10.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dv-prop .dv-time { color: var(--accent-text); }
.dv-tag { flex-shrink: 0; font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  background: var(--accent-solid); color: var(--accent-contrast); padding: 1px 4px; margin-right: 4px; }
.dv-note { font-size: 12px; color: var(--text-secondary); padding: 6px 12px; border-top: 1px solid var(--border-subtle); overflow-wrap: anywhere; }
.ev-line { font-size: 13px; padding: 7px 10px; border-left: 3px solid var(--border-subtle); color: var(--text-primary);
  background: var(--bg-muted); overflow-wrap: anywhere; }
.ev-line.ev-line-busy { border-left-color: var(--error-solid); }
.ev-line.ev-line-maybe { border-left-color: var(--paused-solid); }
</style>`;

/** A finite number for a style attribute, at most two decimals. */
const px = (n: number): string =>
  Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0';

/** Port of week.tsx `sizing()`. */
function sizing(height: number): { font: number; pad: string; time: boolean } {
  if (height < 16) return { font: 8, pad: '0 3px', time: false };
  if (height < 34) return { font: 9.5, pad: '1px 4px', time: false };
  return { font: 11.5, pad: '3px 6px', time: true };
}

const dot = (category: EventCategory | null): string => {
  const c = category && CATEGORY_DOT[category];
  return c ? `<span class="dv-dot" style="--d:${c}"></span>` : '';
};

function chipHtml(c: Chip): string {
  const cls = [
    'dv-chip',
    c.proposed ? 'dv-prop' : '',
    c.declined ? 'dv-declined' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}" style="--c:${safeColor(c.color)}">${c.proposed ? '<span class="dv-tag">Proposed</span>' : dot(c.category)}${esc(c.title)}</div>`;
}

function pos(b: { y: number; h: number; lane: number; lanes: number }): string {
  const lanes = b.lanes > 0 ? b.lanes : 1;
  return `top:${px(b.y)}px;height:${px(b.h)}px;left:calc(${px((b.lane / lanes) * 100)}% + 2px);width:calc(${px(100 / lanes)}% - 5px)`;
}

function blockHtml(b: Block): string {
  const size = sizing(b.h);
  const cls = [
    'dv-ev',
    b.declined ? 'dv-declined' : '',
    b.draft ? 'dv-draft' : '',
    b.outline ? `dv-${b.outline}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}" style="--c:${safeColor(b.color, BUSY_GREY)};${pos(b)};padding:${size.pad}">
<div class="dv-row">${dot(b.category)}<span class="dv-title" style="font-size:${size.font}px;line-height:${px(Math.min(b.h - 2, size.font + 4))}px">${esc(b.title)}</span></div>${size.time ? `<span class="dv-time">${esc(b.time)}</span>` : ''}</div>`;
}

function proposedHtml(m: DayModel): string {
  const p = m.proposed;
  if (p.allDay) return '';
  const size = sizing(p.h);
  return `<div class="dv-ev dv-prop" style="${pos(p)};padding:${size.pad}">
<div class="dv-row"><span class="dv-tag">Proposed</span><span class="dv-title" style="font-size:${size.font}px;line-height:${px(Math.min(p.h - 2, size.font + 4))}px">${esc(p.title)}</span></div>${size.time ? `<span class="dv-time">${esc(p.time)}</span>` : ''}</div>`;
}

export function dayViewHtml(m: DayModel): string {
  const [dow, num, ...rest] = m.dayLabel.split(' ');
  const head = num
    ? `<span class="dv-dow">${esc(dow)}</span><span class="dv-num">${esc(num)}</span><span class="dv-dow">${esc(rest.join(' '))}</span>`
    : `<span class="dv-dow">${esc(m.dayLabel)}</span>`;
  const strip = m.allDay.length
    ? `<div class="dv-allday"><div class="dv-allday-label">All day</div><div class="dv-allday-cell">${m.allDay.map(chipHtml).join('')}</div></div>`
    : '';
  const labels = m.hours
    .filter((h) => h.y > 0)
    .map(
      (h) =>
        `<span class="dv-hour" style="top:${px(h.y)}px">${esc(h.label)}</span>`,
    )
    .join('');
  const lines = m.hours
    .map((h) => `<div class="dv-line" style="top:${px(h.y)}px"></div>`)
    .join('');
  const band = m.proposed.allDay
    ? ''
    : `<div class="dv-band" style="top:${px(m.proposed.y)}px;height:${px(m.proposed.h)}px"></div>`;
  const notes = [
    ...m.alsoOn,
    ...(m.more > 0 ? [`+${m.more} more`] : []),
    ...m.notes,
  ]
    .map((n) => `<div class="dv-note">${esc(n)}</div>`)
    .join('');
  return `${DAY_VIEW_CSS}<div class="dv">
<div class="dv-head">${head}<span class="dv-tz">${esc(m.timeZone)}</span></div>
${strip}
<div id="ev-day" class="dv-scroll" data-scroll="${px(m.scrollPx)}">
<div class="dv-grid" style="height:${px(m.dayLenMin)}px">
<div class="dv-gutter">${labels}</div>
<div class="dv-col">${lines}${band}${m.blocks.map(blockHtml).join('')}${proposedHtml(m)}</div>
</div></div>
${notes}
</div>`;
}
