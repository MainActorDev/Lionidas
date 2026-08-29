import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';
import RunsPage from './pages/RunsPage.vue';
import RunDetailPage from './pages/RunDetailPage.vue';
import MatrixPage from './pages/MatrixPage.vue';
import BaselinesPage from './pages/BaselinesPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'wall', component: WallPage, meta: { register: 'control' } },
    { path: '/runs', name: 'runs', component: RunsPage },
    { path: '/runs/:id', name: 'runDetail', component: RunDetailPage },
    { path: '/tickets/:key', name: 'matrix', component: MatrixPage },
    { path: '/baselines', name: 'baselines', component: BaselinesPage },
  ] satisfies RouteRecordRaw[],
});
