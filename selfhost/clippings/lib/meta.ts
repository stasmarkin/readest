import { basename } from 'node:path';
import {
  frontmatterToMetadata,
  parseFrontmatter,
} from '../../../apps/readest-app/src/utils/mdFrontmatter.ts';

export type PandocMeta = {
  title: string;
  author?: string[];
  date?: string;
  description?: string;
  subject?: string[];
  identifier: string;
  relation: string;
  lang: 'ru' | 'en';
};

export type BuiltMeta = { meta: PandocMeta; body: string; source?: string; epoch: number };

const list = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Obsidian writes authors as wiki links: `[[Name]]`, and unquoted YAML leaves `[Name]`. */
const cleanAuthor = (a: string) =>
  a
    .trim()
    .replace(/^\[\[(.*)\]\]$/, '$1')
    .replace(/^\[(.*)\]$/, '$1')
    .trim();

const scalar = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
};

/** Seconds of the date's UTC midnight: what SOURCE_DATE_EPOCH takes. */
export const epochOf = (date?: string): number => {
  const m = date?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && t > 0 ? t / 1000 : 0;
};

export const obsidianToMarkdown = (body: string): string =>
  body
    .replace(/!\[\[([^\]]+)\]\]/g, (_m, x: string) => `[вложение: ${x.split('|')[0]!.trim()}]`)
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');

export const buildMeta = (relpath: string, md: string, srcKey: string): BuiltMeta => {
  const { body: rawBody, fields } = parseFrontmatter(md);
  const { metadata } = frontmatterToMetadata(fields);
  const source = scalar(fields['source']);
  let body = obsidianToMarkdown(rawBody);
  const lang = /[А-Яа-яЁё]/.test(body) ? 'ru' : 'en';
  // An autolink only for a URL: anything else in <…> would be raw HTML.
  if (source)
    body = `Источник: ${/^https?:\/\/\S+$/.test(source) ? `<${source}>` : source}\n\n${body}`;
  const published = typeof metadata.published === 'string' ? metadata.published.trim() : '';
  const date = published || scalar(fields['created']);
  const subject = Array.isArray(metadata.subject)
    ? metadata.subject.filter((s): s is string => typeof s === 'string')
    : [];
  const authors = list(metadata.author).map(cleanAuthor).filter(Boolean);
  const meta: PandocMeta = {
    title:
      (typeof metadata.title === 'string' && metadata.title.trim()) ||
      basename(relpath).replace(/\.md$/, ''),
    identifier: `obsidian-clipping:${relpath}`,
    relation: `src:${srcKey}`,
    lang,
  };
  if (authors.length) meta.author = authors;
  if (date) meta.date = date;
  if (metadata.description?.trim()) meta.description = metadata.description.trim();
  if (subject.length) meta.subject = subject;
  return { meta, body, ...(source ? { source } : {}), epoch: epochOf(date) };
};
