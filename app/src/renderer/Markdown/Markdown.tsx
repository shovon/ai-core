import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { dollarMath } from './math.ts';

// Outside the component, so the lists are the same ones on every render.
const reading = [remarkGfm, remarkMath];
const rendering = [rehypeKatex];

/**
 * Markdown as the model writes it, with tables, strikethrough and task lists,
 * and mathematics set with KaTeX: `$…$` or `\(…\)` within a line, `$$…$$` or
 * `\[…\]` on its own.
 * A formula KaTeX cannot parse is shown as it was written, in red.
 *
 * Raw HTML in it is shown as text, never run. It can be given text that is
 * still arriving: an unfinished construct renders as far as it has got.
 * How it looks is `.markdown` in index.css, and KaTeX's own stylesheet.
 */
const Markdown = ({ text }: { text: string }) => (
  <div className="markdown">
    <ReactMarkdown remarkPlugins={reading} rehypePlugins={rendering}>
      {dollarMath(text)}
    </ReactMarkdown>
  </div>
);

export default Markdown;
