import { BookOpenText, KeyRound, Moon, Sun, BrainCircuit, LogOut } from 'lucide-react';
import { useState } from 'react';
import { VIEWS, type ViewName } from '../views/config';
import { applyTheme, currentTheme, type Theme } from '../lib/dom';
import { Button } from '@/components/ui/button';

const VIEW_ICONS = { memories: BrainCircuit, keys: KeyRound, guide: BookOpenText } as const;

interface Props {
  active: ViewName;
  onNavigate: (v: ViewName) => void;
  userName: string;
}

export default function Sidebar({ active, onNavigate, userName }: Props) {
  const [theme, setTheme] = useState<Theme>(currentTheme());

  const toggleTheme = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    setTheme(next);
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-2 border-r bg-card p-4">
      <div className="mb-4 flex items-center gap-3 px-1">
        <img className="size-10 rounded-lg" src="/icon-128.png" alt="aimemory" />
        <div className="leading-tight">
          <strong className="block text-sm">aimemory</strong>
          <span className="text-muted-foreground text-xs">mem0 形态记忆库</span>
        </div>
      </div>

      <nav className="flex flex-col gap-1" aria-label="主导航">
        {VIEWS.map(({ name, nav }) => {
          const Icon = VIEW_ICONS[name];
          return (
            <Button
              key={name}
              variant={name === active ? 'secondary' : 'ghost'}
              className="justify-start"
              onClick={() => onNavigate(name)}
            >
              <Icon className="size-4" />
              <span>{nav}</span>
            </Button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-1 border-t pt-3">
        <Button variant="ghost" className="justify-start" onClick={toggleTheme} aria-label="切换亮暗模式">
          {theme === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          <span>{theme === 'light' ? '暗色模式' : '亮色模式'}</span>
        </Button>
        <Button variant="ghost" className="text-muted-foreground justify-start" asChild>
          <a href="/auth/logout">
            <LogOut className="size-4" />
            <span>退出（{userName}）</span>
          </a>
        </Button>
      </div>
    </aside>
  );
}
