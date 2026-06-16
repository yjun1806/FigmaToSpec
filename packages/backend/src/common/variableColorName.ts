// Resolves a Figma color-variable id to its sanitized name (e.g. "semantic/label" → "semantic-label"),
// falling back to the id when the variable can't be read. Extracted from the (removed) Tailwind
// conversion tables so the core node conversion carries no code-generator dependency.
export const variableToColorName = async (id: string): Promise<string> =>
  (await figma.variables.getVariableByIdAsync(id))?.name
    .replaceAll("/", "-")
    .replaceAll(" ", "-") || id.toLowerCase().replaceAll(":", "-");
