import type { JSX } from 'preact';
import { useTranslation } from 'react-i18next';
import styles from '../Options.module.css';

/**
 * About section showing extension information.
 * @returns The about section element
 */
export function AboutSection(): JSX.Element {
  const { t } = useTranslation();
  const version = chrome.runtime.getManifest().version;

  return (
    <section className={styles.card}>
      <h2 className={styles.cardTitle}>{t('about_section_title')}</h2>

      <div className={styles.cardContent}>
        <div>
          <div style={{ fontWeight: 500 }}>{t('about_extension_name')}</div>
          <div className={styles.hint}>{t('about_version', { version })}</div>
        </div>
      </div>
    </section>
  );
}
