<script setup lang="ts">
/** Audit log — timeline ledger (round 037 variant A, user-approved
 *  2026-10-15; plan 20261015T065500Z). Dense day-grouped rows, facet rail
 *  (client-side "in view"), server-side q= search, numbered pagination,
 *  detail-on-click Sheet. Supervisor+ (server-gated; nav hides below
 *  supervisor). API: GET /api/audit?actor=&event=&q=&page=&limit= →
 * {events,total,page,pageCount}. NOTE: page offsets can drift on a live
 * log — accepted (timestamped, not transactional). */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import { Button } from '@/components/ui/button';
import { Search } from 'lucide-vue-next';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface AuditRow { id: number; at: number; email: string | null; user_id: string | null; event: string; detail: string }

const PAGE_SIZE = 50;
const rows = ref<AuditRow[]>([]);
const total = ref(0);
const pageCount = ref(0);
const page = ref(1);
const loading = ref(false);
const err = ref('');
const fActor = ref('');
const fQ = ref('');
// facet class filter — client-side over the loaded window ("in view")
const fClass = ref<string>('all');
const grouped = ref(true);
const selected = ref<AuditRow | null>(null);

const EVENT_CLASSES: Array<{ label: string; events: string[] }> = [
  { label: 'auth', events: ['login', 'login_failed', 'logout', 'session_killed'] },
  { label: 'accounts', events: ['approved', 'unapproved', 'role_changed', 'active_changed', 'password_changed', 'bot_token_rotated'] },
  { label: 'runs', events: ['run_play', 'run_abort'] },
  { label: 'cases', events: ['case_create', 'case_edit', 'case_delete'] },
  { label: 'devices', events: ['manual_take_control', 'manual_release', 'device_action', 'build_trigger', 'app_installed', 'app_uninstalled'] },
  { label: 'rbac', events: ['rbac_denied'] },
];

function classOf(ev: string): string {
  return EVENT_CLASSES.find((c) => c.events.includes(ev))?.label ?? 'other';
}

/** loaded rows after the client-side class facet ("in view") */
const viewRows = computed<AuditRow[]>(() =>
  fClass.value === 'all' ? rows.value : rows.value.filter((r) => classOf(r.event) === fClass.value),
);

