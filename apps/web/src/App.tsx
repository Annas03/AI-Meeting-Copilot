import { useEffect, useState } from 'react';
import { HomePage } from './pages/HomePage';
import { MeetingPage } from './pages/MeetingPage';

type Route = { name: 'home' } | { name: 'meeting'; meetingId: string };

function parseRoute(pathname: string): Route {
  const match = /^\/m\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (match) return { name: 'meeting', meetingId: match[1]! };
  return { name: 'home' };
}

export function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (route.name === 'meeting') {
    return <MeetingPage key={route.meetingId} meetingId={route.meetingId} />;
  }
  return <HomePage />;
}
