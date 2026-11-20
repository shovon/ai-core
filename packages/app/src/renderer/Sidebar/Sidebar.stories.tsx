import type { Meta, StoryObj } from '@storybook/react-vite';
import Sidebar from './Sidebar.tsx';

const entries = [
  { id: 'c', title: 'Name a shape.', answering: false },
  { id: 'b', title: 'A thread whose first prompt went on for rather a long time before…', answering: false },
  { id: 'a', title: 'Name a colour.', answering: false },
];

const meta = {
  component: Sidebar,
  args: { entries, open: 'b', onSelect: () => undefined, onNew: () => undefined, onRename: () => undefined, onRemove: () => undefined },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Threads: Story = {};

/** Nothing has been said anywhere yet, and a new thread is on screen. */
export const Empty: Story = { args: { entries: [], open: undefined } };

/** A new thread is on screen, so none of the listed ones is marked. */
export const NewThread: Story = { args: { open: undefined } };

/** A thread goes on answering while another is on screen. */
export const AnsweringElsewhere: Story = {
  args: { entries: entries.map((entry) => ({ ...entry, answering: entry.id === 'c' })), open: 'a' },
};

export const ManyThreads: Story = {
  args: { entries: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, title: `Thread number ${60 - i}`, answering: false })), open: 't3' },
};
