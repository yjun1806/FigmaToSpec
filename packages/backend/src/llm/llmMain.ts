import { PluginSettings } from "types";
import { rgbToCssColor } from "../common/color";
import { getVisibleNodes } from "../common/nodeVisibility";
import { renderAndAttachSVG } from "../altNodes/altNodeUtils";
import {
  commonLineHeight,
  commonLetterSpacing,
} from "../common/commonTextHeightSpacing";
import { commonStroke } from "../common/commonStroke";
import { htmlGradientFromFills } from "../html/builderImpl/htmlColor";

// Figma image scale modes → the object-fit vocabulary an LLM already maps to CSS.
const IMAGE_FIT: Record<string, string> = {
  FILL: "cover",
  FIT: "contain",
  CROP: "cover",
  TILE: "tile",
};

// Per-run state threaded through the tree walk to deduplicate repeated content.
type Ctx = {
  styleAliases: Map<string, string>; // font spec -> alias (T1, T2, ...)
  stringAliases: Map<string, string>; // repeated long text -> alias (S1, S2, ...)
  componentRefs: Map<string, string>; // componentId -> ref tag (C1, C2, ...) for repeats only
  dupRefs: Map<string, string>; // identical-element key -> ref tag (D1, D2, ...) for repeats only
  seenComponents: Map<string, { texts: string[] }>; // componentId -> first use's text content
  seenDups: Set<string>; // identical-element keys already emitted in full
};

// Repeated text strings at least this long are worth replacing with an S-alias.
const MIN_ALIAS_LEN = 12;

// Rounds to 2 decimals so the spec stays readable while preserving sub-pixel intent.
const round = (n: number): number => Math.round(n * 100) / 100;

// Map Figma auto-layout alignment to Flexbox vocabulary an LLM already understands.
const alignMap: Record<string, string> = {
  MIN: "start",
  CENTER: "center",
  MAX: "end",
  SPACE_BETWEEN: "space-between",
  BASELINE: "baseline",
};

// Figma constraints → how an absolutely-positioned element reacts when its parent resizes.
const constraintMap: Record<string, string> = {
  MIN: "start", // pinned to left/top
  MAX: "end", // pinned to right/bottom
  CENTER: "center",
  STRETCH: "stretch", // both edges pinned → size flexes with parent
  SCALE: "scale", // scales proportionally
};

const paintToString = (paint: any): string | null => {
  if (!paint || paint.visible === false) return null;
  switch (paint.type) {
    case "SOLID": {
      const color = rgbToCssColor(paint.color, paint.opacity ?? 1);
      // Bound to a design token (Figma variable): surface the token, keep hex as fallback.
      return paint.variableColorName
        ? `var(--${paint.variableColorName}, ${color})`
        : color;
    }
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      // Emit the real CSS gradient (actual stops + angle) so it is reproducible, not just named.
      // Falls back to the type word if the handle positions needed for the math are missing.
      return (
        (paint.gradientHandlePositions ? htmlGradientFromFills(paint) : "") ||
        `${paint.type.replace("GRADIENT_", "").toLowerCase()}-gradient`
      );
    case "IMAGE": {
      // The raster BYTES are excluded on purpose — a base64 fill costs thousands of tokens. Keep
      // the cheap REFERENCE instead (object-fit intent + a short asset id), so the slot is sized
      // and filled correctly and the real asset can be fetched out-of-band.
      const fit = IMAGE_FIT[paint.scaleMode] ?? "cover";
      const ref = paint.imageHash
        ? ` asset:#${String(paint.imageHash).slice(0, 8)}`
        : "";
      return `image fit:${fit}${ref}`;
    }
    default:
      return null;
  }
};

