/**
 * ICU-lite message formatting (no dependencies):
 *
 *   'Call {name}'                                   -> argument
 *   '{n, plural, =0 {none} one {# call} other {# calls}}' -> Intl.PluralRules, `#` = formatted n
 *   '{reason, select, dnd {Do Not Disturb} other {busy}}'
 *
 * Arguments may be strings, numbers (formatted for the locale) or any other
 * value (e.g. React nodes), which are returned as separate parts.
 * Malformed messages are returned verbatim rather than throwing.
 */

type Node =
  | string
  | { type: 'arg'; name: string }
  | { type: 'hash' }
  | { type: 'plural' | 'select'; name: string; options: Record<string, Node[]> };

export type MessageValues = Record<string, unknown>;

export interface FormatContext {
  plural: (n: number) => string;
  number: (n: number) => string;
}

const cache = new Map<string, Node[] | null>();

export function parseMessage(src: string): Node[] | null {
  let i = 0;

  const readUntil = (stop: RegExp): string => {
    const start = i;
    while (i < src.length && !stop.test(src[i]!)) i++;
    return src.slice(start, i);
  };
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  function nodes(inPlural: boolean, nested: boolean): Node[] {
    const out: Node[] = [];
    let buf = '';
    const flush = () => {
      if (buf) out.push(buf);
      buf = '';
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === '{') {
        flush();
        i++;
        out.push(arg(inPlural));
      } else if (c === '}') {
        if (!nested) throw new Error('unbalanced }');
        break;
      } else if (c === '#' && inPlural) {
        flush();
        out.push({ type: 'hash' });
        i++;
      } else {
        buf += c;
        i++;
      }
    }
    flush();
    return out;
  }

  function arg(inPlural: boolean): Node {
    const name = readUntil(/[,}]/).trim();
    if (!name) throw new Error('empty argument');
    if (src[i] === '}') {
      i++;
      return { type: 'arg', name };
    }
    i++; // ','
    const kind = readUntil(/[,}]/).trim();
    if (src[i] === '}') {
      // `{n, number}` and friends: treat as a plain argument.
      i++;
      return { type: 'arg', name };
    }
    if (kind !== 'plural' && kind !== 'select') throw new Error(`unknown argument type ${kind}`);
    i++; // ','
    const options: Record<string, Node[]> = {};
    for (;;) {
      skipWs();
      if (i >= src.length) throw new Error('unterminated argument');
      if (src[i] === '}') {
        i++;
        break;
      }
      const key = readUntil(/[\s{}]/);
      skipWs();
      if (!key || src[i] !== '{') throw new Error('expected {');
      i++;
      options[key] = nodes(inPlural || kind === 'plural', true);
      if (src[i] !== '}') throw new Error('unterminated option');
      i++;
    }
    if (!options.other) throw new Error('missing other');
    return { type: kind, name, options };
  }

  try {
    const result = nodes(false, false);
    return i === src.length ? result : null;
  } catch {
    return null;
  }
}

function parsed(src: string): Node[] | null {
  let ast = cache.get(src);
  if (ast === undefined) {
    ast = parseMessage(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, ast);
  }
  return ast;
}

function render(nodes: Node[], values: MessageValues, ctx: FormatContext, hash: number | undefined, out: unknown[]): void {
  for (const node of nodes) {
    if (typeof node === 'string') out.push(node);
    else if (node.type === 'hash') out.push(hash === undefined ? '#' : ctx.number(hash));
    else if (node.type === 'arg') {
      const v = values[node.name];
      if (v === undefined || v === null) out.push(`{${node.name}}`);
      else out.push(typeof v === 'number' ? ctx.number(v) : v);
    } else if (node.type === 'plural') {
      const n = Number(values[node.name] ?? 0);
      const opts = node.options;
      const branch = opts[`=${n}`] ?? opts[ctx.plural(n)] ?? opts.other!;
      render(branch, values, ctx, n, out);
    } else {
      const v = String(values[node.name] ?? 'other');
      render(node.options[v] ?? node.options.other!, values, ctx, hash, out);
    }
  }
}

/** Format to parts; adjacent strings are merged. */
export function formatToParts(src: string, values: MessageValues = {}, ctx: FormatContext): unknown[] {
  const ast = parsed(src);
  if (!ast) return [src];
  const raw: unknown[] = [];
  render(ast, values, ctx, undefined, raw);
  const out: unknown[] = [];
  for (const part of raw) {
    const last = out.length - 1;
    if (typeof part === 'string' && typeof out[last] === 'string') out[last] = (out[last] as string) + part;
    else out.push(part);
  }
  return out;
}

/** Format to a string (non-string values are stringified). */
export function formatMessage(src: string, values: MessageValues = {}, ctx: FormatContext): string {
  return formatToParts(src, values, ctx).map(String).join('');
}

/** Argument names used by a message (for catalogue consistency tests). */
export function messageArguments(src: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === 'string' || n.type === 'hash') continue;
      names.add(n.name);
      if (n.type !== 'arg') Object.values(n.options).forEach(walk);
    }
  };
  const ast = parseMessage(src);
  if (ast) walk(ast);
  return [...names].sort();
}
