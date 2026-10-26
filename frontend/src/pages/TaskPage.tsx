import { useParams } from 'react-router';
import { TaskDetail } from '../components/TaskDetail';

export function TaskPage() {
  const { taskKey } = useParams();
  return (
    <div className="flex h-full flex-col bg-card/40">
      <TaskDetail key={taskKey} taskKey={taskKey!} />
    </div>
  );
}
