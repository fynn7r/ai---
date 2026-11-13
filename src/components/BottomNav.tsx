/**
 * @file BottomNav.tsx
 * @description 底部导航。显示哪些页面、什么顺序由 preferences.navPaths 决定，
 * 可选项来自 lib/nav.ts 的注册表，自定义入口在工作台。
 */

import { useEffect, useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import ReminderCountBadges from '@/components/ReminderCountBadges';
import { useReminderCounts } from '@/hooks/useReminderCounts';
import { NAV_CHANGED_EVENT, resolveNavItems } from '@/lib/nav';
import { getPreferences } from '@/lib/preferences';

export default function BottomNav() {
  const { pending, expired } = useReminderCounts();
  const [navPaths, setNavPaths] = useState<string[]>(() => getPreferences().navPaths);

  // preferences 不是 store，改完只能靠事件通知；跨标签页用 storage 事件补一刀。
  useEffect(() => {
    const sync = () => setNavPaths(getPreferences().navPaths);
    window.addEventListener(NAV_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(NAV_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const items = useMemo(() => resolveNavItems(navPaths), [navPaths]);

  // 读屏要听到的句子。角标本身是 aria-hidden 的（见 ReminderCountBadges），
  // 数量改由 aria-describedby 挂到链接上：accessible name 仍严格等于「提醒事项」，
  // 描述另说一条。若把数量写进链接里，菜单名就会被数字改写，
  // 读屏会念成「3 2 提醒事项」。
  const countText = [pending > 0 ? `${pending} 条待办` : '', expired > 0 ? `${expired} 条已过期` : '']
    .filter(Boolean)
    .join('，');

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/60 bg-background/95 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-around px-2">
        {items.map((item) => {
          const Icon = item.icon;
          const isReminders = item.path === '/reminders';
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              // 描述节点必须挂在链接外面：放进去就成了链接内容，
              // 会被算进 accessible name。
              aria-describedby={isReminders && countText ? 'reminder-count-desc' : undefined}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[11px] transition-colors ${
                  isActive
                    ? 'text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`
              }
            >
              <span className="relative inline-flex">
                <Icon className="size-5" />
                {isReminders && <ReminderCountBadges pending={pending} expired={expired} />}
              </span>
              <span>{item.label}</span>
            </NavLink>
          );
        })}
      </div>
      {countText && (
        <span id="reminder-count-desc" className="sr-only">
          {countText}
        </span>
      )}
    </nav>
  );
}