const paintsToString = (paints: any): string | null => {
  if (!Array.isArray(paints)) return null;
  const parts = paints.map(paintToString).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

const sanitizeToken = (token: string): string =>
  token.replace(/[^a-zA-Z0-9_-]/g, "-");

// Wraps a color in its design token (from a Paint Style or variable) so the token, not the
// raw hex, is the source of truth. Skips wrapping when the color is already a var() (variable
// binding handled in paintToString) or when there is no token.
const applyToken = (
  colorStr: string | null,
  token: string | undefined,
): string | null => {
  if (!colorStr) return null;
  if (!token || colorStr.startsWith("var(")) return colorStr;
  return `var(--${sanitizeToken(token)}, ${colorStr})`;
};

const paddingToString = (node: any): string | null => {
  const t = round(node.paddingTop ?? 0);
  const r = round(node.paddingRight ?? 0);
  const b = round(node.paddingBottom ?? 0);
  const l = round(node.paddingLeft ?? 0);
  if (!t && !r && !b && !l) return null;
  if (t === r && r === b && b === l) return `${t}`;
  if (t === b && l === r) return `${t} ${l}`;
  return `${t} ${r} ${b} ${l}`;
};

const layoutToString = (node: any): string | null => {
  if (!node.layoutMode || node.layoutMode === "NONE") return null;
  const dir = node.layoutMode === "HORIZONTAL" ? "row" : "column";
  const parts = [`flex ${dir}`];
  if (node.itemSpacing) parts.push(`gap ${round(node.itemSpacing)}`);
  const pad = paddingToString(node);
  if (pad) parts.push(`padding ${pad}`);
  const main = alignMap[node.primaryAxisAlignItems];
  if (main && main !== "start") parts.push(`justify ${main}`);
  const cross = alignMap[node.counterAxisAlignItems];
  if (cross && cross !== "start") parts.push(`align ${cross}`);
  if (node.layoutWrap === "WRAP") {
    parts.push("wrap");
    // Wrapped layouts have a separate gap between rows; `gap` above is only the in-row spacing.
    if (node.counterAxisSpacing)
      parts.push(`row-gap ${round(node.counterAxisSpacing)}`);
  }
  return parts.join(", ");
};

const radiusToString = (node: any): string | null => {
  if (typeof node.cornerRadius === "number") {
    return node.cornerRadius > 0 ? `${round(node.cornerRadius)}` : null;
  }
  const corners = [
    node.topLeftRadius,
    node.topRightRadius,
    node.bottomRightRadius,
    node.bottomLeftRadius,
  ];
  if (corners.some((c) => typeof c === "number" && c > 0)) {
    return corners.map((c) => round(c ?? 0)).join(" ");
  }
  return null;
};

const strokeToString = (node: any): string | null => {
  const color = applyToken(paintsToString(node.strokes), node.borderColorTokenName);
  if (!color) return null;
  // Per-side weights (dividers, table cells) are common — keep each edge. commonStroke returns
  // {all} when uniform or {top,right,bottom,left} when they differ; emit T/R/B/L in CSS order.
  const side = commonStroke(node);
  const weight =
    side && "left" in side
      ? `${round(side.top)}/${round(side.right)}/${round(side.bottom)}/${round(side.left)}px`
      : `${round(side && "all" in side ? side.all : 1)}px`;
  const parts = [weight, color];
  // strokeAlign changes the rendered box size (OUTSIDE/CENTER grow past the bounds); INSIDE is
  // the default and maps to a plain CSS border, so only flag the others.
  if (node.strokeAlign && node.strokeAlign !== "INSIDE")
    parts.push(node.strokeAlign.toLowerCase());
  if (Array.isArray(node.dashPattern) && node.dashPattern.length)
    parts.push("dashed");
  return parts.join(" ");
};

const effectsToString = (effects: any): string | null => {
  if (!Array.isArray(effects)) return null;
  const parts = effects
    .filter((e) => e.visible !== false)
    .map((e) => {
      switch (e.type) {
        case "DROP_SHADOW":
        case "INNER_SHADOW": {
          if ((e.color?.a ?? 1) === 0) return null; // fully transparent shadow → noise
          const inset = e.type === "INNER_SHADOW" ? "inset " : "";
          const color = rgbToCssColor(e.color, e.color?.a ?? 1);
          return `${inset}${round(e.offset?.x ?? 0)} ${round(
            e.offset?.y ?? 0,
          )} ${round(e.radius ?? 0)} ${round(e.spread ?? 0)} ${color}`;
        }
        case "LAYER_BLUR":
          return `blur(${round(e.radius ?? 0)})`;
        case "BACKGROUND_BLUR":
          return `backdrop-blur(${round(e.radius ?? 0)})`;
        default:
          return null;
      }
    })
    .filter(Boolean);
  return parts.length ? parts.join("; ") : null;
};

const fontOfSegment = (seg: any): string => {
  const font = [seg.fontName?.family, seg.fontName?.style, `${round(seg.fontSize)}px`]
    .filter(Boolean)
    .join(" ");
  // Lead with the design-system text style token (e.g. "caption 1/medium") when the segment is
  // bound to one — it's the canonical reference; the resolved font/color follow as a fallback.
  const parts = seg.textStyleName
    ? [`text-style "${seg.textStyleName}"`, font]
    : [font];
  const color = applyToken(paintsToString(seg.fills), seg.colorTokenName);
  if (color) parts.push(`color ${color}`);
  if (seg.lineHeight) {
    const lh = commonLineHeight(seg.lineHeight, seg.fontSize);
    if (lh) parts.push(`lh ${round(lh)}`);
  }
  if (seg.letterSpacing) {
    const ls = commonLetterSpacing(seg.letterSpacing, seg.fontSize);
    if (ls) parts.push(`ls ${round(ls)}`);
  }
  if (seg.textCase && seg.textCase !== "ORIGINAL")
    parts.push(`case ${seg.textCase.toLowerCase()}`);
  if (seg.textDecoration && seg.textDecoration !== "NONE")
    parts.push(seg.textDecoration.toLowerCase());
  return parts.join(", ");
};

// Builds the inline summary that follows a node's header line.
const nodeProps = (node: any, parentAutoLayout: boolean): string[] => {
  // Emit px only on axes whose size is FIXED. HUG (size derived from children + padding) and
  // FILL (size set by the parent) are computed downstream, so pinning a px there over-constrains
  // the layout and just duplicates what the structure already implies. Axes outside auto-layout
  // have no sizing mode (undefined) → treat as fixed, since the px is then the only signal.
  const hHug = node.layoutSizingHorizontal === "HUG" || node.layoutSizingHorizontal === "FILL";
  const vHug = node.layoutSizingVertical === "HUG" || node.layoutSizingVertical === "FILL";
  const props: string[] = [];
  if (!hHug && !vHug) props.push(`${round(node.width)}×${round(node.height)}`);
  else if (!hHug) props.push(`w ${round(node.width)}`);
  else if (!vHug) props.push(`h ${round(node.height)}`);

  // A node is positioned (not flowed) when its parent has no auto-layout OR when it opts out of
  // the parent's auto-layout via layoutPositioning=ABSOLUTE (pinned badges/overlays). Flag the
  // explicit opt-out so the LLM uses absolute positioning instead of a flow child.
  const isAbsoluteChild = node.layoutPositioning === "ABSOLUTE";
  const positioned = !parentAutoLayout || isAbsoluteChild;
  if (isAbsoluteChild && parentAutoLayout) props.push("absolute");

  // Coordinates only matter for a positioned node (and not at 0,0).
  if (positioned && typeof node.x === "number" && (node.x !== 0 || node.y !== 0)) {
    props.push(`@(${round(node.x)},${round(node.y)})`);
  }

  const layout = layoutToString(node);
  if (layout) props.push(layout);

  // Responsive sizing: flag axes that stretch (fill). hug is the default and is now implied by
  // the omitted px size above; fixed axes carry their px, so no extra hint is needed.
  if (node.layoutSizingHorizontal === "FILL") props.push("w:fill");
  if (node.layoutSizingVertical === "FILL") props.push("h:fill");
  if (node.layoutGrow === 1) props.push("grow"); // flex-grow in parent's main axis

  // Constraints describe how a positioned child reacts when its parent resizes.
  if (positioned && node.constraints) {
    const h = constraintMap[node.constraints.horizontal];
    const v = constraintMap[node.constraints.vertical];
    if (h || v) props.push(`pin H:${h ?? "?"} V:${v ?? "?"}`);
  }

  // Min/max bounds → responsive clamps (min-width/max-width, etc.).
  const limits: string[] = [];
  if (typeof node.minWidth === "number") limits.push(`minW ${round(node.minWidth)}`);
  if (typeof node.maxWidth === "number") limits.push(`maxW ${round(node.maxWidth)}`);
  if (typeof node.minHeight === "number")
    limits.push(`minH ${round(node.minHeight)}`);
  if (typeof node.maxHeight === "number")
    limits.push(`maxH ${round(node.maxHeight)}`);
  if (limits.length) props.push(limits.join(" "));

  if (node.type !== "TEXT") {
    const fill = applyToken(paintsToString(node.fills), node.bgColorTokenName);
    if (fill) props.push(`fill ${fill}`);
  } else {
    // Text alignment — LEFT/TOP are the defaults (omitted), everything else changes the render.
    if (node.textAlignHorizontal && node.textAlignHorizontal !== "LEFT")
      props.push(`text-align ${node.textAlignHorizontal.toLowerCase()}`);
    if (node.textAlignVertical && node.textAlignVertical !== "TOP")
      props.push(`text-valign ${node.textAlignVertical.toLowerCase()}`);
  }

  // Overflow / masking: clip = the frame hides overflowing children; mask = this layer clips its
  // siblings to its shape (circular avatars, rounded image crops). Both are invisible in a flat
  // screenshot, so they must be stated here or they are lost.
  if (node.clipsContent === true) props.push("clip");
  if (node.isMask === true) props.push("mask");

  const stroke = strokeToString(node);
  if (stroke) props.push(`border ${stroke}`);

  const radius = radiusToString(node);
  if (radius) props.push(`radius ${radius}`);

  const effects = effectsToString(node.effects);
  if (effects) props.push(`effect ${effects}`);

  if (typeof node.opacity === "number" && node.opacity < 1)
    props.push(`opacity ${round(node.opacity)}`);
  if (typeof node.rotation === "number" && Math.round(node.rotation) !== 0)
    props.push(`rotation ${round(node.rotation)}deg`);

  // Lead with the semantic role (when known) so the LLM picks the right element/component first,
  // then reads the visual props. Purely name-derived, so it stays stable across the dedup passes.
  const role = semanticRole(node);
  return role ? [`role:${role}`, ...props] : props;
};

// Figma embeds raster fills as base64 inside <pattern>/<image> defs and repeats xmlns
// boilerplate on every SVG. For an LLM spec none of this helps reproduce the shape — the
// raster fill is already noted in the node's prop line ("…, image") — and it costs thousands
// of tokens. Drop the dead image markup and the xmlns attributes; keep the vector paths.
export const minifySvg = (svg: string): string => {
  let out = svg;

  // 1. Remove <image> defs whose href is a base64 raster; remember their ids.
  const deadImageIds = new Set<string>();
  out = out.replace(/<image\b[^>]*>/g, (tag) => {
    if (
      /(?:xlink:)?href\s*=\s*["']data:image\/[a-zA-Z0-9.+-]+;base64,/.test(tag)
    ) {
      const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1];
      if (id) deadImageIds.add(id);
      return "";
    }
    return tag;
  });

  // 2. Remove <pattern> blocks whose <use> points at a dead image; remember their ids.
  const deadPatternIds = new Set<string>();
  out = out.replace(/<pattern\b[^>]*>[\s\S]*?<\/pattern>/g, (block) => {
    const ref = block.match(
      /<use\b[^>]*?(?:xlink:)?href\s*=\s*["']#([^"']+)["']/,
    )?.[1];
    if (ref && deadImageIds.has(ref)) {
      const id = block.match(/\bid\s*=\s*["']([^"']+)["']/)?.[1];
      if (id) deadPatternIds.add(id);
      return "";
    }
    return block;
  });

  // 3. Remove shapes filled by a now-dead pattern (fill="url(#deadPattern)").
  if (deadPatternIds.size) {
    out = out.replace(
      /<(?:path|rect|circle|ellipse|polygon)\b[^>]*\/>/g,
      (tag) => {
        const fill = tag.match(/fill\s*=\s*["']url\(#([^)]+)\)["']/)?.[1];
        return fill && deadPatternIds.has(fill) ? "" : tag;
      },
    );
  }

  // 4. Drop now-empty <defs></defs> and the xmlns/xmlns:xlink boilerplate.
  out = out
    .replace(/<defs>\s*<\/defs>/g, "")
    .replace(/\s+xmlns(:xlink)?\s*=\s*["'][^"']*["']/g, "");

  // Collapse the blank lines left behind by the removals.
  return out.replace(/\n\s*\n+/g, "\n");
};

// Embeds the original SVG source as a fenced block under the node header.
const svgLines = (svg: string, indent: string): string[] => {
  const out = [`${indent}  \`\`\`svg`];
  minifySvg(svg)
    .trim()
    .split("\n")
    .forEach((line) => out.push(`${indent}  ${line}`));
  out.push(`${indent}  \`\`\``);
  return out;
};

const textContent = (node: any): string => {
  const segs = node.styledTextSegments;
  return (
    node.characters ??
    (Array.isArray(segs) ? segs.map((s: any) => s.characters).join("") : "")
  );
};

// A text label: an S-alias if the string is a known repeat, else the quoted string.
const labelText = (ctx: Ctx, s: string): string =>
  ctx.stringAliases.get(s) ?? JSON.stringify(s);

// Auto-generated / generic layer names carry no information beyond the node type — drop them.
export const AUTO_NAME =
  /^(frame|group|rectangle|rect|ellipse|vector|line|component|instance|polygon|star|boolean operation|union|subtract|intersect|exclude|mask|shape|content|row|column|container|wrapper|spacer|item)(\s*\d+)?$/i;

const labelOf = (node: any): string => {
  const n = (node.name ?? "").trim();
  return !n || AUTO_NAME.test(n) ? "" : ` ${JSON.stringify(n)}`;
};

// High-confidence layer name → semantic role. Conservative by design: a wrong role misleads the
// downstream LLM more than no role, so only unambiguous, well-known names qualify (a trailing
// boundary keeps "Buttonish" from matching "button"). Framework-agnostic — the LLM turns
// `role:button` into <button>, <Button>, <TouchableOpacity>, … for whatever stack it targets.
const B = "(?:[\\s/_-]|$)"; // word boundary that also accepts the /, _, - used in layer names
const ROLE_PATTERNS: [RegExp, string][] = [
  [new RegExp(`^(?:button|btn|cta)${B}`, "i"), "button"],
  [new RegExp(`^(?:link|hyperlink)${B}`, "i"), "link"],
  [new RegExp(`^(?:text\\s?field|text\\s?input|input|textbox|search\\s?(?:bar|field|input))${B}`, "i"), "input"],
  [new RegExp(`^(?:textarea|text\\s?area)${B}`, "i"), "textarea"],
  [new RegExp(`^(?:checkbox|check\\s?box)${B}`, "i"), "checkbox"],
  [new RegExp(`^radio(?:\\s?button)?${B}`, "i"), "radio"],
  [new RegExp(`^(?:toggle|switch)${B}`, "i"), "switch"],
  [new RegExp(`^(?:select|dropdown|combo\\s?box)${B}`, "i"), "select"],
  [new RegExp(`^(?:nav(?:bar|igation)?|tab\\s?bar|menu\\s?bar)${B}`, "i"), "nav"],
  [new RegExp(`^tab${B}`, "i"), "tab"],
  [new RegExp(`^(?:app\\s?bar|top\\s?bar|header|masthead)${B}`, "i"), "header"],
  [new RegExp(`^footer${B}`, "i"), "footer"],
  [new RegExp(`^(?:list\\s?item|menu\\s?item)${B}`, "i"), "listitem"],
  [new RegExp(`^(?:card|tile)${B}`, "i"), "card"],
  [new RegExp(`^(?:badge|chip|pill)${B}`, "i"), "badge"],
  [new RegExp(`^avatar${B}`, "i"), "avatar"],
  [new RegExp(`^(?:modal|dialog|popover|bottom\\s?sheet)${B}`, "i"), "dialog"],
];

const semanticRole = (node: any): string | null => {
  const name = (node.name ?? "").trim();
  if (!name) return null;
  for (const [re, role] of ROLE_PATTERNS) if (re.test(name)) return role;
  return null;
};

// A pure pass-through container (single child, no own styling) adds nesting noise but no
// information — unwrap it and describe its child directly.
const isUnwrappable = (node: any): boolean =>
  (node.type === "FRAME" || node.type === "GROUP") &&
  !node.canBeFlattened &&
  Array.isArray(node.children) &&
  getVisibleNodes(node.children).length === 1 &&
  !paintsToString(node.fills) &&
  !(Array.isArray(node.strokes) && node.strokes.length > 0) &&
  !effectsToString(node.effects) &&
  !radiusToString(node) &&
  !paddingToString(node);

const unwrap = (node: any): any => {
  let cur = node;
  while (isUnwrappable(cur)) cur = getVisibleNodes(cur.children)[0];
  return cur;
};

// All text strings under a node, in order — used to compare repeated component instances.
const collectTexts = (node: any): string[] => {
  const out: string[] = [];
  if (node.type === "TEXT") out.push(textContent(node));
  if (Array.isArray(node.children))
    getVisibleNodes(node.children).forEach((c) => out.push(...collectTexts(c)));
  return out;
};

// Identity keys for the "repeated identical element" dedup (D refs).
const svgKey = (svg: string): string => `svg:${minifySvg(svg)}`;
const leafKey = (node: any, props: string[]): string =>
  `leaf:${node.type}|${labelOf(node)}|${props.join("|")}`;

// True for childless, non-text, non-component nodes (rectangles, dividers, spacers, etc.)
// whose entire description is a single line — the cheap case for identical-element dedup.
const isDedupableLeaf = (node: any, children: any[]): boolean =>
  children.length === 0 && node.type !== "TEXT" && node.type !== "INSTANCE";

// Turns a frequency map into aliases (prefix + index) for entries seen 2+ times.
const finalizeRefs = (freq: Map<string, number>, prefix: string): Map<string, string> => {
  const refs = new Map<string, string>();
  let i = 0;
  for (const [k, count] of freq) {
    if (count >= 2) {
      i += 1;
      refs.set(k, `${prefix}${i}`);
    }
  }
  return refs;
};

// First pass: count how often each text font spec occurs so repeats become T-aliases.
const collectStyleAliases = (roots: any[]): Map<string, string> => {
  const freq = new Map<string, number>();
  const visit = (node: any) => {
    if (node.canBeFlattened) return;
    const segs = node.styledTextSegments;
    if (node.type === "TEXT" && Array.isArray(segs) && segs.length === 1) {
      const spec = fontOfSegment(segs[0]);
      freq.set(spec, (freq.get(spec) ?? 0) + 1);
    }
    if (Array.isArray(node.children)) getVisibleNodes(node.children).forEach(visit);
  };
  roots.forEach((r) => visit(unwrap(r)));
  return finalizeRefs(freq, "T");
};

// First pass: count repeated long text strings (in TEXT nodes and component text overrides).
const collectStringAliases = (roots: any[]): Map<string, string> => {
  const freq = new Map<string, number>();
  const seenComp = new Map<string, string[]>();
  const bump = (s: string) => {
    if (s && s.length >= MIN_ALIAS_LEN) freq.set(s, (freq.get(s) ?? 0) + 1);
  };
  const visit = (raw: any) => {
    const node = unwrap(raw);
    if (node.canBeFlattened) return;
    if (node.type === "INSTANCE" && node.componentId) {
      const first = seenComp.get(node.componentId);
      if (first) {
        const texts = collectTexts(node);
        if (texts.join(" ") !== first.join(" ")) texts.forEach(bump);
        return;
      }
      seenComp.set(node.componentId, collectTexts(node));
    }
    if (node.type === "TEXT") {
      bump(textContent(node));
      return;
    }
    getVisibleNodes(node.children ?? []).forEach(visit);
  };
  roots.forEach(visit);
  return finalizeRefs(freq, "S");
};

// First pass: count component instances so repeated ones get a short reference tag (C1, C2…).
const collectComponentRefs = (roots: any[]): Map<string, string> => {
  const freq = new Map<string, number>();
  const visit = (node: any) => {
    if (node.type === "INSTANCE" && node.componentId)
      freq.set(node.componentId, (freq.get(node.componentId) ?? 0) + 1);
    if (Array.isArray(node.children)) getVisibleNodes(node.children).forEach(visit);
  };
  roots.forEach((r) => visit(unwrap(r)));
  return finalizeRefs(freq, "C");
};

// First pass: count identical elements (SVGs and single-line leaf nodes) so repeats get D refs.
const collectDupRefs = async (roots: any[]): Promise<Map<string, string>> => {
  const freq = new Map<string, number>();
  const seenComp = new Set<string>();
  const bump = (k: string) => freq.set(k, (freq.get(k) ?? 0) + 1);

  const visit = async (raw: any, parentAutoLayout: boolean) => {
    const node = unwrap(raw);
    if (node.canBeFlattened) {
      await renderAndAttachSVG(node);
      if (node.svg) bump(svgKey(node.svg));
      return;
    }
    if (node.type === "INSTANCE" && node.componentId) {
      if (seenComp.has(node.componentId)) return; // later copies collapse to "same as C"
      seenComp.add(node.componentId);
    }
    const children = getVisibleNodes(node.children ?? []);
    if (isDedupableLeaf(node, children)) {
      bump(leafKey(node, nodeProps(node, parentAutoLayout)));
      return;
    }
    const isAuto = node.layoutMode && node.layoutMode !== "NONE";
    for (const c of children) await visit(c, isAuto);
  };

  for (const r of roots) await visit(r, false);
  return finalizeRefs(freq, "D");
};

// Component variant/boolean selections carry the design intent — Theme=Line, Size=small… — and
// appear nowhere else in the spec, so the LLM can't otherwise know which variant to build.
// TEXT props are skipped (the value already shows as a TEXT node in the tree) and INSTANCE_SWAP
// values are node ids (meaningless here). Extract the rest as a compact `props:` segment.
const componentPropsLabel = (node: any): string => {
  const cp = node.componentProperties;
  if (!cp || typeof cp !== "object") return "";
  const parts: string[] = [];
  for (const [rawName, prop] of Object.entries(cp) as [string, any][]) {
    if (!prop || (prop.type !== "VARIANT" && prop.type !== "BOOLEAN")) continue;
    if (prop.value === undefined || prop.value === null) continue;
    parts.push(`${rawName.split("#")[0]}=${prop.value}`); // drop Figma's "#id" name suffix
  }
  return parts.length ? `props: ${parts.join(", ")}` : "";
};

// Joins a node header with its prop list, dropping the " — " separator when there are no props
// (a node can now be prop-less once auto-sized dimensions are omitted).
const headLine = (head: string, props: string[]): string =>
  props.length ? `${head} — ${props.join(" | ")}` : head;

const describeNode = async (
  node: any,
  depth: number,
  parentAutoLayout: boolean,
  ctx: Ctx,
): Promise<string[]> => {
  node = unwrap(node); // collapse pure pass-through wrappers
  const indent = "  ".repeat(depth);
  const props = nodeProps(node, parentAutoLayout);

  // Surface component properties on the instance's first occurrence (later copies say
  // "same as Cn" and share the same variant, so repeating them would only waste tokens).
  if (node.type === "INSTANCE") {
    const cp = componentPropsLabel(node);
    if (cp) props.push(cp);
  }

  // Icons/vectors flatten to a single SVG — dedup identical sources via D refs.
  if (node.canBeFlattened) {
    await renderAndAttachSVG(node);
    const svg = node.svg as string | undefined;
    const key = svg ? svgKey(svg) : "";
    const ref = key ? ctx.dupRefs.get(key) : undefined;
    if (ref && ctx.seenDups.has(key)) {
      return [`${indent}- SVG${labelOf(node)} — ${props.join(" | ")} | same as ${ref}`];
    }
    if (ref) ctx.seenDups.add(key);
    const lines = [
      headLine(`${indent}- SVG${labelOf(node)}${ref ? ` (${ref})` : ""}`, props),
    ];
    if (svg) lines.push(...svgLines(svg, indent));
    return lines;
  }

  // Repeated component instance: describe the first one fully, later ones by reference.
  if (node.type === "INSTANCE" && node.componentId) {
    const seen = ctx.seenComponents.get(node.componentId);
    if (seen) {
      const ref = ctx.componentRefs.get(node.componentId);
      const texts = collectTexts(node);
      const differs = texts.join(" ") !== seen.texts.join(" ");
      const overrides =
        differs && texts.length
          ? `; texts: ${texts.map((t) => labelText(ctx, t)).join(", ")}`
          : "";
      return [`${indent}- INSTANCE${labelOf(node)} — same as ${ref}${overrides}`];
    }
    ctx.seenComponents.set(node.componentId, { texts: collectTexts(node) });
  }

  // TEXT: use the content (or its S-alias) as the label, font (or its T-alias) inline.
  if (node.type === "TEXT") {
    const segments = node.styledTextSegments;
    const singleSeg =
      Array.isArray(segments) && segments.length === 1 ? segments[0] : null;
    if (singleSeg) {
      const spec = fontOfSegment(singleSeg);
      props.push(ctx.styleAliases.get(spec) ?? spec);
    }
    const multi = Array.isArray(segments) && segments.length > 1;
    const content = textContent(node);
    // Single-style text can collapse to an S-alias; multi-style keeps its runs (to preserve
    // per-run color/font) on first use, and only later copies reference it via text overrides.
    const alias = multi ? undefined : ctx.stringAliases.get(content);
    if (alias) return [`${indent}- TEXT ${alias} — ${props.join(" | ")}`];
    const lines = [
      `${indent}- TEXT ${JSON.stringify(content)} — ${props.join(" | ")}`,
    ];
    // Multiple styles in one text node: list each run with its own font.
    if (multi) {
      segments.forEach((seg: any) =>
        lines.push(`${indent}  - ${JSON.stringify(seg.characters)} — ${fontOfSegment(seg)}`),
      );
    }
    return lines;
  }

  const children = getVisibleNodes(node.children ?? []);

  // Childless shapes/dividers/spacers: dedup identical repeats via D refs.
  if (isDedupableLeaf(node, children)) {
    const key = leafKey(node, props);
    const ref = ctx.dupRefs.get(key);
    if (ref && ctx.seenDups.has(key)) {
      return [`${indent}- ${node.type}${labelOf(node)} — ${props.join(" | ")} | same as ${ref}`];
    }
    if (ref) ctx.seenDups.add(key);
    return [
      headLine(`${indent}- ${node.type}${labelOf(node)}${ref ? ` (${ref})` : ""}`, props),
    ];
  }

  // Tag the first occurrence of a repeated component so later copies can reference it.
  const refMarker =
    node.type === "INSTANCE" &&
    node.componentId &&
    ctx.componentRefs.has(node.componentId)
      ? ` (${ctx.componentRefs.get(node.componentId)})`
      : "";
  const lines = [
    headLine(`${indent}- ${node.type}${labelOf(node)}${refMarker}`, props),
  ];

  const isAutoLayout = node.layoutMode && node.layoutMode !== "NONE";
  for (const child of children) {
    lines.push(...(await describeNode(child, depth + 1, isAutoLayout, ctx)));
  }

  return lines;
};

// The build guide is identical for every export — same goals, rules, and full notation catalog.
// Keeping it static (not filtered per component) is the point: it becomes a stable, cacheable
// prefix an agent can send once / rely on prompt caching for, then stream many per-component
// bodies after it. The per-export specifics (canvas, root id, styles, strings, tree) live in
// buildSpecBody. Bump SPEC_VERSION whenever the notation or rules change so a body can be matched
// to the guide it expects.
export const SPEC_VERSION = "v1";

export const buildSpecGuide = (): string =>
  [
    `# Figma → Code Spec (${SPEC_VERSION})`,
    "",
    "How to use: register this guide ONCE in your project's agent memory (AGENTS.md / CLAUDE.md /",
    "memory) so it is loaded before any Figma → code work. It is identical for every component, so",
    "it only needs to be set up once; each `## Component` block you receive afterwards references it",
    "by version. (Already registered? Skip this.)",
    "",
    "---",
    "",
    "Each `## Component` is a complete, framework-agnostic spec of one screen. Implement it in",
    "whatever stack the user names (React, Vue, Svelte, plain HTML+CSS, SwiftUI, …). Two goals, both",
    "required: the running UI matches the screen exactly, AND the code is production-quality and",
    "reusable — not a flat dump of divs.",
    "",
    "Build rules:",
    "- Fidelity: match colors, fonts, spacing, sizes, and radii exactly. Sizes are px at the design",
    "  viewport; a node with no listed size hugs its contents (derived from children + padding).",
    "- Semantics: when a node lists `role:x`, build the real element for it (role:button → a button,",
    "  role:input → an input, role:nav → nav, role:listitem → a list item, …) with sensible a11y.",
    "- Reusability: a `(C1)` tag marks a repeated component — define it ONCE as a reusable component",
    "  and invoke it per copy; later copies read `same as C1` with their text/prop overrides. A",
    "  `props:` line lists that component's Figma props (variant/boolean) — model them as real",
    "  component props/states (e.g. State=hover → a hover state, Disabled=true → a disabled state).",
    "- Design tokens: `var(--token, #hex)` and `text-style \"name\"` reference design-system tokens —",
    "  map each to the equivalent token in the target codebase; the hex/utilities are only fallbacks.",
    "- Nesting is shown by indentation. A line absent below means its default applies.",
    "",
    "Notation:",
    "- `role:x` = the node's semantic role (button/input/nav/listitem/…) — build the real element.",
    "- `flex row/col` + gap/padding/justify/align — auto-layout in Flexbox terms; `row-gap` = wrap gap.",
    "- `w:fill`/`h:fill` = stretch to parent; `grow` = flex:1; `pin` = pinned edges.",
    "- `absolute` = positioned out of the parent's auto-layout flow; use absolute positioning at `@(x,y)`.",
    "- `image fit:x` = an image fill (object-fit x); fetch the real asset by its `asset:#id` — it is not inlined.",
    "- `clip` = hide overflowing children (overflow:hidden); `mask` = clip siblings to this shape.",
    "- `border t/r/b/l px` = per-side widths (CSS top/right/bottom/left order); `outside`/`center` = strokeAlign.",
    "- `text-align`/`text-valign` = text alignment (LEFT/TOP are the omitted defaults).",
    "- `var(--token, #hex)` = use the design token; the hex is only a fallback.",
    '- `text-style "name"` = a design-system typography token; the font/color that follow are its resolved fallback.',
    "- `Tn` = a shared text style (font/color/line-height) defined in ## Styles.",
    "- `Sn` = a repeated text string defined in ## Strings.",
    "- `(C1)` tags a repeated component; later copies say `same as C1` (+ text overrides if any).",
    "- `props:` on an INSTANCE lists its Figma component properties (variant/boolean) — build that variant.",
    "- `(D1)` tags a repeated identical element (icon/SVG/shape); later copies say `same as D1`.",
    "- `SVG` blocks hold the original SVG — reuse verbatim.",
    "- For original visuals, call Figma MCP `get_screenshot` on the root id in ## Canvas.",
    "",
    "When done, render your result and compare it against that screenshot; fix any mismatch in",
    "layout, color, type, or spacing until they line up.",
  ].join("\n");

// Assembles the per-component payload: canvas dimensions + root id, the Styles/Strings glossaries
// this component actually uses, and the node tree. This half is meaningless on its own — pair it
// with buildSpecGuide() (combined for you by llmMain).
const buildSpecBody = async (ctx: Ctx, roots: any[]): Promise<string> => {
  const width = Math.max(...roots.map((n) => round(n.width)));
  const height = roots.reduce((sum, n) => sum + round(n.height), 0);

  const treeLines: string[] = [];
  for (const node of roots) {
    treeLines.push(...(await describeNode(node, 0, false, ctx)));
  }

  const styleLines = [...ctx.styleAliases.entries()].map(
    ([spec, alias]) => `- ${alias} = ${spec}`,
  );
  const stringLines = [...ctx.stringAliases.entries()].map(
    ([s, alias]) => `- ${alias} = ${JSON.stringify(s)}`,
  );

  return [
    `## Component`,
    `> Build this per the **Figma → Code Spec (${SPEC_VERSION})** registered in your AGENTS.md / CLAUDE.md / memory.`,
    `> If that guide is not in context, load it first — this block relies on its notation and build rules.`,
    ``,
    `## Canvas`,
    `- ${round(width)} × ${round(height)} px · root node \`${roots[0]?.id ?? ""}\` (spec ${SPEC_VERSION}, Figma MCP get_screenshot)`,
    ...(styleLines.length ? [``, `## Styles`, ...styleLines] : []),
    ...(stringLines.length ? [``, `## Strings`, ...stringLines] : []),
    ``,
    `## Tree`,
    ...treeLines,
  ].join("\n");
};

// Returns the two separable halves: a static, cacheable `guide` (send once / cache) and the
// per-component `body`. Use this when streaming many components past one shared guide; use
// llmMain when you want a single self-contained artifact.
export const llmSpecParts = async (
  sceneNode: Array<SceneNode>,
  _settings: PluginSettings,
): Promise<{ guide: string; body: string }> => {
  const roots = getVisibleNodes(sceneNode);
  if (roots.length === 0) return { guide: buildSpecGuide(), body: "" };

  const ctx: Ctx = {
    styleAliases: collectStyleAliases(roots),
    stringAliases: collectStringAliases(roots),
    componentRefs: collectComponentRefs(roots),
    dupRefs: await collectDupRefs(roots),
    seenComponents: new Map(),
    seenDups: new Set(),
  };

  return { guide: buildSpecGuide(), body: await buildSpecBody(ctx, roots) };
};

export const llmMain = async (
  sceneNode: Array<SceneNode>,
  settings: PluginSettings,
): Promise<string> => {
  const { guide, body } = await llmSpecParts(sceneNode, settings);
  return body ? `${guide}\n\n${body}` : "";
};
