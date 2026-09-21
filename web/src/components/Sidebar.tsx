import {
  Archive, BookOpenText, BrainCircuit, Boxes, FlaskConical, FileDown, KeyRound, LayoutDashboard,
  Moon, ScrollText, Settings, Sun, Webhook, LogOut,
} from 'lucide-react';
import { useState } from 'react';
import { VIEWS, type ViewName } from '../views/config';
import { applyTheme, currentTheme, type Theme } from '../lib/dom';
import { Button } from '@/components/ui/button';

const VIEW_ICONS = {
  dashboard: LayoutDashboard,
  memories: BrainCircuit,
  entities: Boxes,
  archives: Archive,
  requests: ScrollText,
  playground: FlaskConical,
  exports: FileDown,
  webhooks: Webhook,
  settings: Settings,
  keys: KeyRound,
  guide: BookOpenText,
} as const;

/** mem0 控制台式分组导航：大写小节标题 + 组内条目 */
const SECTIONS: { label: string; views: ViewName[] }[] = [
  { label: 'ACTIVITY', views: ['dashboard', 'memories', 'entities', 'archives', 'requests', 'playground', 'exports', 'webhooks'] },
  { label: 'SETUP', views: ['settings', 'keys', 'guide'] },
];

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
    <aside className="flex w-56 shrink-0 flex-col gap-4 border-r bg-card p-4">
      <div className="mb-1 flex items-center gap-3 px-1">
        <img className="size-10 rounded-lg" src="/icon-128.png" alt="aimemory" />
        <div className="leading-tight">
          <strong className="block text-sm">aimemory</strong>
          <span className="text-muted-foreground text-xs">mem0 形态记忆库</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto" aria-label="主导航">
        {SECTIONS.map((section) => (
          <div key={section.label} className="flex flex-col gap-1">
            <span className="text-muted-foreground/70 px-1.5 text-[10px] font-semibold tracking-widest uppercase">
              {section.label}
            </span>
            {VIEWS.filter((v) => section.views.includes(v.name)).map(({ name, nav }) => {
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
          </div>
        ))}
      </nav>

      <div className="mt-auto flex shrink-0 flex-col gap-1 border-t pt-3">
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
