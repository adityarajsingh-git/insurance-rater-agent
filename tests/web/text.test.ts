import { expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { itemsToText } from '../../src/web/lib';

const item = (str: string, x: number, y: number): TextItem =>
  ({ str, transform: [1, 0, 0, 1, x, y], width: 10, height: 10, dir: 'ltr', fontName: 'f', hasEOL: false }) as TextItem;

it('rebuilds lines top-down, ordered by x, joined by single spaces', () => {
  const text = itemsToText([
    item('Premium', 300, 700.5), item('Policy', 10, 700), item(' ', 50, 700), item('No:  123', 60, 701),
    item('HR-26', 60, 680), item('RTO', 10, 680),
  ]);
  expect(text).toBe('Policy No: 123 Premium\nRTO HR-26');
});
