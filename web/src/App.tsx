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
import KeysView from './views/KeysView';
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
    <div className="flex min-h-screen">
      <Sidebar active={view} onNavigate={setView} userName={me.username || '我'} />
      <main className="flex min-w-0 flex-1 flex-col gap-4 p-6">
        <header>
          <h1 className="text-lg font-semibold">{meta.title}</h1>
          <p className="text-muted-foreground text-sm">{meta.sub}</p>
        </header>
        {/* 三个视图常驻挂载（只切显隐）：Token 一次性明文等跨视图状态不丢 */}
        <MemoriesView {...active('memories')} />
        <KeysView {...active('keys')} />
        <GuideView {...active('guide')} />
      </main>
      <Toaster position="top-center" />
    </div>
  );
}
