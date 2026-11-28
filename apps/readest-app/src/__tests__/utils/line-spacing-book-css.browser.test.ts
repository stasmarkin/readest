import { describe, test, expect, afterEach } from 'vitest';

import { getStyles, ThemeCode, transformInlineFonts, transformStylesheet } from '@/utils/style';
import { ViewSettings } from '@/types/book';
import {
  DEFAULT_BOOK_FONT,
  DEFAULT_BOOK_LAYOUT,
  DEFAULT_BOOK_LANGUAGE,
  DEFAULT_BOOK_STYLE,
  DEFAULT_VIEW_CONFIG,
  DEFAULT_TTS_CONFIG,
  DEFAULT_TRANSLATOR_CONFIG,
  DEFAULT_ANNOTATOR_CONFIG,
  DEFAULT_SCREEN_CONFIG,
} from '@/services/constants';

function makeViewSettings(overrides: Partial<ViewSettings> = {}): ViewSettings {
  return {
    ...DEFAULT_BOOK_FONT,
    ...DEFAULT_BOOK_LAYOUT,
    ...DEFAULT_BOOK_LANGUAGE,
    ...DEFAULT_BOOK_STYLE,
    ...DEFAULT_VIEW_CONFIG,
    ...DEFAULT_TTS_CONFIG,
    ...DEFAULT_TRANSLATOR_CONFIG,
    ...DEFAULT_ANNOTATOR_CONFIG,
    ...DEFAULT_SCREEN_CONFIG,
    ...overrides,
  } as ViewSettings;
}

const themeCode = {
  bg: '#ffffff',
  fg: '#000000',
  primary: '#3366cc',
  isDarkMode: false,
  palette: {
    'base-100': '#ffffff',
    'base-200': '#f0f0f0',
    'base-300': '#e0e0e0',
    'base-content': '#000000',
    neutral: '#808080',
    'neutral-content': '#ffffff',
    primary: '#3366cc',
    secondary: '#6699cc',
    accent: '#33cc99',
  },
} as ThemeCode;

// The rules an O'Reilly (Safari Books Online) export ships: an id selector
// outranks the reader's plain `p` and `li` rules.
const BOOK_CSS = [
  '#sbo-rt-content p { line-height: 125%; }',
  '#sbo-rt-content li { line-height: 1.25; }',
  '#sbo-rt-content p.short { font: 10px/1.5 serif; }',
].join('\n');

const BOOK_HTML = `<div id="sbo-rt-content"><section>
  <p class="book">Text</p>
  <ul><li>Item</li></ul>
  <p class="short">Shorthand</p>
  <p class="inline" style="${transformInlineFonts('line-height: 1')}">Inline</p>
</section></div>
<p class="plain">No book rule</p>`;

const iframes: HTMLIFrameElement[] = [];

const lineHeightRatio = (selector: string, settings: Partial<ViewSettings>) => {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  iframes.push(iframe);
  const doc = iframe.contentDocument!;
  const bookStyle = doc.createElement('style');
  bookStyle.textContent = transformStylesheet(BOOK_CSS, 800, 600, false);
  doc.head.appendChild(bookStyle);
  const readerStyle = doc.createElement('style');
  readerStyle.textContent = getStyles(makeViewSettings(settings), themeCode);
  doc.head.appendChild(readerStyle);
  doc.body.innerHTML = BOOK_HTML;
  const cs = iframe.contentWindow!.getComputedStyle(doc.querySelector(selector)!);
  return Math.round((parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)) * 100) / 100;
};

describe('Line Spacing Scale multiplies the line-height in effect', () => {
  afterEach(() => {
    for (const iframe of iframes.splice(0)) iframe.remove();
  });

  test.each([
    ['p.book', 1.25],
    ['li', 1.25],
    ['p.short', 1.5],
    ['p.inline', 1],
    ['p.plain', 1.4],
  ])('%s keeps its line-height at scale 1', (selector, expected) => {
    expect(lineHeightRatio(selector, { lineHeight: 1.4, lineHeightScale: 1 })).toBe(expected);
  });

  test.each([
    ['p.book', 2.5],
    ['li', 2.5],
    ['p.short', 3],
    ['p.inline', 2],
    ['p.plain', 2.8],
  ])('%s doubles at scale 2', (selector, expected) => {
    expect(lineHeightRatio(selector, { lineHeight: 1.4, lineHeightScale: 2 })).toBe(expected);
  });

  test('scales the book line-height under Use Book Layout', () => {
    expect(lineHeightRatio('p.book', { useBookLayout: true, lineHeightScale: 2 })).toBe(2.5);
  });

  test('scales the reader Line Spacing under Override Book Layout', () => {
    expect(
      lineHeightRatio('p.book', { overrideLayout: true, lineHeight: 1.4, lineHeightScale: 2 }),
    ).toBe(2.8);
  });

  test('scales text the book leaves at normal under Use Book Layout', () => {
    // At x1 the book's `normal` is left alone (it computes to no number).
    expect(lineHeightRatio('p.plain', { useBookLayout: true, lineHeightScale: 1 })).toBeNaN();
    expect(lineHeightRatio('p.plain', { useBookLayout: true, lineHeightScale: 2 })).toBe(2.4);
  });

  test.each([
    ['an invalid value', 'p { line-height: 1,5; }'],
    ['a keyword', 'p { line-height: normal; }'],
    ['a book variable', 'p { line-height: var(--lh); }'],
    ['an lh length', 'p { line-height: 1lh; }'],
    ['a comment after !important', 'p { line-height: 30px !important /* x */; }'],
    ['a negative number', 'p { line-height: -1; }'],
    ['an unknown unit', 'p { line-height: 2ptt; }'],
  ])('leaves %s as written', (_name, css) => {
    expect(transformStylesheet(css, 800, 600, false)).not.toContain('--readest-line-height-scale');
  });

  test.each(['5vh', 'clamp(16px, 2em, 40px)', 'max(1.4em, 20px)'])('scales %s', (value) => {
    expect(transformStylesheet(`p { line-height: ${value}; }`, 800, 600, false)).toContain(
      '--readest-line-height-scale',
    );
  });

  test('leaves a spaced expression after the shorthand slash as written', () => {
    expect(transformInlineFonts('font: 16px/calc(1em + 6px) Georgia')).not.toContain(
      '--readest-line-height-scale',
    );
  });

  test('scales a dynamic-viewport length', () => {
    expect(transformStylesheet('p { line-height: 2dvh; }', 800, 600, false)).toContain(
      '--readest-line-height-scale',
    );
  });

  test('takes the shorthand line-height after the size, not a division inside calc()', () => {
    expect(transformInlineFonts('font: calc(40px / 2 + 0px)/1.5 Georgia')).toBe(
      'font: calc(40px / 2 + 0px)/calc(1.5*var(--readest-line-height-scale,1)) Georgia',
    );
  });

  test('a repeated transform does not scale twice', () => {
    const once = transformStylesheet(BOOK_CSS, 800, 600, false);
    expect(transformStylesheet(once, 800, 600, false)).toBe(once);
  });
});
