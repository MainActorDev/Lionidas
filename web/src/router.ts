import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import WallPage from './pages/WallPage.vue';
import OverviewPage from './pages/OverviewPage.vue';
import RunsPage from './pages/RunsPage.vue';
import RunDetailPage from './pages/RunDetailPage.vue';
import MatrixPage from './pages/MatrixPage.vue';
import CockpitPage from './pages/CockpitPage.vue';
import ForgePage from './pages/ForgePage.vue';
import TestCasesPage from './pages/TestCasesPage.vue';
import ScreensPage from './pages/ScreensPage.vue';
import EnvPage from './pages/EnvPage.vue';
import ProjectsPage from './pages/ProjectsPage.vue';
import SettingsPage from './pages/SettingsPage.vue';
import BuildsPage from './pages/BuildsPage.vue';
import LoginPage from './pages/LoginPage.vue';
import SetupPage from './pages/SetupPage.vue';
import UsersPage from './pages/UsersPage.vue';
import AuditPage from './pages/AuditPage.vue';
import GuidePage from './pages/GuidePage.vue';
import SuitesPage from './pages/SuitesPage.vue';
import AgentChatPage from './pages/agent/AgentChatPage.vue';
import StatusPage from './pages/StatusPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewPage, meta: { title: 'overview' } },
    { path: '/suites', name: 'suites', component: SuitesPage, meta: { title: 'suites' } },
    { path: '/devices', name: 'wall', component: WallPage, meta: { title: 'devices' } },
    { path: '/runs', name: 'runs', component: RunsPage, meta: { title: 'runs' } },
    { path: '/runs/:id', name: 'runDetail', component: RunDetailPage, meta: { title: 'run' } },
    { path: '/tickets/:key', name: 'matrix', component: MatrixPage, meta: { title: 'acceptance criteria' } },
    { path: '/cockpit', name: 'cockpit', component: CockpitPage, meta: { title: 'cockpit', fullscreen: true } },
    { path: '/forge', name: 'forge', component: ForgePage, meta: { title: 'network' } },
    { path: '/templates', name: 'templates', component: TestCasesPage, meta: { title: 'test cases' } },
    { path: '/screens', name: 'screens', component: ScreensPage, meta: { title: 'screens' } },
    { path: '/env', name: 'env', component: EnvPage, meta: { title: 'env' } },
    { path: '/users', name: 'users', component: UsersPage, meta: { title: 'users' } },
    { path: '/audit', name: 'audit', component: AuditPage, meta: { title: 'audit log' } },
    { path: '/projects', name: 'projects', component: ProjectsPage, meta: { title: 'projects' } },
    { path: '/builds', name: 'builds', component: BuildsPage, meta: { title: 'builds' } },
    { path: '/settings', name: 'settings', component: SettingsPage, meta: { title: 'settings' } },
    { path: '/login', name: 'login', component: LoginPage, meta: { title: 'sign in', public: true } },
    { path: '/setup', name: 'setup', component: SetupPage, meta: { title: 'first-run setup', public: true } },
    { path: '/guide', name: 'guide', component: GuidePage, meta: { title: 'guide' } },
    { path: '/agent', name: 'agentChat', component: AgentChatPage, meta: { title: 'agent' } },
    { path: '/status', name: 'status', component: StatusPage, meta: { title: 'status' } },
  ] satisfies RouteRecordRaw[],
});


// Auth guard: pages require a session; /login is public. The API's own 401s
// remain the enforcement — this is the UX layer (redirect instead of empty pages).
// Setup-window aware: while the instance is unclaimed, /setup stays reachable
// (the wizard runs BEFORE any account exists — otherwise login↔setup loop).
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user: unknown | null };
    if (b.user) return true;
    // unclaimed instance: the only meaningful destination is the wizard
    try {
      const s = await fetch('/api/setup/state');
      if (s.ok && to.path !== '/setup') return { path: '/setup' };
    } catch { /* setup closed — normal */ }
    return { path: '/login', query: { redirect: to.fullPath } };
  } catch {
    return true; // server unreachable — let the page render its own error state
  }
});
