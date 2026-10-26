import { useQueryClient } from '@tanstack/react-query';
import { GitBranch, Bot, ChevronsUpDown, FolderKanban, KeyRound, LogOut, Monitor, Moon, Sun, Users } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';
import { useEffect } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ApiError, post } from '../api/client';
import { useMe, useProjects } from '../api/queries';
import { realtime } from '../lib/realtime';
import { Loading, UserAvatar } from './common';
import { Logo } from './Logo';

/** Everything behind login. Forces a pending password change first. */
export function Layout() {
  const me = useMe();
  const location = useLocation();
  const qc = useQueryClient();
  const user = me.data;
  const ready = !!user && !user.mustChangePassword;

  useEffect(() => {
    if (!ready) return;
    realtime.start(qc);
    return () => realtime.stop();
  }, [ready, qc]);

  if (me.isPending) return <Loading className="h-full" />;
  if (me.error || !user) {
    if (me.error instanceof ApiError && me.error.status !== 401) {
      return <div className="p-8 text-destructive">Can’t reach the server: {me.error.message}</div>;
    }
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`} replace />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <Link to="/" className="flex h-14 items-center gap-2.5 px-4">
          <Logo />
          <span className="font-semibold tracking-tight">Claude Task</span>
        </Link>
        {ready && <SidebarNav isAdmin={user.role === 'admin'} />}
        <div className="mt-auto border-t border-sidebar-border p-2">
          <UserMenu name={user.displayName} email={user.email} id={user.id} canChangePassword={ready} />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

const navItem = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
    isActive
      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
  );

function SidebarNav({ isAdmin }: { isAdmin: boolean }) {
  const projects = useProjects(false);
  return (
    <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
      <NavLink to="/" end className={navItem}>
        <FolderKanban className="size-4" /> Projects
      </NavLink>
      <NavLink to="/agents" className={navItem}><Bot className="size-4" /> Agents</NavLink>
      {isAdmin && <NavLink to="/admin/extensions" className={navItem}><Bot className="size-4" /> Extensions</NavLink>}
      {isAdmin && <NavLink to="/admin/credentials" className={navItem}><KeyRound className="size-4" /> Credentials</NavLink>}
      {isAdmin && <NavLink to="/admin/git" className={navItem}><GitBranch className="size-4" /> Git</NavLink>}
      {isAdmin && (
        <NavLink to="/admin/users" className={navItem}>
          <Users className="size-4" /> Users
        </NavLink>
      )}
      {projects.data && projects.data.length > 0 && (
        <>
          <p className="mt-5 mb-1 px-2.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Boards</p>
          {projects.data.map((p) => (
            <NavLink key={p.id} to={`/p/${p.key}`} className={navItem}>
              <span className="flex size-5 items-center justify-center rounded bg-primary/15 font-mono text-[9px] font-semibold text-primary">
                {p.key.slice(0, 2)}
              </span>
              <span className="truncate">{p.name}</span>
            </NavLink>
          ))}
        </>
      )}
    </nav>
  );
}

function UserMenu({ name, email, id, canChangePassword }: { name: string; email: string; id: string; canChangePassword: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    realtime.stop();
    qc.clear();
    navigate('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <UserAvatar user={{ id, displayName: name }} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{email}</span>
        </span>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(t) => setTheme(t as Theme)}>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {canChangePassword && (
          <DropdownMenuItem onSelect={() => navigate('/change-password')}>
            <KeyRound /> Change password
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={logout}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
