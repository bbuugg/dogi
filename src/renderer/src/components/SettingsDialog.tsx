import { useAppStore } from '@/stores/app-store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelSettings } from '@/components/settings/ModelSettings'
import { McpSettings } from '@/components/settings/McpSettings'
import { PrefSettings } from '@/components/settings/PrefSettings'

export function SettingsDialog() {
  const settingsOpen = useAppStore((s) => s.ui.settingsOpen)
  const settingsTab = useAppStore((s) => s.ui.settingsTab)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription className="text-xs">
            模型配置、MCP 服务与 AI 行为偏好
          </DialogDescription>
        </DialogHeader>
        <Tabs value={settingsTab} onValueChange={(v) => setSettingsOpen(true, v as never)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="models">模型配置</TabsTrigger>
            <TabsTrigger value="mcp">MCP 服务</TabsTrigger>
            <TabsTrigger value="prefs">偏好</TabsTrigger>
          </TabsList>
          <TabsContent value="models" className="mt-3">
            <ModelSettings />
          </TabsContent>
          <TabsContent value="mcp" className="mt-3">
            <McpSettings />
          </TabsContent>
          <TabsContent value="prefs" className="mt-3">
            <PrefSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
