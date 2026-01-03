import { Route, Switch } from 'wouter-preact';
import { Sidebar } from './components/Sidebar';
import { Speakers } from './views/Speakers';
import { Server } from './views/Server';
import { Settings } from './views/Settings';
import { Onboarding } from './views/Onboarding';
import { useOnboarding } from './hooks/useOnboarding';
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
