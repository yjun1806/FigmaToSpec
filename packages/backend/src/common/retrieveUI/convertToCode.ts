import { PluginSettings } from "types";
import { llmMain } from "../../llm/llmMain";

// This build only ships the LLM spec exporter; all other framework generators were removed.
export const convertToCode = async (
  nodes: SceneNode[],
  settings: PluginSettings,
) => llmMain(nodes, settings);
