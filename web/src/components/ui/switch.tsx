import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 轻量开关（不引 radix，项目内无其他开关场景）：button + role="switch"。
 * 受控组件：checked 由父级持有，onCheckedChange 回传新值。
 */
function Switch({
  className,
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
  ...props
}: React.ComponentProps<'button'> & {
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'focus-visible:ring-ring inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'bg-background pointer-events-none block size-4 rounded-full shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export { Switch };
