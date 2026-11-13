/**
 * @file WorkbenchPage.tsx
 * @description 工作台首页：一屏回答「今天必须做什么」，并且能当场把事做完。
 *
 * 数据全部来自本地已经存在的 reminderStore，没有新增请求，
 * 也没有新增「工作台」专用的数据结构——它只是把待办换了个读法：
 * 按「今天 / 7 天内 / 已逾期」分堆，而不是按创建顺序列出来。
 *
 * 三个动作（贴通知、勾完成、顺延）刻意都放在首屏：
 * 只能看的首页叫仪表盘，能就地改的才叫工作台。
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CalendarClock, Loader2, SlidersHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, endOfDay } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import ImportanceBadge from '@/components/common/ImportanceBadge';
import NavSettingsDialog from '@/components/NavSettingsDialog';
import { reminderStore } from '@/lib/reminder-store';
import { useReminders } from '@/hooks/useReminders';
import { formatCountdown, formatDateTime, formatLocalDateTime, getSafeTime, parseSmartDate } from '@/lib/date-utils';
import { NAV_REGISTRY } from '@/lib/nav';
import type { IReminder } from '@/data/reminder';
import { cn } from '@/lib/utils';

/** 工作台上最多列 5 条：再多就不像「今天要看什么」，而像把提醒页搬过来了。 */
const UPCOMING_LIMIT = 5;

