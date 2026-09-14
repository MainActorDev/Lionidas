/** Viewtree parser (viewtree probe P1): recursiveDescription text → flat
 *  VNode tree. Pure — no DOM, no device.
 *
 *  Input format (lldb `expr -O -- (NSString *)[keyWindow recursiveDescription]`):
 *    <UIWindow: 0x…; frame = (0 0; 402 874); …>
 *       | <UITransitionView: 0x…; frame = (0 0; 402 874); …>
 *       |    | <LionParcelLogistics.CustomLabel: 0x…; baseClass = UILabel; frame = (0 36; 74 12); text = 'Cek Ongkir'; …>
 *
 *  Depth = indentation: each level is "   |" (3 spaces + pipe). The root
 *  line has no leading pipe. Honesty rules (same contract as the AX tree):
 *  a line that doesn't parse THROWS — never silently dropped; missing
 *  optional attrs stay undefined. Unknown extra attributes are ignored. */
import type { AxNode } from './ax-tree.js';

export type VNode = AxNode & {
  /** Real UIKit class, e.g. 'UIButton' or 'LionParcelLogistics.BaseStackView'. */
  viewClass: string;
  /** UIKit base class when the class is app-specific, e.g. 'UILabel'. */
  baseClass?: string;
  /** View address (0x…) — identity within one dump only. */
  address?: string;
  hidden?: boolean;
  alpha0?: boolean;
  clipped?: boolean;
};

/** Leading indentation of a view line: pipes (any count), each followed by
 *  spaces. Depth = number of pipes in THIS prefix (never attrs text). */
const PREFIX = /^(\s*(?:\|+\s*)*)/;
/** View line: `<Class: 0xaddr; attrs>` — attrs end at the FIRST `>`;
 *  recursiveDescription sometimes appends trailing tokens after it
 *  (UIStackView: `…> axis=horiz distribution=fillEqually`). */
const VIEW_LINE = /^\s*(?:\|+\s*)*<([^:<]+):\s*(0x[0-9a-f]+);\s*([^>]*)>/;
/** lldb banner/assembly noise + layer-only echo lines (`<CALayer: 0x…>
 *  (layer)` — the parent view's layer re-mentioned, carries no frame). */
const NOISE = /^\s*(?:\(lldb\)|Process |Executable |Architecture |Target |note:|stop reason|->|0x[0-9a-f]+ |frame #|\* thread|libsystem|\d+\s+0x)|\(layer\)\s*$/;

/** Parse one recursiveDescription dump. Throws on a line that looks like a
 *  view but fails to parse (class missing, frame malformed) — garbage-in
 *  must be loud, not partial. */
export function parseRecursiveDescription(text: string): VNode[] {
  const out: VNode[] = [];
  // stack of parent indices per depth
  const parents: number[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = VIEW_LINE.exec(line);
    if (!m) {
      // Non-view noise (lldb banner, assembly, logs) is skipped; anything
      // pipe-indented that ISN'T recognizable noise and isn't a view is an
      // error — a truncated dump must not parse as a small tree.
      if (/^\s+\|/.test(line) && out.length > 0 && !NOISE.test(line)) {
        throw new Error(`viewtree: unparseable view line: ${line.slice(0, 120)}`);
      }
      continue;
    }
    const viewClass = (m[1] ?? '').trim();
    const address = m[2] ?? '';
    const attrs = m[3] ?? '';
    // depth = pipes in the leading indentation prefix (never attrs text)
    const depth = ((PREFIX.exec(line)?.[1] ?? '').match(/\|/g) ?? []).length;
    if (depth > parents.length) throw new Error(`viewtree: depth jump without parent: ${line.slice(0, 120)}`);
    const frameM = /frame = \((-?[\d.]+) (-?[\d.]+); (-?[\d.]+) (-?[\d.]+)\)/.exec(attrs);
    if (!frameM) throw new Error(`viewtree: view without frame: ${viewClass}`);
    const idx = out.length;
    const node: VNode = {
      index: idx,
      viewClass,
      address,
      type: 'Other',
      hittable: !/userInteractionEnabled = NO/.test(attrs),
      rect: {
        x: Number(frameM[1]), y: Number(frameM[2]),
        width: Number(frameM[3]), height: Number(frameM[4]),
      },
    };
    const baseM = /baseClass = ([^;]+)/.exec(attrs);
    if (baseM?.[1]) node.baseClass = baseM[1].trim();
    const textM = /text = '([^']*)'/.exec(attrs);
    if (textM && textM[1]) node.label = textM[1];
    if (/hidden = YES/.test(attrs)) node.hidden = true;
    if (/alpha = 0([.;])/.test(attrs)) node.alpha0 = true;
    if (/clipsToBounds = YES/.test(attrs)) node.clipped = true;
    // class → AX-ish type for consumers that want a familiar vocabulary
    node.type = viewClassToType(node.baseClass ?? viewClass);
    if (depth > 0) node.parentIndex = parents[depth - 1]!;
    out.push(node);
    parents.splice(depth);      // this node is the last parent at its depth
    parents[depth] = idx;       // …and the parent for depth+1
  }
  return out;
}

const CLASS_TYPE: Readonly<Record<string, string>> = {
  UIWindow: 'Window', UIView: 'Other', UITransitionView: 'Other',
  UIDropShadowView: 'Other', UIViewControllerWrapperView: 'Other',
  UILayoutContainerView: 'Other', UINavigationTransitionView: 'Other',
  UIButton: 'Button', UIButtonLabel: 'StaticText', UILabel: 'StaticText',
  CustomLabel: 'StaticText', UITextField: 'TextField', UITextView: 'TextField',
  UIImageView: 'Image', UITableView: 'Table', UITableViewCell: 'Cell',
  UITableViewCellContentView: 'Cell', UICollectionView: 'CollectionView',
  UICollectionViewCell: 'Cell', UIScrollView: 'ScrollView',
  UITabBar: 'TabBar', UITabBarButton: 'Button', UITabBarButtonLabel: 'StaticText',
  UINavigationBar: 'Other', UIStackView: 'Other', UISwitch: 'Other',
  UIActivityIndicatorView: 'Other', _UILabelLayer: 'Other',
};

/** baseClass wins when present (app classes map through their base). */
function viewClassToType(cls: string): string {
  const short = cls.split('.').pop() ?? cls;
  return CLASS_TYPE[short] ?? CLASS_TYPE[cls] ?? 'Other';
}
