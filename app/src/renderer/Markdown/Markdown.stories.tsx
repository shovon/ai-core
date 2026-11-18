import type { Meta, StoryObj } from '@storybook/react-vite';
import Markdown from './Markdown.tsx';

const everything = `# A heading

Some prose with **bold**, *italic*, ~~struck~~ and \`inline code\`, and [a link](https://example.com).

## A smaller heading

1. First, with a nested list:
   - one
   - two
2. Second

- [x] Done
- [ ] Not done

> A quotation, which may run on for long enough that it has to wrap onto a second line to be read.

\`\`\`ts
const add = (a: number, b: number) => a + b;
// A line long enough that the block has to scroll sideways rather than wrap or push the page wider than it is.
\`\`\`

| Colour | Why |
| --- | --- |
| Blue | It was asked for |
| Green | It sits next to blue |

---

<script>alert('raw HTML is shown, not run')</script>
`;

const meta = {
  component: Markdown,
  args: { text: everything },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-white p-6 font-sans text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Everything: Story = {};

export const PlainText: Story = { args: { text: 'Blue.' } };

/** Mathematics, in a line and on its own, as the model writes it between dollar signs. */
export const Mathematics: Story = {
  args: {
    text: 'The roots of $ax^2 + bx + c = 0$ are\n\n$$\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n$$\n\nand the Gaussian integral is $\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$.\n\nA formula that does not parse is shown as it was written: $\\frac{1}{$',
  },
};

/** The same, written the way LaTeX itself does, which is how the model often writes it. */
export const MathematicsInBrackets: Story = {
  args: {
    text: 'The roots of \\(ax^2 + bx + c = 0\\) are\n\n\\[\nx = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]\n\nwhere \\(b^2 - 4ac\\) is the discriminant. In code it is left alone: `\\(x\\)`. A coffee costs \\$5.',
  },
};

/** Text that stopped arriving in the middle of a code block. */
export const Unfinished: Story = {
  args: { text: 'Here is the function:\n\n```ts\nconst add = (a: number, b: number) =>' },
};
