import { useLocation } from 'wouter-preact';
import { useTranslation } from 'react-i18next';
import { useSignal } from '@preact/signals';
import { getVersion } from '@tauri-apps/api/app';
import { useEffect } from 'preact/hooks';
import { BrandBlock, NavItem, type GlyphName } from '@thaumic-cast/ui';
import { castingSpeakers } from '../state/store';
import styles from './Sidebar.module.css';

/**
 * Sidebar navigation component.
 *
 * The brand (lit while a cast plays, with the version in the wide rail) and the
 * navigation links. Under a 45rem window it collapses to icons, each with a
 * tooltip. Phase 4 rebuilds it as the Rail (DESIGN.md C-rail).
 * @returns The rendered Sidebar component
 */
export function Sidebar() {
  const [location, navigate] = useLocation();
  const { t } = useTranslation();
  const version = useSignal('');

  useEffect(() => {
    getVersion().then((v) => {
      version.value = v;
    });
  }, []);

  const links: { href: string; icon: GlyphName; label: string }[] = [
    { href: '/', icon: 'speaker', label: t('nav.speakers') },
    { href: '/server', icon: 'server', label: t('nav.server') },
    { href: '/settings', icon: 'settings', label: t('nav.settings') },
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <BrandBlock
          name={t('app.title')}
          kind="rail"
          lit={castingSpeakers.value.size > 0}
          version={
            version.value ? t('settings.about_version', { version: version.value }) : undefined
          }
        />
      </div>

      <nav className={styles.nav} aria-label={t('app.title')}>
        {links.map(({ href, icon, label }) => (
          <NavItem
            key={href}
            href={href}
            icon={icon}
            label={label}
            current={location === href}
            onNavigate={navigate}
          />
        ))}
      </nav>
    </aside>
  );
}
