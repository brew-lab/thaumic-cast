import { Route, Switch } from 'wouter-preact';
import { useEffect } from 'preact/hooks';
import { Sidebar } from './components/Sidebar';
import { Speakers } from './views/Speakers';
import { Server } from './views/Server';
import { Settings } from './views/Settings';
import { Onboarding } from './views/Onboarding';
import { useOnboarding } from './hooks/useOnboarding';
import { useHashScroll } from './hooks/useHashScroll';
import { startNetworkServices } from './state/store';
import './App.css';
import styles from './App.module.css';
import { useTranslation } from 'react-i18next';

/**
 * Root application component.
 *
 * Renders onboarding for first-time users, otherwise the main app with
 * sidebar navigation and routes.
 * @returns The rendered App component
 */
export function App() {
  const { t } = useTranslation();
  const { isLoading, isComplete } = useOnboarding();

  // Enable hash-based scrolling for client-side navigation
  useHashScroll();

  // Start network services when onboarding is already complete (returning users)
  useEffect(() => {
    if (isComplete) {
      startNetworkServices();
    }
  }, [isComplete]);

  // Show nothing while loading onboarding state
  if (isLoading) {
    return null;
  }

  // Show onboarding for first-time users
  if (!isComplete) {
    return <Onboarding />;
  }

  return (
    <div className={styles.layout}>
      <Sidebar />
      <main className={styles.content}>
        <Switch>
          <Route path="/" component={Speakers} />
          <Route path="/server" component={Server} />
          <Route path="/settings" component={Settings} />
          <Route>
            <div className={styles.notFound}>
              <h2>{t('error.page_not_found')}</h2>
              <a href="/">{t('error.go_home')}</a>
            </div>
          </Route>
        </Switch>
      </main>
    </div>
  );
}
