import { Link, useLocation } from 'wouter-preact';
import { Speaker, Server, Settings, Radio } from 'lucide-preact';
import { useTranslation } from 'react-i18next';
import { useSignal } from '@preact/signals';
import { getVersion } from '@tauri-apps/api/app';
import { useEffect } from 'preact/hooks';
import styles from './Sidebar.module.css';
import { clsx } from 'clsx';

/**
 * Sidebar navigation component.
 *
 * Contains app branding, navigation links, and version display.
 * @returns The rendered Sidebar component
 */
export function Sidebar() {
  const [location] = useLocation();
  const { t } = useTranslation();
  const version = useSignal('');

  useEffect(() => {
    getVersion().then((v) => {
      version.value = `v${v}`;
    });
  }, []);

  const links = [
    { href: '/', icon: Speaker, label: t('nav.speakers') },
    { href: '/server', icon: Server, label: t('nav.server') },
    { href: '/settings', icon: Settings, label: t('nav.settings') },
  ];

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <Radio size={24} color="var(--color-primary)" />
        <h1 className={styles.title}>{t('app.title')}</h1>
      </div>

      <nav className={styles.nav}>
        {links.map(({ href, icon: Icon, label }) => {
          const isActive = location === href;
          return (
            <Link
              key={href}
              href={href}
              className={clsx(styles['nav-link'], isActive && styles['nav-link-active'])}
            >
              <Icon size={20} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className={styles.version}>{version}</div>
    </aside>
  );
}
