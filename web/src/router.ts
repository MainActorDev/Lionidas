import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'wall', component: WallPage, meta: { register: 'control' } },
  ] satisfies RouteRecordRaw[],
});
