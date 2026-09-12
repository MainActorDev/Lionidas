/** Inspect sample fetching: pixel-estimates for the selected node, from the
 *  server's /inspect-sample route. Debounced 250ms, single in-flight, keyed to
 *  node index + rect so a fast hover-switch never paints stale values. Honesty:
 *  failed/absent → sample stays null → UI shows "—". */
import { ref, watch, type Ref } from 'vue';
import type { AxNode } from '@crucible/shared/ax-tree';

export interface InspectSampleData {
  text: { color: string; token: string | null; sizePt: number | null } | null;
  fill: { color: string; token: string | null } | null;
  radius: { pt: number } | null;
  scale: number;
  capturedAt: number;
}

export function useInspectSample(
  sessionId: Ref<string | null>,
  selected: Ref<AxNode | null>,
  logicalW: Ref<number | null>,
  enabled: Ref<boolean>,
) {
  const sample = ref<InspectSampleData | null>(null);
  const loading = ref(false);
  const failed = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let gen = 0;
  let lastKey: string | null = null;

  const keyOf = (n: AxNode | null): string | null => {
    if (!n?.rect) return null;
    const r = n.rect;
    return `${n.index}|${r.x},${r.y},${r.width},${r.height}`;
  };

  watch(
    [selected, enabled, logicalW, sessionId] as const,
    ([node, on, lw, sid]) => {
      if (timer) clearTimeout(timer);
      const key = on ? keyOf(node) : null;
      if (key && key === lastKey) return; // same node+rect → keep current sample
      if (!key || !lw || !sid) {
        if (inFlight) { inFlight.abort(); inFlight = null; }
        if (timer) { clearTimeout(timer); timer = null; }
        sample.value = null;
        loading.value = false;
        failed.value = false;
        lastKey = null;
        return;
      }
      lastKey = key;
      loading.value = true;
      failed.value = false;
      if (inFlight) inFlight.abort();
      const ac = new AbortController();
      inFlight = ac;
      const my = ++gen;
      const nodeRect = node!.rect!;
      timer = setTimeout(async () => {
        if (inFlight !== ac) return;
        try {
          const res = await fetch(`/api/manual/${sid}/inspect-sample`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rect: nodeRect, logicalW: lw, nodeType: node!.type ?? null }),
            signal: ac.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as InspectSampleData;
          if (my !== gen) return; // superseded while in flight
          sample.value = data;
          failed.value = false;
        } catch {
          if (my !== gen || ac.signal.aborted) return;
          sample.value = null;
          failed.value = true;
        } finally {
          if (my === gen) loading.value = false;
        }
      }, 250);
    },
    { immediate: true },
  );

  return { sample, loading, failed };
}
