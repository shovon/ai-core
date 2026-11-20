import type { Meta, StoryObj } from '@storybook/react-vite';
import { user, type PortableMessage } from '@ai-idioms/core';
import type { ModelPart } from '../../shared/threads.ts';
import Thread, { type Row } from './Thread.tsx';

// A stored row has an id and its versions; one still arriving has neither.
const said = (id: string | undefined, text: string, versions = id === undefined ? undefined : [id]): Row => ({
  id,
  versions,
  message: user(text),
});
const answered = (id: string | undefined, text: string, end?: 'stop' | 'length' | 'refusal'): Row => {
  const message: PortableMessage = { from: 'model', content: [{ type: 'text', text }], end };
  return { id, versions: id === undefined ? undefined : [id], message };
};

const conversation = [
  said('a', 'Name a colour.'),
  answered('b', 'Blue.', 'stop'),
  said('c', 'Another, and say why you chose it.'),
  answered('d', 'Green.\n\nIt sits next to blue on the spectrum, so it is the nearest colour that is still clearly a different one.', 'stop'),
];

const meta = {
  component: Thread,
  args: {
    rows: conversation,
    busy: false,
    onSend: () => undefined,
    onEdit: () => undefined,
    onRetry: () => undefined,
    onStop: () => undefined,
    onShow: () => undefined,
  },
  // The thread fills whatever it is put in; in the app, that is the window beside the sidebar.
  decorators: [
    (Story) => (
      <div className="flex h-screen">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Thread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { rows: [] } };

export const Conversation: Story = {};

/** The second prompt has been edited twice; the middle version is showing. */
export const Versions: Story = {
  args: {
    rows: [
      said('a', 'Name a colour.'),
      answered('b', 'Blue.', 'stop'),
      said('e', 'A warmer one.', ['c', 'e', 'g']),
      answered('f', 'Red.', 'stop'),
    ],
  },
};

/** The first prompt has two versions, and the newest is showing: there is no later one to go to. */
export const NewestVersion: Story = {
  args: { rows: [said('z', 'Name a shape.', ['a', 'z']), answered('y', 'A square.', 'stop')] },
};

/** The last turn has no `end`: it is still arriving. Nothing can be edited or shown differently meanwhile. */
export const Answering: Story = {
  args: {
    rows: [
      said('a', 'Name a colour.'),
      answered('b', 'Blue.', 'stop'),
      said('e', 'A warmer one.', ['c', 'e']),
      answered(undefined, 'Red. It is the'),
    ],
    busy: true,
  },
};

// A model turn that began with reasoning. With no id it is still arriving; with one it is stored and finished.
const thinking = (text: string, then: ModelPart[] = [], id?: string): Row => {
  const content: ModelPart[] = [{ type: 'reasoning', text }, ...then];
  const message: PortableMessage = id === undefined ? { from: 'model', content } : { from: 'model', content, end: 'stop' };
  return { id, versions: id === undefined ? undefined : [id], message };
};

/** The model has started working, and has shown nothing of it yet. */
export const Thinking: Story = {
  args: { rows: [...conversation, said('e', 'Prove that the square root of 2 is irrational.'), thinking('')], busy: true },
};

/** Its account of its working arrives while it works, so the wait has something in it. */
export const ThinkingAloud: Story = {
  args: {
    rows: [
      ...conversation,
      said('e', 'Prove that the square root of 2 is irrational.'),
      thinking('The classic route is by contradiction: suppose $\\sqrt{2} = p/q$ in lowest terms, and show both $p$ and $q$ must be even.'),
    ],
    busy: true,
  },
};

/** Once the answer begins, the reasoning folds away above it; it opens again on a click. */
export const AnsweringAfterThinking: Story = {
  args: {
    rows: [
      ...conversation,
      said('e', 'Prove that the square root of 2 is irrational.'),
      thinking('The classic route is by contradiction.', [{ type: 'text', text: 'Suppose, for contradiction, that' }]),
    ],
    busy: true,
  },
};

/** A stored turn keeps its reasoning, folded. */
export const Thought: Story = {
  args: {
    rows: [
      said('a', 'Prove that the square root of 2 is irrational.'),
      thinking('The classic route is by contradiction.', [{ type: 'text', text: 'Suppose $\\sqrt{2} = p/q$ in lowest terms. Then $p^2 = 2q^2$, so $p$ is even…' }], 'b'),
    ],
  },
};

// A turn that called a tool, and the message its result is stored in.
const searched = (id: string | undefined, query: string): Row => {
  const message: PortableMessage = {
    from: 'model',
    content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_call', id: 'call 1', name: 'web_search', input: { query } }],
    end: 'stop',
  };
  return { id, versions: id === undefined ? undefined : [id], message };
};
const came = (id: string, text: string, error?: boolean): Row => {
  const message: PortableMessage = { from: 'tool', content: [{ type: 'tool_result', id: 'call 1', content: [{ type: 'text', text }], error }] };
  return { id, versions: [id], message };
};
const pages = '1. Release notes\n   https://example.com/releases\n   Version 5.2 was released last week.\n\n2. Changelog\n   https://example.com/changelog\n   Every change since 5.0.';

/** The tool is running: the turn that called it is stored, and its result is not back yet. */
export const RunningATool: Story = {
  args: { rows: [said('a', 'What is the latest version?'), searched('b', 'latest version')], busy: true },
};

/** The result is folded under the call, and the answer follows it. */
export const UsedATool: Story = {
  args: {
    rows: [
      said('a', 'What is the latest version?'),
      searched('b', 'latest version'),
      came('c', pages),
      answered('d', 'Version 5.2, released last week ([release notes](https://example.com/releases)).', 'stop'),
    ],
  },
};

/** The tool failed. The model was told, and says so. */
export const ToolFailed: Story = {
  args: {
    rows: [
      said('a', 'What is the latest version?'),
      searched('b', 'latest version'),
      came('c', 'web search failed: 403 Authentication error', true),
      answered('d', 'I could not search the web just now, so I cannot confirm the latest version.', 'stop'),
    ],
  },
};

/** Sent, but nothing has come back yet. */
export const Waiting: Story = {
  args: { rows: [...conversation, said('e', 'And a third?')], busy: true },
};

export const Failed: Story = {
  args: {
    rows: [...conversation, said('e', 'And a third?')],
    error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  },
};

/** The answer was retried: it has two versions, and the prompt before it has one. */
export const RetriedAnswer: Story = {
  args: {
    rows: [said('a', 'Name a colour.'), { ...answered('c', 'Green.', 'stop'), versions: ['b', 'c'] }],
  },
};

/** The user stopped the answer. It is stored with no `end`: it never finished. */
export const Stopped: Story = {
  args: { rows: [said('a', 'Write a very long poem.'), answered('b', 'Roses are red, violets are')] },
};

/** What the model writes is Markdown. */
export const Formatted: Story = {
  args: {
    rows: [
      said('a', 'How do I add two numbers in TypeScript?'),
      answered('b', 'Use the `+` operator:\n\n```ts\nconst add = (a: number, b: number) => a + b;\n```\n\nTwo things to know:\n\n1. Both operands must be **numbers**.\n2. With a string, `+` joins instead.', 'stop'),
    ],
  },
};

export const StoppedEarly: Story = {
  args: { rows: [said('a', 'Write a very long poem.'), answered('b', 'Roses are red, violets are', 'length')] },
};
