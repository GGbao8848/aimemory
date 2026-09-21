import { FileDown, FileJson, Sheet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { endpoints } from '../api/contract';
import { download } from '../api/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function ExportsView({ active }: { active: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);

  const downloadAs = async (format: 'json' | 'csv') => {
    setBusy(format);
    try {
      await download(
        `${endpoints.memoriesExport()}?format=${format}`,
        `aimemory-memories-${new Date().toISOString().slice(0, 10)}.${format}`,
      );
      toast.success(`已导出 ${format.toUpperCase()} 文件`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto' : 'hidden'}>
      <div className="grid gap-3 md:grid-cols-2">
        <Card className="gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <FileJson className="size-4" />
            <span className="text-sm font-semibold">JSON 全量导出</span>
          </div>
          <p className="text-muted-foreground text-xs">
            全部记忆及完整结构：文本、来源（origin）、分类、实体、facts、agent/run、元数据与时间戳。适合备份与迁移到其他 mem0 兼容系统。
          </p>
          <Button variant="outline" size="sm" onClick={() => downloadAs('json')} disabled={busy !== null}>
            <FileDown /> {busy === 'json' ? '导出中…' : '下载 JSON'}
          </Button>
        </Card>

        <Card className="gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <Sheet className="size-4" />
            <span className="text-sm font-semibold">CSV 表格导出</span>
          </div>
          <p className="text-muted-foreground text-xs">
            扁平表格：id、文本、来源、分类、实体（竖线分隔）、agent/run 与时间。适合 Excel 分析或导入表格工具。
          </p>
          <Button variant="outline" size="sm" onClick={() => downloadAs('csv')} disabled={busy !== null}>
            <FileDown /> {busy === 'csv' ? '导出中…' : '下载 CSV'}
          </Button>
        </Card>
      </div>
      <Card className="px-4 py-3">
        <p className="text-muted-foreground text-xs">
          提示：数据库文件的在线备份用服务器上的 <code className="bg-muted rounded px-1">scripts/backup.sh</code>（含 WAL 一致性快照与保留策略），与本页的格式化导出互为补充。
        </p>
      </Card>
    </div>
  );
}
