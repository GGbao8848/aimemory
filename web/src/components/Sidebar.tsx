import { useState } from 'react';
import { LogoutIcon, MoonIcon, SunIcon } from './Icons.tsx';
import { VIEWS, type ViewName } from '../views/config.ts';
import { applyTheme, currentTheme, type Theme } from '../lib/dom.ts';

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
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src="/icon-128.png" alt="aimemory" />
        <div className="brand-text">
          <strong>aimemory</strong>
          <span>个人 AI 记忆库</span>
        </div>
      </div>

      <nav className="nav" aria-label="主导航">
        {VIEWS.map(({ name, nav, Icon }) => (
          <button
            key={name}
            type="button"
            className={name === active ? 'nav-item active' : 'nav-item'}
            onClick={() => onNavigate(name)}
          >
            <Icon className="nav-ico" />
            <span>{nav}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="theme-toggle" onClick={toggleTheme} aria-label="切换亮暗模式">
          <SunIcon className="ico ico-sun" />
          <MoonIcon className="ico ico-moon" />
          <span className="lbl-sun">亮色模式</span>
          <span className="lbl-moon">暗色模式</span>
        </button>
        <div className="user-chip">
          <span className="who-dot" aria-hidden="true" />
          <span className="who">{userName}</span>
        </div>
        <a className="logout" href="/auth/logout">
          <LogoutIcon className="nav-ico" />
          <span>退出登录</span>
        </a>
      </div>
    </aside>
  );
}
