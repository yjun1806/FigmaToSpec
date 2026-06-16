import { PluginSettings } from "types";
import { composeMain } from "../../compose/composeMain";
import { flutterMain } from "../../flutter/flutterMain";
import { htmlMain } from "../../html/htmlMain";
import { llmMain } from "../../llm/llmMain";
import { llmTailwindMain } from "../../llm/llmTailwindMain";
import { swiftuiMain } from "../../swiftui/swiftuiMain";
import { tailwindMain } from "../../tailwind/tailwindMain";

export const convertToCode = async (
  nodes: SceneNode[],
  settings: PluginSettings,
) => {
  switch (settings.framework) {
    case "Tailwind":
      return await tailwindMain(nodes, settings);
    case "Flutter":
      return await flutterMain(nodes, settings);
    case "SwiftUI":
      return await swiftuiMain(nodes, settings);
    case "Compose":
      return composeMain(nodes, settings);
    case "LLM":
      return llmMain(nodes, settings);
    case "LLM+Tailwind":
      return llmTailwindMain(nodes, settings);
    case "HTML":
    default:
      return (await htmlMain(nodes, settings)).html;
  }
};
