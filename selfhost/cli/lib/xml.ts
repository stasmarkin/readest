import { CliError } from './errors.ts';

/** An element, or a text run (`name === '#text'`) kept in `children` so textOf preserves document order. */
export type XmlNode = {
  name: string;
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text of this element (all its own text runs concatenated). */
  text: string;
};

// Predefined XML entities plus the HTML ones foliate's sanitizeXMLEntities maps.
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
};

const decode = (s: string): string =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ref: string) => {
        if (ref[0] === '#') {
          const cp =
            ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
          return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        return NAMED[ref] ?? NAMED[ref.toLowerCase()] ?? m;
      });

const localOf = (name: string): string => name.slice(name.indexOf(':') + 1);

const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const fail = (msg: string): never => {
  throw new CliError(`invalid XML: ${msg}`);
};

export const parseXml = (text: string, maxDepth = 256): XmlNode => {
  const len = text.length;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const addText = (s: string) => {
    const top = stack[stack.length - 1];
    if (!top || !s) return;
    top.text += s;
    top.children.push({ name: '#text', local: '#text', attrs: {}, children: [], text: s });
  };
  const endOf = (marker: string, from: number): number => {
    const at = text.indexOf(marker, from);
    if (at < 0) fail(`unterminated ${marker}`);
    return at;
  };

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decode(text.slice(i)));
      break;
    }
    if (lt > i) addText(decode(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      i = endOf('-->', lt + 4) + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = endOf(']]>', lt + 9);
      addText(text.slice(lt + 9, end));
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      i = endOf('?>', lt + 2) + 2;
    } else if (text.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...].
      let j = lt + 2;
      let brackets = 0;
      let quote = '';
      for (; j < len; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') brackets++;
        else if (c === ']') brackets--;
        else if (c === '>' && brackets <= 0) break;
      }
      if (j >= len) fail('unterminated declaration');
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const end = endOf('>', lt + 2);
      const name = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) fail(`unexpected </${name}>`);
      i = end + 1;
    } else {
      let j = lt + 1;
      let quote = '';
      for (; j < len; j++) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= len) fail('unterminated tag');
      let body = text.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const name = body.match(/^[^\s/>]+/)?.[0];
      if (!name) fail('empty tag name');
      const attrs: Record<string, string> = {};
      for (const m of body.slice(name!.length).matchAll(ATTR)) {
        attrs[m[1]!] = decode(m[2] ?? m[3] ?? '');
      }
      const node: XmlNode = { name: name!, local: localOf(name!), attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) fail('multiple root elements');
      else root = node;
      if (!selfClose) {
        if (stack.length + 1 > maxDepth) fail(`nesting depth exceeds ${maxDepth}`);
        stack.push(node);
      }
      i = j + 1;
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1]!.name}>`);
  if (!root) fail('no root element');
  return root!;
};

const isElement = (n: XmlNode) => n.name !== '#text';

export const findAll = (n: XmlNode, local: string): XmlNode[] => {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode) => {
    for (const c of x.children) {
      if (!isElement(c)) continue;
      if (c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
};

export const first = (n: XmlNode, local: string): XmlNode | undefined => {
  for (const c of n.children) {
    if (!isElement(c)) continue;
    if (c.local === local) return c;
    const found = first(c, local);
    if (found) return found;
  }
  return undefined;
};

/** Concatenated text of the node and its descendants, like DOM textContent. */
export const textOf = (n: XmlNode): string =>
  isElement(n) ? n.children.map(textOf).join('') : n.text;
