/** Namespace-agnostic XML helpers over @xmldom/xmldom. Pure. */
import { DOMParser } from '@xmldom/xmldom';

/** Recoverable markup errors are tolerated silently (real-world Office files
 *  carry them); a fatal error or a part with no root element throws, so a
 *  garbage part fails the conversion instead of rendering as empty. */
export function parseXml(src: string): Document {
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => {},
      fatalError: (m: string) => {
        throw new Error(`xml: ${m}`);
      },
    },
  }).parseFromString(src, 'text/xml') as unknown as Document;
  if (!doc.documentElement) throw new Error('xml: not a document');
  return doc;
}

/** Descendant elements with this local name, in document order. */
export function byLocalName(root: Node, name: string): Element[] {
  const out: Element[] = [];
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if ((c as Element).localName === name) out.push(c as Element);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

export function childByLocalName(el: Element, name: string): Element | null {
  for (let c = el.firstChild; c; c = c.nextSibling)
    if (c.nodeType === 1 && (c as Element).localName === name)
      return c as Element;
  return null;
}

/** The value of the attribute with this local name, whatever its prefix. */
export function attr(el: Element, localName: string): string | null {
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i);
    if (a && (a.localName ?? a.name) === localName) return a.value;
  }
  return null;
}

/** Text of a node, with ODF (`s`, `tab`, `line-break`) and OOXML (`br`,
 *  `tab`) spacing elements rendered as whitespace. */
export function textContent(node: Node): string {
  let out = '';
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 || c.nodeType === 4) out += c.nodeValue ?? '';
    else if (c.nodeType === 1) {
      const el = c as Element;
      switch (el.localName) {
        case 's': {
          const n = Number(attr(el, 'c') ?? '1');
          out += ' '.repeat(
            Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 1,
          );
          break;
        }
        case 'tab':
          out += '\t';
          break;
        case 'line-break':
        case 'br':
          out += '\n';
          break;
        default:
          out += textContent(el);
      }
    }
  }
  return out;
}