/** day groups from viewRows (adjacent-merge keeps page seams single-header) */
const dayGroups = computed<Array<{ key: string; label: string; count: number; rows: AuditRow[] }>>(() => {
  const groups: Array<{ key: string; label: string; count: number; rows: AuditRow[] }> = [];
  for (const r of viewRows.value) {
    const d = new Date(r.at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const label = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else groups.push({ key, label, count: 0, rows: [r] });
  }
  for (const g of groups) g.count = g.rows.length;
  return groups;
});

/** facet counts — from the loaded window, labeled "in view" (plan Task 2.2) */
const facetCounts = computed<Record<string, number>>(() => {
  const c: Record<string, number> = { all: rows.value.length };
  for (const cls of EVENT_CLASSES) c[cls.label] = 0;
  for (const r of rows.value) {
    const k = classOf(r.event);
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
});

/** actor facets — from the loaded window; click sends the server `actor` filter */
const actorFacets = computed<Array<{ email: string; label: string; n: number }>>(() => {
  const c = new Map<string, number>();
  for (const r of rows.value) {
    if (!r.email) continue;
    c.set(r.email, (c.get(r.email) ?? 0) + 1);
  }
  return [...c.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([email, n]) => {
      const local = email.split('@')[0] ?? email;
      const label = local.length > 14 ? `${local.slice(0, 12)}…` : local;
      return { email, label, n };
    });
});

function toggleActor(email: string): void {
  fActor.value = fActor.value === email ? '' : email;
  void fetchPage(1);
}

/** pagination window: numbers + ellipsis */
const pageWindow = computed<Array<number | '…'>>(() => {
  const pc = pageCount.value;
  const p = page.value;
  if (pc <= 7) return Array.from({ length: pc }, (_, i) => i + 1);
  const out: Array<number | '…'> = [1];
  const lo = Math.max(2, p - 1);
  const hi = Math.min(pc - 1, p + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pc - 1) out.push('…');
  out.push(pc);
  return out;
});

async function fetchPage(p: number): Promise<void> {
  loading.value = true; err.value = '';
  try {
    const q = new URLSearchParams();
    if (fActor.value) q.set('actor', fActor.value);
    if (fQ.value) q.set('q', fQ.value);
    q.set('page', String(p));
    q.set('limit', String(PAGE_SIZE));
    const r = await fetch(`/api/audit?${q}`);
    if (!r.ok) { err.value = r.status === 403 ? 'supervisor role required' : `load failed (${r.status})`; return; }
    const b = (await r.json()) as { events: AuditRow[]; total: number; page: number; pageCount: number };
    rows.value = b.events;
    total.value = b.total;
    pageCount.value = b.pageCount;
    page.value = b.page;
    if (b.page > b.pageCount && b.pageCount > 0) { await fetchPage(b.pageCount); return; } // clamp
  } catch { err.value = 'load failed'; } finally { loading.value = false; }
}

function applyFilters(): void { void fetchPage(1); }
function go(p: number | '…'): void { if (p !== '…' && p !== page.value && p >= 1 && p <= pageCount.value) void fetchPage(p); }

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtFull(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}

function openDetail(r: AuditRow): void { selected.value = r; }

onMounted(() => void fetchPage(1));
</script>

<template>
  <div class="page audit">
    <PageHeader title="audit log">
      <span class="ph-desc">who did what, when — {{ total }} events in range</span>
    </PageHeader>

    <div class="audit-body">
      <!-- facet rail: client-side "in view" (sketch 037-A) -->
      <aside class="rail" aria-label="filters in view">
        <div>
          <div class="rail-h">event class <button v-if="fClass !== 'all'" type="button" class="clear" @click="fClass = 'all'">clear</button></div>
          <div class="rail-list">
            <button
              v-for="cls in [{ label: 'all' }, ...EVENT_CLASSES]" :key="cls.label"
              type="button" class="facet" :class="[cls.label, { on: fClass === cls.label }]"
              :aria-pressed="fClass === cls.label"
              @click="fClass = cls.label"
            >
              <span class="dot" aria-hidden="true"></span>{{ cls.label === 'all' ? 'all events' : cls.label === 'rbac' ? 'rbac denials' : cls.label }}
              <span class="n">{{ facetCounts[cls.label] ?? 0 }}</span>
            </button>
          </div>
        </div>
        <div>
          <div class="rail-h">actors</div>
          <div class="rail-list">
            <button
              v-for="a in actorFacets" :key="a.email" type="button" class="facet"
              :class="{ on: fActor === a.email }" :aria-pressed="fActor === a.email"
              @click="toggleActor(a.email)"
            >
              <span class="dot" aria-hidden="true"></span>{{ a.label }}
              <span class="n">{{ a.n }}</span>
            </button>
          </div>
        </div>
      </aside>

      <section class="ledger-col">
        <!-- toolbar: search-first (sketch: carbon-filled search + grouping toggle) -->
        <div class="toolbar">
          <label class="q">
            <Search aria-hidden="true" />
            <input
              v-model="fQ" type="text" placeholder="search actor, event, detail…"
              aria-label="search audit log" @keydown.enter="applyFilters"
            >
            <span class="k" aria-hidden="true">↵</span>
          </label>
          <div class="seg" role="group" aria-label="time grouping">
            <button type="button" :class="{ on: grouped }" @click="grouped = true">day</button>
            <button type="button" :class="{ on: !grouped }" @click="grouped = false">continuous</button>
          </div>
        </div>

        <p v-if="err" class="err" role="alert">{{ err }}</p>

        <!-- loading skeleton -->
        <div v-if="loading" class="skeleton-strip" aria-hidden="true">
          <div v-for="i in 8" :key="i" class="skel-row"></div>
        </div>

        <!-- the ledger -->
        <div v-else-if="viewRows.length" class="ledger" aria-label="audit events">
          <template v-if="grouped">
            <template v-for="g in dayGroups" :key="g.key">
              <div class="day" role="presentation">
                <span class="d">{{ g.label }}</span><span class="n">{{ g.count }} events</span>
              </div>
              <button
                v-for="r in g.rows" :key="r.id" type="button" class="row"
                @click="openDetail(r)"
              >
                <span class="t">{{ fmtTime(r.at) }}</span>
                <span class="who" :title="r.email ?? ''">{{ r.email ?? 'system' }}</span>
                <span class="ev" :class="classOf(r.event)"><span class="dot" aria-hidden="true"></span>{{ r.event }}</span>
                <span class="what">{{ r.detail }}</span>
              </button>
            </template>
          </template>
          <template v-else>
            <button
              v-for="r in viewRows" :key="r.id" type="button" class="row"
              @click="openDetail(r)"
            >
              <span class="t">{{ fmtTime(r.at) }}</span>
              <span class="who" :title="r.email ?? ''">{{ r.email ?? 'system' }}</span>
              <span class="ev" :class="classOf(r.event)"><span class="dot" aria-hidden="true"></span>{{ r.event }}</span>
              <span class="what">{{ r.detail }}</span>
            </button>
          </template>
        </div>
        <p v-else-if="!err" class="empty">no audit rows match</p>

        <!-- numbered pagination -->
        <nav v-if="pageCount > 1 && !loading" class="pager" aria-label="pagination">
          <Button variant="outline" size="sm" :disabled="page <= 1" @click="go(page - 1)">prev</Button>
          <template v-for="(p, i) in pageWindow" :key="i">
            <span v-if="p === '…'" class="ell">…</span>
            <Button v-else variant="outline" size="sm" :class="{ cur: p === page }" :aria-current="p === page ? 'page' : undefined" @click="go(p)">{{ p }}</Button>
          </template>
          <Button variant="outline" size="sm" :disabled="page >= pageCount" @click="go(page + 1)">next</Button>
        </nav>
      </section>
    </div>

    <!-- detail sheet -->
    <Sheet :open="selected !== null" @update:open="(o: boolean) => { if (!o) selected = null; }">
      <SheetContent side="right" class="detail-sheet w-[min(92vw,400px)] p-0">
        <SheetHeader class="detail-head">
          <SheetTitle class="d-ev" :class="selected ? classOf(selected.event) : ''">{{ selected?.event }}</SheetTitle>
        </SheetHeader>
        <div v-if="selected" class="detail-body">
          <div class="kv"><span class="k">when</span><span class="v">{{ fmtFull(selected.at) }}</span></div>
          <div class="kv"><span class="k">actor</span><span class="v">{{ selected.email ?? '—' }}</span></div>
          <div class="kv"><span class="k">user id</span><span class="v">{{ selected.user_id ?? '—' }}</span></div>
          <div class="kv"><span class="k">class</span><span class="v">{{ classOf(selected.event) }}</span></div>
          <div class="kv"><span class="k">detail</span><span class="v">{{ selected.detail }}</span></div>
          <div class="d-h">raw record</div>
          <pre class="raw">{{ JSON.stringify(selected, null, 2) }}</pre>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>

<style scoped>
/* layout only — chrome from theme tokens; colors via theme vars (no hexes) */
.audit { width: 100%; }
.audit-body { display: grid; grid-template-columns: 200px 1fr; gap: 20px; align-items: start; }

/* facet rail — sketch 037-A: two stacked sections, sticky */
.rail { position: sticky; top: 0; display: flex; flex-direction: column; gap: 22px; padding-top: 22px; }
.rail-h { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-foreground); margin-bottom: 8px; display: flex; align-items: baseline; }
.rail-h .clear { margin-left: auto; font-size: 10px; font-family: var(--font-mono); color: var(--muted-foreground); }
.rail-h .clear:hover { color: var(--foreground); }
.rail-list { display: flex; flex-direction: column; gap: 2px; }
.facet { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--muted-foreground); padding: 3px 6px; border-radius: 3px; border: 1px solid transparent; text-align: left; }
.facet:hover { background: var(--accent); color: var(--accent-foreground); }
.facet.on { background: var(--accent); border-color: var(--border); color: var(--accent-foreground); }
.facet .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
.facet.auth .dot { background: var(--muted-foreground); }
.facet.runs .dot { background: var(--status-green); }
.facet.rbac .dot { background: var(--status-orange); }
.facet .n { margin-left: auto; color: var(--muted-foreground); font-size: 11px; }

