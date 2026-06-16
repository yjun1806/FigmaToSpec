import { useMemo, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { coldarkDark as theme } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CopyButton } from "./CopyButton";

interface CodeBlockProps {
  code: string;
  language: string;
  // Optional caption shown above the block (used to label the LLM guide vs component blocks).
  label?: string;
  initialLinesToShow?: number;
}

// A single syntax-highlighted code block with its own truncation/expand state and floating copy
// button. Extracted so CodePanel can render more than one (the LLM spec = guide + component).
const CodeBlock = ({
  code,
  language,
  label,
  initialLinesToShow = 25,
}: CodeBlockProps) => {
  const [syntaxHovered, setSyntaxHovered] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const lineCount = useMemo(() => code.split("\n").length, [code]);
  const shouldTruncate = !isExpanded && lineCount > initialLinesToShow;
  const displayedCode = shouldTruncate
    ? code.split("\n").slice(0, initialLinesToShow).join("\n") + "\n..."
    : code;
  const showMoreButton = lineCount > initialLinesToShow;
  const showCodeCopyButton = lineCount > 5;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <p className="px-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
          {label}
        </p>
      )}
      <div
        className={`relative rounded-lg ring-green-600 transition-all duration-200 ${
          syntaxHovered ? "ring-2" : "ring-0"
        }`}
      >
        {showCodeCopyButton && (
          <div className="pointer-events-none sticky top-3 z-10 h-0">
            <CopyButton
              value={code}
              showLabel={false}
              onMouseEnter={() => setSyntaxHovered(true)}
              onMouseLeave={() => setSyntaxHovered(false)}
              className="pointer-events-auto absolute right-2 top-2 h-7 w-7 rounded-md bg-neutral-800/90 p-0 text-neutral-200 shadow-sm ring-1 ring-white/10 backdrop-blur-sm hover:bg-neutral-600 hover:text-white hover:ring-white/20 dark:bg-neutral-800/90 dark:hover:bg-neutral-600"
            />
          </div>
        )}
        <SyntaxHighlighter
          language={language}
          style={theme}
          customStyle={{
            fontSize: 12,
            borderRadius: 8,
            marginTop: 0,
            marginBottom: 0,
            backgroundColor: syntaxHovered ? "#1E2B1A" : "#1B1B1B",
            transitionProperty: "all",
            transitionTimingFunction: "ease",
            transitionDuration: "0.2s",
          }}
        >
          {displayedCode}
        </SyntaxHighlighter>
        {showMoreButton && (
          <div className="flex justify-center dark:bg-[#1B1B1B] border-t dark:border-gray-700">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-xs w-full flex justify-center py-3 text-blue-500 hover:text-blue-400 transition-colors"
              aria-label="Show more code. This could be slow or freeze Figma for a few seconds."
              title="Show more code. This could be slow or freeze Figma for a few seconds."
            >
              {isExpanded ? "Show Less" : "Show More"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeBlock;
