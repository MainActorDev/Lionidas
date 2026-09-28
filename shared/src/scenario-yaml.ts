/** Scenario document grammar (plan 20260928T092527Z rev 2, Stage 2).
 *  The scenario document is the machine-readable rulebook surface: an agent
 *  (or operator) reads/writes exactly this. Same two-way contract as case
 *  yaml and screen yaml — parse/emit round-trip through this module only.
 *
 *  Review F9: the folder path is DERIVED at read (rendered by the UI from the
 *  list payload) — it is never stored and never round-trips. */

export interface ScenarioDocPreset {
  preset: string;
  enabled: boolean;
}

export interface ScenarioDoc {
  scenario: string;
  id: string;
  presets: ScenarioDocPreset[];
  launchArg: string | null;
}

export interface ScenarioParseOk {
  ok: true;
  doc: ScenarioDoc;
}
export interface ScenarioParseErr {
  ok: false;
  errors: Array<{ line: number; message: string }>;
}
export type ScenarioParseResult = ScenarioParseOk | ScenarioParseErr;

/** minimal YAML scalar quoting (mirrors case-yaml's yamlScalar) */
function yamlScalar(v: string): string {
  if (v === '') return "''";
  if (/[:#\-?[\]{}&*!|>'"%@`,]/.test(v) || /^\s|\s$/.test(v) || /^(true|false|null|~|\d+(\.\d+)?)$/i.test(v)) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
}

/** parse + validate a scenario document. Unknown keys are REJECTED (the
 *  grammar is explicit by design — typos must not silently drop facts). */
export function parseScenarioYaml(text: string): ScenarioParseResult {
  const errors: Array<{ line: number; message: string }> = [];
  const lines = text.split('\n');
  let scenario = '';
  let id = '';
  let launchArg: string | null = null;
  const presets: ScenarioDocPreset[] = [];
  let inPresets = false;
  let curPreset: ScenarioDocPreset | null = null;

  const unquote = (s: string): string => {
    const t = s.trim();
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
    return t;
  };
  const stripComment = (s: string): string => {
    // a # starts a comment unless quoted — the simple scan suffices for this grammar
    let inS = false; let inD = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i);
    }
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const raw = stripComment(lines[i]!).replace(/\r$/, '');
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t === '[]') {
      // empty presets list in flow form (after 'presets:')
      if (inPresets) continue;
      errors.push({ line: ln, message: 'unexpected line: []' });
      continue;
    }

    const kv = t.match(/^(?:-\s*)?([a-z_]+):\s*(.*)$/);
    if (!kv) {
      errors.push({ line: ln, message: `unexpected line: ${t.slice(0, 40)}` });
      continue;
    }
    const key = kv[1]!;
    const val = kv[2]!.trim();

    if (indent === 0) {
      inPresets = false;
      curPreset = null;
      if (key === 'scenario') {
        if (!val) errors.push({ line: ln, message: 'scenario: needs a name' });
        else scenario = unquote(val);
      } else if (key === 'id') {
        id = unquote(val);
      } else if (key === 'launch_arg') {
        launchArg = val ? unquote(val) : null;
        if (launchArg === '') launchArg = null;
      } else if (key === 'presets') {
        inPresets = true;
      } else if (key === 'folder') {
        errors.push({ line: ln, message: 'folder: is derived at read — remove it (moves happen via the folder UI)' });
      } else {
        errors.push({ line: ln, message: `unknown key: ${key}` });
      }
    } else if (inPresets) {
      if (key === 'preset') {
        if (!val) errors.push({ line: ln, message: 'preset: needs an id' });
        curPreset = { preset: unquote(val.replace(/^-\s*/, '')), enabled: true };
        presets.push(curPreset);
      } else if (key === 'enabled') {
        if (!curPreset) errors.push({ line: ln, message: 'enabled: belongs to a preset entry' });
        else curPreset.enabled = val !== 'false';
      } else {
        errors.push({ line: ln, message: `unknown key in preset entry: ${key} (only preset/enabled — method/path/status/body render read-only from the preset registry)` });
      }
    } else {
      errors.push({ line: ln, message: `unexpected indented key: ${key}` });
    }
  }

  if (!scenario) errors.push({ line: 1, message: 'scenario: name is required' });
  if (!id) errors.push({ line: 1, message: 'id: is required' });
  if (launchArg !== null && /\n/.test(launchArg)) errors.push({ line: 1, message: 'launch_arg must be a single line' });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { scenario, id, presets, launchArg } };
}

/** emit the canonical document form. Preset entries may carry read-only
 *  render hints (method/path/status) — they are DISPLAY-ONLY and never
 *  parsed back (the parser rejects them, keeping storage minimal). */
export function scenarioToYaml(doc: ScenarioDoc, hints?: Record<string, { method?: string; path?: string; status?: number }>): string {
  const lines: string[] = [];
  lines.push(`scenario: ${yamlScalar(doc.scenario)}`);
  lines.push(`id: ${yamlScalar(doc.id)} # stable pin — rename freely`);
  lines.push('presets:');
  if (doc.presets.length === 0) {
    lines.push('  []');
  } else {
    for (const p of doc.presets) {
      const h = hints?.[p.preset];
      lines.push(`  - preset: ${yamlScalar(p.preset)}`);
      if (h?.method || h?.path || h?.status) {
        lines.push(`    # ${h?.method ?? ''} ${h?.path ?? ''} → ${h?.status ?? ''}`.replace(/\s+/g, ' ').trimEnd());
      }
      lines.push(`    enabled: ${p.enabled ? 'true' : 'false'}`);
    }
  }
  lines.push(`launch_arg: ${doc.launchArg ? yamlScalar(doc.launchArg) : "''"}`);
  return lines.join('\n') + '\n';
}
