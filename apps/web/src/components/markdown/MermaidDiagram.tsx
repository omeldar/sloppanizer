import { useEffect, useId, useState } from "react";
import { useTheme } from "../../lib/theme.ts";
import styles from "./Markdown.module.css";
import { cachedDiagram, type DiagramResult, drawDiagram } from "./mermaid.ts";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** The diagram text of a ```mermaid fence (a <pre> around <code class="language-mermaid">), else null. */
export function mermaidSourceOf(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((child) => child.type === "element");
  if (!code || code.tagName !== "code") return null;
  const classes = code.properties?.className;
  const isMermaid =
    Array.isArray(classes) && classes.some((name) => String(name).toLowerCase() === "language-mermaid");
  return isMermaid ? textOf(code).replace(/\n$/, "") : null;
}

/**
 * A Mermaid diagram. Until it is drawn, and when it cannot be, the text shows as a code block; a
 * redraw (new text, other theme) keeps the last picture up until the new one is ready.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // The last drawing this diagram got; a drawn one for the current text and theme comes from the cache.
  const [last, setLast] = useState<DiagramResult | undefined>(() => cachedDiagram(source, theme));
  const result = cachedDiagram(source, theme) ?? last;

  useEffect(() => {
    if (cachedDiagram(source, theme)) return;
    let current = true;
    const draw = async () => {
      const next = await drawDiagram(id, source, theme);
      // Text or theme changed meanwhile: that drawing is on its way, this one is stale.
      if (current) setLast(next);
    };
    void draw();
    return () => {
      current = false;
    };
  }, [id, source, theme]);

  if (result?.ok) {
    const { src, alt, width, height } = result.diagram;
    return (
      <figure className={styles.diagram}>
        <img src={src} alt={alt} width={width} height={height} />
      </figure>
    );
  }
  return (
    <div className={styles.diagramSource}>
      <pre>
        <code className="language-mermaid">{source}</code>
      </pre>
      {result && (
        <p className={styles.diagramError} role="status">
          Diagram could not be drawn: {result.error}
        </p>
      )}
    </div>
  );
}
