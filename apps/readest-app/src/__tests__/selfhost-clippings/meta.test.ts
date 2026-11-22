import { describe, it, expect } from 'vitest';
import { buildMeta, epochOf } from '../../../../../selfhost/clippings/lib/meta.ts';

const clipper = `---
title: "T"
source: "https://example.com/post"
author:
  - "[[Addy Osmani]]"
published: 2026-11-11
created: 2026-11-20
description: "D"
tags:
  - "clippings"
---
First paragraph.

Second paragraph.
`;

describe('buildMeta', () => {
  it('Web Clipper frontmatter', () => {
    const r = buildMeta('dir/a.md', clipper, 'KEY');
    expect(r.meta).toEqual({
      title: 'T',
      author: ['Addy Osmani'],
      date: '2026-11-11',
      description: 'D',
      subject: ['clippings'],
      identifier: 'obsidian-clipping:dir/a.md',
      relation: 'src:KEY',
      lang: 'en',
    });
    expect(r.epoch).toBe(Date.UTC(2026, 10, 11) / 1000);
    expect(r.source).toBe('https://example.com/post');
    const lines = r.body.split('\n');
    expect(lines[0], 'source first').toBe('Источник: <https://example.com/post>');
    expect(r.body).toContain('First paragraph.\n\nSecond paragraph.');
  });

  it('unquoted [[Name]] author, created as the fallback date, no date at all', () => {
    const a = buildMeta(
      'a.md',
      '---\nauthor: [[Имя]]\npublished:\ncreated: 2026-01-02\n---\nx',
      'k',
    );
    expect(a.meta.author).toEqual(['Имя']);
    expect(a.meta.date).toBe('2026-01-02');
    expect(a.epoch).toBe(Date.UTC(2026, 0, 2) / 1000);
    const b = buildMeta('a.md', '---\ntitle: X\n---\nx', 'k');
    expect(b.meta.date).toBeUndefined();
    expect(b.epoch).toBe(0);
    expect(epochOf('garbage')).toBe(0);
  });

  it('no title: the file name without .md', () => {
    expect(buildMeta('sub/My note.md', 'body', 'k').meta.title).toBe('My note');
  });

  it('language: Cyrillic in the body is ru, Latin only is en', () => {
    expect(buildMeta('a.md', 'Привет', 'k').meta.lang).toBe('ru');
    expect(buildMeta('a.md', 'Hello', 'k').meta.lang).toBe('en');
  });

  it('an unclosed block stays in the body; a bad line in a closed block is skipped', () => {
    const open = buildMeta('a.md', '---\ntitle: X\nbody text', 'k');
    expect(open.meta.title).toBe('a');
    expect(open.body).toContain('title: X');
    const bad = buildMeta('a.md', '---\n!!! not yaml\ntitle: Kept\n---\nbody', 'k');
    expect(bad.meta.title).toBe('Kept');
    expect(bad.body).toBe('body');
  });

  it('frontmatter only: the body is the source line', () => {
    const r = buildMeta('a.md', '---\ntitle: T\nsource: https://s.test/x\n---\n', 'k');
    expect(r.body.trim()).toBe('Источник: <https://s.test/x>');
  });

  it('a source that is not a URL is plain text, not raw HTML', () => {
    const r = buildMeta('a.md', '---\nsource: книга\n---\nx', 'k');
    expect(r.body.split('\n')[0]).toBe('Источник: книга');
  });

  it('wiki links become text, embeds a note', () => {
    const r = buildMeta('a.md', 'see [[a|b]] and [[c]] ![[x.png]]', 'k');
    expect(r.body).toBe('see b and c [вложение: x.png]');
  });
});
