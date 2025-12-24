import { Route, Switch } from 'wouter-preact';
import { Sidebar } from './components/Sidebar';
import { Speakers } from './views/Speakers';
import { Server } from './views/Server';
import { Settings } from './views/Settings';
import './App.css';
import styles from './App.module.css';
import { useTranslation } from 'react-i18next';

/**
 * Root application component.
 *
 * Renders the sidebar navigation and routes to the appropriate view.
 * @returns The rendered App component
 */
export function App() {
  const { t } = useTranslation();
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
