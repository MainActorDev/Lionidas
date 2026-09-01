/** Shared suite composable — ONE loader/runner for verdicts + plans, used by
 *  BOTH the suite home board and the test-cases page (no duplicated query
 *  logic to drift — B8's lesson). */
import { ref, computed } from 'vue';

export interface Step { idx: number; action: string; x?: number; y?: number; direction?: string; text?: string; optional?: boolean; selector?: { identifier?: string; label?: string; type?: string }; templateId?: string }
export interface Verdict {
  lastRunId: string | null; lastStatus: string | null; lastBlocked: number;
  lastFinishedAt: number | null; lastAppVersion: string | null;
  trend: string | null; totalRuns: number;
}
export interface CaseRow {
  id: string; name: string; description: string | null; ticketKey: string | null;
  udid: string; logicalW: number | null; logicalH: number | null;
  steps: Step[]; defaultPresetId: string | null;
  appBundleId: string | null; appName: string | null; appVersion: string | null;
  tags: string[]; verdict: Verdict | null;
  createdBy: string; createdAt: number; updatedAt: number;
}
export interface Plan { id: string; name: string; tags: string[]; udid: string | null; appBundleId: string | null; scenarioId: string | null; env: Record<string, string> }

export type VerdictKind = 'never' | 'green' | 'red' | 'blocked' | 'aborted';

export function verdictKind(t: CaseRow): VerdictKind {
  const v = t.verdict;
  if (!v || v.lastStatus === null) return 'never';
  if (v.lastStatus === 'passed') return 'green';
  if (v.lastStatus === 'aborted') return 'aborted';
  return v.lastBlocked === 1 ? 'blocked' : 'red';
}

export function verdictStatusClass(t: CaseRow): string {
  const k = verdictKind(t);
  return k === 'green' ? 'status-pass' : k === 'red' ? 'status-fail' : k === 'blocked' ? 'status-blocked' : k === 'aborted' ? 'status-quarantined' : 'status-none';
}

export function verdictLabel(t: CaseRow): string {
  const k = verdictKind(t);
  if (k === 'never') return 'never run';
  const v = t.verdict!;
  const when = v.lastFinishedAt ? relTime(v.lastFinishedAt) : '';
  const build = v.lastAppVersion ? ` · v${v.lastAppVersion}` : '';
  const lbl = k === 'green' ? 'pass' : k === 'red' ? 'fail' : k === 'blocked' ? 'blocked (infra)' : 'aborted';
  return `${lbl}${build}${when ? ` · ${when}` : ''}`;
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** trend glyph → (symbol, system class) — mirrors .status-* semantics */
export function trendGlyphs(t: CaseRow): Array<{ g: string; cls: string }> {
  const trend = t.verdict?.trend;
  if (!trend) return [];
  return trend.split('').map((g) => ({ g: g === 'p' ? '✓' : g === 'F' ? '◆' : g === 'f' ? '✕' : '◌', cls: g === 'p' ? 't-pass' : g === 'F' ? 't-blocked' : g === 'f' ? 't-fail' : 't-abort' }));
}

/** attention order: red > blocked > never > aborted > green; ties by oldest
 *  last-run first (stale greens get eyes too). SORT not filter — the board
 *  shows the whole suite's shape. */
const KIND_RANK: Record<VerdictKind, number> = { red: 0, blocked: 1, never: 2, aborted: 3, green: 4 };

export function useSuite() {
  const cases = ref<CaseRow[]>([]);
  const plans = ref<Plan[]>([]);
  const loading = ref(true);
  const error = ref('');

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const r = await fetch('/api/templates');
      cases.value = ((await r.json()) as { templates?: CaseRow[] }).templates ?? [];
      error.value = '';
    } catch {
      error.value = 'failed to load the suite';
    } finally { loading.value = false; }
    try {
      const r = await fetch('/api/plans');
      plans.value = ((await r.json()) as { plans: Plan[] }).plans ?? [];
    } catch { /* plans optional */ }
  }

  const summary = computed(() => {
    const ks = cases.value.map(verdictKind);
    return {
      total: ks.length,
      green: ks.filter((k) => k === 'green').length,
      red: ks.filter((k) => k === 'red').length,
      blocked: ks.filter((k) => k === 'blocked').length,
      aborted: ks.filter((k) => k === 'aborted').length,
      never: ks.filter((k) => k === 'never').length,
    };
  });

  const attentionOrder = computed(() =>
    [...cases.value].sort((a, b) => {
      const ra = KIND_RANK[verdictKind(a)];
      const rb = KIND_RANK[verdictKind(b)];
      if (ra !== rb) return ra - rb;
      const ta = a.verdict?.lastFinishedAt ?? 0;
      const tb = b.verdict?.lastFinishedAt ?? 0;
      return ta - tb;
    }),
  );

  return { cases, plans, loading, error, summary, attentionOrder, load };
}
