import { Route, Switch, useLocation } from 'wouter-preact';
import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { getVersion } from '@tauri-apps/api/app';
import { useTranslation } from 'react-i18next';
import { DesktopShell, Rail, Toast, type RailItem } from '@thaumic-cast/ui';
import { Speakers } from './views/Speakers';
import { Server } from './views/Server';
import { Settings } from './views/Settings';
import { NotFound } from './views/NotFound';
import { Onboarding } from './views/Onboarding';
import { useOnboarding } from './hooks/useOnboarding';
import { useHashScroll } from './hooks/useHashScroll';
import {
  castingSpeakers,
  startNetworkServices,
  startSpeakerNoticeListener,
  toast,
} from './state/store';

/**
 * Root application component.
 *
 * Renders onboarding for first-time users, otherwise the window (DesktopShell): the Rail,
 * the current view, and the toast row.
 * @returns The rendered App component
 */
export function App() {
  const { t } = useTranslation();
  const { isLoading, isComplete } = useOnboarding();
  const [location, navigate] = useLocation();
  const version = useSignal('');

  // Enable hash-based scrolling for client-side navigation
  useHashScroll();

  // Start network services when onboarding is already complete (returning users)
  useEffect(() => {
    if (isComplete) {
      startNetworkServices();
      startSpeakerNoticeListener();
    }
  }, [isComplete]);

  useEffect(() => {
    getVersion()
      .then((v) => {
        version.value = v;
      })
      .catch(() => undefined);
  }, []);

  // A Toast is about what was just done; leaving the view clears it.
  useEffect(() => {
    toast.value = null;
  }, [location]);

  // So does the next action: any control pressed outside the toast row (M-toast).
  useEffect(() => {
    const onPress = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (!toast.value || !target || target.closest('[data-toast-row]')) return;
      if (target.closest('button, a[href], input, select, summary')) toast.value = null;
    };
    document.addEventListener('click', onPress, true);
    return () => document.removeEventListener('click', onPress, true);
  }, []);

  // Show nothing while loading onboarding state
  if (isLoading) {
    return null;
  }

  // Show onboarding for first-time users
  if (!isComplete) {
    return <Onboarding />;
  }

  const items: RailItem[] = [
    { href: '/', icon: 'speaker', label: t('nav.speakers') },
    { href: '/server', icon: 'server', label: t('nav.server') },
    { href: '/settings', icon: 'settings', label: t('nav.settings') },
  ];

  return (
    <DesktopShell
      wide={location === '/'}
      rail={
        <Rail
          brand={{
            name: t('app.title'),
            version: version.value
              ? t('settings.about_version', { version: version.value })
              : undefined,
            lit: castingSpeakers.value.size > 0,
          }}
          items={items}
          current={location}
          onNavigate={navigate}
          navLabel={t('app.title')}
        />
      }
      toast={
        toast.value && (
          <Toast
            text={toast.value}
            onDismiss={() => {
              toast.value = null;
            }}
            dismissLabel={t('dismiss')}
          />
        )
      }
    >
      <Switch>
        <Route path="/" component={Speakers} />
        <Route path="/server" component={Server} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </DesktopShell>
  );
}
