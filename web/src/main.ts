import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router.ts';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';

createApp(App).use(createPinia()).use(router).mount('#app');
