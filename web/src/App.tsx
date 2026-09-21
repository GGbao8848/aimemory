import { Toaster } from 'sonner';
import { useEffect, useState } from 'react';
import { get, onUnauthorized } from './api/client';
import { endpoints, type Me } from './api/contract';
import Sidebar from './components/Sidebar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { VIEWS, type ViewName } from './views/config';
import MemoriesView from './views/MemoriesView';
import EntitiesView from './views/EntitiesView';
import ArchivesView from './views/ArchivesView';
import RequestsView from './views/RequestsView';
import DashboardView from './views/DashboardView';
import PlaygroundView from './views/PlaygroundView';
import ExportsView from './views/ExportsView';
import WebhooksView from './views/WebhooksView';
import KeysView from './views/KeysView';
import SettingsView from './views/SettingsView';
import GuideView from './views/GuideView';

function LoginView() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm gap-5 p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <img className="size-14 rounded-xl" src="/icon-128.png" alt="aimemory" />
          <h1 className="text-lg font-semibold">登录记忆库</h1>
          <p className="text-muted-foreground text-sm">输入访问口令以管理你的记忆。</p>
        </div>
        <form className="flex flex-col gap-3" method="POST" action="/auth/local-login">
          <Input
            name="password"
            type="password"
            placeholder="访问口令"
            autoComplete="current-password"
            required
            autoFocus
          />
          <Button type="submit" className="w-full">登录</Button>
        </form>
      </Card>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<ViewName>('memories');
  // 实体页 → 记忆页的联动过滤（消费后置空）
  const [focusScope, setFocusScope] = useState<{ type: 'agent' | 'run'; name: string } | null>(null);

  const openScope = (type: 'agent' | 'run', name: string) => {
    setFocusScope({ type, name });
    setView('memories');
  };

  useEffect(() => {
    onUnauthorized(() => setMe(null));
    get<Me>(endpoints.me())
      .then((u) => setMe(u && u.userId ? u : null))
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return null;
  if (!me) return <LoginView />;

  const meta = VIEWS.find((v) => v.name === view) ?? VIEWS[0];
  const active = (name: ViewName) => ({ active: view === name });

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar active={view} onNavigate={setView} userName={me.username || '我'} />
      {/* 页面整体不滚动：每个视图自管滚动（记忆视图固定一屏 + 翻页，其余视图内部滚动） */}
      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden p-6">
        <header>
          <h1 className="text-lg font-semibold">{meta.title}</h1>
          <p className="text-muted-foreground text-sm">{meta.sub}</p>
        </header>
        {/* 各视图常驻挂载（只切显隐）：Token 一次性明文等跨视图状态不丢 */}
        <DashboardView {...active('dashboard')} />
        <MemoriesView
          {...active('memories')}
          focusScope={view === 'memories' ? focusScope : null}
          onFocusScopeConsumed={() => setFocusScope(null)}
        />
        <EntitiesView {...active('entities')} onOpen={openScope} />
        <ArchivesView {...active('archives')} />
        <RequestsView {...active('requests')} />
        <PlaygroundView {...active('playground')} />
        <ExportsView {...active('exports')} />
        <WebhooksView {...active('webhooks')} />
        <KeysView {...active('keys')} />
        <SettingsView {...active('settings')} />
        <GuideView {...active('guide')} />
      </main>
      <Toaster position="top-center" />
    </div>
  );
}
