import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';
import RunsPage from './pages/RunsPage.vue';
import RunDetailPage from './pages/RunDetailPage.vue';
import MatrixPage from './pages/MatrixPage.vue';
import BaselinesPage from './pages/BaselinesPage.vue';
import DrivePage from './pages/DrivePage.vue';
import FlakesPage from './pages/FlakesPage.vue';
import ForgePage from './pages/ForgePage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'wall', component: WallPage, meta: { title: 'wall' } },
    { path: '/runs', name: 'runs', component: RunsPage, meta: { title: 'runs' } },
    { path: '/runs/:id', name: 'runDetail', component: RunDetailPage, meta: { title: 'run' } },
    { path: '/tickets/:key', name: 'matrix', component: MatrixPage, meta: { title: 'matrix' } },
    { path: '/baselines', name: 'baselines', component: BaselinesPage, meta: { title: 'baselines' } },
    { path: '/drive', name: 'drive', component: DrivePage, meta: { title: 'drive' } },
    { path: '/flakes', name: 'flakes', component: FlakesPage, meta: { title: 'flakes' } },
    { path: '/forge', name: 'forge', component: ForgePage, meta: { title: 'forge' } },
  ] satisfies RouteRecordRaw[],
});
