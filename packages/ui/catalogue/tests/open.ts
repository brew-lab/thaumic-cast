/*
 * Opening the catalogue for a behaviour test. A page of every section takes headless WebKit
 * seconds to draw and keeps some 80 animations running, so a test opens a page of only the
 * sections its file names (`?section=`, Catalogue.tsx): the same components and stylesheets,
 * fewer of them. axe and the screenshots still read the whole page (catalogue.pw.ts).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Every section id, in page order, as sections/index.ts lists them. */
export const SECTION_IDS: string[] = [
  ...readFileSync(new URL('../sections/index.ts', import.meta.url), 'utf8').matchAll(
    /^ {4}id: '([a-z0-9-]+)',$/gm,
  ),
].map((match) => match[1]);

const named = new Map<string, string[]>();

/**
 * The sections a test file names: each id written in quotes or after a `#`. A role or a word
 * that is also an id ('button') draws a section the file may not need, which costs a little
 * time and nothing else; a section a test needs but never names fails the test loudly.
 * @param file - The test file's path
 * @returns The ids, in page order
 */
function sectionsNamedIn(file: string): string[] {
  let ids = named.get(file);
  if (!ids) {
    const source = readFileSync(file, 'utf8');
    ids = SECTION_IDS.filter((id) => new RegExp(`['"\`#]${id}(?![a-z0-9-])`).test(source));
    named.set(file, ids);
  }
  return ids;
}

/**
 * Opens the catalogue with only the sections the running test's file names, and waits until
 * the page is ready (main.tsx sets data-ready a second after load).
 * @param page - The test's page
 * @param address - The address as it would open the whole page, e.g. `/?theme=light#size`
 */
export async function openSections(page: Page, address: string): Promise<void> {
  const ids = sectionsNamedIn(test.info().file);
  expect(ids.length, 'the test file names no section').toBeGreaterThan(0);
  const [path, hash = ''] = address.split('#');
  const join = path.includes('?') ? '&' : '?';
  await page.goto(`${path}${join}section=${ids.join(',')}${hash ? `#${hash}` : ''}`);
  await expect(page.locator('html[data-ready]')).toHaveCount(1);
  await expect(page.locator('main > section.section[id]')).toHaveCount(ids.length);
}
