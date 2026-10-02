import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';
import OverviewPage from './pages/OverviewPage.vue';
import RunsPage from './pages/RunsPage.vue';
import RunDetailPage from './pages/RunDetailPage.vue';
import MatrixPage from './pages/MatrixPage.vue';
import BaselinesPage from './pages/BaselinesPage.vue';
import DrivePage from './pages/DrivePage.vue';
import CockpitPage from './pages/CockpitPage.vue';
import FlakesPage from './pages/FlakesPage.vue';
import ForgePage from './pages/ForgePage.vue';
import TestCasesPage from './pages/TestCasesPage.vue';
import ScreensPage from './pages/ScreensPage.vue';
import EnvPage from './pages/EnvPage.vue';
import MonitoringPage from './pages/MonitoringPage.vue';
import LoginPage from './pages/LoginPage.vue';
import UsersPage from './pages/UsersPage.vue';
import GuidePage from './pages/GuidePage.vue';
import SuitesPage from './pages/SuitesPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewPage, meta: { title: 'overview' } },
    { path: '/suites', name: 'suites', component: SuitesPage, meta: { title: 'suites' } },
    { path: '/devices', name: 'wall', component: WallPage, meta: { title: 'devices' } },
    { path: '/runs', name: 'runs', component: RunsPage, meta: { title: 'runs' } },
    { path: '/runs/:id', name: 'runDetail', component: RunDetailPage, meta: { title: 'run' } },
    { path: '/tickets/:key', name: 'matrix', component: MatrixPage, meta: { title: 'acceptance criteria' } },
    { path: '/baselines', name: 'baselines', component: BaselinesPage, meta: { title: 'approvals' } },
    { path: '/drive', name: 'drive', component: DrivePage, meta: { title: 'manual control' } },
    { path: '/cockpit', name: 'cockpit', component: CockpitPage, meta: { title: 'cockpit' } },
    { path: '/flakes', name: 'flakes', component: FlakesPage, meta: { title: 'flaky tests' } },
    { path: '/forge', name: 'forge', component: ForgePage, meta: { title: 'network' } },
    { path: '/templates', name: 'templates', component: TestCasesPage, meta: { title: 'test cases' } },
    { path: '/screens', name: 'screens', component: ScreensPage, meta: { title: 'screens' } },
    { path: '/env', name: 'env', component: EnvPage, meta: { title: 'env' } },
    { path: '/monitoring', name: 'monitoring', component: MonitoringPage, meta: { title: 'monitoring' } },
    { path: '/users', name: 'users', component: UsersPage, meta: { title: 'users' } },
    { path: '/login', name: 'login', component: LoginPage, meta: { title: 'sign in', public: true } },
    { path: '/guide', name: 'guide', component: GuidePage, meta: { title: 'guide' } },
  ] satisfies RouteRecordRaw[],
});


// Auth guard: pages require a session; /login is public. The API's own 401s
// remain the enforcement — this is the UX layer (redirect instead of empty pages).
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user: unknown | null };
    if (b.user) return true;
    return { path: '/login', query: { redirect: to.fullPath } };
  } catch {
    return true; // server unreachable — let the page render its own error state
  }
});
