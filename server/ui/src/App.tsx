import { useState, useEffect } from 'preact/hooks';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { SonosLink } from './pages/SonosLink';

type Route = 'login' | 'signup' | 'sonos-link';

function getRoute(): Route {
  const path = window.location.pathname;
  if (path === '/signup') return 'signup';
  if (path === '/sonos/link') return 'sonos-link';
  return 'login';
}

export function App() {
  const [route, setRoute] = useState<Route>(getRoute);

  useEffect(() => {
    const handlePopState = () => setRoute(getRoute());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setRoute(getRoute());
  };

  switch (route) {
    case 'signup':
      return <Signup onNavigate={navigate} />;
    case 'sonos-link':
      return <SonosLink onNavigate={navigate} />;
    default:
      return <Login onNavigate={navigate} />;
  }
}
