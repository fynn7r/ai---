/**
 * @file nav.ts
 * @description 导航项的唯一注册表。
 *
 * 原来底部导航和顶部 Header 各写了一份 NAV_ITEMS，中文标签与图标重复维护。
 * 现在「有哪些页面」只在这里定义一次，「显示哪些、什么顺序」由
 * preferences.navPaths 决定，工作台卡片也直接读这里。
 *
 * 顺序与显隐存在 preferences 里而不是这里，是因为用户能改；
 * 但改的只能是「注册过的 path」，所以 resolveNavItems 必须过滤未知项。
 */

import {
  Bell,
  BookOpen,
  FilePenLine,
  History,
  LayoutGrid,
  Sparkles,
  User,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** 工作台入口卡片上的一句话说明 */
  description: string;
}

export const NAV_REGISTRY: NavItem[] = [
  { path: '/', label: '工作台', icon: LayoutGrid, description: '今天的待办与全部入口' },
  { path: '/parse', label: '智能解析', icon: Sparkles, description: '粘贴通知，提取截止时间' },
  { path: '/generator', label: '通知生成', icon: FilePenLine, description: '按模板写一份规范通知' },
  { path: '/rules', label: '规则库', icon: BookOpen, description: '导入细则，判断重要程度' },
  { path: '/reminders', label: '提醒事项', icon: Bell, description: '全部待办与日历导出' },
  { path: '/history', label: '历史记录', icon: History, description: '回看解析过的通知' },
  { path: '/profile', label: '我的', icon: User, description: '模型接入与偏好设置' },
];

/** 首次使用时的默认导航。通知生成与历史记录收进工作台卡片，手机上一排不至于挤成七个。 */
export const DEFAULT_NAV_PATHS = ['/', '/parse', '/reminders', '/rules', '/profile'];

/** 导航改动的广播事件。preferences 不是 store，只能靠事件通知订阅方重新读。 */
export const NAV_CHANGED_EVENT = 'notizhi:nav-changed';

export function findNavItem(path: string): NavItem | undefined {
  return NAV_REGISTRY.find((item) => item.path === path);
}

/**
 * 把 paths 解析成导航项：丢掉未注册的、去重、保持用户顺序。
 * 全部失效时回退到默认导航——返回空数组会让整条底部导航消失，
 * 那样连「回到默认」的入口都没了。
 */
export function resolveNavItems(paths: string[]): NavItem[] {
  const seen = new Set<string>();
  const items: NavItem[] = [];
  for (const path of paths) {
    const item = findNavItem(path);
    if (!item || seen.has(path)) continue;
    seen.add(path);
    items.push(item);
  }
  return items.length ? items : DEFAULT_NAV_PATHS.map(findNavItem).filter((i): i is NavItem => Boolean(i));
}
