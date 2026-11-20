import type { ThreadsApi } from '../../shared/threads.ts';
import Sidebar from '../Sidebar/Sidebar.tsx';
import Thread from '../Thread/Thread.tsx';
import { useThreads } from './useThreads.ts';

const App = ({ threads }: { threads: ThreadsApi }) => {
  const page = useThreads(threads);
  return (
    <div className="flex h-screen">
      <Sidebar
        entries={page.entries}
        open={page.open}
        onSelect={(id) => void page.select(id)}
        onNew={page.startNew}
        onRename={(id, title) => void page.rename(id, title)}
        onRemove={(id) => void page.remove(id)}
      />
      <Thread
        // One per thread, so what is typed or being edited in one never shows in another.
        key={page.open ?? 'new'}
        rows={page.rows}
        busy={page.busy}
        error={page.error}
        onSend={(text) => void page.send(text)}
        onEdit={(id, text) => void page.edit(id, text)}
        onRetry={(id) => void page.retry(id)}
        onStop={() => void page.stop()}
        onShow={(id) => void page.show(id)}
      />
    </div>
  );
};

export default App;