/* toolbar — sketch 037-A: carbon-filled search box + seg toggle */
.toolbar { display: flex; gap: 8px; padding: 14px 0; align-items: center; }
.q { flex: 1; min-width: 220px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 3px; padding: 7px 10px; background: var(--card); }
.q:focus-within { border-color: var(--muted-foreground); }
.q input { background: none; border: none; color: var(--foreground); font-family: var(--font-mono); font-size: 12px; outline: none; flex: 1; }
.q input::placeholder { color: var(--muted-foreground); }
.q svg { width: 12px; height: 12px; color: var(--muted-foreground); flex-shrink: 0; }
.q .k { font-family: var(--font-mono); font-size: 10px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; flex-shrink: 0; }
.seg { display: flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
.seg button { font-family: var(--font-mono); font-size: 11px; padding: 7px 12px; color: var(--muted-foreground); }
.seg button.on { background: var(--accent); color: var(--accent-foreground); }
.seg button + button { border-left: 1px solid var(--border); }

/* ledger */
.ledger { border-top: 1px solid var(--border); }
.day { position: sticky; top: 0; background: var(--background); z-index: 2; display: flex; align-items: baseline; gap: 10px; padding: 10px 12px 6px; border-bottom: 1px solid var(--border); }
.day .d { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--foreground); }
.day .n { font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); }
.row { display: grid; grid-template-columns: 64px 200px 150px 1fr; gap: 14px; padding: 7px 12px; border-bottom: 1px solid var(--border); align-items: baseline; cursor: pointer; text-align: left; }
.row:hover, .row:focus-visible { background: var(--accent); color: var(--accent-foreground); }
.row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.row .t { font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
.row .who { font-family: var(--font-mono); font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .ev { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); }
.row .ev .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--border); flex-shrink: 0; }
.row .ev.auth .dot { background: var(--muted-foreground); }
.row .ev.runs .dot { background: var(--status-green); }
.row .ev.rbac .dot { background: var(--status-orange); }
.row .ev.rbac { color: var(--status-orange); }
.row .what { font-size: 13px; color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* skeleton */
.skeleton-strip { display: flex; flex-direction: column; }
.skel-row { height: 32px; border-bottom: 1px solid var(--border); background: linear-gradient(90deg, transparent, var(--muted), transparent); background-size: 200% 100%; animation: shimmer 1.2s infinite linear; opacity: 0.15; }
@keyframes shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) { .skel-row { animation: none } }

