import { PluginSettings } from "types";
import { getVisibleNodes } from "../common/nodeVisibility";
import { tailwindMain } from "../tailwind/tailwindMain";
import { minifySvg } from "./llmMain";
import { dedupeTokens } from "./tailwindTokenDedup";

// A token-optimized pairing of working-style Tailwind JSX with a compact design-token glossary.
// The JSX keeps standard structure (layout utilities inline) so it stays natively readable, while
// the heavy, repeated parts are stripped or aliased: base64 raster fills removed from SVGs,
// colors/text-styles/shadows collapsed into c#/t#/e# defined once up top. The result is markedly
// smaller and easier to scan than raw Tailwind, especially for large/repetitive screens.
export const llmTailwindMain = async (
  sceneNode: Array<SceneNode>,
  settings: PluginSettings,
): Promise<string> => {
  const jsx = await tailwindMain(sceneNode, {
    ...settings,
    tailwindGenerationMode: "jsx",
  });

  // Strip embedded base64 rasters (and the dead pattern/image markup around them) from every SVG
  // — they cost thousands of tokens and add nothing to reproduction.
  const stripped = jsx.replace(/<svg\b[\s\S]*?<\/svg>/g, (svg) => minifySvg(svg));
  const { code, glossary } = dedupeTokens(stripped);

  const rootId = getVisibleNodes(sceneNode)[0]?.id ?? "";
  const note = [
    "Figma → JSX (token-optimized). Reproduce faithfully: match colors, fonts, spacing, and radii.",
    "Design tokens are referenced by their name; expand them when writing real code:",
    "  kind-[token/name]   →  the color token (e.g. text-[semantic/label/normal])",
    "  a text-style class  →  the utilities listed (e.g. body-1-normal-semibold)",
    "  c# / e#             →  values with NO design token (raw color / shadow stack)",
    "Definitions are in the glossary below. data-* attributes are component variant props (build that variant). A node with no size hugs its contents.",
    rootId
      ? `Root node \`${rootId}\` — call Figma MCP get_screenshot to compare against the original.`
      : "",
  ].filter(Boolean);

  const header = [...note, ...(glossary ? ["", glossary] : [])].join("\n");
  return `/*\n${header}\n*/\n\n${code}`;
};
