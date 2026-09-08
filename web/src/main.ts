import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue'
// global 401 interceptor: an expired session mid-page redirects to login
// (instead of silently broken fetches). Login-page calls are exempt (they 401 by design).
{
  const orig = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await orig(...args);
    if (res.status === 401 && !location.pathname.startsWith('/login') && !String(args[0]).includes('/api/auth/')) {
      location.href = `/login?redirect=${encodeURIComponent(location.pathname + location.search)}`;
    }
    return res;
  };
};
import { router } from './router.ts';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';

createApp(App).use(createPinia()).use(router).mount('#app');
