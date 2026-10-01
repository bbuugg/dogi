import { cn } from "cn"
import { ChevronRight } from "lucide-react"

export default function ({ expanded, onToggle, color }: { expanded: boolean; onToggle: () => void; color?: string | null }) {
    return <>
        <button
            type="button"
            title={expanded ? '收起' : '展开'}
            onClick={(e) => {
                e.stopPropagation()
                onToggle()
            }}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10"
        >
            <ChevronRight
                className={cn('size-4 transition-transform duration-200', expanded && 'rotate-90')}
                style={color ? { color } : undefined}
            />
        </button>
    </>
}