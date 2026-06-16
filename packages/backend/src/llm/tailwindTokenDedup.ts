// Compresses generated Tailwind JSX by leaning on design-token names. Anything bound to a Figma
// token is referenced by that token name directly (self-documenting, no lookup needed): colors
// become `kind-[token/name]`, text styles become a `sanitized-token-name` class. Only values with
// NO token — repeated raw colors and shadow stacks — get a freshly minted short alias (c#, e#)
// defined in the glossary. Layout utilities stay inline so the structure stays readable. The
// redundant data-token attributes are dropped. Non-runnable by design; optimized for an LLM.
import { stringToClassName } from "../common/numToAutoFixed";
import { AUTO_NAME } from "./llmMain";

type TokenEntry = { ref: string; value: string; name: string };

// A class value (after `text-`/`bg-`/`outline-`) that denotes a color.
const isColorValue = (rem: string): boolean =>
  /^\[(#|rgb|hsl|var)/i.test(rem) ||
  /^(white|black|transparent|current)(\/\d+)?$/.test(rem) ||
  /^[a-z]+-\d{1,3}(\/\d+)?$/.test(rem);

const COLOR_KINDS = ["text", "bg", "outline"] as const;
type ColorKind = (typeof COLOR_KINDS)[number];

const colorKindOf = (cls: string): ColorKind | null => {
  for (const k of COLOR_KINDS) {
    if (cls.startsWith(`${k}-`) && isColorValue(cls.slice(k.length + 1))) return k;
  }
  return null;
};

const isStyleUtil = (cls: string): boolean => {
  if (colorKindOf(cls)) return false;
  if (/^font-/.test(cls)) return true;
  if (/^leading-/.test(cls)) return true;
  if (/^tracking-/.test(cls)) return true;
  if (
    /^(italic|not-italic|underline|line-through|no-underline|overline|uppercase|lowercase|capitalize|normal-case)$/.test(
      cls,
    )
  )
    return true;
  if (/^text-/.test(cls)) return true;
  return false;
};

const isShadow = (cls: string): boolean =>
  cls === "shadow" || cls.startsWith("shadow-");

const attrForKind: Record<ColorKind, string> = {
  text: "data-text-color-token",
  bg: "data-bg-color-token",
  outline: "data-border-color-token",
};

const dataAttr = (attrs: string, name: string): string | undefined =>
  attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];

const classesOf = (attrs: string): string[] =>
  (attrs.match(/\b(?:class|className)="([^"]*)"/)?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);

const tokensForTag = (attrs: string): Record<ColorKind, string | undefined> => ({
  text: dataAttr(attrs, "data-text-color-token"),
  bg: dataAttr(attrs, "data-bg-color-token"),
  outline: dataAttr(attrs, "data-border-color-token"),
});

// Token name → className-safe form. Keep slashes for colors (hierarchy, used inside `[...]`);
// callers that need a bare class (text styles) pass keepSlash=false.
const safeName = (name: string, keepSlash: boolean): string =>
  name
    .trim()
    .replace(keepSlash ? /\s+/g : /[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const dedupeTokens = (
  jsx: string,
): { code: string; glossary: string } => {
  const colorTokens = new Map<string, TokenEntry>(); // token name -> inline ref + resolved value
  const textTokens = new Map<string, TokenEntry>(); // token name -> class ref + utilities
  const rawColors = new Map<string, string>(); // raw value -> c# (untokened, repeated only)
  const effects = new Map<string, string>(); // shadow stack -> e#
  let cN = 0;
  let eN = 0;

  // Pre-pass: count untokened raw colors and shadow stacks so only repeats get an alias.
  const rawColorCount = new Map<string, number>();
  const shadowCount = new Map<string, number>();
  jsx.replace(/<(?:div|span|sub|sup)\b([^>]*)>/g, (_full, attrs: string) => {
    const tk = tokensForTag(attrs);
    const classes = classesOf(attrs);
    for (const cls of classes) {
      const k = colorKindOf(cls);
      if (k && !tk[k]) {
        const v = cls.slice(k.length + 1);
        rawColorCount.set(v, (rawColorCount.get(v) ?? 0) + 1);
      }
    }
    const stack = classes.filter(isShadow).join(" ");
    if (stack) shadowCount.set(stack, (shadowCount.get(stack) ?? 0) + 1);
    return _full;
  });

  const code = jsx.replace(
    /<(div|span|sub|sup)\b([^>]*)>/g,
    (full, tag: string, attrs: string) => {
      const tokenForKind = tokensForTag(attrs);
      const textToken = dataAttr(attrs, "data-text-token");

      const clsMatch = attrs.match(/\b(class|className)="([^"]*)"/);
      if (!clsMatch) return full;
      const orig = clsMatch[2].split(/\s+/).filter(Boolean);
      const roles = orig.map((cls) => {
        if (isShadow(cls)) return { type: "shadow" as const };
        const k = colorKindOf(cls);
        if (k) return { type: "color" as const, kind: k };
        if (isStyleUtil(cls)) return { type: "style" as const };
        return { type: "other" as const };
      });

      const removeAttrs = new Set<string>();

      // Text style: a tokened run collapses to its token-name class; otherwise leave inline.
      const styleIdx = roles
        .map((r, i) => (r.type === "style" ? i : -1))
        .filter((i) => i >= 0);
      let textRef: string | null = null;
      if (textToken && styleIdx.length) {
        const utils = styleIdx.map((i) => orig[i]).join(" ");
        const existing = textTokens.get(textToken);
        textRef = existing?.ref ?? safeName(textToken, false);
        if (!existing)
          textTokens.set(textToken, { ref: textRef, value: utils, name: textToken });
        removeAttrs.add("data-text-token");
      }

      // Shadow stack: alias to e# when the exact stack repeats; otherwise leave inline.
      const shadowIdx = roles
        .map((r, i) => (r.type === "shadow" ? i : -1))
        .filter((i) => i >= 0);
      let shadowRef: string | null = null;
      if (shadowIdx.length) {
        const stack = shadowIdx.map((i) => orig[i]).join(" ");
        if ((shadowCount.get(stack) ?? 0) >= 2) {
          shadowRef = effects.get(stack) ?? `e${++eN}`;
          if (!effects.has(stack)) effects.set(stack, shadowRef);
        }
      }

      // Layer names: keep meaningful ones, drop generic/text-echo names + their className class.
      const layer = dataAttr(attrs, "data-layer");
      const isTextEl = styleIdx.length > 0 || textToken !== undefined;
      let noiseLayerClass: string | null = null;
      if (layer !== undefined && (isTextEl || AUTO_NAME.test(layer))) {
        removeAttrs.add("data-layer");
        noiseLayerClass = stringToClassName(layer);
      }

      const out: string[] = [];
      orig.forEach((cls, i) => {
        const role = roles[i];
        if (role.type === "color") {
          const name = tokenForKind[role.kind];
          const value = cls.slice(role.kind.length + 1);
          if (name) {
            // Tokened → reference by name directly.
            const ref = colorTokens.get(name)?.ref ?? `[${safeName(name, true)}]`;
            if (!colorTokens.has(name))
              colorTokens.set(name, { ref, value, name });
            removeAttrs.add(attrForKind[role.kind]);
            out.push(`${role.kind}-${ref}`);
          } else if ((rawColorCount.get(value) ?? 0) >= 2) {
            // Untokened but repeated → mint a short alias.
            let alias = rawColors.get(value);
            if (!alias) {
              alias = `c${++cN}`;
              rawColors.set(value, alias);
            }
            out.push(`${role.kind}-${alias}`);
          } else {
            out.push(cls); // untokened singleton → leave inline
          }
          return;
        }
        if (role.type === "style" && textRef) {
          if (i === styleIdx[0]) out.push(textRef);
          return;
        }
        if (role.type === "shadow" && shadowRef) {
          if (i === shadowIdx[0]) out.push(shadowRef);
          return;
        }
        if (noiseLayerClass && cls === noiseLayerClass) return;
        out.push(cls);
      });

      let newAttrs = attrs.replace(
        /\b(class|className)="[^"]*"/,
        `${clsMatch[1]}="${out.join(" ")}"`,
      );
      for (const a of removeAttrs) {
        newAttrs = newAttrs.replace(new RegExp(`\\s*${a}="[^"]*"`), "");
      }
      return `<${tag}${newAttrs}>`;
    },
  );

  return { code, glossary: buildGlossary(colorTokens, textTokens, rawColors, effects) };
};

const buildGlossary = (
  colorTokens: Map<string, TokenEntry>,
  textTokens: Map<string, TokenEntry>,
  rawColors: Map<string, string>,
  effects: Map<string, string>,
): string => {
  const groups: string[][] = [];
  if (colorTokens.size) {
    const g = ["Color tokens (referenced by name in code; value for reference):"];
    for (const { ref, value } of colorTokens.values()) g.push(`  ${ref} = ${value}`);
    groups.push(g);
  }
  if (textTokens.size) {
    const g = ["Text styles (referenced by name; expand to these utilities):"];
    for (const { ref, value } of textTokens.values()) g.push(`  ${ref} = ${value}`);
    groups.push(g);
  }
  if (rawColors.size) {
    const g = ["Untokened colors (no design token):"];
    for (const [value, alias] of rawColors) g.push(`  ${alias} = ${value}`);
    groups.push(g);
  }
  if (effects.size) {
    const g = ["Effects (shadow stacks):"];
    for (const [stack, alias] of effects) g.push(`  ${alias} = ${stack}`);
    groups.push(g);
  }
  return groups.map((g) => g.join("\n")).join("\n\n");
};