/** 把「YYYY-MM-DD HH:mm:ss」整体推后一天，时间点保持不变。解析失败返回 null。 */
function shiftOneDay(value: string): string | null {
  const date = parseSmartDate(value);
  if (!date) return null;
  return formatLocalDateTime(addDays(date, 1));
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'today' | 'overdue';
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4" data-metric={label}>
      <div
        className={cn(
          'text-2xl font-bold tabular-nums',
          tone === 'today' && value > 0 && 'text-primary',
          tone === 'overdue' && value > 0 && 'text-destructive'
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

export default function WorkbenchPage() {
  const { items, loading } = reminderStore.useStore();
  const { toggleComplete, updateReminder } = useReminders();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [quickText, setQuickText] = useState('');

  const stats = useMemo(() => {
    const now = Date.now();
    const todayEnd = endOfDay(new Date()).getTime();
    const weekEnd = endOfDay(addDays(new Date(), 7)).getTime();
    let today = 0;
    let week = 0;
    let overdue = 0;
    let done = 0;
    for (const item of items) {
      if (item.completed) {
        done += 1;
        continue;
      }
      const time = getSafeTime(item.deadline);
      // 没有截止时间的待办既不算到期也不算逾期，和导航角标的口径保持一致
      if (time === Infinity) continue;
      if (time < now) overdue += 1;
      else if (time <= todayEnd) today += 1;
      else if (time <= weekEnd) week += 1;
    }
    return { today, week, overdue, done };
  }, [items]);

  const upcoming = useMemo(
    () =>
      items
        .filter((item) => !item.completed)
        .sort((a, b) => getSafeTime(a.deadline) - getSafeTime(b.deadline))
        .slice(0, UPCOMING_LIMIT),
    [items]
  );

  /** 空着也能点：直接进解析页，那儿能传文件、贴图、贴公众号链接。 */
  const goParse = () => {
    const text = quickText.trim();
    navigate('/parse', text ? { state: { text } } : undefined);
  };

  const handleComplete = (item: IReminder) => {
    toggleComplete(item.id);
    toast.success('已完成', { description: item.title });
  };

  const handlePostpone = (item: IReminder) => {
    const nextDeadline = shiftOneDay(item.deadline);
    if (!nextDeadline) {
      toast.error('这条没有可顺延的截止时间');
      return;
    }
    // 提醒时间跟着一起挪：只改 deadline 会让旧提醒在新截止时间之前抢跑。
    const nextRemind = shiftOneDay(item.remindAt);
    updateReminder(item.id, {
      deadline: nextDeadline,
      ...(nextRemind ? { remindAt: nextRemind } : {}),
    });
    toast.success('已顺延一天', { description: `${item.title} → ${formatDateTime(nextDeadline)}` });
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const todayLabel = new Date().toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  return (
    <div className="w-full min-w-0 overflow-hidden">
      <div className="mx-auto max-w-3xl px-4 py-8 md:px-6 md:py-12">
        <div className="mb-6 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">工作台</h1>
            <p className="mt-2 text-sm text-muted-foreground">{todayLabel}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setNavOpen(true)}>
            <SlidersHorizontal className="mr-1.5 size-4" />
            自定义导航
          </Button>
        </div>

        <Card className="mb-4 border-border/60 shadow-sm">
          <CardContent className="p-4 md:p-5">
            <label htmlFor="quick-notice" className="text-sm font-medium">
              贴一条通知
            </label>
            <p className="mt-1 text-xs text-muted-foreground">
              粘贴后直接进解析；要传文件、贴截图或公众号链接，去解析页再加。
            </p>
            <Textarea
              id="quick-notice"
              value={quickText}
              onChange={(event) => setQuickText(event.target.value)}
              placeholder="例：本周五 18:00 前把实验报告交到教务处，逾期不再受理。"
              className="mt-3 min-h-[88px] resize-y rounded-lg border-border/60 text-sm leading-relaxed focus-visible:ring-1"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {quickText.trim() ? `${quickText.trim().length} 字` : '留空也能进解析页'}
              </span>
              <Button size="sm" onClick={goParse}>
                <Sparkles className="mr-1.5 size-4" />
                解析这条通知
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="今天到期" value={stats.today} tone="today" />
          <Metric label="7 天内" value={stats.week} />
          <Metric label="已逾期" value={stats.overdue} tone="overdue" />
          <Metric label="已完成" value={stats.done} />
        </div>

        {stats.overdue > 0 && (
          <Link
            to="/reminders"
            className="mb-6 flex items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-4 text-sm transition-colors hover:bg-destructive/[0.07]"
          >
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <span className="flex-1 text-foreground">
              有 {stats.overdue} 条已过截止时间，去确认还要不要补办
            </span>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        )}

        <Card className="mb-8 border-border/60 shadow-sm">
          <CardContent className="p-0">
            <div className="flex items-center justify-between px-4 py-3 md:px-6">
              <h2 className="text-sm font-medium">接下来要做</h2>
              <Link to="/reminders" className="text-xs text-primary hover:underline">
                全部待办
              </Link>
            </div>
            {upcoming.length === 0 ? (
              <div className="px-4 pb-6 pt-2 text-center md:px-6">
                <p className="text-sm text-muted-foreground">
                  还没有待办。粘贴一条群通知，让它自己算出截止时间。
                </p>
                <Button asChild size="sm" className="mt-3">
                  <Link to="/parse">去解析通知</Link>
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {upcoming.map((item) => {
                  const hasDeadline = getSafeTime(item.deadline) !== Infinity;
                  return (
                    <li key={item.id} className="flex items-center gap-3 px-4 py-3 md:px-6">
                      <Checkbox
                        aria-label={`标记完成：${item.title}`}
                        checked={item.completed}
                        onCheckedChange={() => handleComplete(item)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{item.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {hasDeadline
                            ? `${formatDateTime(item.deadline)} · ${formatCountdown(item.deadline)}`
                            : '无截止时间'}
                        </p>
                      </div>
                      {hasDeadline && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                          aria-label={`顺延一天：${item.title}`}
                          onClick={() => handlePostpone(item)}
                        >
                          <CalendarClock className="mr-1 size-3.5" />
                          顺延
                        </Button>
                      )}
                      <ImportanceBadge level={item.importance} />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <h2 className="mb-3 text-sm font-medium">功能入口</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {NAV_REGISTRY.filter((item) => item.path !== '/').map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                to={item.path}
                className="rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30"
              >
                <Icon className="size-5 text-primary" />
                <p className="mt-2 text-sm font-medium">{item.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
              </Link>
            );
          })}
        </div>
      </div>

      <NavSettingsDialog open={navOpen} onOpenChange={setNavOpen} />
    </div>
  );
}
