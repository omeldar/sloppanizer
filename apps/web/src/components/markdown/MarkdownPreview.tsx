import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import styles from "./Markdown.module.css";

/** Stored Markdown is untrusted text: it renders through rehype-sanitize, links open in a new tab. */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className={styles.preview}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
