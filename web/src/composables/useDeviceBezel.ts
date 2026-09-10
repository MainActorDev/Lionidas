/** Device bezel — engine-sourced chrome definition for the stream stage.
 *  Absent bezel (no chrome bundle / engine down) degrades to the bare
 *  canvas layout; never an error state. */
import { ref, type Ref } from 'vue';

export interface BezelDefinition {
  identifier: string;
  scale: number;
  bezel: { width: number; height: number; url: string };
  screen: { xPct: number; yPct: number; wPct: number; hPct: number };
  screenRadius: { pctW: number; pctH: number };
  buttons: Array<{
    name: string;
    anchor: string;
    onTop: boolean;
    boxPct: { left: number; top: number; width: number; height: number };
    normalOffset: { x: number; y: number };
    rolloverOffset: { x: number; y: number };
    imageUrl: string;
  }>;
}

export function useDeviceBezel(udid: Ref<string | undefined>): {
  def: Ref<BezelDefinition | null>;
  load: () => Promise<void>;
} {
  const def = ref<BezelDefinition | null>(null);
  const load = async (): Promise<void> => {
    def.value = null;
    const u = udid.value;
    if (!u) return;
    try {
      const r = await fetch(`/screenstream/devices/${u}/definition.json`);
      if (r.ok) def.value = await r.json() as BezelDefinition;
    } catch { /* engine absent — bare canvas */ }
  };
  return { def, load };
}
