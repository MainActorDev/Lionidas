import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';
import SuiteHomePage from './pages/SuiteHomePage.vue';
import RunsPage from './pages/RunsPage.vue';
import RunDetailPage from './pages/RunDetailPage.vue';
import MatrixPage from './pages/MatrixPage.vue';
import BaselinesPage from './pages/BaselinesPage.vue';
import DrivePage from './pages/DrivePage.vue';
import FlakesPage from './pages/FlakesPage.vue';
import ForgePage from './pages/ForgePage.vue';
import TestCasesPage from './pages/TestCasesPage.vue';
import GuidePage from './pages/GuidePage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'suite', component: SuiteHomePage, meta: { title: 'suite' } },
    { path: '/devices', name: 'wall', component: WallPage, meta: { title: 'devices' } },
    { path: '/runs', name: 'runs', component: RunsPage, meta: { title: 'runs' } },
    { path: '/runs/:id', name: 'runDetail', component: RunDetailPage, meta: { title: 'run' } },
    { path: '/tickets/:key', name: 'matrix', component: MatrixPage, meta: { title: 'acceptance criteria' } },
    { path: '/baselines', name: 'baselines', component: BaselinesPage, meta: { title: 'approvals' } },
    { path: '/drive', name: 'drive', component: DrivePage, meta: { title: 'manual control' } },
    { path: '/flakes', name: 'flakes', component: FlakesPage, meta: { title: 'flaky tests' } },
    { path: '/forge', name: 'forge', component: ForgePage, meta: { title: 'network' } },
    { path: '/templates', name: 'templates', component: TestCasesPage, meta: { title: 'test cases' } },
    { path: '/guide', name: 'guide', component: GuidePage, meta: { title: 'guide' } },
  ] satisfies RouteRecordRaw[],
});
