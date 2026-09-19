import { useEffect, useState } from 'react';
import { get, onUnauthorized } from './api/client';
import { endpoints, type Me } from './api/contract';
import Sidebar from './components/Sidebar';
import { ToastProvider } from './components/Toast';
import { VIEWS, type ViewName } from './views/config';
import MemoriesView from './views/MemoriesView';
import KeysView from './views/KeysView';
import ArchiveView from './views/ArchiveView';
import OpsView from './views/OpsView';
import L3View from './views/L3View';
import GuideView from './views/GuideView';

function LoginView() {
  return (
    <section className="login-wrap">
      <div className="card login-card">
        <img className="login-logo" src="/icon-128.png" alt="aimemory" />
        <h1>登录记忆平台</h1>
        <p className="muted">输入访问口令以管理你的记忆、会话归档与接入 Token。</p>
        <form className="login-form" method="POST" action="/auth/local-login">
          <input name="password" type="password" placeholder="访问口令" autoComplete="current-password" required autoFocus />
          <button className="btn btn-primary btn-block" type="submit">登录</button>
        </form>
      </div>
    </section>
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
    <ToastProvider>
      <div className="app">
        <Sidebar active={view} onNavigate={setView} userName={me.username || '我'} />
        <main className="main">
          <header className="main-head">
            <h1>{meta.title}</h1>
            <p className="sub">{meta.sub}</p>
          </header>
          {/* 六个视图常驻挂载（只切显隐）：Token 一次性明文、归档下钻选择等状态跨视图切换不丢 */}
          <MemoriesView {...active('memories')} />
          <KeysView {...active('keys')} />
          <ArchiveView {...active('sessions')} />
          <OpsView {...active('ops')} />
          <L3View {...active('l3')} />
          <GuideView {...active('guide')} />
        </main>
      </div>
    </ToastProvider>
  );
}
