import { useParams } from 'react-router';
import { TaskDetail } from '../components/TaskDetail';

export function TaskPage() {
  const { taskKey } = useParams();
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col border-x bg-card/40">
      <TaskDetail key={taskKey} taskKey={taskKey!} />
    </div>
  );
}
