import { useEffect, useRef } from 'react';

/** 进入视图时取一次数（离开后再进来会重新取），与旧前端 switchView 里的按需加载一致 */
export function useEnterReload(active: boolean, reload: () => void): void {
  const fn = useRef(reload);
  fn.current = reload;
  const entered = useRef(false);

  useEffect(() => {
    if (!active) {
      entered.current = false;
      return;
    }
    if (entered.current) return;
    entered.current = true;
    fn.current();
  }, [active]);
}