/* pagination */
.pager { display: flex; gap: 6px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.ell { color: var(--muted-foreground); padding: 0 2px; }
:deep(.cur) { border-color: var(--ring); color: var(--foreground); }

/* states */
.empty { color: var(--muted-foreground); font-size: 13px; padding: 24px 0; }
.err { color: var(--status-orange); font-size: 13px; }

/* detail sheet */
.detail-head { padding: 20px 22px 0; }
.d-ev { font-family: var(--font-mono); font-size: 15px; font-weight: 500; }
.d-ev.rbac { color: var(--status-orange); }
.d-ev.runs { color: var(--status-green); }
.detail-body { padding: 8px 22px 24px; overflow-y: auto; }
.kv { display: grid; grid-template-columns: 88px 1fr; gap: 10px; padding: 3px 0; font-size: 12px; }
.kv .k { font-family: var(--font-mono); color: var(--muted-foreground); }
.kv .v { font-family: var(--font-mono); color: var(--foreground); word-break: break-all; }
.d-h { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted-foreground); padding: 12px 0 6px; border-top: 1px solid var(--border); margin-top: 8px; }
.raw { border: 1px solid var(--border); border-radius: 3px; background: var(--muted); padding: 10px; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); white-space: pre-wrap; word-break: break-all; }

/* mobile */
@media (max-width: 900px) {
  .audit-body { grid-template-columns: 1fr; }
  .rail { display: none; }
  .row { grid-template-columns: 56px 1fr 110px; }
  .row .who { display: none; }
  .row .what { grid-column: 1 / -1; grid-row: 2; }
}
</style>
