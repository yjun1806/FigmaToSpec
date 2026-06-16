import {
  Framework,
  LocalCodegenPreferenceOptions,
  PluginSettings,
  SelectPreferenceOptions,
} from "types";
import { useMemo } from "react";
import { CopyButton } from "./CopyButton";
import CodeBlock from "./CodeBlock";
import EmptyState from "./EmptyState";
import SettingsGroup from "./SettingsGroup";
import FrameworkTabs from "./FrameworkTabs";
import { TailwindSettings } from "./TailwindSettings";

interface CodePanelProps {
  code: string;
  selectedFramework: Framework;
  settings: PluginSettings | null;
  preferenceOptions: LocalCodegenPreferenceOptions[];
  selectPreferenceOptions: SelectPreferenceOptions[];
  onPreferenceChanged: (
    key: keyof PluginSettings,
    value: PluginSettings[keyof PluginSettings],
  ) => void;
}

// Prism language for each framework's output.
const languageFor = (
  framework: Framework,
  settings: PluginSettings | null,
): string => {
  if (framework === "HTML" && settings?.htmlGenerationMode === "styled-components")
    return "jsx";
  switch (framework) {
    case "Flutter":
      return "dart";
    case "SwiftUI":
      return "swift";
    case "Compose":
      return "kotlin";
    case "LLM":
      return "markdown";
    case "LLM+Tailwind":
      return "jsx";
    default:
      return "html";
  }
};

// The LLM spec is `guide + "\n\n" + body`, where the per-component body always starts with the
// `## Component Spec` heading. Split there so the static guide and the component payload render as
// two separate, independently-copyable blocks. The guide never contains that heading at line
// start, so anchoring on the blank-line-prefixed heading is unambiguous.
const splitLLMSpec = (full: string): { guide: string; body: string } => {
  const idx = full.indexOf("\n\n## Component Spec");
  if (idx === -1) return { guide: full, body: "" };
  return { guide: full.slice(0, idx), body: full.slice(idx + 2) };
};

const CodePanel = (props: CodePanelProps) => {
  const {
    code,
    preferenceOptions,
    selectPreferenceOptions,
    selectedFramework,
    settings,
    onPreferenceChanged,
  } = props;
  const isCodeEmpty = code === "";

  // Helper function to add the prefix before every class (or className) in the code.
  // It finds every occurrence of class="..." or className="..." and, for each class,
  // prepends the custom prefix.
  const applyPrefixToClasses = (
    codeString: string,
    prefix: string | undefined,
  ) => {
    if (!prefix) {
      return codeString;
    }

    return codeString.replace(
      /(class(?:Name)?)="([^"]*)"/g,
      (_match, attr, classes) => {
        const prefixedClasses = classes
          .split(/\s+/)
          .filter(Boolean)
          .map((cls: string) => prefix + cls)
          .join(" ");
        return `${attr}="${prefixedClasses}"`;
      },
    );
  };

  // If the selected framework is Tailwind and a prefix is provided then transform the code.
  const prefixedCode =
    selectedFramework === "Tailwind" &&
    settings?.customTailwindPrefix?.trim() !== ""
      ? applyPrefixToClasses(code, settings?.customTailwindPrefix)
      : code;

  const language = languageFor(selectedFramework, settings);

  // For LLM, show the shared guide and the per-component body as two separate blocks.
  const llmParts = selectedFramework === "LLM" ? splitLLMSpec(prefixedCode) : null;

  // Memoized preference groups for better performance
  const {
    essentialPreferences,
    stylingPreferences,
    selectableSettingsFiltered,
  } = useMemo(() => {
    // Get preferences for the current framework
    const frameworkPreferences = preferenceOptions.filter((preference) =>
      preference.includedLanguages?.includes(selectedFramework),
    );

    // Define preference grouping based on property names
    const essentialPropertyNames = ["jsx"];
    const stylingPropertyNames = [
      "useTailwind4",
      "roundTailwindValues",
      "roundTailwindColors",
      "useColorVariables",
      "showLayerNames",
      "embedImages",
      "embedVectors",
    ];

    // Group preferences by category
    return {
      essentialPreferences: frameworkPreferences.filter((p) =>
        essentialPropertyNames.includes(p.propertyName),
      ),
      stylingPreferences: frameworkPreferences.filter((p) =>
        stylingPropertyNames.includes(p.propertyName),
      ),
      selectableSettingsFiltered: selectPreferenceOptions.filter((p) =>
        p.includedLanguages?.includes(selectedFramework),
      ),
    };
  }, [preferenceOptions, selectPreferenceOptions, selectedFramework]);

  const hasSettingsBeforeStyling =
    essentialPreferences.length > 0 || selectableSettingsFiltered.length > 0;

  return (
    <div className="w-full flex flex-col gap-2 mt-2">
      <div className="flex items-center justify-between w-full">
        <p className="text-lg font-medium text-center text-foreground rounded-lg">
          Code
        </p>
        {!isCodeEmpty && (
          <CopyButton value={prefixedCode} />
        )}
      </div>

      {!isCodeEmpty && (
        <div className="flex flex-col p-3 bg-card border rounded-lg text-sm">
          {/* Essential settings always shown */}
          <SettingsGroup
            title=""
            settings={essentialPreferences}
            alwaysExpanded={true}
            selectedSettings={settings}
            onPreferenceChanged={onPreferenceChanged}
          />

          {/* Framework-specific options */}
          {selectableSettingsFiltered.length > 0 && (
            <div className="mb-2 flex flex-col gap-2 last:mb-0">
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {selectedFramework} Options
              </p>
              {selectableSettingsFiltered.map((preference) => {
                // Regular toggle buttons for other options
                return (
                  <FrameworkTabs
                    options={preference.options}
                    selectedValue={
                      (settings?.[preference.propertyName] ??
                        preference.options.find((option) => option.isDefault)
                          ?.value ??
                        "") as string
                    }
                    onChange={(value) => {
                      onPreferenceChanged(preference.propertyName, value);
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* Styling preferences with custom prefix for Tailwind */}
          {(stylingPreferences.length > 0 ||
            selectedFramework === "Tailwind") && (
            <div className={hasSettingsBeforeStyling ? "mt-2" : undefined}>
              <SettingsGroup
                title="Styling Options"
                settings={stylingPreferences}
                selectedSettings={settings}
                onPreferenceChanged={onPreferenceChanged}
              >
                {selectedFramework === "Tailwind" && (
                  <TailwindSettings
                    settings={settings}
                    onPreferenceChanged={onPreferenceChanged}
                  />
                )}
              </SettingsGroup>
            </div>
          )}
        </div>
      )}

      {isCodeEmpty ? (
        <EmptyState />
      ) : llmParts ? (
        <div className="flex flex-col gap-3">
          {llmParts.body && (
            <CodeBlock
              code={llmParts.body}
              language={language}
              label="Component Spec · 이 화면"
            />
          )}
          <CodeBlock
            code={llmParts.guide}
            language={language}
            label="Spec Guide · 공통 (캐시/재사용)"
          />
        </div>
      ) : (
        <CodeBlock code={prefixedCode} language={language} />
      )}
    </div>
  );
};

export default CodePanel;
