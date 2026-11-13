/**
 * @file NavSettingsDialog.tsx
 * @description 自定义底部导航：勾掉不常用的、调一下顺序。
 *
 * 只让用户改「显示哪些、什么顺序」，不允许新增未注册的页面——
 * 可选集合永远来自 NAV_REGISTRY，所以存进去的 path 一定能被路由解析到。
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NAV_REGISTRY, resolveNavItems } from '@/lib/nav';
import { getPreferences, setNavPaths } from '@/lib/preferences';

interface NavSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function NavSettingsDialog({ open, onOpenChange }: NavSettingsDialogProps) {
  const [paths, setPaths] = useState<string[]>([]);

  // 每次打开都重新读：上次点了取消，弹窗里的草稿不能留到下一次。
  useEffect(() => {
    if (open) setPaths(getPreferences().navPaths);
  }, [open]);

  // 存进去的可能是旧版本遗留的无效 path，先过一遍注册表再展示
  const visible = resolveNavItems(paths).map((item) => item.path);
  const hidden = NAV_REGISTRY.filter((item) => !visible.includes(item.path));
  const lastOne = visible.length <= 1;

  function move(path: string, delta: number) {
    const next = [...visible];
    const index = next.indexOf(path);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setPaths(next);
  }

  function save() {
    setNavPaths(visible);
    onOpenChange(false);
    toast.success('导航已更新');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>自定义导航</DialogTitle>
          <DialogDescription>
            底部导航建议控制在 6 项以内，放不下的页面仍可从工作台的入口卡片进入。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">当前显示</p>
            <ul className="space-y-1.5">
              {visible.map((path, index) => {
                const item = NAV_REGISTRY.find((nav) => nav.path === path);
                if (!item) return null;
                const Icon = item.icon;
                return (
                  <li
                    key={path}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm">{item.label}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`上移${item.label}`}
                      disabled={index === 0}
                      onClick={() => move(path, -1)}
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`下移${item.label}`}
                      disabled={index === visible.length - 1}
                      onClick={() => move(path, 1)}
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`移除${item.label}`}
                      disabled={lastOne}
                      onClick={() => setPaths(visible.filter((p) => p !== path))}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            {lastOne && (
              <p className="mt-2 text-xs text-muted-foreground">至少保留一项导航。</p>
            )}
          </div>

          {hidden.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">未显示</p>
              <ul className="flex flex-wrap gap-2">
                {hidden.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.path}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setPaths([...visible, item.path])}
                      >
                        <Plus className="size-3.5" />
                        <Icon className="size-3.5" />
                        {item.label}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
