import type { Preview } from '@storybook/react-vite';
import 'katex/dist/katex.min.css';
import '../src/renderer/index.css';

// No bridge stub: views take what they call as props, so a story hands each
// one exactly what it needs.

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    a11y: { test: 'todo' },
  },
};

export default preview;
