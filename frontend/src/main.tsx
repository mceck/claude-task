import { GitHubPage } from './pages/GitHubPage';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme';
import { ApiError } from './api/client';
import { keys } from './api/queries';
import { ConfirmProvider } from './components/common';
import { Layout } from './components/Layout';
import './index.css';
import { BoardPage } from './pages/BoardPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { TaskPage } from './pages/TaskPage';
import { UsersPage } from './pages/UsersPage';
import { AgentsPage } from './pages/AgentsPage';
import { AgentPage } from './pages/AgentPage';
import { CredentialsPage } from './pages/CredentialsPage';

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      // A lost session anywhere sends us back through the auth check.
      if (err instanceof ApiError && err.status === 401 && query.queryKey[0] !== keys.me[0]) {
        void queryClient.invalidateQueries({ queryKey: keys.me });
      }
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <ProjectsPage /> },
      { path: '/change-password', element: <ChangePasswordPage /> },
      { path: '/p/:projectKey', element: <BoardPage /> },
      { path: '/p/:projectKey/settings', element: <ProjectSettingsPage /> },
      { path: '/t/:taskKey', element: <TaskPage /> },
      { path: '/admin/users', element: <UsersPage /> },
      { path: '/agents', element: <AgentsPage /> },
      { path: '/agents/:agentId', element: <AgentPage /> },
      { path: '/admin/credentials', element: <CredentialsPage /> },
      { path: '/admin/github', element: <GitHubPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
