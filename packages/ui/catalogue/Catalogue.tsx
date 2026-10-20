import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { AnnouncerProvider } from '../src/Announcer';
import { applyTheme, type ThemePreference } from '../src/theme';
import { SchemeContext, type Scheme } from './scheme';
import { SECTIONS } from './sections';

const SCHEMES: Scheme[] = ['light', 'dark'];

// `?section=a,b` draws only those sections, with the same components and stylesheets. The
// tests open a page this way, as a page of every section takes WebKit seconds to draw; axe
// and the screenshots still read the whole page.
const only = new URLSearchParams(location.search).get('section')?.split(',');
const SHOWN = only ? SECTIONS.filter((s) => only.includes(s.id)) : SECTIONS;

/** Props for {@link Catalogue}. */
export interface CatalogueProps {
  /** The theme the page opened with. */
  initialTheme: ThemePreference;
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * The catalogue page: every built design-system item, by tier, each drawn in light and in
 * dark side by side. Later phases add sections to `sections/index.ts`.
 * @param props - Component props
 * @param props.initialTheme - The theme the page opened with
 * @returns The page
 */
export function Catalogue({ initialTheme }: CatalogueProps): JSX.Element {
  const [theme, setTheme] = useState(initialTheme);
  const [hits, setHits] = useState(() => new URLSearchParams(location.search).get('hits') === '1');
  const showHits = (on: boolean): void => {
    setHits(on);
    document.documentElement.toggleAttribute('data-hits', on);
  };
  if (hits) document.documentElement.setAttribute('data-hits', '');
  const choose = (value: ThemePreference): void => {
    setTheme(value);
    applyTheme(value);
  };
  return (
    <AnnouncerProvider>
      <div class="page">
        <header class="page-header">
          <h1 class="title">Thaumic Cast design system</h1>
          <p class="lead">
            The catalogue renders every item built so far, in light and in dark. The spec is{' '}
            <code>packages/ui/DESIGN.md</code>.
          </p>
          <fieldset class="theme-switch">
            <legend>Page theme</legend>
            {THEMES.map((t) => (
              <label key={t.value} class="theme-option">
                <input
                  type="radio"
                  name="theme"
                  value={t.value}
                  checked={theme === t.value}
                  onChange={() => choose(t.value)}
                />
                {t.label}
              </label>
            ))}
          </fieldset>
          <label class="theme-option hits-toggle">
            <input
              type="checkbox"
              checked={hits}
              onChange={(event) => showHits((event.currentTarget as HTMLInputElement).checked)}
            />
            Show hit areas
          </label>
          <nav aria-label="Sections">
            <ul class="toc">
              {SHOWN.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.title}</a>
                </li>
              ))}
            </ul>
          </nav>
        </header>
        <main>
          {SHOWN.map(({ id, title, tier, summary, wide, Specimen }) => (
            <section key={id} id={id} class="section" aria-labelledby={`${id}-title`}>
              <h2 id={`${id}-title`} class="section-title">
                {title} <span class="tier">{tier}</span>
              </h2>
              <p class="summary">{summary}</p>
              <div class={wide ? 'schemes wide' : 'schemes'} data-section={id}>
                {SCHEMES.map((scheme) => (
                  <div key={scheme} class="scheme" data-scheme={scheme}>
                    <p class="scheme-name">{scheme === 'light' ? 'Light' : 'Dark'}</p>
                    <SchemeContext.Provider value={scheme}>
                      <Specimen />
                    </SchemeContext.Provider>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>
    </AnnouncerProvider>
  );
}
